#!/usr/bin/env node
// agent 回路语料（<日志根>/talk/full/*.jsonl）只读视图 + 「回路体检」读数。
// 用法：node scripts/talkfull-view.js [--file <path>] [--model <供应商/模型id>] [--session <key>] [--tail N] [--all]
// 只读契约：全程只用 readFileSync / statSync / readdirSync —— 不建目录、不写文件、不改权限、不 import src/（避免把运行时模块拖进脚本）。
// 体检读数放读侧（design D12）：判据阈值全部置顶、随输出打印，缺判据不下结论。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// —— 判据常量（spec「视图给出回路体检读数」/ D12：阈值置顶并随输出打印）——
export const TH = {
  REPEAT_MIN: 3,            // ② 同 name + 同 arguments（空白归一后 sha1 尾 8）出现次数 ≥ 此值即点名
  DEAD_STREAK_MIN: 2,       // ③ 连续「零 toolCalls 且零正文」的轮数 ≥ 此值即点名区间
  LOOP_HINT_MIN: 3,         // ④ 同会话思考里命中循环措辞的轮数 ≥ 此值即点名
  REASONING_RATIO_MIN: 0.9, // ⑤ finishReason=length 且 思考字符 /(思考+正文) ≥ 此值即点名
  DESC_CAP: 200,            // 工具 description 呈现上限（超出打省略号）
  ARG_CAP: 120,             // 工具调用 arguments 摘要长度上限
  BLOCK_CAP: 2000,          // 单段正文/思考默认截断长度（--all 打全文）
  TAIL_DEFAULT: 50,         // 未给 --tail/--all 时，每会话只渲染最后 N 条
  LOOP_HINT_WORDS: ["继续", "重试", "再试一次", "再来一次", "重新尝试", "上一次失败", "还是失败", "换个思路", "again", "retry", "previous attempt"],
};

const SUBDIR = join("talk", "full");
const SUFFIX = "-talkfull.jsonl";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const intOrNull = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
const N = "\u0000";

// —— 日志根：MSLXDFF_DAEMON_DIR ＞ state.json 同目录 ＞ ~/.config/mslxdff/（src/logs.js + src/state/store.js 同口径，此处独立实现）——
function isTestEnv(env) {
  if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) return true;
  if (env.MSLXDFF_STATE_FILE && String(env.MSLXDFF_STATE_FILE).includes("mslxdff-test")) return true;
  return false;
}
export function logRoot(env = process.env) {
  const d = String(env.MSLXDFF_DAEMON_DIR || "").trim();
  if (d) return d;
  const sf = String(env.MSLXDFF_STATE_FILE || "").trim();
  if (sf) return dirname(sf);
  if (isTestEnv(env)) return join(tmpdir(), "mslxdff-test-state");
  return join(homedir(), ".config", "mslxdff");
}
export function talkFullDir(env = process.env) { return join(logRoot(env), SUBDIR); }

// —— 文件名：与 src/talk-log.js talkLogName 同一规则，只把尾缀换成 -talkfull.jsonl（不 import，规则在此等价重写）——
export function talkFullFileName(model) {
  const s = String(model || "unknown").trim().toLowerCase();
  const segs = s.includes("/") ? s.split("/").filter((x) => x && x !== "unknown") : [s];
  const safe = segs.join("-").replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 180);
  return `${safe || "unknown"}${SUFFIX}`;
}

// —————————————————————————— 读侧解析 ——————————————————————————

/** 逐行 JSON.parse；坏行收集不致命。空行/纯空白行直接跳过（不计坏行）。
 *  尾行若无换行符且解析失败 → 判为「daemon 正在追加的半行」（写侧 appendFile 保证完整行必带 \\n），
 *  单独记账、不混进坏行：否则一次并发读取会被误报成「语料出现不可解析行」。 */
export function parseRecords(text) {
  const src = String(text == null ? "" : text);
  const records = [];
  const bad = [];
  let halfLine = null;
  const endsWithNewline = src === "" || /\n$/.test(src);
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const isTail = i === lines.length - 1 && !endsWithNewline;
    const drop = (reason) => {
      const rec = { line: i + 1, reason, preview: line.slice(0, 80) };
      if (isTail) halfLine = rec; else bad.push(rec);
    };
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      drop(String(e && e.message ? e.message : e).slice(0, 120));
      return;
    }
    if (!isObj(obj)) { drop("顶层不是对象"); return; }
    Object.defineProperty(obj, "__seq", { value: records.length, enumerable: false, configurable: true });
    records.push(obj);
  });
  return { records, bad, badLines: bad.length, halfLine, totalLines: lines.length };
}

export function tsMs(r) {
  if (typeof r.ts === "number" && Number.isFinite(r.ts)) return r.ts;
  if (typeof r.ts === "string") {
    if (/^\d+$/.test(r.ts)) return Number(r.ts);
    const p = Date.parse(r.ts);
    if (Number.isFinite(p)) return p;
  }
  if (typeof r.time === "string") { const p = Date.parse(r.time.replace(" ", "T")); if (Number.isFinite(p)) return p; }
  return null;
}
function tsDisplay(r) {
  if (typeof r.time === "string" && r.time.trim()) return r.time.trim();
  const ms = tsMs(r);
  if (ms != null) { const d = new Date(ms); return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 19) : String(r.ts); }
  return "时间未知";
}
/** 按 ts 正序（缺 ts 的排到最后，按落盘序），原地不动入参。 */
export function sortRecords(records) {
  return [...records].sort((a, b) => {
    const ta = tsMs(a), tb = tsMs(b);
    if (ta == null && tb == null) return seq(a) - seq(b);
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta - tb || seq(a) - seq(b);
  });
}
function seq(r) { return typeof r.__seq === "number" ? r.__seq : 0; }

