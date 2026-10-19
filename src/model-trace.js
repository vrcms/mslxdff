// Per-model request trace formatting. Never include prompt, response body, headers or credentials.
// Note: 同步 appendFileSync（异步 append 会在并发下打乱同一请求的阶段行序）— 见 .agents/notes/implemented/feature/2026-09-25-model-trace-log.md
// Note: 事件面用黑名单（默认全可见，只排除噪声/敏感面）+ 决定类事件只渲染登记过的标量字段——起因是 empty-turn-retry 曾被阶段白名单静默吞掉，"关键决定不许再被漏登记" — 见 .agents/notes/implemented/feature/2026-09-27-qoder-per-request-sticky-account.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "./logs.js";
import { fmtShanghaiYMDHMS } from "./time.js";

const MAX_TRACE_BYTES = 1024 * 1024;
// 裁剪后保留的比例（按**字节**回退）。与 logs.js 的 KEEP_RATIO 同口径：
// 旧的 `slice(-100)` 是按**行数**回退，与按字节的阈值严重不匹配 —— 实测
// cline-cline-pass-deepseek-v4.1-flash.log 到 1,006,482 字节 / 5346 行时，
// 一次裁剪丢 5246 行（98.1% 历史），事后回溯基本不可用。按字节留 3/4 则每次只丢 ~1/4。
const TRACE_KEEP_RATIO = 3 / 4;

export function modelLogName(model) {
  const s = String(model || "unknown").trim().toLowerCase();
  const safe = s.replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 180);
  return `${safe || "unknown"}.log`;
}

export function modelLogFile(model) {
  return join(logDir(), modelLogName(model));
}


function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function summarizeRequest(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const roles = {};
  for (const m of messages) roles[String(m?.role || "unknown")] = (roles[String(m?.role || "unknown")] || 0) + 1;
  return {
    stream: body.stream === true,
    messages: messages.length,
    roles,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    maxTokens: count(body.max_tokens ?? body.max_completion_tokens),
    temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : null,
    topP: Number.isFinite(Number(body.top_p)) ? Number(body.top_p) : null,
  };
}

