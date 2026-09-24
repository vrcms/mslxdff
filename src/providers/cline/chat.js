import { joinUrl, sleep } from "../base.js";
import { appendEvent } from "../../logs.js";
import { createHash } from "node:crypto";
import { clineHeaders } from "./headers.js";
import { createTransport } from "../../transport/index.js";
import { normalizeProviderId } from "../model-id.js";
import { recordLimit, recordOutput, exactOutputTokens } from "./usage.js";
import { createSdkDispatch } from "../../upstream-engine/sdk/dispatch.js";

function genSessionId() { return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

// 只记哈希标识，不落邮箱 / refreshToken（events.log 可读不可泄）
function acctId(account) {
  const seed = String(account?.refreshToken || "");
  if (!seed) return "slot-unknown";
  return `acct_${createHash("sha256").update(seed).digest("hex").slice(0, 8)}`;
}
// 池子快照：ready/cooling 按「该模型」口径统计（ready=对该模型可用的号数）。
// isReady 由调用方注入 authPool.accountAvailable(a, model)，避免与 auth 逻辑分叉。
function poolStat(pool, isReady = () => true) {
  let cooling = 0;
  let dead = 0;
  for (const a of pool || []) {
    if (a.dead) dead++;
    else if (!isReady(a)) cooling++;
  }
  const total = (pool || []).length;
  return { total, cooling, dead, ready: total - cooling - dead };
}

// 429 错误体自带权威模型名（"...Daily free limit reached on model meta/muse-spark-1.3-contributor"）。
function limitModelOf(bodyText) {
  // 模型名可含 / . - _ : 字母数字（如 meta/muse-spark-1.3-contributor），
  // 遇空格/引号/逗号/句号结尾或 "Try again" 前的空白即停。
  const m = String(bodyText || "").match(/on model\s+([A-Za-z0-9/._:-]+?)(?=[\s"',]|\.\s|$)/i);
  return m ? m[1] : "";
}

// stripProviderPrefix 只剥「本供应商」前缀（cline/<裸 id> → 裸 id），非本前缀（含上游自带多段 id
// 如 meta/vendor/x）原样透传，不误削首段（旧实现按段数剥曾是潜在 bug）。
function stripProviderPrefix(model, providerId) {
  const s = String(model || "");
  const i = s.indexOf("/");
  if (i <= 0) return s;
  const low = (v) => normalizeProviderId(String(v || "").toLowerCase());
  return low(s.slice(0, i)) === low(providerId) ? s.slice(i + 1) : s;
}
function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage || d.output) return d;
  }
  return obj;
}

async function streamToNonStream(upstream, track = null) {
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
  if (track) {
    const exact = exactOutputTokens(usage);
    if (exact) track({ tokens: exact, estimated: false });
    else if (content || reasoning) track({ tokens: Math.ceil((content.length + reasoning.length) / 4), estimated: true });
  }
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
  const sdk = createSdkDispatch({ id, providerName: id || "cline" });

  async function clineFetch(body, sessionId, allowSdk = false) {
    const token = await authPool.getAccessToken(body?.model);
    appendEvent({ type: "cline-account-state", provider: id || "cline", state: "selected", accountId: acctId(authPool.getCurrentAccount()), model: body?.model, pool: poolStat(authPool.getAccounts(), (a) => authPool.accountAvailable(a, body?.model)) });
    const headers = clineHeaders(sessionId, token);
    const finalUrl = joinUrl(resolvedBase, resolvedChat);
    const isStream = body?.stream === true;
    // SDK 通道（缺省）：仅客户端显式流式；forceStream 聚合与非流式保持原生（避免丢 nonStreamWithContentCheck）。
    if (allowSdk && sdk.enabled) {
      const r = await sdk.trySdk({ url: finalUrl, body, headers, fetchImpl });
      if (r) return r;
    }
    return transport.request({ url: finalUrl, headers, body, stream: isStream, timeoutMs: connectTimeoutMs });
  }
  // 记账回调：捕获当前账号哈希，成功输出进当前额度周期
  const track = (model) => ({ tokens, estimated }) => recordOutput({ accountId: acctId(authPool.getCurrentAccount()), model, tokens, estimated }).catch(() => {});

  function isLimitHit(status, bodyText) {
    if (status === 429) return true;
    if (status >= 500 && String(bodyText).includes("empty response content")) return true;
    return false;
  }

  async function clineFetchWithRetry(body, sessionId, allowSdk = false) {
    const maxRetries = 4;
    let lastResp = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const resp0 = await authPool.enqueue(() => clineFetch(body, sessionId, allowSdk));
      let resp = resp0;
      let bodyText = "";
      if (resp.status !== 200) {
        try { bodyText = await resp.text(); } catch {}
        // 错误响应体已在此读走：原生 transport 的 text() 有缓存，而 SDK Response 的 body 一次性，
        // 重建以便上层/客户端仍能读到错误详情（如 429 的 INFERENCE_CAP_ERROR）。
        try {
          resp = new Response(bodyText, { status: resp0.status, statusText: resp0.statusText, headers: new Headers(resp0.headers) });
        } catch {}
      }
      lastResp = resp;
      const hit = isLimitHit(resp.status, bodyText);
      if (hit) {
        const { parseCooldown } = await import("./auth.js");
        const cooldownMs = parseCooldown(bodyText, resp.status);
        const cur = authPool.getCurrentAccount();
        // 免费额度按「账号 × 模型」计：只把该模型挂到这个号上（limits[model]），
        // 不动账号级 cooldownUntil、不清 accessToken——同号其它模型照常可用。
        authPool.markLimit(cur, body?.model, cooldownMs);
        const limitedModel = limitModelOf(bodyText);
        if (limitedModel && limitedModel !== body?.model) authPool.markLimit(cur, limitedModel, cooldownMs);
        const cycle = await recordLimit({ accountId: acctId(cur), model: body?.model, reason: resp.status === 429 ? "daily_limit" : "empty_response", status: resp.status, cooldownMs });
        const pool = authPool.getAccounts();
        const ready = (a) => authPool.accountAvailable(a, body?.model);
        const hasOther = pool.some(ready);
        // 限流是「账号 × 模型」维度：429 只说明当前账号在这个模型上额度用尽，
        // 换模型（如 muse-spark → deepseek）往往仍可用，故日志必须点名模型。
        appendEvent({
          type: "cline-account-state",
          provider: id || "cline",
          state: hasOther ? "switch" : "pool-exhausted",
          accountId: acctId(cur),
          model: body?.model,
          limitedModel: limitedModel || undefined,
          scope: "model",
          reason: resp.status === 429 ? "daily_limit" : "empty_response",
          status: resp.status,
          cooldownMs,
          pool: poolStat(pool, ready),
          cycleOutputTokens: cycle?.cycleOutputTokens ?? 0,
          cycleCount: cycle?.cycleCount ?? 0,
        });
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
      if (ct.includes("text/event-stream")) normalized = await streamToNonStream(resp, track(body?.model));
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
        // 空响应是「模型 × 通道」形态问题（deepseek 非流式特性），同样只挡该模型。
        authPool.markLimit(cur, body?.model, 30 * 1000);
        appendEvent({ type: "cline-account-state", provider: id || "cline", state: "cooldown", accountId: acctId(cur), model: body?.model, reason: "empty_response", cooldownMs: 30000, scope: "model", pool: poolStat(authPool.getAccounts(), (a) => authPool.accountAvailable(a, body?.model)) });
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
    const upstreamModel = stripProviderPrefix(model, id);
    // token 上限对标 dsh-cline-pass（DEFAULT_MAX_TOKENS=32000）：客户端显式 max 优先，
    // 缺省给 32000 而非 4096——旧 4096 默认会在长文处 finish=length 拦腰截断（2026-09-23 实测）。
    // reasoning_effort 缺省不发（dsh 同款：调用方自选 none→max，不替上游做 high 假设；
    // 高推理+小预算双挤是超大上下文秒回超短答的推手之一）；max_completion_tokens 双写保留
    //（只发 max_tokens 会被部分通道拒，历史教训）。
    const tokLimit = body?.max_tokens || body?.max_completion_tokens || 32000;
    const upstreamBody = {
      model: upstreamModel,
      max_tokens: tokLimit,
      max_completion_tokens: tokLimit,
      session_id: sessionId,
      messages: body?.messages || [],
    };
    const effort = body?.reasoning_effort || body?.reasoningEffort;
    if (effort) upstreamBody.reasoning_effort = effort;
    // 部分免费通道（deepseek 家族，含 cline-free/deepseek-*）原生非流式不可靠
    //（500 empty response）：这类模型在内部走 stream+聚合成 JSON，对外仍按请求方
    // stream 标志返回（true 直透，false 聚合）。其它模型完全尊重请求方，不强制。
    const forceStream = !isStream && String(upstreamModel).toLowerCase().includes("deepseek");
    if (isStream || forceStream) upstreamBody.stream = true;
    for (const k of ["temperature", "top_p", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"]) {
      if (body[k] !== undefined) upstreamBody[k] = body[k];
    }
    for (let netAttempt = 0; netAttempt < 3; netAttempt++) {
      try {
        const resp = await clineFetchWithRetry(upstreamBody, sessionId, isStream);
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
        if (!raw || typeof raw !== "object") {
          if (!raw) return resp;
          return new Response(JSON.stringify({ error: { message: "upstream returned non-JSON body", type: "api_error" } }), { status: 502, headers: { "Content-Type": "application/json" } });
        }
        const normalized = unwrapData(raw);
        normalized.model = model;
        // 非流式终点：正文估算记账（上游有 usage 时 streamToNonStream 路径才拿得到精确值；此处 raw 无流）
        const m2 = normalized?.choices?.[0]?.message || {};
        const outLen2 = String(m2.content || "").length + String(m2.reasoning || "").length;
        if (outLen2 > 0) track(model)({ tokens: Math.ceil(outLen2 / 4), estimated: true });
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