/** 按 sessionKey 分组（缺 key 归入 "(无 sessionKey)"），组内按 ts 正序。 */
export function groupSessions(records) {
  const map = new Map();
  for (const r of sortRecords(records)) {
    const k = typeof r.sessionKey === "string" && r.sessionKey.trim() ? r.sessionKey.trim() : "(无 sessionKey)";
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

// —————————————————————————— messages 工具 ——————————————————————————

function contentPartsLen(c) {
  if (c == null) return 0;
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) return c.reduce((a, p) => a + contentPartsLen(isObj(p) ? (p.text ?? p.content) : p), 0);
  if (isObj(c)) return JSON.stringify(c).length;
  return String(c).length;
}
function contentText(m) {
  const c = m && m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (isObj(p) ? String(p.text ?? p.content ?? `[${p.type ?? "part"}]`) : String(p))).join("\n");
  return c == null ? "" : JSON.stringify(c);
}
function callsSig(calls) {
  if (!Array.isArray(calls) || !calls.length) return "";
  return calls.map((c) => `${(isObj(c) && isObj(c.function) ? c.function.name : c?.name) || "?"}|${normArgs(isObj(c) && isObj(c.function) ? c.function.arguments : c?.arguments)}`).join(";");
}
function msgKey(m) {
  if (!isObj(m)) return `raw:${JSON.stringify(m)}`;
  if (isDegradedMsg(m)) return `deg:${m.i ?? ""}:${m.role ?? ""}:${m.chars ?? ""}:${m.hash ?? ""}`;
  return [`r:${m.role ?? "?"}`, `c:${contentText(m)}`, `t:${callsSig(m.tool_calls)}`, `n:${m.name ?? ""}`, `i:${m.tool_call_id ?? ""}`].join(N);
}
/** 降级态（D4）：messages 被换成 { i, role, chars, hash, head } 结构摘要。 */
export function isDegradedMsg(m) {
  return isObj(m) && m.content === undefined && (m.hash !== undefined || m.head !== undefined)
    && typeof m.role === "string" && (typeof m.chars === "number" || typeof m.chars === "string");
}
export function isDegradedMessages(msgs) {
  return Array.isArray(msgs) && msgs.length > 0 && msgs.every(isDegradedMsg);
}
function messagesOf(r) { return Array.isArray(r?.request?.messages) ? r.request.messages : null; }
function historyChars(r) {
  const ms = messagesOf(r);
  if (!ms) return null;
  if (isDegradedMessages(ms)) return ms.reduce((a, m) => a + (intOrNull(m.chars) ?? 0), 0);
  return ms.reduce((a, m) => a + contentPartsLen(isObj(m) ? m.content : m), 0);
}
function tailChars(msgs) { return (msgs || []).reduce((a, m) => a + contentPartsLen(isObj(m) ? m.content : m), 0); }

/** D5：与上一条做前缀 diff，只取新增尾巴（落盘不去重，读侧去重）。
 *  cur 不是数组时**绝不给「本轮新增 0 条」这种假读数**，交回调用方按 unavailable 渲染。 */
export function prefixDiff(prevMsgs, curMsgs) {
  if (!Array.isArray(curMsgs)) return { added: null, same: 0, diverged: false, total: 0, unavailable: true, why: "messages 缺失或非数组" };
  const prev = Array.isArray(prevMsgs) ? prevMsgs : null;
  if (!prev) return { added: curMsgs, same: 0, diverged: false, total: curMsgs.length };
  let k = 0;
  while (k < prev.length && k < curMsgs.length && msgKey(prev[k]) === msgKey(curMsgs[k])) k++;
  return { added: curMsgs.slice(k), same: k, diverged: k < prev.length, total: curMsgs.length };
}

// —————————————————————————— 轮次视图模型 ——————————————————————————

function normArgs(a) {
  // 空白归一：arguments 是 JSON 串时先紧凑重排（pretty/compact 同参视为同一次调用），
  // 解析不了的才退回「空白折叠 + trim」；字符串值内部的空白原样保留，不产生假合并。
  if (a == null) return "";
  if (typeof a === "string") {
    try { return JSON.stringify(JSON.parse(a)); } catch { return a.replace(/\s+/g, " ").trim(); }
  }
  try { return JSON.stringify(a); } catch { return String(a).replace(/\s+/g, " ").trim(); }
}
const argHash8 = (s) => createHash("sha1").update(s).digest("hex").slice(-8);

