import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonDir, readPid, isPidAlive } from "./daemon.js";
import { writeExitMarker } from "./runtime/lifecycle-forensics.js";

const TASK_NAME = "mslxdff";
const SERVICE_NAME = "mslxdff";

function isWin() { return process.platform === "win32"; }

function nodePath() { return process.execPath; }

function scriptPath() {
  // src/autostart.js -> ../bin/mslxdff.js
  return join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mslxdff.js");
}

function execAsync(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 8000, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || ""), code: err?.code ?? 0 });
    });
  });
}

// ---------- Windows: schtasks ----------
async function winRegQuery() {
  const r = await execAsync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", TASK_NAME]);
  if (!r.err && r.stdout.includes(TASK_NAME)) return { exists: true, raw: r.stdout, method: "registry" };
  return { exists: false, raw: r.stdout || r.stderr };
}

async function winQuery() {
  const r = await execAsync("schtasks", ["/query", "/tn", TASK_NAME, "/fo", "LIST", "/v"]);
  if (!r.err) {
    const out = r.stdout || "";
    if (out.includes(TASK_NAME)) return { exists: true, raw: out, method: "schtasks" };
  }
  // 回退查注册表
  const reg = await winRegQuery();
  if (reg.exists) return { exists: true, raw: reg.raw, method: "registry" };
  return { exists: false, raw: r.stderr || r.stdout };
}

