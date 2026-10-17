import { appendFileSync, readFileSync, mkdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { appendFile, stat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import { defaultStateFile } from "./state.js";
import { fmtShanghaiYMDHMS } from "./time.js";

// 日志桶体积上限。events.log 是排查主入口（`-log`/`-debug` 都读它），1MB ≈ 1000 行
// ≈ 3 分钟窗口，事后回溯基本不可用；同时旧的 `slice(-100)` 回退策略与 1MB 阈值严重不匹配
// ——一次裁剪丢弃 90% 容量（实测 1043 行 → 99 行）。阈值提到 4MB、回退按字节保留末尾 3/4，
// 两者配平后覆盖窗口约 10 倍于改前，且不再有断崖。
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_RATIO = 3 / 4;

export function logDir() {
  return process.env.MSLXDFF_DAEMON_DIR || dirname(defaultStateFile());
}

export function callsFile() {
  return join(logDir(), "calls.log");
}

export function errorsFile() {
  return join(logDir(), "errors.log");
}

export function eventsFile() {
  return join(logDir(), "events.log");
}

export function timelineFile() {
  return join(logDir(), "timeline.log");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/**
 * 按字节从尾部回退（不截半行）：累积整行直到超出预算，丢弃更早的行。
 * 用 `lines.slice(-N)` 之类的**行数**回退无法与**字节**阈值配平——行有长有短（events 行含 detail
 * 对象，实测均值 ~1KB），固定行数等于固定容量，一次裁剪就是断崖。
 */
function keepTailByBytes(text, maxBytes) {
  const limit = Math.max(1, Math.floor(maxBytes * KEEP_RATIO));
  if (Buffer.byteLength(text) <= limit) return text;
  const lines = text.split("\n");
  let bytes = 0;
  let i = lines.length - 1;
  for (; i >= 0; i--) {
    const b = Buffer.byteLength(lines[i]) + 1;
    if (bytes + b > limit) break;
    bytes += b;
  }
  // 至少保留最后一条：单行本身超过 limit 时（超大 detail/堆栈）上面的循环会一路退到第一条内容行之前，
  // 返回空串 = 整个日志被清空，比截断更糟（一次丢掉全部历史，且看起来像"日志坏了"）。
  // 判据是「保留结果为空」而不是 `i === lines.length-1`：文件以换行结尾时 split 出来的最后一个元素是
  // 空串，`lines.length-1` 指向它，与真正的内容行不同（这一处曾写错，实测保底从未生效）。
  // 宁可让这一条略微超出预算，也要留住"最新发生了什么"。
  const kept = lines.slice(i + 1).join("\n");
  if (!kept && lines.length) {
    const last = lines.filter((l) => l !== "");
    if (last.length) return last[last.length - 1];
  }
  return kept;
}

function trimIfOversized(file, maxBytes = MAX_BYTES) {
  try {
    const st = statSync(file);
    if (st.size <= maxBytes) return;
    writeFileSync(file, keepTailByBytes(readFileSync(file, "utf8"), maxBytes));
  } catch {
    // ignore
  }
}

async function trimIfOversizedAsync(file, maxBytes = MAX_BYTES) {
  try {
    const st = await stat(file);
    if (st.size <= maxBytes) return;
    await writeFile(file, keepTailByBytes(await readFile(file, "utf8"), maxBytes));
  } catch {
    // ignore
  }
}

function shouldSync(file) {
  if (process.env.MSLXDFF_LOGS_SYNC === "1") return true;
  if (process.env.MSLXDFF_DAEMON_DIR) {
    const dir = process.env.MSLXDFF_DAEMON_DIR;
    if (file.startsWith(dir)) return true;
  }
  // 显式 tmp 文件（所有 test 的 mkdtemp 前缀）走同步，保证 read-after-write 可见
  const low = file.toLowerCase();
  if (low.includes("mslxdff-") || low.includes("tmp") || low.includes("temp")) return true;
  // 非默认目录的文件一律同步（测试传入的临时路径）
  try {
    const def = logDir().toLowerCase();
    if (!low.startsWith(def)) return true;
  } catch {}
  return false;
}

function appendLine(file, entry) {
  ensureDir(dirname(file));
  const line = JSON.stringify({ ts: fmtShanghaiYMDHMS(new Date()), ...entry }) + "\n";
  if (shouldSync(file)) {
    appendFileSync(file, line);
    trimIfOversized(file);
    return;
  }
  // 线上异步：不阻塞事件循环
  appendFile(file, line)
    .catch(() => {})
    .then(() => trimIfOversizedAsync(file).catch(() => {}));
}

export function recentTimeline(n = 10, { file = timelineFile() } = {}) {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-n);
  } catch { return []; }
}

export function appendCall(entry, { file = callsFile() } = {}) {
  appendLine(file, entry);
}

export function appendError(entry, { file = errorsFile() } = {}) {
  appendLine(file, entry);
}

// Structured debug event stream: one JSON line per request/error/forward
// step, consumed live by `mslxdff -debug`.
export function appendEvent(entry, { file = eventsFile() } = {}) {
  appendLine(file, dropTalk(entry));
}

// events.log 是 debug 流（1MB 环形），对话正文只准进 talk/*.log。
// 单点剥掉 detail.talk：任何 relay 路径（含绕过 relay-pipeline 的 exhausted 收尾）都不会
// 把整段问答灌进 debug 行；留 talkChars 计数，debug 时仍看得出这轮有没有出字。
function dropTalk(entry) {
  const t = entry?.detail?.talk;
  if (!t) return entry;
  const detail = { ...entry.detail };
  delete detail.talk;
  detail.talkChars = (t.content || []).join("").length;
  detail.talkReasoningChars = (t.reasoning || []).join("").length;
  return { ...entry, detail };
}

export function recentEvents(n = 100, { file = eventsFile() } = {}) {
  return readLines(file).slice(-n);
}

function readLines(file) {
  try {
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    return text.split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function recentCalls(n = 5, { file = callsFile() } = {}) {
  return readLines(file).slice(-n);
}

export function lastError({ file = errorsFile() } = {}) {
  const lines = readLines(file);
  return lines.length ? lines[lines.length - 1] : null;
}

export function recentErrors(n = 5, { file = errorsFile() } = {}) {
  return readLines(file).slice(-n);
}

export function appendTimeline(entry, { file = timelineFile() } = {}) {
  const line = `${fmtShanghaiYMDHMS(new Date())} ${String(entry || "")}\n`;
  ensureDir(dirname(file));
  if (shouldSync(file)) {
    appendFileSync(file, line);
    trimIfOversized(file);
    return;
  }
  appendFile(file, line).catch(() => {}).then(() => trimIfOversizedAsync(file).catch(() => {}));
}