function callsOf(r) {
  const list = Array.isArray(r?.response?.toolCalls) ? r.response.toolCalls : [];
  return list.filter(isObj).map((c) => {
    const fn = isObj(c.function) ? c.function : {};
    const name = String(fn.name || c.name || "(未命名工具)");
    const rawArgs = fn.arguments !== undefined ? fn.arguments : c.arguments;
    const norm = normArgs(rawArgs);
    // 参数缺失是「没有数据」，不是「参数逐字相同」：进同参桶会把 3 次无参调用断言成重复调用
    const argsMissing = rawArgs == null || norm === "";
    return { name, args: norm, argsMissing, hash: argsMissing ? "" : argHash8(norm), id: c.id != null ? String(c.id) : null, summary: norm ? norm.slice(0, TH.ARG_CAP) : "(无参数)" };
  });
}
function textOf(v) { return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 0); }
function reqBytesOf(r) { return intOrNull(r?.meta?.requestBytes); }
// 写侧二级降级（talk-full-redact.js composeLine）会把 response.reasoning/content 各 clip 到 2000 字，
// 于是「文本长度 < 真实长度」。读数一律取 max(文本长度, meta.*)，并标出被 clip，别把上限值当真值。
function reasoningCharsOf(r) {
  const len = textOf(r?.response?.reasoning).length;
  const m = intOrNull(r?.meta?.reasoningChars);
  return m == null ? len : Math.max(len, m);
}
function contentCharsOf(r) {
  const len = textOf(r?.response?.content).length;
  if (len === 0 && textOf(r?.response?.reasoning).length === 0 && !isTruncated(r)) return 0;
  // meta.responseChars 是桶的累计 n（思考+正文之和，见 src/talk-full.js:90），故正文要减掉思考
  const mc = intOrNull(r?.meta?.responseChars);
  const mr = intOrNull(r?.meta?.reasoningChars);
  const fromMeta = mc == null ? null : mr != null && mc >= mr ? mc - mr : mc;
  return fromMeta == null ? len : Math.max(len, fromMeta);
}
/** 响应侧文本比 meta 短 = 被写侧 clip 过，此时读数是上限值而非真实长度。 */
function respClipped(r) {
  const tLen = textOf(r?.response?.reasoning).length + textOf(r?.response?.content).length;
  const mc = intOrNull(r?.meta?.responseChars);
  const mr = intOrNull(r?.meta?.reasoningChars);
  if (mc == null && mr == null) return false;
  const total = mc != null ? mc : mr + textOf(r?.response?.content).length;
  return total > tLen;
}
const isTruncated = (r) => r?.meta?.truncated === true || r?.meta?.truncated === 1 || r?.meta?.truncated === "true";
const capOf = (r) => intOrNull(r?.meta?.cap);
// 写侧落的是数字（src/talk-full.js:84 `stream: body?.stream ? 1 : 0`）：先认 1/0，再兼容布尔
const streamMark = (v) => (v === 1 || v === true ? 1 : v === 0 || v === false ? 0 : "?");
// 耗时读数（ADR-0046 口径）：elapsedMs=本次上游尝试墙钟（新口径真值）；缺失（旧语料/降级）回落 meta.relayMs 并标注来源，
// 两值不同（hedge/缓冲重放）时另列 relayMs —— 「上游多久 vs 写给客户端多久」必须分得开。
function elapsedReadout(r) {
  const el = intOrNull(r?.elapsedMs);
  const rl = intOrNull(r?.meta?.relayMs);
  if (el != null) return rl != null && rl !== el ? `${el}ms（relayMs=${rl}ms）` : `${el}ms`;
  if (rl != null) return `${rl}ms（elapsedMs 缺失，回退 meta.relayMs=relay 计时）`;
  return "?";
}

/**
 * 一个会话的记录 → 轮次数组（渲染与体检共用，保证轮号一致）。
 * opts.windowCut：本窗口切掉了该会话的上一条 → 首轮**没有 diff 基线**。此时绝不能把整段历史
 *   当「本轮新增」，否则 ① 的「涨幅最大」会稳定假指向窗口首轮，读者得出「第 1 轮就暴涨」的错判。
 * opts.baselineDegraded：上一条是降级摘要 → 同样不能拿它当真消息比对（摘要数组永远对不上前缀）。
 * 任一轮降级/缺失只会让「紧接着的那一轮」失去基线，再往后又可比。
 */
function buildTurns(sessionRecords, opts = {}) {
  const recs = sortRecords(sessionRecords);
  let prevMsgs = null;
  let prevUnusable = opts.windowCut === true || opts.baselineDegraded === true;
  return recs.map((rec, i) => {
    const msgs = messagesOf(rec);
    const degraded = isDegradedMessages(msgs);
    const missing = msgs === null;
    const firstNoBaseline = i === 0 && prevUnusable;
    const unusable = degraded || missing || (i > 0 && prevUnusable) || firstNoBaseline;
    const why = degraded ? "该轮请求体已是结构摘要"
      : missing ? "messages 缺失或非数组"
      : firstNoBaseline ? (opts.baselineDegraded ? "上一条为降级摘要，本轮无 diff 基线" : "上一条不在本次渲染窗口内，本轮无 diff 基线")
      : "上一条为降级摘要，本轮无 diff 基线";
    const diff = unusable ? { added: null, same: 0, diverged: false, total: msgs ? msgs.length : 0, unavailable: true, why } : prefixDiff(prevMsgs, msgs);
    const st = Number(rec.status);
    const t = {
      idx: i + 1,
      rec,
      degraded,
      missing,
      truncated: isTruncated(rec),
      clipped: respClipped(rec),
      cap: capOf(rec),
      diff,
      tailChars: i === 0 || unusable ? null : (diff.added ? tailChars(diff.added) : null),
      historyChars: historyChars(rec),
      requestBytes: reqBytesOf(rec),
      reasoningChars: reasoningCharsOf(rec),
      contentChars: contentCharsOf(rec),
      status: rec.status == null || !Number.isFinite(st) ? null : Math.trunc(st),
      calls: callsOf(rec),
      finish: typeof rec.finishReason === "string" ? rec.finishReason : null,
    };
    prevMsgs = degraded || missing ? null : msgs;
    prevUnusable = degraded || missing;
    return t;
  });
}

// —————————————————————————— 回路体检（结构化读数，不打印） ————————————————

