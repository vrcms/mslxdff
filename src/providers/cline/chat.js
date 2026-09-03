import { joinUrl, sleep } from "../base.js";
import { clineHeaders } from "./headers.js";
import { createTransport } from "../../transport/index.js";

function genSessionId() { return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage || d.output) return d;
  }
  return obj;
}

async function streamToNonStream(upstream) {
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let model = "";
  let id = "";
  let usage = null;
  for await (const ev of upstream.stream()) {
    if (!ev || ev === "[DONE]") continue;
    try {
      const obj = JSON.parse(ev);
      const normalized = unwrapData(obj);
      const choice = normalized?.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) content += delta.content;
      if (delta.reasoning) reasoning += delta.reasoning;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (normalized.id) id = normalized.id;
      if (normalized.model) model = normalized.model;
      if (normalized.usage) usage = normalized.usage;
    } catch {}
  }
  const msg = { role: "assistant", content };
  if (reasoning) msg.reasoning = reasoning;
  if (!content && reasoning) { msg.content = reasoning; msg.reasoning_used_as_content = true; }
  return {
    id: id || `gen_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "",
    choices: [{ index: 0, message: msg, finish_reason: finishReason || "stop", logprobs: null, native_finish_reason: finishReason || "stop" }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function createChatService({
  id,
  baseUrl,
  chatPath,
  fetchImpl,
  dispatcher,
  authPool,
  connectTimeoutMs = 30_000,
} = {}) {
  const resolvedBase = String(baseUrl).trim().replace(/\/+$/, "");
  const resolvedChat = chatPath || (String(resolvedBase).includes("/api/v1") ? "/chat/completions" : "/api/v1/chat/completions");
  const transport = createTransport({ fetchImpl, dispatcher, keepAlive: !!dispatcher, timeoutMs: connectTimeoutMs, retry: {} });

  async function clineFetch(body, sessionId) {
    const token = await authPool.getAccessToken();
    const headers = clineHeaders(sessionId, token);
    const finalUrl = joinUrl(resolvedBase, resolvedChat);
    const isStream = body?.stream === true;
    return transport.request({ url: finalUrl, headers, body, stream: isStream, timeoutMs: connectTimeoutMs });
  }

  function isLimitHit(status, bodyText) {
    if (status === 429) return true;
    if (status >= 500 && String(bodyText).includes("empty response content")) return true;
    return false;
  }

  async function clineFetchWithRetry(body, sessionId) {
    const maxRetries = 4;
    let lastResp = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const resp = await authPool.enqueue(() => clineFetch(body, sessionId));
      lastResp = resp;
      let bodyText = "";
      if (resp.status !== 200) { try { bodyText = await resp.text(); } catch {} }
      const hit = isLimitHit(resp.status, bodyText);
      if (hit) {
        const { parseCooldown } = await import("./auth.js");
        const cooldownMs = parseCooldown(bodyText, resp.status);
        const cur = authPool.getCurrentAccount();
        if (cur) { cur.cooldownUntil = Date.now() + cooldownMs; cur.accessToken = null; cur.expiry = 0; }
        const pool = authPool.getAccounts();
        const hasOther = pool.some((a) => !a.cooldownUntil || a.cooldownUntil <= Date.now());
        if (!hasOther) return resp;
        await sleep(500 + Math.floor(Math.random() * 500));
        continue;
      }
      if (resp.ok) return resp;
      return resp;
    }
    return lastResp;
  }

  async function nonStreamWithContentCheck(body, sessionId, firstResp) {
    const maxAttempts = 3;
    let lastData = null;
    let resp = firstResp;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!resp) resp = await clineFetchWithRetry(body, sessionId);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        const hdrs = new Headers(resp.headers);
        const errBody = JSON.stringify({ error: { message: errText.slice(0, 500), type: "api_error" } });
        return { error: new Response(errBody, { status: resp.status, headers: hdrs }) };
      }
      const ct = resp.headers.get("content-type") || "";
      let normalized = null;
      if (ct.includes("text/event-stream")) normalized = await streamToNonStream(resp);
      else {
        const raw = await resp.json().catch(() => null);
        if (raw) normalized = unwrapData(raw);
      }
      if (!normalized) return { error: new Response(JSON.stringify({ error: { message: "upstream returned non-SSE body", type: "api_error" } }), { status: 502 }) };
      lastData = normalized;
      const msg = normalized?.choices?.[0]?.message || {};
      const content = String(msg.content || "").trim();
      const reasoning = String(msg.reasoning || "").trim();
      const isFallback = msg.reasoning_used_as_content === true;
      if (content && !isFallback) return { data: normalized };
      if (reasoning || isFallback) {
        const cur = authPool.getCurrentAccount();
        if (cur) { cur.cooldownUntil = Date.now() + 30 * 1000; cur.accessToken = null; cur.expiry = 0; }
        await sleep(300 + Math.floor(Math.random() * 300));
        resp = null;
        continue;
      }
      await sleep(300 + Math.floor(Math.random() * 300));
      resp = null;
    }
    return { data: lastData };
  }

  async function runChat(body, ring, sourceKey) {
    const model = body?.model || "deepseek/deepseek-v4-flash";
    const sessionId = genSessionId();
    const isStream = body?.stream === true;
    const upstreamModel = String(model).split("/").pop().includes(":") ? model : model;
    const upstreamBody = {
      model: upstreamModel,
      max_tokens: body?.max_tokens || body?.max_completion_tokens || 4096,
      session_id: sessionId,
      reasoning_effort: body?.reasoning_effort || body?.reasoningEffort || "high",
      messages: body?.messages || [],
    };
    const forceStream = !isStream && String(upstreamModel).startsWith("deepseek/");
    if (isStream || forceStream) upstreamBody.stream = true;
    for (const k of ["temperature", "top_p", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"]) {
      if (body[k] !== undefined) upstreamBody[k] = body[k];
    }
    for (let netAttempt = 0; netAttempt < 3; netAttempt++) {
      try {
        const resp = await clineFetchWithRetry(upstreamBody, sessionId);
        if (!resp) throw new Error("empty response");
        if (!resp.ok) return resp;
        if (isStream) return resp;
        if (forceStream) {
          const ret = await nonStreamWithContentCheck(upstreamBody, sessionId, resp);
          if (ret.error) return ret.error;
          ret.data.model = model;
          const hdrs = new Headers({ "Content-Type": "application/json" });
          return new Response(JSON.stringify(ret.data), { status: 200, headers: hdrs });
        }
        const raw = await resp.json().catch(() => null);
        if (!raw) return resp;
        const normalized = unwrapData(raw);
        normalized.model = model;
        return new Response(JSON.stringify(normalized), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (err) {
        if (netAttempt < 2 && String(err?.message || "").toLowerCase().includes("timed out")) { await sleep(300); continue; }
        throw err;
      }
    }
    throw new Error("cline chat failed after retries");
  }

  return { runChat, streamToNonStream, _clineFetch: clineFetch };
}
