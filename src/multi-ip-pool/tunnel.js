// multi-ip-pool · 一槽一条 openvpn 子进程 + 一条独立策略路由表。
//
// 为什么这么装（照参照实现 aimili-vpngate 的必要动作，但这里每槽各一套）：
//   openvpn 起来后内核多一个 tunX 设备，VPNGate 推给它的内网地址就是**本槽的源地址**；
//   把「源地址 = <tunX 地址> 的包」整表引到「默认路由 = tunX」的策略表里，
//   该槽的出站（含 undici 的 connect.localAddress 绑定）就只会从这条隧道出去。
//   ⇒ 一块网卡上 N 条隧道、N 个真实出口，互不干扰（参照实现一次只挂 1 条）。
//
// 平台纪律：只有 Linux 能干（tun + `ip rule`）；其它平台由调用方**诚实跳过一行**，不做半吊子。
import { spawn } from "node:child_process";
import { devNameFor, tableFor } from "./config.js";
import { fmtArgv, fmtExit, fmtRpf, fmtRuleFail, fmtSpawn, fmtTunAddrFail } from "./report.js";
import { openvpnErrorLine, openvpnErrorBrief } from "./diagnose.js";

/** openvpn 就绪标志（配置文件里可能出现别的 "Sequence"，必须整串匹配）。 */
export const READY_PATTERN = /Initialization Sequence Completed/;

/** 策略路由表号 → 规则优先级：落在 main(32766) 之前，且多槽之间固定可复现。 */
export const RULE_PRIORITY_BASE = 20_000;

export function rulePriorityFor(i) {
  return RULE_PRIORITY_BASE + i;
}

/** 只有 Linux 支持：tun 设备 + `ip rule`/`ip route`。 */
export function isSupportedPlatform(platform = process.platform) {
  return platform === "linux";
}

export function isRoot(getuid = process.getuid?.bind(process)) {
  try {
    return typeof getuid === "function" ? getuid() === 0 : true; // 取不到 uid 的平台上由平台门先拦
  } catch {
    return true;
  }
}

/**
 * openvpn 命令行。**dev 与路由一律走命令行覆盖**（命令行优先于 config 文件）：
 * `--route-nopull` + `--pull-filter ignore redirect-gateway` 保证它绝不碰主路由表——
 * 主路由表被改 = 整台机器的流量（含 daemon 自己打上游）都被拽进隧道，那是灾难。
 * `--dev-type tun` 不可省：槽设备名（`mltun1`…）**不以 tun/tap 开头**，openvpn 从名字推不出类型
 * （其 usage 原文：dev-type「仅当 --dev 的设备名不以 tun 或 tap 开头时使用」）；实测 97 个 VPNGate 节点全是 `dev tun`。
 * 三个必填项缺一即抛：空串传下去会被 openvpn 判成「选项缺参数」，只留下一句没头没尾的 usage 错误（2026-10-25 真机踩过）。
 */
export function buildOpenvpnArgs({ conf, dev, authFile, logFile = "", verb = 3 }) {
  for (const [name, v] of [["conf", conf], ["dev", dev], ["authFile", authFile]]) {
    if (!v) throw new Error(`buildOpenvpnArgs 缺 ${name}：拒绝起隧道（空参数会让 openvpn 只报一句 usage 错误，看不出病因）`);
  }
  return [
    "--config", conf,
    "--dev", dev,
    "--dev-type", "tun",
    "--auth-user-pass", authFile,
    "--route-nopull",
    "--pull-filter", "ignore", "redirect-gateway",
    "--verb", String(verb),
    ...(logFile ? ["--log", logFile] : []),
  ];
}


/** 从 `ip -4 addr show dev <dev>` 输出里取 tun 地址（VPNGate 推的是 10.x 内网地址）。 */
export function parseTunAddr(text) {
  const m = /inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(String(text || ""));
  return m ? m[1] : "";
}

/** 该槽要装的策略路由（纯函数）：源地址定表 → 表里默认走隧道。 */
export function tunnelUpCommands({ tunIp, table, dev, priority }) {
  return [
    ["ip", "rule", "add", "from", `${tunIp}/32`, "lookup", String(table), "priority", String(priority)],
    ["ip", "route", "replace", "default", "dev", dev, "table", String(table)],
  ];
}