/** 五项读数（① 膨胀 ② 重复工具调用 ③ 连续零输出 ④ 思考循环 ⑤ length+思考吃满）。 */
export function healthReadings(records) {
  const turns = buildTurns(records);
  const h = TH;

  // ① 逐轮膨胀曲线
  const growth = turns.map((t) => ({
    turn: t.idx,
    time: tsDisplay(t.rec),
    requestBytes: t.requestBytes,
    historyChars: t.historyChars,
    addedChars: t.tailChars,
    degraded: t.degraded,
  }));
  let maxJump = null;
  for (const g of growth) {
    if (g.addedChars == null) continue;
    if (!maxJump || g.addedChars > maxJump.addedChars) maxJump = g;
  }
  if (maxJump) {
    const cur = maxJump.historyChars;
    const prev = growth[maxJump.turn - 2]?.historyChars;
    maxJump.prevHistoryChars = prev ?? null;
    maxJump.ratio = prev ? Number((cur / prev).toFixed(2)) : null;
  }

  // ② 重复工具调用
  const buckets = new Map();
  for (const t of turns) {
    for (const c of t.calls) {
      const key = `${c.name}${N}${c.hash}`;
      if (!buckets.has(key)) buckets.set(key, { name: c.name, argHash: c.hash, argSummary: c.summary, turns: [], reqs: [], count: 0 });
      const b = buckets.get(key);
      b.count++; b.turns.push(t.idx); const rq = String(t.rec?.reqId ?? "?"); if (!b.reqs.includes(rq)) b.reqs.push(rq);
    }
  }
  const repeats = [...buckets.values()].filter((b) => b.count >= h.REPEAT_MIN)
    .sort((a, b) => b.count - a.count);

  // ③ 连续零 toolCalls 且零正文——前置条件：status===200 且收尾不是工具轮。
  // 写侧对「带 messages 但上游失败」的轮也会落盘（src/talk-full.js:77 判据以 !msgs.length 开头），
  // 这些轮 response 三项全空但成因是报错：混进 streak 会把「上游挂了」读成「模型空转」。
  // 权威口径：CONTEXT.md「空轮 Empty turn」= 正常收尾且零输出；与 stream-scan.js isEmptyTurnDetail 同源。
  const TOOL_FINISH = new Set(["tool_calls", "function_call"]);
  const zeroOut = (t) => t.calls.length === 0 && t.contentChars === 0;
  const isDead = (t) => zeroOut(t) && Number(t.rec?.status) === 200 && !TOOL_FINISH.has(t.finish);
  const deadStreaks = [];
  const deadByError = [];
  let run = null;
  for (const t of turns) {
    if (isDead(t)) { if (!run) run = { from: t.idx, to: t.idx, length: 0, reasoningTurns: [], reqIds: [] }; run.to = t.idx; run.reasoningTurns.push(t.reasoningChars); const rq2 = String(t.rec?.reqId ?? "?"); if (!run.reqIds.includes(rq2)) run.reqIds.push(rq2); }
    else {
      if (run) { run.length = run.to - run.from + 1; if (run.length >= h.DEAD_STREAK_MIN) deadStreaks.push(run); run = null; }
      if (zeroOut(t) && (Number(t.rec?.status) !== 200 || TOOL_FINISH.has(t.finish))) deadByError.push(t.idx);
    }
  }
  if (run) { run.length = run.to - run.from + 1; if (run.length >= h.DEAD_STREAK_MIN) deadStreaks.push(run); }
  for (const s of deadStreaks) s.reasoningCharsTotal = s.reasoningTurns.reduce((a, b) => a + b, 0);
  for (const s of deadStreaks) s.reqCount = s.reqIds.length, delete s.reasoningTurns, delete s.reqIds;

  // ④ 思考循环信号：命中轮数只列读数；给「打转」结论必须命中轮**相邻成串**（连续 ≥ LOOP_HINT_MIN）。
  // 「重试/继续/retry」是本项目领域日常词（讨论重试策略的技术对话天然多轮命中），只数总数会误报（P1-6）。
  const re = new RegExp(h.LOOP_HINT_WORDS.map(escapeRe).join("|"), "gi");
  const hintTurns = [];
  for (const t of turns) {
    const text = textOf(t.rec?.response?.reasoning);
    if (!text) continue;
    const words = [...new Set([...text.matchAll(re)].map((m) => m[0].toLowerCase()))];
    if (words.length) hintTurns.push({ turn: t.idx, words, time: tsDisplay(t.rec) });
  }
  let hintRun = 0, hintStreak = 0;
  for (let i = 0; i < hintTurns.length; i++) {
    hintRun = i > 0 && hintTurns[i].turn === hintTurns[i - 1].turn + 1 ? hintRun + 1 : 1;
    if (hintRun > hintStreak) hintStreak = hintRun;
  }
  const loopHints = { hitTurns: hintTurns, count: hintTurns.length, maxAdjacent: hintStreak, triggered: hintStreak >= h.LOOP_HINT_MIN };

  // ⑤ 额度吃光形态
  const lengthTurns = [];
  for (const t of turns) {
    const denom = Math.max(1, t.reasoningChars + t.contentChars);
    const ratio = t.reasoningChars / denom;
    if (t.finish === "length") {
      lengthTurns.push({
        turn: t.idx, time: tsDisplay(t.rec), reasoningChars: t.reasoningChars, contentChars: t.contentChars,
        ratio: Number(ratio.toFixed(3)), triggered: ratio >= h.REASONING_RATIO_MIN,
        maxTokens: intOrNull(t.rec?.request?.params?.max_tokens) ?? intOrNull(t.rec?.request?.params?.max_completion_tokens),
        finish: t.finish,
      });
    }
  }
  const lengthEaten = lengthTurns.filter((x) => x.triggered);

  return {
    thresholds: { REPEAT_MIN: h.REPEAT_MIN, DEAD_STREAK_MIN: h.DEAD_STREAK_MIN, LOOP_HINT_MIN: h.LOOP_HINT_MIN, REASONING_RATIO_MIN: h.REASONING_RATIO_MIN, LOOP_HINT_WORDS: h.LOOP_HINT_WORDS },
    turnCount: turns.length,
    growth, maxJump, repeats, deadStreaks, deadByError, loopHints, lengthTurns, lengthEaten,
  };
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// —————————————————————————— 渲染 ——————————————————————————

const pad = (v, n) => String(v == null ? "-" : v).padStart(n);
function fmtInt(v) { return v == null ? "-" : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
export function fmtBytes(v) {
  if (v == null || !Number.isFinite(v)) return "未知";
  const kb = v / 1024;
  return kb >= 1024 ? `${v} B (${(kb / 1024).toFixed(1)} MB)` : `${v} B (${kb.toFixed(1)} KB)`;
}

function cap(text, all) {
  const s = String(text);
  if (all || s.length <= TH.BLOCK_CAP) return s;
  return `${s.slice(0, TH.BLOCK_CAP)}\n…（本段共 ${s.length} 字符，此处只贴 ${TH.BLOCK_CAP}；--all 打全文）`;
}
function block(label, text, all) {
  const body = cap(textOf(text), all);
  const rows = body.length ? body.split(/\r?\n/).map((l) => `  │ ${l}`) : ["  │ (空)"];
  return [`  ${label}`, ...rows].join("\n");
}
const preview = (s, n) => { const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

function renderTools(tools) {
  const list = Array.isArray(tools) ? tools.filter(isObj) : [];
  if (!list.length) return "  [工具清单] 本轮请求未声明 tools（或形状不认识）";
  const lines = [`  [工具清单] 共 ${list.length} 个（判据：name + description 前 ${TH.DESC_CAP} 字 + parameters 顶层键名，* 表示 required）`];
  for (const t of list) {
    const fn = isObj(t.function) ? t.function : t;
    const params = isObj(fn.parameters) ? fn.parameters : (isObj(t.input_schema) ? t.input_schema : {});
    const props = isObj(params.properties) ? Object.keys(params.properties) : [];
    const req = new Set(Array.isArray(params.required) ? params.required : []);
    const shape = props.length ? props.map((k) => (req.has(k) ? `${k}*` : k)).join(", ") : (params.type ? `type=${params.type}` : "(无顶层键)");
    lines.push(`  - ${fn.name ?? t.name ?? "(未命名)"}: ${preview(fn.description ?? t.description ?? "", TH.DESC_CAP) || "(无 description)"}`);
    lines.push(`      参数顶层键: ${shape}`);
  }
  return lines.join("\n");
}

function renderMessage(m, i, all) {
  if (!isObj(m)) return `  [${i}] (非对象消息) ${JSON.stringify(m)}`;
  if (isDegradedMsg(m)) {
    return `  [${i}] role=${m.role ?? "?"} (结构摘要，原文未落盘) chars=${m.chars ?? "?"} sha1尾8=${m.hash ?? "?"}\n  │ ${preview(m.head, 240) || "(无 head)"}`;
  }
  const role = String(m.role ?? "?");
  if (role === "system" || role === "developer") {
    return block(`[${i}] 【${role === "system" ? "系统提示全文（skill 正文在此）" : "开发者指令全文"}】`, contentText(m), all);
  }
  if (role === "tool") {
    const head = `  [${i}] [工具结果] tool_call_id=${m.tool_call_id ?? "?"}${m.name ? ` name=${m.name}` : ""}（${contentPartsLen(m.content)} 字符）`;
    return `${head}\n${cap(contentText(m), all).split(/\r?\n/).map((l) => `  │ ${l}`).join("\n")}`;
  }
  if (role === "assistant") {
    const tc = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    const rows = [`  [${i}] [助手（历史回显）] ${contentText(m).trim() || "(无正文)"}`];
    for (const c of tc) rows.push(`      ↳ 该轮曾调用 ${isObj(c.function) ? c.function.name : c?.name}: ${preview(isObj(c.function) ? c.function.arguments : c?.arguments, TH.ARG_CAP) || "(无参数)"}`);
    return rows.join("\n");
  }
  return `  [${i}] [${role === "user" ? "用户" : role}] ${cap(contentText(m), all)}`;
}

function flagsOf(turn) {
  const f = [];
  if (turn.degraded) f.push("⚠降级:该轮请求体已降级为结构摘要(messages={i,role,chars,hash,head})，原文未落盘、前缀diff不可用");
  if (turn.truncated) f.push("⚠truncated:内容触顶不完整");
  return f;
}

/** 一个会话 → 「体检」一节 + 逐轮正文（纯字符串，不 console.log）。 */
export function renderSession(records, opts = {}) {
  const all = !!opts.all;
  const turns = buildTurns(records);
  const out = [];
  if (!turns.length) return "（无可渲染记录）";
  const first = turns[0].rec;
  const models = [...new Set(turns.map((t) => t.rec.model).filter(Boolean))];
  out.push(`\n════ 会话 ${first.sessionKey || "(无 sessionKey)"} ｜ ${turns.length} 轮 ｜ 模型: ${models.join(", ") || "未知"} ｜ clientIp: ${first.clientIp || "?"} ｜ hops: ${first.hops ?? "?"} ════`);
  out.push(renderHealth(first, turns, healthReadings(turns.map((t) => t.rec))));

  let prevTools = null;
  for (const t of turns) {
    const r = t.rec;
    const flags = flagsOf(t);
    out.push(`\n── 轮 ${t.idx}/${turns.length} ─ ${tsDisplay(r)} ｜ ${r.model || "模型未知"} ｜ status=${r.status ?? "?"} ｜ 耗时=${elapsedReadout(r)} ｜ stream=${streamMark(r.stream)} ｜ finish=${t.finish || "?"} ｜ reqBytes=${fmtInt(t.requestBytes)}${flags.length ? `\n   ${flags.join("\n   ")}` : ""}`);
    const u = isObj(r.usage) ? r.usage : null;
    out.push(`   usage: ${u ? `prompt=${u.prompt_tokens ?? "?"} completion=${u.completion_tokens ?? "?"} total=${u.total_tokens ?? "?"}` : "未捕获"} ｜ 思考=${t.reasoningChars} 字符 ｜ 正文=${t.contentChars} 字符 ｜ 工具调用=${t.calls.length} 次 ｜ reqId=${r.reqId || "?"} ｜ via=${r.via || "?"} ｜ account=${r.account || "?"} ｜ pick=${typeof r.pick === "object" && r.pick ? JSON.stringify(r.pick) : (r.pick ?? "?")}`);

    const msgs = messagesOf(r) || [];
    if (t.idx === 1) {
      out.push(`   [请求侧] 本会话首条完整呈现：${msgs.length} 条消息（${fmtInt(t.historyChars)} 字符）+ tools 清单，后续轮只打前缀 diff 的新增尾巴（design D5）`);
      for (let i = 0; i < msgs.length; i++) out.push(renderMessage(msgs[i], i + 1, all));
      out.push(renderTools(r.request?.tools));
    } else if (t.diff.unavailable) {
      out.push(`   [请求侧] 降级态结构摘要 ${msgs.length} 条（${fmtInt(t.historyChars)} 字符），无法与上一条做前缀 diff —— 下表逐条列出摘要形状内容`);
      for (let i = 0; i < msgs.length; i++) out.push(renderMessage(msgs[i], i + 1, all));
    } else {
      const added = t.diff.added;
      out.push(`   [请求侧] 与上一条前缀 diff：共享 ${t.diff.same} 条（已在前面轮次呈现，不重复）→ 本轮新增 [+${added.length} 条]${t.diff.diverged ? " ｜ ⚠历史不共享前缀（客户端裁剪/改写过历史，被裁部分不再出现）" : ""}`);
      for (let i = 0; i < added.length; i++) out.push(renderMessage(added[i], t.diff.same + i + 1, all));
    }
    const names = (Array.isArray(r.request?.tools) ? r.request.tools : []).map((x) => (isObj(x.function) ? x.function.name : x?.name)).filter(Boolean).join(",");
    if (t.idx > 1 && names !== (prevTools ?? names)) out.push(`   [工具清单] ⚠与首条不同（本轮生效 ${r.request?.tools?.length ?? 0} 个）：${preview(names, 300)}`);
    if (prevTools === null) prevTools = names;

    out.push(block(`[模型思考]（${t.reasoningChars} 字符）`, textOf(r.response?.reasoning), all));
    out.push(block(`[模型正文]（${t.contentChars} 字符）`, textOf(r.response?.content), all));
    if (t.calls.length) {
      const rows = [`   [工具调用] ${t.calls.length} 次`];
      for (const c of t.calls) rows.push(`     → ${c.name} 参数=${c.summary}${c.id ? ` (call_id=${c.id})` : ""} [args sha1尾8=${c.hash}]`);
      out.push(rows.join("\n"));
    } else {
      out.push("   [工具调用] 0 次");
    }
  }
  return out.join("\n");
}

function renderHealth(rec, turns, rd) {
  const L = [];
  L.push("\n┌────────────────────── 回路体检（判据阈值见每节；读侧派生，design D12）──────────────────────");
  L.push(`│ 样本：${turns.length} 轮（${tsDisplay(rec)} 起）｜ 阈值 REPEAT_MIN=${rd.thresholds.REPEAT_MIN} DEAD_STREAK_MIN=${rd.thresholds.DEAD_STREAK_MIN} LOOP_HINT_MIN=${rd.thresholds.LOOP_HINT_MIN} REASONING_RATIO_MIN=${rd.thresholds.REASONING_RATIO_MIN}`);

  // ①
  L.push("│");
  L.push("│ ① 上下文膨胀曲线（判据：新增字符 = 本轮 messages 与上一条前缀 diff 后尾巴的文本字符数；总长 = 本轮全量历史文本字符数；requestBytes 取 meta.requestBytes）");
  L.push("│    轮  requestBytes  历史字符    本轮新增");
  for (const g of rd.growth) {
    const mark = rd.maxJump && g.turn === rd.maxJump.turn ? "  ← 涨幅最大" : "";
    L.push(`│  ${String(g.turn).padStart(4)}  ${pad(fmtInt(g.requestBytes), 12)}  ${pad(fmtInt(g.historyChars), 10)}  ${pad(g.addedChars == null ? (g.degraded ? "n/a(降级)" : "n/a") : fmtInt(g.addedChars), 10)}${mark}`);
  }
  if (rd.maxJump) L.push(`│  → 涨幅最大：轮 ${rd.maxJump.turn}（新增 ${fmtInt(rd.maxJump.addedChars)} 字符；历史 ${fmtInt(rd.maxJump.prevHistoryChars)} → ${fmtInt(rd.maxJump.historyChars)}${rd.maxJump.ratio ? `，×${rd.maxJump.ratio}` : ""}）`);
  else L.push("│  → 无可比新增（全部轮次均为降级摘要或无 messages），涨幅读数不给结论");

  // ②
  L.push("│");
  L.push(`│ ② 重复工具调用（判据：同 name + 同 arguments —— arguments 可 JSON.parse 就紧凑重排、不能就折叠空白，取 sha1 尾 8 比对；累计 ≥${rd.thresholds.REPEAT_MIN} 次才点名）`);
  if (!rd.repeats.length) L.push(`│    无命中（当前最大重复次数 ${maxCount(turns)}，未达 ${rd.thresholds.REPEAT_MIN}）`);
  for (const b of rd.repeats) {
    L.push(`│    ⚠ ${b.name} ×${b.count} 次（按 reqId 去重 ${b.reqs.length} 个请求），参数摘要 ${b.argSummary} [args sha1尾8=${b.argHash}]，轮号：${b.turns.join(", ")}`);
    L.push(`│      ↳ 参数逐字相同：${b.count} 次调用携带同一份参数${b.reqs.length < b.count ? `；其中 ${b.reqs.length} 个不同 reqId —— 同一客户端轮的多次上游尝试/failover 会被分开点数（spec「各次上游尝试各自成条」），别把重试读成模型反复犯错` : "（原文见上述各轮的 [工具调用] 行）"}`);
  }

  // ③
  L.push("│");
  L.push(`│ ③ 连续零输出轮（判据：response.toolCalls 长度为 0 且 正文字符数为 0，连续 ≥${rd.thresholds.DEAD_STREAK_MIN} 轮；思考非空也算零输出）`);
  if (!rd.deadStreaks.length) L.push("│    无命中");
  for (const s of rd.deadStreaks) L.push(`│    ⚠ 轮 ${s.from}–${s.to} 连续 ${s.length} 轮既不产工具调用也不产正文，期间思考合计 ${fmtInt(s.reasoningCharsTotal)} 字符（只在原地想；按 reqId 去重 ${s.reqCount} 个请求${s.reqCount < s.length ? " —— 含同轮多次尝试，勿直接当「连续 N 轮空转」" : ""}）`);

  // ④
  L.push("│");
  L.push(`│ ④ 思考循环信号（判据：response.reasoning 命中措辞之一 ${JSON.stringify(rd.thresholds.LOOP_HINT_WORDS)}，同会话命中轮数 ≥${rd.thresholds.LOOP_HINT_MIN} 才点名）`);
  L.push(`│    命中 ${rd.loopHints.count} 轮：${rd.loopHints.hitTurns.map((h) => `轮${h.turn}[${h.words.join(",")}]`).join(" ") || "无"}`);
  L.push(rd.loopHints.triggered ? `│    ⚠ 达标（${rd.loopHints.count} ≥ ${rd.thresholds.LOOP_HINT_MIN}）：思考文本反复出现同一类自救措辞 → 回路在打转` : `│    未达标（${rd.loopHints.count} < ${rd.thresholds.LOOP_HINT_MIN}），只列命中不给结论`);

  // ⑤
  L.push("│");
  L.push('│ ⑤ 额度吃光形态（判据：finishReason === "length" 且 reasoningChars / max(1, reasoningChars+正文chars) ≥ 0.9；max_tokens 取 request.params）');
  if (!rd.lengthTurns.length) L.push(`│    无 finishReason=length 的轮（本会话 finishReason 取值：${[...new Set(turns.map((t) => t.finish || "null"))].join(", ")}）`);
  for (const x of rd.lengthTurns) {
    L.push(`│    轮 ${x.turn}（${x.time}）finishReason=length ｜ 思考=${fmtInt(x.reasoningChars)} 字符 ｜ 正文=${fmtInt(x.contentChars)} 字符 ｜ 思考占比=${x.ratio}${x.maxTokens == null ? " ｜ max_tokens=未捕获(request.params 无该键)" : ` ｜ max_tokens=${x.maxTokens}`}`);
    L.push(x.triggered ? `│      ↳ ⚠ 命中判据（占比 ${x.ratio} ≥ ${rd.thresholds.REASONING_RATIO_MIN}）：这一轮的额度几乎全花在思考上` : `│      ↳ 未达判据（占比 ${x.ratio} < ${rd.thresholds.REASONING_RATIO_MIN}），只给读数不判死`);
  }
  L.push("└──────────────────── 体检结束，以下为逐轮正文 ────────────────────");
  return L.join("\n");
}

function maxCount(turns) {
  const m = new Map();
  for (const t of turns) for (const c of t.calls) { const k = `${c.name}|${c.hash}`; m.set(k, (m.get(k) || 0) + 1); }
  return m.size ? Math.max(...m.values()) : 0;
}

// —————————————————————————— CLI 入口（唯一有 fs 读副作用的地方，且只读）——————————————————————————

const USAGE = [
  "用法：node scripts/talkfull-view.js [--file <path>] [--model <供应商/模型id>] [--session <key>] [--tail N] [--all]",
  "  无 --file：列出日志根 talk/full/ 下的候选文件（按 mtime 倒序 + 各自字节数，首行为目录总占用）",
  "  --model：按 talkLogName 同规则算出 <供应商>-<模型>-talkfull.jsonl 并直接渲染",
  "  --session：只渲染该 sessionKey（先精确匹配，落空再子串匹配）",
  "  --tail N：每会话只渲染最后 N 条（缺省 " + TH.TAIL_DEFAULT + "）；--all：全部记录 + 正文不截断",
  "  只读脚本：不建目录、不写文件、不改权限。",
].join("\n");

function parseArgs(argv) {
  const opt = { file: null, model: null, session: null, tail: null, all: false, help: false };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--file" || a === "-f") opt.file = val();
    else if (a === "--model" || a === "-m") opt.model = val();
    else if (a === "--session" || a === "-s") opt.session = val();
    else if (a === "--tail" || a === "-t") { const n = Number(val()); if (Number.isFinite(n) && n > 0) opt.tail = Math.trunc(n); else errors.push("--tail 需要正整数"); }
    else if (a === "--all") opt.all = true;
    else if (a === "--help" || a === "-h") opt.help = true;
    else errors.push(`未识别参数：${a}`);
  }
  return { opt, errors };
}

function dirUsage(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    try { const st = statSync(join(dir, e.name)); files.push({ name: e.name, bytes: st.size, mtimeMs: st.mtimeMs }); } catch { /* 读不到的条目跳过，只读脚本不报错 */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { dir, files, total: files.reduce((a, f) => a + f.bytes, 0) };
}
const fmtTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

function listCandidates() {
  const dir = talkFullDir();
  const info = dirUsage(dir);
  console.log(`[成本] 目录 ${dir} 总占用 = ${info ? fmtBytes(info.total) : "读不到"}（判据：目录内全部文件当前字节数求和，含 .1/.2 轮转旧份；单文件上限 MSLXDFF_TALK_FULL_MAX_MB 默认 50MB、保留 MSLXDFF_TALK_FULL_KEEP 默认 3 份 → 每模型最坏 200MB）`);
  if (!info) {
    console.log("  ✗ 目录不存在或读不到：回路语料缺省已开（未设 env 即捕获、自动建目录），只有显式关闭词 MSLXDFF_TALK_FULL=0/off/false/no/disable 才停写——或日志根不是这里。");
    console.log(`  下一步：确认日志根（MSLXDFF_DAEMON_DIR ＞ state 同目录 ＞ ~/.config/mslxdff/）后重试，或直接 --file <path>。`);
    return;
  }
  if (!info.files.length) { console.log("  (目录在，但里面没有文件 —— 还没有捕获到任何请求)"); return; }
  console.log(`  共 ${info.files.length} 个文件（mtime 倒序）：`);
  for (const f of info.files) console.log(`    ${pad(fmtBytes(f.bytes), 22)}  改于 ${fmtTime(f.mtimeMs)}  ${join(dir, f.name)}${/\.jsonl\.\d+$/.test(f.name) ? "  (轮转旧份)" : ""}`);
  console.log("  下一步：node scripts/talkfull-view.js --model <供应商/模型id> 或 --file <上面任一路径>");
}

function resolveFile(opt) {
  if (opt.file) return { file: opt.file };
  const dir = talkFullDir();
  if (opt.model) {
    const name = talkFullFileName(opt.model);
    const cand = join(dir, name);
    if (statOrnull(cand)) return { file: cand, note: `按 --model "${opt.model}" → ${name}` };
    const legacy = join(dir, name.replace(SUFFIX, "-talkfull.log"));
    if (statOrnull(legacy)) return { file: legacy, note: `按 --model 未命中 ${name}，回退旧名 ${basename(legacy)}` };
    return { error: `--model "${opt.model}" 解析为 ${cand}，该文件不存在` };
  }
  const info = dirUsage(dir);
  const newest = info?.files?.[0];
  if (!newest) return { error: `${dir} 下没有可渲染的文件` };
  return { file: join(dir, newest.name), note: `未指定 --file/--model，按 mtime 取最新 ${newest.name}` };
}
function statOrnull(p) { try { return statSync(p).isFile() ? statSync(p) : null; } catch { return null; } }

function main() {
  const { opt, errors } = parseArgs(process.argv.slice(2));
  if (opt.help) { console.log(USAGE); return; }
  if (errors.length) { errors.forEach((e) => console.error(`✗ ${e}`)); console.error(USAGE); process.exitCode = 2; return; }
  if (!opt.file && !opt.model && !opt.session && !opt.tail && !opt.all) { listCandidates(); return; }
  if (!opt.file && !opt.model && (opt.session || opt.tail || opt.all)) {
    const info = dirUsage(talkFullDir());
    if (!info?.files?.length) { console.error(`✗ 给了 --session/--tail/--all 但没有 --file/--model，且 ${talkFullDir()} 下没有文件`); process.exitCode = 2; return; }
    opt.file = join(talkFullDir(), info.files[0].name);
    console.log(`[选档] 未给 --file，按 mtime 取最新：${opt.file}`);
  }
  const resolved = opt.file ? { file: opt.file } : resolveFile(opt);
  if (resolved.error) { console.error(`✗ ${resolved.error}`); console.error("  下一步：不带参数重跑可列出候选文件。"); process.exitCode = 1; return; }
  if (resolved.note) console.log(`[选档] ${resolved.note}`);
  const file = resolved.file;
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { console.error(`✗ 读不到 ${file}：${e.message}`); process.exitCode = 1; return; }
  renderFromFile(file, text, opt);
}

export function renderFromFile(file, text, opt = {}) {
  const st = statOrnull(file);
  const info = st && basename(dirname(file)) === "full" ? dirUsage(dirname(file)) : dirUsage(talkFullDir());
  console.log(`[成本] 本次文件 ${file} = ${st ? fmtBytes(st.size) : "未知"} ｜ 目录 ${info ? info.dir : talkFullDir()} 总占用 ${info ? fmtBytes(info.total) : "读不到（目录不存在：回路语料缺省已开，设 MSLXDFF_TALK_FULL=0 可关；也可能是日志根不对）"}`);
  const { records, bad, totalLines } = parseRecords(text);
  const lineNos = bad.map((b) => b.line).join(", ");
  console.log(`[解析] 文件 ${totalLines} 行 → 可解析记录 ${records.length} 条 ｜ 坏行 ${bad.length} 条已跳过${bad.length ? `（行号：${lineNos}）` : ""}｜ 空行不计坏行`);
  if (bad.length) for (const b of bad.slice(0, 5)) console.log(`        ↳ 行 ${b.line}：${b.reason} ｜ 预览 ${b.preview}`);
  if (bad.length > 5) console.log(`        ↳ …其余 ${bad.length - 5} 条坏行只计数不逐条打印`);
  let groups = groupSessions(records);
  if (opt.session) {
    let hit = [...groups.entries()].filter(([k]) => k === opt.session);
    let mode = "精确";
    if (!hit.length) { hit = [...groups.entries()].filter(([k]) => k.includes(opt.session)); mode = "子串"; }
    if (!hit.length) { console.log(`[过滤] --session "${opt.session}" 在本文件 0 命中；文件内现有会话：${[...groups.keys()].join(", ")}`); return; }
    groups = new Map(hit);
    console.log(`[过滤] --session ${opt.session}（${mode}匹配）→ ${hit.length} 个会话`);
  }
  const tail = opt.all ? null : (opt.tail ?? TH.TAIL_DEFAULT);
  const shown = new Map();
  for (const [k, list] of groups) shown.set(k, tail ? list.slice(-tail) : list);
  const src = new Set(); const hops = new Set();
  let degradedTurns = 0, truncatedTurns = 0, rendered = 0;
  for (const list of shown.values()) {
    rendered += list.length;
    for (const r of list) { hops.add(String(r.hops ?? "缺失")); if (r.clientIp) src.add(String(r.clientIp)); if (isTruncated(r)) truncatedTurns++; if (isDegradedMessages(messagesOf(r))) degradedTurns++; }
  }
  console.log(`[分组] ${shown.size} 个会话 ｜ 渲染 ${rendered} 条记录（文件内可解析共 ${records.length} 条）｜ hops 取值 {${[...hops].join(",")}} ｜ clientIp 取值 {${[...src].join(",") || "缺失"}}`);
  console.log("       来源核对判据：spec 只允许 hops=0（本机直连）落盘，出现 hops>0 即为写侧越界；clientIp 仅核对不作安全边界。");
  if (degradedTurns || truncatedTurns) console.log(`[标注] 降级态（请求体只剩结构摘要）轮 ${degradedTurns} 处 ｜ truncated（内容触顶）轮 ${truncatedTurns} 处 —— 均标在对应轮次标题行`);
  if (tail) console.log(`[窗口] 每会话只渲染最后 ${tail} 条（体检读数同样只算被渲染的这些轮；看全部用 --all 或 --tail <更大值>）`);
  for (const [k, list] of shown) {
    const full = groups.get(k).length;
    if (full > list.length) console.log(`\n════ 提示：该会话共 ${full} 轮，本次只渲染末 ${list.length} 轮（轮号从 1 重新计）════`);
    console.log(renderSession(list, { all: !!opt.all }));
  }
  console.log(`\n[收尾] 坏行 ${bad.length} 条（已跳过，未整体报错）｜ 渲染会话 ${shown.size} 个`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();