// talk-full 的纯函数核（redact）：写前处理链 + 会话标识归一，无 IO、无 env 读取（阈值由调用方传入），可独立单测。
// 处理链顺序冻结：结构摘要化 → 递归字段黑名单抹凭据 → JSON.stringify → 整串过 maskText 正则 → 单条超限降级。
import { createHash } from "node:crypto";
import { maskText } from "./talk-log.js";

const NO_CAP = Number.MAX_SAFE_INTEGER; // 只借 maskText 的正则，不套它的字节截断（截断会把 JSON 语法层切坏）
const REDACTED = "[已脱敏]";
// 凭据键名黑名单（键名归一化后比对）：命中即整值抹掉，同层其它字段原样保留。
const DENY = new Set(["apikey", "accesstoken", "refreshtoken", "token", "secret", "password", "clientsecret", "cookie", "authorization", "xapikey"]);
// 字符串叶同款键值正则：覆盖 tool 结果 / tool_calls.arguments 这类「JSON 文本塞在字符串里」的凭据。
const LEAF_CRED = /"(apiKey|api_key|accessToken|refreshToken|token|secret|password|client_secret|cookie|authorization|x-api-key)"(\s*:\s*)"[^"]*"/gi;
const SKIP_PARAM = new Set(["messages", "tools", "functions", "model"]);

export const sha1 = (s) => createHash("sha1").update(String(s)).digest("hex");
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
const clip = (v, n) => { const s = String(v ?? ""); return s.length > n ? `${s.slice(0, n)}…[已截断]` : s; };
// 循环引用 / BigInt 兜底：诊断材料宁可标「已循环」也不能抛出去影响请求。
export function stringifySafe(v) {
  const seen = new WeakSet();
  return JSON.stringify(v, (k, x) => {
    if (typeof x === "bigint") return String(x);
    if (x && typeof x === "object") { if (seen.has(x)) return "[已循环]"; seen.add(x); }
    return x;
  });
}

const imgTag = (p) => `[图片 ${String(p?.image_url?.url ?? p?.image_url ?? "").slice(0, 60)}]`;
/** 非文本部件只留形不留料（沿用 talk-log.js 的 60 字口径）；全程造新对象，不改调用方的 body。 */
function summarizeParts(v, d = 0) {
  if (d > 24) return v;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" && (x.image_url !== undefined || x.type === "image_url")) ? imgTag(x) : summarizeParts(x, d + 1));
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = summarizeParts(x, d + 1); return o; }
  return v;
}
/** 递归字段黑名单：命中键名整值抹掉；字符串叶另走键值正则。 */
function redactDeep(v, d = 0) {
  if (d > 24) return REDACTED;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, d + 1));
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = DENY.has(normKey(k)) ? REDACTED : redactDeep(x, d + 1); return o; }
  if (typeof v === "string") return v.replace(LEAF_CRED, '"$1"$2"[已脱敏]"');
  return v;
}
/** 结构层安全的兜底：逐字符串叶过 maskText 正则（整串跑法偶尔会吃掉 JSON 闭引号）。 */
function maskLeaves(v) {
  if (Array.isArray(v)) return v.map(maskLeaves);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = maskLeaves(x); return o; }
  return typeof v === "string" ? maskText(v, NO_CAP) : v;
}
/** 序列化 + 整串脱敏；结果不是合法 JSON 就退回逐叶脱敏 —— 落盘行必须可独立解析。 */
export function lineOf(rec) {
  const whole = maskText(stringifySafe(rec), NO_CAP);
  try { JSON.parse(whole); return whole; } catch { return stringifySafe(maskLeaves(rec)); }
}
/** 超长字符串叶（含超限标量 params，如 completions 的巨型 prompt）：地板兜底，逐层截短。 */
function clipLongStrings(v, max = 200) {
  if (Array.isArray(v)) return v.map((x) => clipLongStrings(x, max));
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = clipLongStrings(x, max); return o; }
  return typeof v === "string" && v.length > max ? `${v.slice(0, max)}…[已截断]` : v;
}
/** 三级钳制：二级摘要自身也超限时（极端 message 条数）再削 —— 先丢 head 只留 role/chars/hash，再折半只留末尾 N 条。 */
function clampSummaries(rec, limitBytes, line) {
  if (Buffer.byteLength(line, "utf8") <= limitBytes) return line;
  const rows = (Array.isArray(rec.request.messages) ? rec.request.messages : []).map(({ head, ...rest }) => rest); // ① 逐条退化：只留 role + chars + hash（无 head）
  rec.meta.summaryTrimmed = true; // 读侧：摘要被削过（② 末尾 N 条 + messagesOmitted 读数）
  let n = rows.length;
  for (let i = 0; i < 64; i++) { // 折半削减，上限 64 轮 = 有界（绝不死循环）
    rec.request.messages = n > 0 ? rows.slice(-n) : [];
    rec.meta.messagesOmitted = rows.length - rec.request.messages.length;
    line = lineOf(rec);
    if (Buffer.byteLength(line, "utf8") <= limitBytes) return line;
    if (n === 0) break;
    n = n === 1 ? 0 : Math.floor(n / 2);
  }
  return lineOf(Object.assign(rec, clipLongStrings(rec))); // ③ 地板兜底：messages 清空仍超限（超长标量 params）→ 长字符串叶截短
}
/** 超限降级的结构摘要：每条只留 role + 字符数 + sha1尾8 + 首500字。 */
function summarizeMessages(msgs) {
  return (Array.isArray(msgs) ? msgs : []).map((m, i) => {
    const t = typeof m?.content === "string" ? m.content : stringifySafe(m?.content ?? "");
    return { i, role: String(m?.role || "?"), chars: t.length, hash: sha1(t).slice(-8), head: t.slice(0, 500) };
  });
}
/** 单条超 limitBytes 时原地降级（记录不得丢），返回最终行。二级降级只给极端体量兜底。 */
export function composeLine(rec, limitBytes) {
  let line = lineOf(rec);
  if (Buffer.byteLength(line, "utf8") <= limitBytes) return line;
  rec.request.messages = summarizeMessages(rec.request.messages);
  rec.meta.truncated = true;
  line = lineOf(rec);
  if (Buffer.byteLength(line, "utf8") <= limitBytes) return line;
  rec.request.tools = null;
  rec.response = { reasoning: clip(rec.response.reasoning, 2000), content: clip(rec.response.content, 2000), toolCalls: [] };
  return clampSummaries(rec, limitBytes, lineOf(rec)); // 二级之后仍超限 → 三级钳制，保证最终行 ≤ limitBytes
}

