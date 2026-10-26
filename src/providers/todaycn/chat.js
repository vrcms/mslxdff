// todaycn 单次上游尝试（不含轮换）：一枚 refreshCredential → 一次 POST /v1/messages + 轮询 /v2/messages。
// 失败经内部头 x-mslxdff-todaycn-kind 交回 index.js 决定冷却档位（对齐 zcode/agentrouter 的分工）：
//   auth（号失效）| quota（限流/额度）| empty（发出去但超时无 final 回复）| server | network | param | unknown
//
// 实测约束（别再改回去）：
//   1) 无流式：上游 202 + GET 轮询；客户端要 stream:true 时由 sse.js 自造帧。
//   2) threadId 续写无效（消息不落库、无回复）→ 每轮新建 thread，历史全部重放进 content。
//   3) 轮询按 originClientMessageId 认自己的回复；认不到再退化为「发送时间之后的最新 final」。

import { compatFetch, uuid } from "../../compat.js";
import { buildTodaycnContent, parseTodaycnReply } from "./prompt.js";
import { completionToResponse } from "./sse.js";
import {
  TODAYCN_API_BASE,
  TODAYCN_APP_VERSION,
  TODAYCN_CAPABILITIES,
  TODAYCN_CLIENT_PLATFORM,
  TODAYCN_DEFAULT_DEVICE_ID,
  TODAYCN_POLL_INTERVAL_MS,
  TODAYCN_POLL_TIMEOUT_MS,
  TODAYCN_UA,
} from "./const.js";

export const TODAYCN_KIND_HEADER = "x-mslxdff-todaycn-kind";
export const TODAYCN_ACCOUNT_HEADER = "x-mslxdff-todaycn-account";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function classifyStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status >= 500) return "server";
  if (status >= 400) return "param";
  return "unknown";
}

function errRes(status, msg, kind = "", extra = {}) {
  return new Response(JSON.stringify({ error: { message: msg, type: kind || "upstream_error" } }), {
    status,
    headers: { "Content-Type": "application/json", ...(kind ? { [TODAYCN_KIND_HEADER]: kind } : {}), ...extra },
  });
}

export function withHeaders(res, extra = {}) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== "") h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

export function buildHeaders(token, deviceId) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": TODAYCN_UA,
    Origin: "https://todayai.cn",
    Accept: "application/json",
    "Content-Type": "application/json",
    "Accept-Language": "zh-CN",
    "X-App-Version": TODAYCN_APP_VERSION,
    "X-Client-Platform": TODAYCN_CLIENT_PLATFORM,
    "X-Device-Id": deviceId || TODAYCN_DEFAULT_DEVICE_ID,
    "X-Client-Capabilities": TODAYCN_CAPABILITIES,
  };
}

/** HTTP 通道（可注入 exchange 顶掉，便于单测不触网）。 */
export function createTodaycnHttp({ fetchImpl, apiBase = TODAYCN_API_BASE } = {}) {
  const call = fetchImpl || compatFetch;
  async function send(payload, token, deviceId) {
    const res = await call(`${apiBase}/v1/messages`, { method: "POST", headers: buildHeaders(token, deviceId), body: JSON.stringify(payload) });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }
  async function poll(threadId, token, deviceId) {
    const res = await call(`${apiBase}/v2/messages?threadId=${encodeURIComponent(threadId)}&limit=20`, { headers: buildHeaders(token, deviceId) });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }
  return { send, poll };
}

/** 从列表里认这一轮的最终回复：优先 originClientMessageId 命中，退化为发送时间后的最新 final。 */
export function pickFinalReply(json, clientMessageId, sinceIso = "") {
  const data = Array.isArray(json?.data) ? json.data : [];
  const finals = data.filter((m) => m?.role === "assistant" && m?.isFinal);
  const mine = finals.filter(
    (m) => m.originClientMessageId === clientMessageId ||
      (Array.isArray(m.originClientMessageIds) && m.originClientMessageIds.includes(clientMessageId)),
  );
  if (mine.length) return mine[mine.length - 1];
  const after = finals.filter((m) => !sinceIso || String(m.createdAt || "") >= sinceIso);
  return after.length ? after[after.length - 1] : null;
}

