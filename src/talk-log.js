// 环形对话日志（talk log）：按「供应商-模型-talk.log」分文件，只保留最近 1 小时的完整对话。
// 记三件事：我问了什么 / 模型怎么想（reasoning）/ 模型怎么答（content），供人工调研模型的回答方式。
// 与 model-trace 相反：那边刻意不落正文（「加日志」≠「倒数据」），这里专门落正文 —— 所以必须脱敏 + 封顶。
// 默认开；MSLXDFF_TALK_LOG=0 关闭，窗口 MSLXDFF_TALK_LOG_WINDOW_MIN（分，默认 60），单文件 MSLXDFF_TALK_LOG_MAX_KB（默认 5MB）。
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logDir } from "./logs.js";
import { fmtShanghaiYMDHMS } from "./time.js";

const SUBDIR = "talk";
const DEFAULT_WINDOW_MIN = 60;
const DEFAULT_MAX_KB = 5 * 1024; // 5MB per talk-log file (ring buffer)
const MARK = "#talk-entry";
// 正常路径只 append；整文件重写（环形淘汰）只在「最老条目出窗」或「超字节上限」时发生。
// oldestCache 记住每个文件当前最老的 ts，避免每次写入都回读全文件。
const oldestCache = new Map();

export function talkLogEnabled() { return String(process.env.MSLXDFF_TALK_LOG ?? "1") !== "0"; }
function windowMs() { const n = Number(process.env.MSLXDFF_TALK_LOG_WINDOW_MIN); return Number.isFinite(n) && n > 0 ? n * 60000 : DEFAULT_WINDOW_MIN * 60000; }
function maxBytes() { const n = Number(process.env.MSLXDFF_TALK_LOG_MAX_KB); return Number.isFinite(n) && n > 0 ? n * 1024 : DEFAULT_MAX_KB * 1024; }
/** 仅测试用：进程重启等价物（环形窗口的内存基线清空）。 */
export function resetTalkLogCache() { oldestCache.clear(); }

/** 供应商-模型-talk.log：qoder/qfmodel → qoder-qfmodel-talk.log；裸 id（免费池）直接用一个名字段。 */
export function talkLogName(model) {
  const s = String(model || "unknown").trim().toLowerCase();
  const segs = s.includes("/") ? s.split("/").filter((x) => x && x !== "unknown") : [s];
  const safe = segs.join("-").replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 180);
  return `${safe || "unknown"}-talk.log`;
}

export function talkDir() { return join(logDir(), SUBDIR); }
export function talkLogFile(model) { return join(talkDir(), talkLogName(model)); }

// 正文里的凭据一律先抹再落盘（保留换行，不像 model-trace 那样压成一行 —— 这里要读的是回答本身）。
const MASKS = [
  [/([?&](?:token|refresh[_-]?token|access[_-]?token|api[_-]?key|apikey|key|secret|password|cookie)=)[^\s&]+/gi, "$1[已脱敏]"],
  [/(authorization|bearer|proxy-authorization|cookie|x-api-key)\s*[:=]\s*[^\s,;]+/gi, "$1=[已脱敏]"],
  [/("(?:apiKey|api_key|accessToken|refreshToken|secret|password|client_secret)"\s*:\s*)"[^"]*"/gi, '$1"[已脱敏]"'],
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/g, "[已脱敏-JWT]"],
  [/\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|xox[baprs])-[\w-]{10,}\b/g, "[已脱敏-key]"],
  // 裸 k=v（提问里常出现 token=…、password=…）：只掐足够长的值，避免把「token 数量」这类正常技术讨论也糊掉
  [/\b(token|accessToken|refreshToken|api[_-]?key|apiKey|secret|password|cookie|client_secret|authorization)\s*[:=]\s*[\w./+-]{12,}/gi, "$1=[已脱敏]"],
];

const CUT_MARK = "\n…[已截断]";

