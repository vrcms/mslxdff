// raccoon 流处理：上游就是 OpenAI 形（`/api/web/llm/v2/chat/completions`），
// 因此**不做协议转换**——本文件只做三件事：形状判定、错误信封分类、非流式聚合。
// 流式路径直接把上游 body 透传（逐字节），避免任何整形引入的失真。
import { createSseParser } from "../../transport/sse.js";
import { isRaccoonAuthFailure, parseRaccoonEnvelope, raccoonEnvelopeText } from "./envelope.js";

/**
 * 额度类措辞（业务码未取证，见 ADR-0050 决策 8）：**宁可漏判也不误报**。
 * 刻意不收裸 `insufficient`/`balance`/`points` —— 那些词会命中「权限不足」这类非额度错，
 * 一旦误判成 quota 就会长冷 1h 并回 429 `quota_exhausted`，违反 ADR-0044 的「非额度原因不得谎报」。
 */
const QUOTA_HINTS = /(积分|额度|quota|欠费)/i;

export function isRaccoonSseContentType(value) {
  return String(value || "").includes("text/event-stream");
}

function isQuotaLike(envelope) {
  const text = `${envelope?.message ?? ""} ${envelope?.details ?? ""}`;
  if (QUOTA_HINTS.test(text)) return true;
  return envelope?.status === 402;
}

/**
 * 失败分类 → `{ kind, code, status, message }`。
 * kind 取值：auth（重登）/ quota（长冷却）/ rate_limit（短冷却）/ server（上游 5xx，短冷却）/ unknown（4xx 如实透出）。
 */
export function classifyRaccoonFailure(status, payload) {
  const envelope = parseRaccoonEnvelope(payload, status);
  let kind = "unknown";
  if (isRaccoonAuthFailure(envelope, status)) kind = "auth";
  else if (isQuotaLike(envelope)) kind = "quota";
  else if (status === 429) kind = "rate_limit";
  else if (status >= 500) kind = "server";
  return { kind, code: envelope.code, status, message: raccoonEnvelopeText(envelope, `HTTP ${status}`) };
}

const ERROR_MAP = {
  auth: { status: 401, type: "auth_error", text: (f) => `raccoon: 登录态已失效${f.code ? `（code ${f.code}）` : ""}。请运行 mslxdff -provider raccoon login 重新登录` },
  quota: { status: 429, type: "quota_exhausted", text: (f) => `raccoon: 积分不足${f.message ? `（${f.message}）` : ""}。请运行 mslxdff -provider raccoon checkin 领取每日积分，或更换账号` },
  rate_limit: { status: 429, type: "rate_limited", text: () => "raccoon: 上游限流（账号冷却中），请稍后重试" },
  server: { status: 502, type: "upstream_error", text: (f) => `raccoon: 上游服务异常${f.code ? `（code ${f.code}）` : ""}${f.message ? `：${f.message}` : ""}` },
  // unknown 只覆盖 4xx（5xx 已被上面分流成 server）：按请求缺陷如实回 400，不谎报成网关故障
  unknown: { status: 400, type: "invalid_request", text: (f) => `raccoon: 上游拒绝请求（HTTP ${f.status || "?"}${f.code ? ` code ${f.code}` : ""}）${f.message ? `：${f.message}` : ""}` },
};

/** 失败 → Response（带 `x-mslxdff-raccoon-kind`，供工厂决定冷却档位）。 */
export function raccoonErrorResponse(fail = {}) {
  const kind = ERROR_MAP[fail.kind] ? fail.kind : "unknown";
  const entry = ERROR_MAP[kind];
  const headers = { "Content-Type": "application/json" };
  if (fail.kind) headers["x-mslxdff-raccoon-kind"] = fail.kind;
  return new Response(JSON.stringify({ error: { message: entry.text(fail), type: entry.type, code: fail.code || 0 } }), {
    status: entry.status,
    headers,
  });
}

/** 工具调用增量合并（对齐 `qwenwork/sse.js` 的 mergeToolCallDelta：id/type 取一次，name/arguments 追加）。 */
function mergeRaccoonToolCallDelta(merged, delta) {
  for (const key of ["id", "type"]) {
    if (merged[key] === undefined && typeof delta[key] === "string" && delta[key] !== "") merged[key] = delta[key];
  }
  const dfn = delta.function;
  if (!dfn || typeof dfn !== "object") return;
  if (!merged.function || typeof merged.function !== "object") merged.function = {};
  if (typeof dfn.name === "string" && dfn.name !== "") merged.function.name = (merged.function.name || "") + dfn.name;
  if (typeof dfn.arguments === "string" && dfn.arguments !== "") {
    merged.function.arguments = (merged.function.arguments || "") + dfn.arguments;
  }
}

/** 把 SSE 文本聚合成一条 OpenAI chat completion（非流式请求、以及「header 说是 JSON 但体是 SSE」时走这里）。 */
export async function aggregateRaccoonSse(text, { model } = {}) {
  const parser = createSseParser();
  // 聚合拿到的是**完整 body**（不是分片）：补一个定界符，否则末尾缺 `\n\n` 的最后一帧会被当半包丢掉
  const events = parser.push(`${String(text || "")}\n\n`);
  const content = [];
  const reasoning = [];
  const toolCalls = new Map();
  const toolOrder = [];
  let finishReason = "stop";
  let usage;
  let id = "";
  let created = 0;
  for (const raw of events) {
    if (raw === "[DONE]" || !raw) continue;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      continue;
    }
    // 流内错误信封：优先按失败分类返回，不要静默当成空回复
    if (payload?.code !== undefined && Number(payload.code) !== 0) {
      return { error: classifyRaccoonFailure(200, payload) };
    }
    if (payload?.error) {
      return { error: classifyRaccoonFailure(200, payload) };
    }
    if (!id && typeof payload?.id === "string") id = payload.id;
    if (!created && Number.isFinite(payload?.created)) created = Number(payload.created);
    if (payload?.usage) usage = payload.usage;
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
    const delta = choice?.delta ?? choice?.message;
    if (typeof delta?.content === "string" && delta.content.length > 0) content.push(delta.content);
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoning.push(delta.reasoning_content);
    for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
      if (!call || typeof call !== "object") continue;
      const idx = typeof call.index === "number" ? call.index : 0;
      if (!toolCalls.has(idx)) {
        toolCalls.set(idx, { index: idx });
        toolOrder.push(idx);
      }
      mergeRaccoonToolCallDelta(toolCalls.get(idx), call);
    }
    if (typeof choice?.finish_reason === "string" && choice.finish_reason.length > 0) finishReason = choice.finish_reason;
  }
  const message = { role: "assistant", content: content.join("") || null };
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("");
  if (toolOrder.length > 0) {
    toolOrder.sort((a, b) => a - b);
    message.tool_calls = toolOrder.map((idx) => toolCalls.get(idx));
  }
  return {
    openAi: {
      id: id || `chatcmpl-raccoon-${Date.now()}`,
      object: "chat.completion",
      created: created || Math.floor(Date.now() / 1000),
      model: model || "",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    },
  };
}
