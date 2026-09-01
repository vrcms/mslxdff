import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
ExecStart=${node} ${script}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

async function linuxEnable() {
  const unit = systemdUnitPath();
  try {
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, systemdUnitContent(), "utf8");
  } catch (e) {
    return { ok: false, error: `write unit failed: ${e.message}` };
  }
  let r = await execAsync("systemctl", ["--user", "daemon-reload"]);
  if (r.err) return { ok: false, error: (r.stderr || r.stdout).slice(0, 500) };
  r = await execAsync("systemctl", ["--user", "enable", SERVICE_NAME]);
  if (r.err) return { ok: false, error: (r.stderr || r.stdout).slice(0, 500) };
  // 可选立即拉起（不强求）
  await execAsync("systemctl", ["--user", "start", SERVICE_NAME]);
  return { ok: true, method: "systemd:user", unit };
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
