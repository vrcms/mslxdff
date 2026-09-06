// DeepSeek 排障日志：落 ~/.config/mslxdff/deepseek-debug.log（5MB 轮转），定位空流/风控/协议异常
// 解决后统一摘除调用点（用户授权全量日志）
import { appendFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEBUG_FILE = process.env.MSLXDFF_DEEPSEEK_DEBUG_FILE
  || join(homedir(), ".config", "mslxdff", "deepseek-debug.log");
const MAX_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    if (statSync(DEBUG_FILE).size > MAX_BYTES) unlinkSync(DEBUG_FILE);
  } catch {}
}

function write(line) {
  try {
    rotateIfNeeded();
    appendFileSync(DEBUG_FILE, line + "\n");
  } catch {}
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

// 结构化一行：dsDebug("completion", { model, status, ... })
export function dsDebug(scope, fields = {}) {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  write(`[${ts()}] [${scope}] ${pairs.join(" ")}`);
}

// 原始文本截断记录（SSE chunk / 聚合全文）
export function dsDump(scope, label, text, limit = 2000) {
  const s = String(text ?? "");
  write(`[${ts()}] [${scope}] ${label} (${s.length}B) >>> ${s.slice(0, limit).replace(/\n/g, "\\n")}<<<`);
}

export function dsError(scope, err) {
  write(`[${ts()}] [${scope}] ERROR ${String(err?.stack || err?.message || err).slice(0, 800)}`);
}

export { DEBUG_FILE };
