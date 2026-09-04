import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import os from "node:os";

// TOML 字符串：含反斜杠（Windows 路径）时用字面单引号，避免转义被吃
function tomlStr(s) {
  const v = String(s);
  if (v.includes("\\") && !v.includes("'")) return `'${v}'`;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// auth 命令解析：Codex 起子进程不保证继承终端 PATH，所以不用裸 `mslxdff`，
// 而用绝对路径 node + 绝对路径脚本（当前进程即 mslxdff 本体，最可信）。
export function buildAuthCommand({ execPath = process.execPath, argv1 = process.argv[1], cwd = process.cwd() } = {}) {
  const script = argv1 ? (isAbsolute(argv1) ? argv1 : resolve(cwd, argv1)) : "";
  if (execPath && script && /mslxdff(\.js)?$/i.test(script)) {
    try { if (existsSync(script)) return { command: execPath, args: [script, "-showtoken"] }; } catch {}
  }
  return { command: "mslxdff", args: ["-showtoken"] }; // 兜底：走 PATH
}

// Codex/ChatGPT 三端共用 ~/.codex/config.toml：自定义 provider 指向本地网关。
export function codexConfigPath() {
  const home = process.env.CODEX_HOME;
  if (typeof home === "string" && home.trim()) return join(home.trim(), "config.toml");
  return join(os.homedir(), ".codex", "config.toml");
}

// 顶层 key = "value" 行：有则替换，无则追加
function upsertTopKey(lines, key, value) {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const line = `${key} = "${value}"`;
  const idx = lines.findIndex((l) => re.test(l) && !l.trim().startsWith("#"));
  if (idx >= 0) {
    if (lines[idx].trim() === line) return { lines, changed: false };
    lines[idx] = line;
    return { lines, changed: true };
  }
  // 插到首个 [section] 之前（顶层区），无 section 则末尾追加
  const secIdx = lines.findIndex((l) => /^\s*\[/.test(l));
  if (secIdx >= 0) lines.splice(secIdx, 0, line);
  else { if (lines.length && lines[lines.length - 1].trim()) lines.push(""); lines.push(line); }
  return { lines, changed: true };
}

// [model_providers.mslxdff] 整段替换（段从表头到下个 ^[ 或 EOF），无则追加
function upsertProviderSection(lines, section) {
  const head = "[model_providers.mslxdff]";
  const authHead = "[model_providers.mslxdff.auth]";
  let start = lines.findIndex((l) => l.trim() === head);
  const main = [head, ...section.main];
  const auth = ["[model_providers.mslxdff.auth]", ...section.auth];
  const full = [...main, "", ...auth];
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      // 自家子段（[model_providers.mslxdff.*]）不算边界，一并替换
      if (/^\s*\[/.test(lines[i]) && !t.startsWith("[model_providers.mslxdff.")) { end = i; break; }
    }
    const old = lines.slice(start, end).join("\n").trim();
    if (old === full.join("\n").trim()) return { lines, changed: false };
    lines.splice(start, end - start, ...full);
    return { lines, changed: true };
  }
  if (lines.length && lines[lines.length - 1].trim()) lines.push("");
  lines.push(...full);
  return { lines, changed: true };
}

export function buildCodexProvider({ port, auth } = {}) {
  const p = Number(port) || 8989;
  const a = auth || buildAuthCommand();
  return {
    main: [
      'name = "mslxdff local gateway"',
      `base_url = "http://127.0.0.1:${p}/v1"`,
      'wire_api = "responses"', // 显式锁定：现行 Codex 自定义 provider 只认 Responses
    ],
    // command-backed auth：调 mslxdff -showtoken 取 Bearer，token 永不落盘
    auth: [
      `command = ${tomlStr(a.command)}`,
      `args = [${a.args.map(tomlStr).join(", ")}]`,
      "timeout_ms = 5000",
      "refresh_interval_ms = 300000",
    ],
  };
}

export function syncToCodex({ id, port, file, auth } = {}) {
  const targetFile = file || codexConfigPath();
  const model = String(id || "").trim();
  if (!model) throw new Error("model id required");
  let text = "";
  try { text = readFileSync(targetFile, "utf8"); } catch { text = ""; }
  const lines = text ? text.split("\n") : [];
  let changed = false;
  let r = upsertTopKey(lines, "model", model);
  changed = changed || r.changed;
  r = upsertTopKey(r.lines, "model_provider", "mslxdff");
  changed = changed || r.changed;
  r = upsertProviderSection(r.lines, buildCodexProvider({ port, auth }));
  changed = changed || r.changed;
  const next = r.lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  if (!changed && text === next) return { action: "updated", file: targetFile, id: model };
  mkdirSync(dirname(targetFile), { recursive: true });
  const tmp = `${targetFile}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, next, "utf8");
  try {
    renameSync(tmp, targetFile);
  } catch {
    try { writeFileSync(targetFile, next, "utf8"); } catch {}
  }
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
  return { action: text ? "updated" : "inserted", file: targetFile, id: model };
}