/** 脱敏 + 按字节封顶截断（中文 3 字节/字，逐字累加才不会超预算），并报告这一刀是否真的落下。 */
function maskCut(v, cap = 100000) {
  let s = String(v ?? "");
  for (const [re, repl] of MASKS) s = s.replace(re, repl);
  if (Buffer.byteLength(s, "utf8") <= cap) return { text: s, capped: false };
  const tail = Buffer.from(CUT_MARK, "utf8");
  const budget = Math.max(0, cap - tail.length);
  let bytes = 0, i = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > budget) break;
    bytes += n;
    i += ch.length;
  }
  return { text: s.slice(0, i) + CUT_MARK, capped: true };
}

/** 脱敏 + 按字节封顶截断（对外口径与改前逐字一致；要知道是否砍过用 maskCut/pushBlock）。 */
export function maskText(v, cap = 100000) { return maskCut(v, cap).text; }

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p?.text || (p?.image_url ? `[图片 ${String(p.image_url.url).slice(0, 60)}]` : "")).filter(Boolean).join("\n");
  return "";
}

/** 只取「我发给大模型的问题」= 最后一条 user 消息（agent 回路每轮都带全量历史，全落会把环形窗口占满）。 */
export function lastUserQuestion(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : null;
  if (msgs) { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") return textOf(msgs[i].content); }
  const inp = body?.input; // Responses 端点形状兜底
  if (typeof inp === "string") return inp;
  if (Array.isArray(inp)) { for (let i = inp.length - 1; i >= 0; i--) if (inp[i]?.role === "user") return textOf(inp[i].content); }
  return "";
}

const CUT_IN = "----8<----", CUT_OUT = "---->8----";

// 标签行的「N 字」在字节封顶之后只是**已落盘**的字数；不带封顶标记，就会被读成「模型只说了这么多」。
function pushBlock(out, label, text, cap) {
  const { text: m, capped } = maskCut(text, cap);
  if (!m.trim()) return false;
  out.push(`[${label} · ${m.length} 字${capped ? " · 已封顶" : ""}]`, CUT_IN, m, CUT_OUT, "");
  return capped;
}

// 撞捕获上限时紧跟头部行的人类可读提醒：不必先认识 truncated=1 这个键名也能一眼看出「可能不完整」。
const TRUNC_NOTE = "[!] 本轮已撞捕获上限（truncated=1）：思考/正文后半段未落盘，内容可能不完整 —— 别当成模型的完整回答";

/** 一条对话 = 一个可读块：头部一行元信息（ts= 是环形淘汰的唯一依据），正文三段。elapsed= 取本次尝试墙钟（design D3），finish=/relayMs= 为 ADR-0046 新读数。 */
export function formatTalkEntry({ reqId, model, via, hops, status, stream, elapsedMs, question, thinking, answer, tools, usage, upstream, account, pick, ts, talkCapped = false, talkChars, talkCap, finishReason, relayMs } = {}) {
  const fval = finishReason || "-"; // 缺值占位（grill Q5）：「没给 finish」不得被读成 stop；字段恒在场
  const now = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
  const trunc = talkCapped === true;
  const head = [
    `${MARK} ts=${now}`, `time=${fmtShanghaiYMDHMS(new Date(now))}`, `req=${reqId || "-"}`, `model=${model || "-"}`,
    via ? `via=${via}` : "", hops != null ? `hops=${hops}` : "", `status=${status ?? "-"}`,
    stream ? "stream=1" : "stream=0", Number.isFinite(elapsedMs) ? `elapsed=${Math.round(elapsedMs)}ms` : "",
    // 尝试墙钟与 relay 内部计时同值时不重复打印（头行噪音克制，grill Q3）；两值不同（hedge/缓冲重放）才另列 relayMs
    Number.isFinite(relayMs) && Number.isFinite(elapsedMs) && Math.round(relayMs) !== Math.round(elapsedMs) ? `relayMs=${Math.round(relayMs)}ms` : "",
    `finish=${fval}`,
    usage ? `usage(prompt=${usage.prompt_tokens ?? "-"},completion=${usage.completion_tokens ?? "-"})` : "",
    upstream ? `upstream=${upstream}` : "", account ? `account=${account}` : "", pick ? `pick=${pick}` : "",
    // 截断读数只在真截断时出现（未截断不得新增噪音字段）：cap= 上限、chars= 已捕获字符数
    trunc ? `truncated=1 cap=${Number.isFinite(talkCap) && talkCap > 0 ? talkCap : "-"} chars=${Number.isFinite(talkChars) ? talkChars : "-"}` : "",
  ].filter(Boolean).join(" ");
  const out = [head];
  if (trunc) out.push(TRUNC_NOTE);
  out.push("");
  pushBlock(out, "我问", question, 20000);
  pushBlock(out, "思考", thinking, 100000);
  // 零正文不再静默跳块（spec「零输出轮必须可判读」/grill Q4）：缺块与「正文该有却没落盘」同形，缺席必须是可读读数。
  // 只落一行标注 + 空行（没有内容可围，不套 CUT 围栏）；有真实正文的字符串照旧走 pushBlock，该段与改动前逐字节一致。
  // 判据看 trim 不看长度（P1-B）：" "/"\n" 进 pushBlock 也会被 !m.trim() 整块跳过 → 与「正文丢盘」再度同形，而「只调工具 + 吐个换行」是真实 agent 形态。
  if (!String(answer ?? "").trim()) out.push(`[回答 · 0 字 · 本轮无正文（finish=${fval}）]`, "");
  else pushBlock(out, "回答", answer, 200000);
  const t = tools == null || tools === "" ? "" : String(tools);
  pushBlock(out, "工具调用", t, 20000);
  out.push("[END]", "");
  return out.join("\n") + "\n";
}

/** 只读文件头 8KB 取最老一条的 ts（进程重启后重建内存基线，不必回读全文件）。 */
function firstTs(file) {
  let fd = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    const m = buf.subarray(0, n).toString("utf8").match(/^#talk-entry ts=(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch { return null; }
  finally { if (fd != null) { try { closeSync(fd); } catch {} } }
}

/** 追加一条（正常路径只 append；到窗口或超预算才整写淘汰）。 */
export function appendTalkEntry({ file, block, atMs } = {}) {
  try {
    if (!file || !block) return 0;
    mkdirSync(dirname(file), { recursive: true });
    const isNew = !existsSync(file);
    appendFileSync(file, block);
    // mode 只在新建时生效；存量文件补一次 chmod（POSIX；Windows 无意义）
    if (isNew) { try { chmodSync(file, 0o600); } catch {} }
    const now = Number.isFinite(atMs) && atMs > 0 ? atMs : Date.now();
    let base = oldestCache.get(file);
    if (base == null) { base = firstTs(file); if (base == null) base = now; }
    const size = (() => { try { return statSync(file).size; } catch { return 0; } })();
    if (now - base > windowMs() || size > maxBytes()) trimTalkLog(file, now);
    else oldestCache.set(file, Math.min(base, now));
    return 1;
  } catch { return 0; }
}

/** 按 `#talk-entry` 头行切块（内容行理论上可能撞前缀，故要求严格 ts= 形状才认头）。 */
export function splitEntries(txt) {
  const entries = [];
  const lines = String(txt ?? "").split("\n");
  let start = -1;
  const close = (end) => {
    if (start < 0) return;
    const chunk = lines.slice(start, end);
    const m = chunk[0].match(/^#talk-entry ts=(\d+)/);
    entries.push({ ts: m ? Number(m[1]) : 0, text: chunk.join("\n") + "\n" });
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^#talk-entry ts=\d+/.test(lines[i])) { close(i); start = i; }
  }
  close(lines.length);
  return entries;
}

/** 环形淘汰：先按时间窗口丢，再按字节预算从最老的丢（至少留最新 1 条）；tmp+rename 原子替换。 */
export function trimTalkLog(file, nowTs = Date.now()) {
  try {
    if (!existsSync(file)) return 0;
    const limit = nowTs - windowMs();
    const cap = maxBytes();
    const all = splitEntries(readFileSync(file, "utf8"));
    // 多进程（restart 交接窗口）可能交错追加 → 按 ts 重排，保证「环形」语义与阅读顺序一致
    let kept = all.filter((e) => e.ts > 0 && e.ts >= limit).sort((a, b) => a.ts - b.ts);
    if (kept.length === 0) { rmSync(file, { force: true }); oldestCache.delete(file); return all.length; }
    let bytes = Buffer.byteLength(kept.map((e) => e.text).join(""), "utf8");
    while (bytes > cap && kept.length > 1) bytes -= Buffer.byteLength(kept.shift().text, "utf8");
    const tmp = `${file}.${process.pid}.trim`;
    writeFileSync(tmp, kept.map((e) => e.text).join(""), { mode: 0o600 });
    renameSync(tmp, file);
    oldestCache.set(file, kept[0].ts);
    return all.length - kept.length;
  } catch { return 0; }
}

/**
 * relay 落盘的唯一入口：把 relay() 累积的 detail.talk（思考/正文/工具分片）拼成一条对话。
 * 空轮（零正文零思考零工具）不占环形窗口 —— 那是 relay-pipeline 已经另行报错的场景。
 * 桶的 capped/n/cap 必须一路传到 formatTalkEntry：撞顶的那条要能看出「后半截没了」。
 * attemptMs（本次上游尝试墙钟）由调用点传入；未传（拿不到尝试起点）回退 out.totalMs —— 此时 elapsed 与 relayMs 同值（spec 降级 scenario）。
 */
export function recordRelayTalk({ reqId, model, via, hops, body, out, echo = {}, attemptMs, finishReason } = {}) {
  if (!talkLogEnabled()) return false;
  try {
    const talk = out?.detail?.talk;
    const answer = (talk?.content || []).join("");
    const thinking = (talk?.reasoning || []).join("");
    const tools = talk?.tools?.length ? JSON.stringify(talk.tools) : "";
    const status = out?.status;
    if (!answer && !thinking && !tools && Number(status) !== 200) return false;
    if (!answer && !thinking && !tools) return false;
    const ts = Date.now();
    const block = formatTalkEntry({
      reqId, model, via, hops, status, stream: Boolean(body?.stream), finishReason: finishReason ?? out?.detail?.sawFinishReason,
      elapsedMs: Number.isFinite(Number(attemptMs)) ? Number(attemptMs) : out?.totalMs, // 新口径：本次尝试墙钟优先（design D3）
      relayMs: out?.totalMs, question: lastUserQuestion(body || {}),
      thinking, answer, tools, usage: out?.detail?.usage, ...echo, ts,
      talkCapped: talk?.capped === true, talkChars: talk?.n, talkCap: talk?.cap,
    });
    appendTalkEntry({ file: talkLogFile(model), block, atMs: ts });
    return true;
  } catch { return false; }
}

/** 读最近 N 条（倒序，最新在前）—— 给 CLI/排障用。 */
export function recentBlocks({ model, n = 10, file } = {}) {
  try {
    const target = file || talkLogFile(model);
    if (!existsSync(target)) return [];
    return splitEntries(readFileSync(target, "utf8")).map((e) => e.text).reverse().slice(0, n);
  } catch { return []; }
}

/** 最近活跃的文件清单（哪些供应商×模型在这一小时里说过话）。 */
export function listRecentFiles({ limit = 20 } = {}) {
  try {
    const dir = talkDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith("-talk.log"))
      .map((d) => {
        let mtime = 0;
        try { mtime = statSync(join(dir, d.name)).mtimeMs; } catch {}
        return { name: d.name, mtime, time: fmtShanghaiYMDHMS(new Date(mtime)) };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch { return []; }
}