/** v2 typed 正文在 messages[].content.text；v1 legacy 在 content 字符串。 */
export function messageText(m) {
  if (Array.isArray(m?.messages) && m.messages.length) {
    return m.messages.map((p) => String(p?.content?.text ?? p?.text ?? "")).join("\n");
  }
  return String(m?.content ?? "");
}

/**
 * 单次尝试。返回 Response：
 *   成功 = 200（stream:true 出 SSE，否则 JSON chat.completion；带 x-mslxdff-todaycn-account 回显号）
 *   失败 = 非 200 + x-mslxdff-todaycn-kind（auth/quota/empty/server/network/param/unknown）
 */
export async function forwardTodaycnChat({
  body = {},
  credential,
  uid = "",
  deviceId = "",
  tokenStore,
  exchange,
  fetchImpl,
  pollIntervalMs = TODAYCN_POLL_INTERVAL_MS,
  pollTimeoutMs = TODAYCN_POLL_TIMEOUT_MS,
  contentMaxChars,
  clock = Date.now,
} = {}) {
  const ex = exchange || createTodaycnHttp({ fetchImpl });
  const tok = await tokenStore.getToken(credential);
  if (!tok.ok) {
    const kind = tok.authFailed ? "auth" : "network";
    return errRes(tok.authFailed ? 401 : 502, `todaycn: 令牌获取失败（${tok.reason}）`, kind);
  }
  const model = String(body.model || "");
  const content = buildTodaycnContent({ messages: body.messages || [], tools: body.tools || [], model, maxChars: contentMaxChars });
  const clientMessageId = uuid();
  const sent = await ex.send({ clientMessageId, messageType: "text", content, sourceDeviceId: deviceId || undefined }, tok.token, deviceId);
  if (sent.status !== 202) {
    const kind = classifyStatus(sent.status);
    return errRes(kind === "auth" ? 401 : kind === "quota" ? 429 : kind === "param" ? 400 : 502,
      `todaycn: 发送失败 ${sent.status} ${String(sent.text || "").slice(0, 200)}`, kind);
  }
  const threadId = String(sent.json?.threadId || "");
  if (!threadId) return errRes(502, "todaycn: 202 响应里没有 threadId", "unknown");
  const sinceIso = String(sent.json?.createdAt || "");

  const deadline = clock() + pollTimeoutMs;
  let lastPollStatus = 0;
  while (clock() < deadline) {
    await sleep(pollIntervalMs);
    const p = await ex.poll(threadId, tok.token, deviceId);
    lastPollStatus = p.status;
    if (p.status === 401 || p.status === 403) return errRes(401, `todaycn: 轮询授权失效 ${p.status}`, "auth");
    if (p.status !== 200) continue;
    const hit = pickFinalReply(p.json, clientMessageId, sinceIso);
    if (!hit) continue;
    const parsed = parseTodaycnReply(messageText(hit));
    const completion = {
      id: `chatcmpl_${String(hit.id || uuid()).replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`,
      object: "chat.completion",
      created: Math.floor(new Date(hit.createdAt || clock()).getTime() / 1000) || Math.floor(clock() / 1000),
      model: model || "todaycn",
      choices: [{
        index: 0,
        message: { role: "assistant", content: parsed.content || null, ...(parsed.tool_calls.length ? { tool_calls: parsed.tool_calls } : {}) },
        logprobs: null,
        finish_reason: parsed.tool_calls.length ? "tool_calls" : "stop",
      }],
    };
    const res = completionToResponse(completion, { stream: body.stream === true });
    return withHeaders(res, { [TODAYCN_ACCOUNT_HEADER]: uid, "x-mslxdff-todaycn-strict": parsed.strict ? "1" : "0" });
  }
  return errRes(504, `todaycn: 上游 ${Math.round(pollTimeoutMs / 1000)}s 内没有给出最终回复（轮询末次状态 ${lastPollStatus}）`, "empty");
}