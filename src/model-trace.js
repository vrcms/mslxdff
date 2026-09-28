// Per-model request trace formatting. Never include prompt, response body, headers or credentials.
// Note: 同步 appendFileSync（异步 append 会在并发下打乱同一请求的阶段行序）— 见 .agents/notes/implemented/feature/2026-09-25-model-trace-log.md
// Note: 事件面用黑名单（默认全可见，只排除噪声/敏感面）+ 决定类事件只渲染登记过的标量字段——起因是 empty-turn-retry 曾被阶段白名单静默吞掉，"关键决定不许再被漏登记" — 见 .agents/notes/implemented/feature/2026-09-27-qoder-per-request-sticky-account.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "./logs.js";
import { fmtShanghaiYMDHMS } from "./time.js";

const MAX_TRACE_BYTES = 1024 * 1024;

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
  "retry", "max", "delayMs", "upstream", "account", "pick", "cooled",
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

// provider 回显头 → 日志字段（谁上的 / 打哪个站 / 为什么选它 / 是否被冷却）：
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
  };
}

export function formatModelTrace({ type, reqId, model, data = {}, request = null, totalMs = null } = {}) {
  const base = { time: fmtShanghaiYMDHMS(new Date()), req: reqId || "-", model: model || "-", stage: type || "-" };
  let detail = "";
  if (type === "request") detail = `incoming ${kv({ ...(request || summarizeRequest(data.body)), hops: data.hops, useAuto: data.useAuto })}`;
  else if (type === "ordered") detail = `route order=${(data.order || []).join(" | ")} hops=${data.hops ?? "-"} fallback=${data.canFallback ? 1 : 0}`;
  else if (type === "model-try") detail = `target=${data.model || model || "-"} idx=${data.idx ?? "-"} remaining=${data.remaining ?? "-"}`;
  else if (type === "alias") detail = `rawModel=${data.rawModel || "-"} requested=${data.requested || model || "-"}`;
  else if (type === "exhausted-local" || type === "exhausted-all") detail = `last=${data.lastModel || model || "-"} status=${data.lastStatus ?? "-"} order=${(data.order || []).join(" | ")}`;
  else if (type === "upstream-try") detail = `target=${data.model || model || "-"} attempt=${data.attempt ?? "-"} payload=${kv(data.payload || {})}`;
  else if (type === "upstream-done" || type === "upstream-error") detail = `upstream status=${data.status ?? "-"} timing=${data.timing?.totalMs ?? "-"}ms${data.upstream ? ` via=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""}${data.cooled ? ` cooled=${data.cooled}` : ""} ${safeText(data.message || data.error || "")}`;
  else if (type === "empty-turn-retry") detail = `retry ${data.retry ?? "-"}/${data.max ?? "-"} delay=${data.delayMs ?? "-"}ms${data.upstream ? ` after=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""} reason=empty turn`;
  else if (type === "peer-request" || type === "peer-forward" || type === "peer-error") detail = `peer=${hostPort(data.peer)} status=${data.status ?? "-"} latency=${data.latencyMs ?? "-"}ms payload=${kv(data.payload || {})} ${safeText(data.message || data.error || "")}`;
  else if (type === "relay-done") {
    const d = data.detail || {};
    const u = d.usage || {};
    detail = `upstream_response status=${data.status ?? "-"} finish=${d.sawFinishReason || "-"} chunks=${d.receivedChunks ?? "-"} bytes=${d.receivedBytes ?? "-"} tools=${d.toolCalls ?? 0} chars=${d.chars ?? 0} usage(prompt=${u.prompt_tokens ?? "-"}/completion=${u.completion_tokens ?? "-"}) elapsed=${data.totalMs ?? "-"}ms${data.upstream ? ` upstream=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""}`;
  } else if (type === "result" || type === "client-response") {
    detail = `client status=${data.status ?? "-"} via=${data.via || "-"} actual=${data.actual || model || "-"} fallback=${data.fallback?.fallback ? 1 : 0} total=${totalMs ?? data.durationMs ?? "-"}ms${data.upstream ? ` upstream=${data.upstream}` : ""}${data.account ? ` account=${data.account}` : ""}${data.pick ? ` pick=${data.pick}` : ""}`;
  } else detail = safeText(`${decisionKv(data)} ${data.message || data.error || ""}`, 200);
  return `[${base.time}] [req=${base.req}] [model=${base.model}] [stage=${base.stage}] ${detail}`;
}

export function appendModelTrace(model, entry, { file = modelLogFile(model) } = {}) {
  const line = `${formatModelTrace(entry)}\n`;
  try {
    mkdirSync(logDir(), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_TRACE_BYTES) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      writeFileSync(file, lines.slice(-100).join("\n") + "\n");
    }
    appendFileSync(file, line);
  } catch {
    // Logging must never affect the chat request.
  }
}