async function winRegEnable() {
  const node = nodePath();
  const script = scriptPath();
  const cmd = `"${node}" "${script}"`;
  const r = await execAsync("reg", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", TASK_NAME, "/t", "REG_SZ", "/d", cmd, "/f"]);
  if (!r.err) return { ok: true, method: "registry:HKCU\\Run", stdout: r.stdout };
  return { ok: false, error: (r.stderr || r.stdout || r.err?.message || "").slice(0, 800) };
}

async function winEnable() {
  const node = nodePath();
  const script = scriptPath();
  const tr = `"${node}" "${script}"`;
  // 1) schtasks ONLOGON（需任务计划权限，部分受限环境会拒绝访问）
  let r = await execAsync("schtasks", ["/create", "/tn", TASK_NAME, "/tr", tr, "/sc", "onlogon", "/f"]);
  if (!r.err) return { ok: true, method: "schtasks:onlogon", stdout: r.stdout };
  r = await execAsync("schtasks", ["/create", "/tn", TASK_NAME, "/tr", tr, "/sc", "onlogon", "/rl", "highest", "/f"]);
  if (!r.err) return { ok: true, method: "schtasks:onlogon:highest", stdout: r.stdout };
  // 2) 回退注册表 HKCU Run（无需管理员，当前用户登录即起，最兼容）
  const reg = await winRegEnable();
  if (reg.ok) return reg;
  // 3) 最后尝试 ONSTART + SYSTEM
  r = await execAsync("schtasks", ["/create", "/tn", TASK_NAME, "/tr", tr, "/sc", "onstart", "/ru", "SYSTEM", "/f"]);
  if (!r.err) return { ok: true, method: "schtasks:onstart:SYSTEM", stdout: r.stdout };
  const msg = r.stderr || r.stdout || reg.error || "";
  // 若错误含拒绝访问，明确提示注册表已成功则不报错
  if (reg.ok) return reg;
  return { ok: false, error: (msg || "schtasks failed").slice(0, 800), stdout: r.stdout, stderr: r.stderr };
}

async function winRegDisable() {
  const r = await execAsync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", TASK_NAME, "/f"]);
  if (!r.err) return { ok: true, stdout: r.stdout };
  const msg = r.stderr || r.stdout || "";
  if (/ERROR.*cannot find/i.test(msg) || /找不到/.test(msg) || /未找到/.test(msg)) return { ok: true, stdout: "already disabled" };
  return { ok: false, error: msg.slice(0, 800) };
}

async function winDisable() {
  let r = await execAsync("schtasks", ["/delete", "/tn", TASK_NAME, "/f"]);
  let okSchtasks = !r.err;
  let regR = await winRegDisable();
  if (okSchtasks || regR.ok) return { ok: true, stdout: (r.stdout || "") + (regR.stdout || "") };
  const msg = r.stderr || r.stdout || "";
  if (/ERROR.*cannot find/i.test(msg) || /找不到/.test(msg)) {
    if (regR.ok) return { ok: true, stdout: "already disabled" };
  }
  // 若两者都失败但注册表已清，也算成功
  if (regR.ok) return { ok: true };
  return { ok: false, error: (msg || regR.error || "").slice(0, 800) };
}

async function winStatus() {
  const q = await winQuery();
  if (!q.exists) return { enabled: false, detail: "未启用（无任务计划也无注册表）" };
  if (q.method === "registry") {
    const m = q.raw.match(/mslxdff\s+REG_SZ\s+(.+)/);
    return { enabled: true, detail: `已启用 · 注册表 HKCU\\Run（登录即起，无需管理员）`, taskToRun: m ? m[1].trim() : "", raw: q.raw };
  }
  const m = q.raw.match(/Status:\s*(.+)/i) || q.raw.match(/状态:\s*(.+)/);
  const last = q.raw.match(/Last Run Result:\s*(.+)/i) || q.raw.match(/上次运行结果:\s*(.+)/);
  const tr = q.raw.match(/Task To Run:\s*(.+)/i) || q.raw.match(/要运行的任务:\s*(.+)/);
  return {
    enabled: true,
    detail: `已启用 · ${m ? m[1].trim() : "Ready"}${last ? ` · 上次结果 ${last[1].trim()}` : ""}`,
    taskToRun: tr ? tr[1].trim() : "",
    raw: q.raw,
  };
}

// ---------- Linux: systemd user ----------
function systemdUnitPath() {
  return join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

function systemdUnitContent() {
  const node = nodePath();
  const script = scriptPath();
  return `[Unit]
Description=mslxdff daemon — OpenCode Free proxy
After=network.target

[Service]
Type=simple
Environment=MSLXDFF_DAEMON=1
ExecStart=${node} ${script} --daemon
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}


/**
 * 从 pid 文件原文算出「要不要等某个裸 daemon 退出」；null = 不等。
 * 自杀护栏①：pid 文件写的就是**本进程**时（daemon 自己 `writePid(process.pid)`），
 * 等它退出、再补一发 SIGKILL，就是等自己死 + 补自己一刀 —— 0.1.236 真机的死法之一。
 */
export function pickBareDaemonPid(raw, self = process.pid, isAlive = isPidAlive) {
  const n = Number(String(raw ?? "").trim().split("\n")[0]);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (n === self) return null;
  return isAlive(n) ? n : null;
}

/**
 * 把「端口持有者集合」拆成「可以杀的」+「自己也是持有者吗」—— 自杀护栏②的判据。
 * 为什么需要：`ss -lptn 'sport = :<port>'` 对本用户自己的进程会显示 pid，集合里必然有 self。
 * 旧代码第一圈 `continue` 跳过自己、第二圈**无差别 SIGKILL** ⇒ daemon 启动 4~5 秒后杀掉自己
 * （0.1.236 真机：errors.log 记 unexplained-kill、daemon.alive 停在 uptimeMs:0、
 * systemd unit 永远停在 disabled，下次裸跑继续循环）。
 * 返回的 selfWasHolder 供调用方决定要不要跑 `fuser -k <port>/tcp`：它按端口无差别杀，绕不过 self。
 */
export function partitionKillTargets(pids, self = process.pid) {
  const set = new Set();
  for (const p of pids || []) {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  const selfWasHolder = set.has(self);
  set.delete(self);
  return { targets: [...set], selfWasHolder };
}
async function linuxEnable() {
  // systemd --user 不可用时**什么都不清理**：先杀掉还能用的裸 daemon、再发现 systemd 起不来，
  // 等于用一次失败把服务弄死。只在 Linux 探测（macOS 也走本函数但没有 systemd，行为保持原样）。
  if (process.platform === "linux") {
    const probe = await execAsync("systemctl", ["--user", "show-environment"]);
    if (probe.err) {
      const why = (probe.stderr || probe.stdout || probe.err.message || "").slice(0, 200);
      return { ok: false, error: `systemd --user 不可用（${why || "systemctl 失败"}）：未做任何清理，裸 daemon 继续运行` };
    }
  }
  const unit = systemdUnitPath();
  try {
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, systemdUnitContent(), "utf8");
  } catch (e) {
    return { ok: false, error: `write unit failed: ${e.message}` };
  }
  // best-effort: enable linger so user service survives logout/SSH disconnect
  let lingerRes = null;
  try {
    let who = "";
    try { who = userInfo().username; } catch {}
    who = who || process.env.USER || process.env.USERNAME || process.env.LOGNAME || "";
    if (who) {
      const lr = await execAsync("loginctl", ["enable-linger", who]);
      lingerRes = lr.err ? (lr.stderr || lr.stdout || lr.err.message || "").slice(0, 200) : "ok";
    }
  } catch {}
  // 先 daemon-reload + enable，再清理裸 daemon：顺序反过来，一旦清理途中进程没了（旧版就是「杀自己」），
  // unit 会永远停在 disabled，下一次裸跑又走进来 —— 这正是 0.1.236 的自我循环。
  let r = await execAsync("systemctl", ["--user", "daemon-reload"]);
  if (r.err) return { ok: false, error: (r.stderr || r.stdout).slice(0, 500) };
  r = await execAsync("systemctl", ["--user", "enable", SERVICE_NAME]);
  if (r.err) return { ok: false, error: (r.stderr || r.stdout).slice(0, 500) };
  // stop bare detached daemon that may hold the port, let systemd take over (best-effort, wait for port free)
  try {
    // 路径相对**本文件**解析：本文件在 src/ 下，daemon.js 与 server.js 都在 src/ 内。
    // 旧写的 `../daemon.js` / `../server.js` 从 src/ 出发指向仓库根 —— 两处都不存在，
    // 整个「停裸 daemon → 等端口释放 → 让 systemd 接管」的分支被后面的 catch {} 静默吞掉、从未执行过。
    const { stopDaemon } = await import("./daemon.js");
    const { resolvePort } = await import("./server.js");
    const port = resolvePort();
    const pidFile = join(daemonDir(), "daemon.pid"); // 权威路径，尊重 MSLXDFF_DAEMON_DIR（旧代码硬编码 ~/.config ⇒ 清错 pid 文件）
    const { existsSync: exists2, readFileSync: read2 } = await import("node:fs");
    let pidToWait = null;
    try {
      if (exists2(pidFile)) {
        const raw = read2(pidFile, "utf8");
        // 自杀护栏①：pid 文件写的就是本进程时（daemon 自己 writePid）既不能等、更不能杀
        pidToWait = pickBareDaemonPid(raw);
      }
    } catch {}
    try { stopDaemon(); } catch {}
    // ensure bare daemon really exits (SIGTERM -> SIGKILL)
    for (let i = 0; i < 15; i++) {
      if (pidToWait && pidToWait !== process.pid && isPidAlive(pidToWait)) {
        if (i === 7 && pidToWait !== process.pid) try { process.kill(pidToWait, "SIGKILL"); } catch {}
        await new Promise((r2) => setTimeout(r2, 200));
      } else break;
    }
    // robust: scan ss for any holder of :port (covers stale pidFile, fuser not installed)
    const killHolders = async () => {
      let killed = 0;
      // 自己是不是端口持有者（决定要不要跑 fuser -k）；探测失败时按「是」处理，宁可不杀
      let selfWasHolder = false;
      try {
        const r = await execAsync("ss", ["-lptn", `sport = :${port}`]);
        const out = r.stdout || "";
        const re = /pid=(\d+)/g;
        let m;
        const pids = new Set();
        while ((m = re.exec(out))) pids.add(Number(m[1]));
        // fallback: full ss if sport filter empty (busybox ss)
        if (!pids.size) {
          const r2 = await execAsync("ss", ["-lptn"]);
          const out2 = r2.stdout || "";
          // only consider lines containing :port
          for (const line of out2.split("\n")) {
            if (!line.includes(`:${port}`)) continue;
            const re2 = /pid=(\d+)/g;
            let m2;
            while ((m2 = re2.exec(line))) pids.add(Number(m2[1]));
          }
        }
        // 自杀护栏②：ss 会把自己报成端口持有者 ⇒ 剔除 self，SIGKILL/fuser 一律不打自己
        const part = partitionKillTargets(pids, process.pid);
        selfWasHolder = part.selfWasHolder;
        for (const p of pids) {
          if (p === process.pid) continue;
          if (p === readPid()) { try { writeExitMarker(daemonDir(), { reason: "autostart-cleanup", prevPid: p, prevVersion: null, byPid: process.pid }); } catch {} }
          try { process.kill(p, "SIGTERM"); killed++; } catch {}
        }
        if (killed) await new Promise((r2) => setTimeout(r2, 400));
        for (const p of part.targets) {
          try { if (isPidAlive(p)) process.kill(p, "SIGKILL"); } catch {}
        }
      } catch { selfWasHolder = true; } // ss 探测失败 ⇒ 谁占着端口不清楚，fuser 一律不开火
      // fuser as extra best-effort (may not exist)
      if (!selfWasHolder) { try { await execAsync("fuser", ["-k", `${port}/tcp`]); } catch {} }
      return killed;
    };
    await killHolders();
    // stop any leftover systemd instance before start (avoid double)
    try { await execAsync("systemctl", ["--user", "stop", SERVICE_NAME]); } catch {}
    // wait for :port to be free (ss probe)
    for (let i = 0; i < 20; i++) {
      const chk = await execAsync("ss", ["-ltn"]);
      if (!chk.stdout.includes(`:${port}`)) break;
      if (i === 6 || i === 12) await killHolders();
      await new Promise((r2) => setTimeout(r2, 250));
    }
  } catch {}
  r = await execAsync("systemctl", ["--user", "start", SERVICE_NAME]);
  // Verify actually active; if not, surface journal hint
  const chk = await execAsync("systemctl", ["--user", "is-active", SERVICE_NAME]);
  const active = !chk.err && /active/i.test(chk.stdout);
  if (!active) {
    const st = await execAsync("systemctl", ["--user", "status", SERVICE_NAME, "--no-pager", "-l"]);
    const hint = (st.stdout || st.stderr || r.stderr || r.stdout || "").slice(0, 600);
    return { ok: false, error: `start failed (not active): ${hint || "check journalctl --user -u mslxdff"}`, unit, linger: lingerRes };
  }
  return { ok: true, method: "systemd:user", unit, linger: lingerRes };
}

async function linuxDisable() {
  await execAsync("systemctl", ["--user", "disable", SERVICE_NAME]);
  await execAsync("systemctl", ["--user", "stop", SERVICE_NAME]);
  try { rmSync(systemdUnitPath(), { force: true }); } catch {}
  await execAsync("systemctl", ["--user", "daemon-reload"]);
  return { ok: true };
}

async function linuxStatus() {
  const unit = systemdUnitPath();
  const exists = existsSync(unit);
  if (!exists) return { enabled: false, detail: "未启用（无 systemd user unit）" };
  const r = await execAsync("systemctl", ["--user", "is-enabled", SERVICE_NAME]);
  const enabled = !r.err && /enabled/i.test(r.stdout);
  const r2 = await execAsync("systemctl", ["--user", "is-active", SERVICE_NAME]);
  const active = !r2.err && /active/i.test(r2.stdout);
  return { enabled, detail: `${enabled ? "已启用" : "已禁用"} · ${active ? "运行中" : "未运行"} · ${unit}`, unit };
}

// ---------- facade ----------
export async function enableAutostart() {
  if (isWin()) return winEnable();
  return linuxEnable();
}

export async function disableAutostart() {
  if (isWin()) return winDisable();
  return linuxDisable();
}

export async function getAutostartStatus() {
  if (isWin()) return winStatus();
  return linuxStatus();
}

export function autostartHelp() {
  if (isWin()) return `Windows: schtasks 任务 "mslxdff"（ONLOGON，最高权限，当前用户登录即自启）`;
  return `Linux: systemd user unit ~/.config/systemd/user/mslxdff.service`;
}
