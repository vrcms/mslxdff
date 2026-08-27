import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { defaultStateFile } from "../state.js";
import { CHAT_HISTORY_MAX_CHARS } from "./config.js";

function histFile() {
  const base = process.env.MSLXDFF_CHAT_HISTORY || join(dirname(defaultStateFile()), "chat-history.json");
  return base;
}

export function loadHistory() {
  try {
    if (!existsSync(histFile())) return [];
    const raw = readFileSync(histFile(), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveHistory(arr) {
  try {
    const f = histFile();
    mkdirSync(dirname(f), { recursive: true });
    // 裁到最近 60 条，避免文件爆炸
    const slim = arr.slice(-60);
    writeFileSync(f, JSON.stringify(slim, null, 2));
  } catch {}
}

export function clearHistory() {
  saveHistory([]);
}

export function histPath() { return histFile(); }

export function estimateChars(messages) {
  let n = 0;
  for (const m of messages) {
    n += String(m.content || "").length;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
    if (m.tool_call_id) n += 200;
  }
  return n;
}

export function needsCompress(messages) {
  return estimateChars(messages) > CHAT_HISTORY_MAX_CHARS;
}