/** 拆槽时按相反顺序撤（先撤表、再撤规则）。 */
export function tunnelDownCommands({ tunIp, table }) {
  return [
    ["ip", "route", "flush", "table", String(table)],
    ["ip", "rule", "del", "from", `${tunIp}/32`, "lookup", String(table)],
  ];
}

/** `ip rule` 的优先级和表号都可能是别人先占的——失败要能一眼看出「占了什么」。 */
export function rpFilterPaths() {
  return [
    "/proc/sys/net/ipv4/conf/all/rp_filter",
    "/proc/sys/net/ipv4/conf/default/rp_filter",
  ];
}

/** 逐行跑命令；超时 SIGKILL（绝不让一个卡住的 ip 调用把启动挂死）。 */
export function runCmd(cmd, args = [], { timeoutMs = 10_000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawnFn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e?.message || e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已经退了 */
      }
    }, timeoutMs);
    child.stdout?.on("data", (b) => { out += String(b); });
    child.stderr?.on("data", (b) => { err += String(b); });
    child.once("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: `${err}${e.message}` }); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

/** 本机到底有没有 openvpn（没有就别装了，诚实跳过）。 */
export async function checkOpenvpn(bin, { runCmdFn = runCmd } = {}) {
  const r = await runCmdFn(bin, ["--version"], { timeoutMs: 8_000 });
  const text = `${r.stdout}${r.stderr}`;
  if (r.code === 0 && /openvpn/i.test(text)) return { ok: true, version: (text.split(/\r?\n/)[0] || "").trim() };
  return { ok: false, why: r.stderr.trim() || `退出码 ${r.code}` };
}

/**
 * 起一条隧道并等它就绪。返回句柄；`ready` reject 表示这槽本轮不可用（调用方换下一个节点）。
 * tail 保留末 20 行：真机排障时"openvpn 为什么退"全在这几行里。
 */
export function startTunnel({ bin, args, timeoutMs = 25_000, spawnFn = spawn, log = () => {}, onExit = null, dev = "" } = {}) {
  // 「我到底跑了什么」必须是第一条信息：openvpn 的 argv 报错只有对着命令行原文才看得懂
  log(fmtArgv({ bin, args }));
  let child;
  try {
    child = spawnFn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { pid: 0, ready: Promise.reject(new Error(`拉不起 ${bin}：${String(e?.message || e)}`)), tail: () => "", stop: () => {} };
  }
  const tail = [];
  const t0 = Date.now();
  let settled = false;
  let stopping = false;
  const push = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      tail.push(s);
      if (tail.length > 20) tail.shift();
    }
  };
  const lastTail = () => openvpnErrorLine(tail.join("\n"));
  const briefTail = () => openvpnErrorBrief(tail.join("\n"));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* 已退 */ }
      reject(new Error(`等 ${Math.round(timeoutMs / 1000)}s 没等到「Initialization Sequence Completed」（隧道没起来）：${briefTail()}`));
    }, timeoutMs);
    const onChunk = (buf) => {
      push(buf);
      if (settled || !READY_PATTERN.test(tail.join("\n"))) return;
      settled = true;
      clearTimeout(timer);
      resolve({ pid: child.pid });
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("exit", (code, signal) => {
      const aliveMs = Date.now() - t0;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`openvpn 提前退出（code=${code} signal=${signal}）：${briefTail()}`));
      }
      // 主动关掉的隧道不算"意外退出"：收摊日志只该出现在真出事时（否则每次换槽都刷一行假警报）
      if (!stopping) log(fmtExit({ dev, code, signal, pid: child.pid, aliveMs, tail: lastTail() }));
      if (onExit) { try { onExit({ code, signal, tail: lastTail() }); } catch { /* 回调失败不影响退出 */ } }
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`拉不起 ${bin}：${String(err?.message || err)}`));
    });
  });
  return { child, pid: child.pid, ready, tail: lastTail, stop: () => { stopping = true; try { child.kill("SIGTERM"); } catch { /* 已退 */ } } };
}

/** 等 tun 地址出现（VPNGate 的 ifconfig 是随隧道建立推送的，通常一两百毫秒内就位）。 */
export async function waitTunAddr({ dev, runCmdFn = runCmd, wait = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 10, gapMs = 300 } = {}) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    const r = await runCmdFn("ip", ["-4", "addr", "show", "dev", dev], { timeoutMs: 5_000 });
    last = `${r.stdout}${r.stderr}`.trim();
    const ip = parseTunAddr(r.stdout);
    if (ip) return { ip, out: last };
    if (i < tries - 1) await wait(gapMs);
  }
  return { ip: "", out: last };
}

