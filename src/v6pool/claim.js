// v6pool · 让内核接受池里的源地址（bind 直用 / ip addr add 认领）+ 认领账 + 释放。
//
// 两条路（Linux 上 bind() 一个没分配给本机的源地址会直接 EADDRNOTAVAIL）：
//   bind：net.ipv6.ip_nonlocal_bind=1 ⇒ 直接 bind 任意地址，**不碰网卡**（首选，零副作用）；
//   add ：ip -6 addr add <addr>/128 dev <iface> nodad ⇒ 加进网卡（需 root）。
//
// 为什么要记账（本轮手工实测的教训）：加进网卡的地址会改变内核的**默认源地址选择**——
// 我在 A 机上留了两个临时地址，结果不带 --interface 的请求也走了新地址（生产机上这是事故）。
// 所以：每次 add/del 都落 `<dir>/claimed.json`（0600、非工作树）；close 时全部释放；
// 启动时按这份账清上一代残留（崩溃 / 被 SIGKILL 时 close 跑不到）。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fmtClaim, fmtClaimFail, fmtSweep } from "./report.js";

export const CLAIM_FILE = "claimed.json";

/** 默认执行器：失败时把 stderr 原文带进 Error（不许把 stderr 吞掉——否则只剩「失败了」）。 */
export function defaultExec(file, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${file} ${args.join(" ")} 失败：${String(stderr || err.message || "").trim()}`);
        e.code = err.code;
        e.stderr = String(stderr || "");
        reject(e);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/** 退出钩子专用（同步）：`process.on("exit")` 里跑不了 async，但地址必须清。 */
export function defaultExecSync(file, args, { timeoutMs = 10_000 } = {}) {
  execFileSync(file, args, { timeout: timeoutMs, stdio: "ignore" });
}

/** 幂等判据：`ip addr add` 报 File exists = 已经在网卡上了，不算失败。 */
export function isAlreadyThere(e) {
  return /File exists|already assigned/i.test(String(e?.stderr || e?.message || ""));
}

/** 释放时「它已经不在了」也不算失败（上一代残留已被别处清掉 / 手工删掉）。 */
export function isAlreadyGone(e) {
  return /Cannot assign requested address|Cannot find device|does not exist/i.test(String(e?.stderr || e?.message || ""));
}

/**
 * @param {{ iface?: string, mode?: "bind"|"add", dir?: string, log?: (s:string)=>void, exec?: Function, fs?: object }} opts
 */
export function createClaimer({ iface = "", mode = "bind", dir = "", log = () => {}, exec = defaultExec, fs = { mkdirSync, writeFileSync, chmodSync, readFileSync } } = {}) {
  /** 只有 add 模式需要记账（bind 模式没改网卡，无残留可言）。 */
  const claimed = new Set();

  function persist() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = join(dir, CLAIM_FILE);
      fs.writeFileSync(file, `${JSON.stringify({ iface, mode, addrs: [...claimed], updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600); // mode 只在新建时生效，存量必须补
    } catch (e) {
      log(`[v6pool] ⚠ 认领账写盘失败（本次照跑，但崩溃后无法自动清残留）：${String(e?.message || e)}`);
    }
  }

  async function ensure(addr) {
    if (mode !== "add") return addr;
    try {
      await exec("ip", ["-6", "addr", "add", `${addr}/128`, "dev", iface, "nodad"]);
      log(fmtClaim({ addr, iface }));
    } catch (e) {
      if (!isAlreadyThere(e)) {
        log(fmtClaimFail({ addr, iface, error: String(e?.message || e) }));
        throw e;
      }
    }
    claimed.add(addr);
    persist();
    return addr;
  }

  async function release(addr) {
    if (mode !== "add" || !claimed.has(addr)) return false;
    claimed.delete(addr);
    persist();
    try {
      await exec("ip", ["-6", "addr", "del", `${addr}/128`, "dev", iface]);
      return true;
    } catch (e) {
      if (isAlreadyGone(e)) return false;
      log(`[v6pool] ⚠ 释放源地址失败（重启时由启动清残留兜底）：${addr} — ${String(e?.stderr || e?.message || "").trim()}`);
      return false;
    }
  }

  async function releaseAll() {
    const done = [];
    for (const a of [...claimed]) if (await release(a)) done.push(a);
    return done;
  }

  /** 退出钩子专用：进程正在退出，只能跑同步命令；清不掉的交给下次启动的 sweepStale。 */
  function releaseAllSync({ execSync = defaultExecSync } = {}) {
    if (mode !== "add" || !claimed.size) return [];
    const done = [];
    for (const a of [...claimed]) {
      try {
        execSync("ip", ["-6", "addr", "del", `${a}/128`, "dev", iface]);
        done.push(a);
      } catch {
        /* 删不掉不抛：进程正在退出，抛了也没人接 */
      }
    }
    claimed.clear();
    return done;
  }

  /** 启动清残留：只删**上一代自己记在账上的**地址，绝不猜（不扫全表，不碰别人的地址）。 */
  async function sweepStale() {
    if (mode !== "add") return { removed: [], failed: [] };
    let prev = [];
    try {
      prev = JSON.parse(fs.readFileSync(join(dir, CLAIM_FILE), "utf8"))?.addrs || [];
    } catch {
      return { removed: [], failed: [] };
    }
    const removed = [];
    const failed = [];
    for (const a of prev) {
      if (typeof a !== "string" || !a) continue;
      try {
        await exec("ip", ["-6", "addr", "del", `${a}/128`, "dev", iface]);
        removed.push(a);
      } catch (e) {
        if (!isAlreadyGone(e)) failed.push({ addr: a, error: String(e?.stderr || e?.message || "").trim() });
      }
    }
    claimed.clear();
    persist();
    const r = { removed, failed };
    if (removed.length || failed.length) log(fmtSweep({ iface, ...r }));
    return r;
  }

  return {
    ensure,
    release,
    releaseAll,
    releaseAllSync,
    sweepStale,
    claimed: () => [...claimed],
    get mode() {
      return mode;
    },
  };
}