/** 采样参数：body 里除 messages/tools/functions/model 外的标量键逐个收（对象键不 dump，避免整身重复）。 */
export function scalarParams(body) {
  const o = {};
  for (const [k, v] of Object.entries(body && typeof body === "object" ? body : {})) {
    if (SKIP_PARAM.has(k)) continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") o[k] = v;
  }
  return o;
}
/** request/response 两侧的落盘形状（已结构摘要化 + 黑名单脱敏）。 */
export function shapeForCapture({ body, model, msgs, reasoning, content, toolCalls }) {
  return redactDeep(summarizeParts({
    request: { model: body?.model ?? model ?? null, messages: msgs, tools: body?.tools ?? body?.functions ?? null, params: scalarParams(body) },
    response: { reasoning, content, toolCalls },
  }));
}

// 会话标识（Session hint）：客户端头 ＞ 首条 system+user 派生 ＞ 进程级兜底；落盘一律归一化。
export const PROCESS_SESSION = `ses_${sha1(`${process.pid}:${Math.random()}`)}`;
/** 形态同 upstream.js:17 的兜底公式，自成一份（不 import 未合并的会话身份变更）。 */
function sessionFromMessages(msgs) {
  const pick = (role) => {
    const m = (msgs || []).find((x) => x?.role === role);
    if (!m) return "";
    return typeof m.content === "string" ? m.content : stringifySafe(m.content ?? "");
  };
  const seed = `${pick("system")}|${pick("user")}`.slice(0, 4000);
  return seed === "|" ? null : `ses_${sha1(seed)}`;
}
/** 归一化短标识：sha1尾12 + "-" + 原值前 8 字（同一原值→同一标识，跨轮稳定、换模型不漂）。 */
export function normSessionKey(raw, msgs) {
  const v = String(raw ?? "").trim() || sessionFromMessages(msgs) || PROCESS_SESSION;
  return `${sha1(v).slice(-12)}-${v.slice(0, 8)}`;
}
