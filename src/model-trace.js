// Per-model request trace formatting. Never include prompt, response body, headers or credentials.
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
const TRACE_STAGES = new Set([
  "request", "alias", "ordered", "model-try", "upstream-try", "upstream-done", "upstream-error",
  "peer-request", "peer-forward", "peer-error", "relay-start", "relay-first-chunk", "relay-done",
  "client-response", "result", "exhausted-local", "exhausted-all",
]);

export function shouldTraceModel(type) {
  return TRACE_STAGES.has(String(type || ""));
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

export function formatModelTrace({ type, reqId, model, data = {}, request = null, totalMs = null } = {}) {
  const base = { time: fmtShanghaiYMDHMS(new Date()), req: reqId || "-", model: model || "-", stage: type || "-" };
  let detail = "";
  if (type === "request") detail = `incoming ${kv({ ...(request || summarizeRequest(data.body)), hops: data.hops, useAuto: data.useAuto })}`;
  else if (type === "ordered") detail = `route order=${(data.order || []).join(" | ")} hops=${data.hops ?? "-"} fallback=${data.canFallback ? 1 : 0}`;
  else if (type === "model-try") detail = `target=${data.model || model || "-"} idx=${data.idx ?? "-"} remaining=${data.remaining ?? "-"}`;
  else if (type === "alias") detail = `rawModel=${data.rawModel || "-"} requested=${data.requested || model || "-"}`;
  else if (type === "exhausted-local" || type === "exhausted-all") detail = `last=${data.lastModel || model || "-"} status=${data.lastStatus ?? "-"} order=${(data.order || []).join(" | ")}`;
  else if (type === "upstream-try") detail = `target=${data.model || model || "-"} attempt=${data.attempt ?? "-"} payload=${kv(data.payload || {})}`;
  else if (type === "upstream-done" || type === "upstream-error") detail = `upstream status=${data.status ?? "-"} timing=${data.timing?.totalMs ?? "-"}ms ${safeText(data.message || data.error || "")}`;
  else if (type === "peer-request" || type === "peer-forward" || type === "peer-error") detail = `peer=${hostPort(data.peer)} status=${data.status ?? "-"} latency=${data.latencyMs ?? "-"}ms payload=${kv(data.payload || {})} ${safeText(data.message || data.error || "")}`;
  else if (type === "relay-done") {
    const d = data.detail || {};
    const u = d.usage || {};
    detail = `upstream_response status=${data.status ?? "-"} finish=${d.sawFinishReason || "-"} chunks=${d.receivedChunks ?? "-"} bytes=${d.receivedBytes ?? "-"} tools=${d.toolCalls ?? 0} chars=${d.chars ?? 0} usage(prompt=${u.prompt_tokens ?? "-"}/completion=${u.completion_tokens ?? "-"}) elapsed=${data.totalMs ?? "-"}ms`;
  } else if (type === "result" || type === "client-response") {
    detail = `client status=${data.status ?? "-"} via=${data.via || "-"} actual=${data.actual || model || "-"} fallback=${data.fallback?.fallback ? 1 : 0} total=${totalMs ?? data.durationMs ?? "-"}ms`;
  } else detail = safeText(data.message || data.reason || data.error || "");
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