function hostPort(value) {
  try { const u = new URL(String(value)); return u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { return "-"; }
}
// 黑名单（而非白名单）：模型日志默认收下**所有**事件，只排除噪声与凭据面。
// 起因：`empty-turn-retry`（"切号换 URL"的真实触发者）曾被白名单静默吞掉，排障时只见现象不见原因。
// 关键决定不允许再被漏登记：新增事件默认可见，确属噪声/敏感才在此登记排除。
const TRACE_DENY = new Set([
  "peer-health",     // 组员心跳，秒级高频，无决策价值
  "heartbeat",       // 运行心跳
  "client-session",  // 客户端会话标识（路由用），非决定且属敏感面
]);

export function shouldTraceModel(type) {
  const t = String(type || "");
  if (!t) return false;
  if (TRACE_DENY.has(t)) return false;
  if (t.startsWith("upstream-probe")) return false; // 探针类（probe/probe-error/probe-skip）
  return true;
}

function safeText(value, n = 140) {
  return String(value ?? "")
    .replace(/([?&](?:token|refreshToken|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|key|secret|password|cookie)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(authorization|bearer|access[_-]?token|refresh[_-]?token|cookie|api[-_]?key|password|secret)\s*[:=]\s*[^,; ]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, n);
}

function kv(obj) {
  return Object.entries(obj).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
}

// 决定类事件的可见字段白名单：只渲染这些标量；事件里的 payload/detail/stages/请求正文等一律不落模型日志。
// 「加日志」不等于「倒数据」——新增决定字段要显式登记在这里才会出现。
const DECISION_FIELDS = [
  "status", "from", "to", "reason", "hook", "applied", "skipped", "plugin",
  "provider", "before", "after", "models", "skippedFaulty", "limit", "tried",
  "winPeer", "winTarget", "peer", "peers", "peerLabel", "routeBest", "at",
  "latencyMs", "ttfMs", "hedged", "hops", "hasShare", "elapsedMs", "threshold",
  "stallHits", "maxGapMs", "interrupted", "providers", "via",
  "retry", "step", "max", "delayMs", "upstream", "account", "pick", "cooled", "queued", "nudged", "retries", "waitedMs", "raiseFrom", "raiseTo",
  "heldOpen", "terminalForm", "requestWaitedMs", "budgetMs", "budgetOut",
  // 终局判决（ADR-0058）：取证时第一眼要看的三件——判的哪种、命中哪条判据、是否因此没问组员
  "kind", "marker", "peersSkipped",
  // 中继/组员目标（2026-10-19）：跨机链路排障第一眼要的是**这一跳打给了谁**——target= 目标成员
  // （url 或 relay://id）、group= 组、leaderUrl= 经谁中继；缺了这几项，relay-try/fail 只剩状态码，
  // 看日志根本认不出是哪个组员出的问题（用户实证要求「日志要全面」）。
  "target", "group", "leaderUrl", "candidates", "tried",
];

function decisionKv(data = {}) {
  const out = [];
  for (const k of DECISION_FIELDS) {
    const v = data[k];
    if (v == null || v === "") continue;
    out.push(`${k}=${Array.isArray(v) ? v.join("|") : v}`);
  }
  return out.join(" ");
}

// provider 回显头 → 日志字段（谁上的 / 打哪个站 / 为什么选它 / 是否被冷却 / 是否被判排队）：
// 单一来源，防各处重复写法漂移；取不到时返回空对象（其它供应商零变化）。
export function upstreamEcho(res) {
  const h = res?.headers;
  if (typeof h?.get !== "function") return {};
  const pick = (name) => h.get(name) || null;
  return {
    upstream: pick("x-mslxdff-upstream"),
    account: pick("x-mslxdff-workbuddy-uid") || pick("x-mslxdff-qoder-region"),
    pick: pick("x-mslxdff-qoder-account"),
    cooled: pick("x-mslxdff-qoder-cooldown"),
    queued: pick("x-mslxdff-qoder-queued"),
  };
}

export function formatModelTrace({ type, reqId, model, data = {}, request = null, totalMs = null } = {}) {
  const base = { time: fmtShanghaiYMDHMS(new Date()), req: reqId || "-", model: model || "-", stage: type || "-" };
  let detail = "";
  // api= 打在 incoming 行最前：门是排查第一眼要的东西，grep "incoming api=" 直接分得开三门；无值时 kv 自然不落该段（不发散成 api=other）
  if (type === "request") detail = `incoming ${kv({ api: data.api, ...(request || summarizeRequest(data.body)), hops: data.hops, useAuto: data.useAuto })}`;
  else if (type === "ordered") detail = `route order=${(data.order || []).join(" | ")} hops=${data.hops ?? "-"} fallback=${data.canFallback ? 1 : 0}`;
  else if (type === "model-try") detail = `target=${data.model || model || "-"} idx=${data.idx ?? "-"} remaining=${data.remaining ?? "-"}`;
  else if (type === "alias") detail = `rawModel=${data.rawModel || "-"} requested=${data.requested || model || "-"}`;
  else if (type === "exhausted-local" || type === "exhausted-all") detail = `last=${data.lastModel || model || "-"} status=${data.lastStatus ?? "-"} order=${(data.order || []).join(" | ")}`;
  else if (type === "upstream-try") detail = `target=${data.model || model || "-"} attempt=${data.attempt ?? "-"} payload=${kv(data.payload || {})}`;
  else if (type === "upstream-done" || type === "upstream-error") detail = `upstream status=${data.status ?? "-"} timing=${data.timing?.totalMs ?? "-"}ms${data.upstream ? ` via=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""}${data.cooled ? ` cooled=${data.cooled}` : ""}${data.queued ? ` queued=1` : ""} ${safeText(data.message || data.error || "")}`;
  else if (type === "empty-turn-retry") detail = `空转重试：retry ${data.retry ?? "-"}/${data.max ?? "-"}${data.step != null ? ` step=${data.step}` : ""} delay=${data.delayMs ?? "-"}ms${data.waitedMs ? ` waited=${data.waitedMs}ms` : ""}${data.requestWaitedMs != null ? ` 请求级累计=${data.requestWaitedMs}ms/预算${data.budgetMs ?? "-"}ms` : ""}${data.raiseTo ? ` max_tokens ${data.raiseFrom}→${data.raiseTo}` : ""}${data.upstream ? ` after=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""}${data.nudged ? ` nudged=1` : ""} reason=empty turn${data.reason ? ` :: ${safeText(data.reason, 120)}` : ""}`;
  else if (type === "empty-turn-recovered") detail = `空转重试成功：第 ${data.retries ?? "-"}/${data.max ?? "-"} 次重拉拿到真实输出，本轮共白等 ${data.waitedMs ?? "-"}ms${data.upstream ? ` via=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""}`;
  else if (type === "empty-turn-exhausted") detail = `空转重试已用尽：重试 ${data.retries ?? 0}/${data.max ?? "-"} 次仍零输出（累计等待 ${data.waitedMs ?? 0}ms${data.budgetOut ? `，请求级等待预算 ${data.budgetMs ?? "-"}ms 用尽` : ""}），交回换候选${data.heldOpen ? "（响应仍开着，换过去的正文还能送达）" : "（响应已封口，重拉只为省额度）"}${data.upstream ? ` after=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""}${data.reason ? ` :: ${safeText(data.reason, 120)}` : ""}`;
  else if (type === "peer-request" || type === "peer-forward" || type === "peer-attempt" || type === "peer-error") detail = `peer=${hostPort(data.peer)}${data.name ? ` name=${data.name}` : ""} status=${data.status ?? "-"} latency=${data.latencyMs ?? "-"}ms payload=${kv(data.payload || {})} ${safeText(data.message || data.error || "")}`;
  else if (type === "relay-done") {
    const d = data.detail || {};
    const u = d.usage || {};
    // 缺 usage 时显式标注来源，别与「真的用了 0 token」混成同一个 `-`（BUG-13：经组员中继的响应
    // 少数轮次拿不到 usage，成本报表会静默偏低，读日志的人也会误判成"这轮没消耗"）。
    const noUsage = u.prompt_tokens == null && u.completion_tokens == null;
    const usageTxt = noUsage
      ? `usage(none${data.via === "peer" ? ":peer 未回" : ""})`
      : `usage(prompt=${u.prompt_tokens ?? "-"}/completion=${u.completion_tokens ?? "-"})`;
    detail = `upstream_response status=${data.status ?? "-"} finish=${d.sawFinishReason || "-"} chunks=${d.receivedChunks ?? "-"} bytes=${d.receivedBytes ?? "-"} tools=${d.toolCalls ?? 0} chars=${d.chars ?? 0} ${usageTxt} elapsed=${data.totalMs ?? "-"}ms${data.upstream ? ` upstream=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""}`;
  } else if (type === "result" || type === "client-response") {
    detail = `client status=${data.status ?? "-"} via=${data.via || "-"} actual=${data.actual || model || "-"} fallback=${data.fallback?.fallback ? 1 : 0} total=${totalMs ?? data.durationMs ?? "-"}ms${data.upstream ? ` upstream=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""}`;
  } else if (type === "relay-try") {
    detail = `指定宽带中继 target=${data.target || "?"} group=${data.group || "-"} via=${data.via || "-"}`;
  } else if (type === "relay-received") {
    detail = `中继收到 转给 target=${data.target || "?"} group=${data.group || "-"} via=${data.via || "-"} msgs=${data.messages ?? "-"} tools=${data.tools ?? "-"} maxTok=${data.maxTokens ?? "-"}`;
  } else if (type === "relay-queued") {
    detail = `已入队交成员 target=${data.target || "?"} reqId=${data.reqId || "-"}`;
  } else if (type === "relay-member-result") {
    detail = `成员回 target=${data.target || "?"} ${data.ok ? "ok" : "FAIL"}${data.status ? ` status=${data.status}` : ""}${data.ms ? ` ${data.ms}ms` : ""}${data.respChars ? ` resp=${data.respChars}B` : ""} ${safeText(data.error || data.respBody || "", 200)}`;
  } else if (type === "relay-fail") {
    detail = `中继失败 target=${data.target || "?"} group=${data.group || "-"} via=${data.via || "-"}${data.status ? ` status=${data.status}` : ""} ${safeText(data.message || "")}`;
  } else if (type === "relay-miss") {
    detail = `宽带中继无候选可试（全部候选未通/无存活成员，交回本地兜底）`;
  } else if (type === "peer-race-start") {
    detail = `组员竞速开始 peers=${data.peers ?? "-"}`;
  } else if (type === "peer-budget-out") {
    detail = `组员竞速预算用尽 reason=${safeText(data.reason || "", 80)} budgetMs=${data.budgetMs ?? "-"} remaining=${data.remaining ?? "-"}`;
  } else if (type === "peer-skip-slow") {
    detail = `跳过过慢组员 peer=${data.peer || "?"} 历史延迟=${data.latencyMs ?? "-"}ms > 上限=${data.capMs ?? "-"}ms`;
  } else detail = safeText(`${decisionKv(data)} ${data.message || data.error || ""}`, 200);
  return `[${base.time}] [req=${base.req}] [model=${base.model}] [stage=${base.stage}] ${detail}`;
}

/**
 * 按字节从尾部回退（不截半行）。行有长有短，固定行数 = 固定容量 ⇒ 一次裁剪就是断崖。
 * 与 logs.js 的 keepTailByBytes 同口径（那边不导出，这里留一份最小实现，避免为一行日志反向依赖）。
 */
function keepTailByBytes(text, maxBytes) {
  const limit = Math.max(1, Math.floor(maxBytes * TRACE_KEEP_RATIO));
  if (Buffer.byteLength(text) <= limit) return text;
  const lines = text.split("\n");
  let bytes = 0;
  let i = lines.length - 1;
  for (; i >= 0; i--) {
    const b = Buffer.byteLength(lines[i]) + 1;
    if (bytes + b > limit) break;
    bytes += b;
  }
  // 至少保留最后一条：单行超 limit 时否则返回空串 = 清空整个 trace。
  // 判据是「结果为空」——文件尾有换行时 split 的最后一个元素是空串，`i === lines.length-1` 判不到内容行。
  const kept = lines.slice(i + 1).join("\n");
  if (!kept) {
    const nonEmpty = lines.filter((l) => l !== "");
    if (nonEmpty.length) return nonEmpty[nonEmpty.length - 1];
  }
  return kept;
}

export function appendModelTrace(model, entry, { file = modelLogFile(model) } = {}) {
  const line = `${formatModelTrace(entry)}\n`;
  try {
    mkdirSync(logDir(), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_TRACE_BYTES) {
      // 按字节留 3/4，不再固定砍到 100 行（那一次就丢 98% 历史，见 TRACE_KEEP_RATIO 注释）。
      const kept = keepTailByBytes(readFileSync(file, "utf8"), MAX_TRACE_BYTES);
      // 末尾补换行：下一次 appendFileSync 才不会把新行接到半截行尾巴上
      writeFileSync(file, kept.endsWith("\n") ? kept : `${kept}\n`);
    }
    appendFileSync(file, line);
  } catch {
    // Logging must never affect the chat request.
  }
}