/**
 * 放宽 rp_filter（严格反向路径过滤会丢「从 tun 出去、从 eth 回来」的不对称包 ⇒ 隧道看起来活着但请求全挂住）。
 * 默认开；MSLXDFF_MULTI_IP_SYSCTL=0 关。改的是内核参数，日志必须写清楚改了什么、怎么还原。
 */
export async function relaxRpf({ enabled = true, readFile, writeFile, log = () => {} } = {}) {
  if (!enabled) {
    log(fmtRpf({ skipped: true }));
    return { ok: true, changed: [] };
  }
  const paths = rpFilterPaths();
  const changed = [];
  try {
    const fs = await import("node:fs");
    const read = readFile || fs.readFileSync;
    const write = writeFile || fs.writeFileSync;
    for (const p of paths) {
      const before = String(read(p, "utf8")).trim();
      if (before === "2") continue;
      write(p, "2");
      changed.push({ path: p, from: before, to: "2" });
    }
    log(fmtRpf({ ok: true, changed }));
    return { ok: true, changed };
  } catch (e) {
    log(fmtRpf({ ok: false, error: String(e?.message || e), changed }));
    return { ok: false, changed, error: String(e?.message || e) };
  }
}

/**
 * 起槽全流程：spawn openvpn → 等就绪 → 读 tun 地址 → 放宽 rp_filter → 装策略路由。
 * @returns {Promise<{dev, table, priority, tunIp, pid, stop, tail}>}
 */
export async function bringUpTunnel({ cfg, slotIndex, node, deps = {} } = {}) {
  const dev = devNameFor(cfg.devPrefix, slotIndex);
  const table = tableFor(cfg.baseTable, slotIndex);
  const priority = rulePriorityFor(slotIndex);
  const runCmdFn = deps.runCmdFn || runCmd;
  const wait = deps.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || (() => {});
  const t = startTunnel({
    bin: cfg.openvpnBin,
    args: buildOpenvpnArgs({ conf: node.conf, dev, authFile: deps.authFile, logFile: deps.openvpnLog || "" }),
    timeoutMs: cfg.connectTimeoutMs,
    spawnFn: deps.spawnFn,
    log,
    dev,
    onExit: deps.onExit,
  });
  try {
    await t.ready;
  } catch (e) {
    t.stop();
    throw e;
  }
  log(fmtSpawn({ dev, pid: t.pid, host: node.host, port: node.port, country: node.countryShort || "", table }));
  const addr = await waitTunAddr({ dev, runCmdFn, wait, tries: deps.addrTries ?? 10 });
  if (!addr.ip) {
    t.stop();
    throw new Error(fmtTunAddrFail({ dev, out: addr.out }));
  }
  await relaxRpf({ enabled: cfg.sysctl !== false, log, readFile: deps.readFile, writeFile: deps.writeFile });
  for (const cmd of tunnelUpCommands({ tunIp: addr.ip, table, dev, priority })) {
    const r = await runCmdFn(cmd[0], cmd.slice(1), { timeoutMs: 8_000 });
    if (r.code !== 0) {
      t.stop();
      throw new Error(fmtRuleFail({ dev, cmd: cmd.join(" "), error: `${r.stderr || r.stdout}`.trim() }));
    }
  }
  return { dev, table, priority, tunIp: addr.ip, pid: t.pid, stop: t.stop, tail: t.tail };
}

/** 拆槽：先撤策略路由（否则表里留着已消失设备的默认路由），再关子进程。 */
export async function tearDownTunnel({ slot, runCmdFn = runCmd, log = () => {} } = {}) {
  if (!slot) return;
  for (const cmd of tunnelDownCommands(slot)) {
    try {
      await runCmdFn(cmd[0], cmd.slice(1), { timeoutMs: 5_000 });
    } catch (e) {
      log(`[multi-ip-pool] 撤策略路由失败（${cmd.join(" ")}）：${String(e?.message || e)}`);
    }
  }
  try {
    slot.stop?.();
  } catch {
    /* 已经退了 */
  }
}