// DeepSeek completion 编排：token→session→pow→completion→(流|聚合)→delete
// 超限分流：expert > 阈值 → 分块喂养 session（对齐 NIyueeE/ds-free-api 方案 B）；其余超限人话报错
// 风控语义参考 TQZHR/deepseek2api classifyProtocolResponse（MIT）
import { androidHeaders, solveChallenge, netRetry, DEEPSEEK_DEFAULT_BASE, DEEPSEEK_API_PREFIX } from "./pow.js";
import { COOLDOWN_PRESETS } from "./auth.js";
import { buildPrompt, mapModelToFlags, createDeepseekSseParser, buildUpstreamBody, promptThresholdFor, splitPromptChunks } from "./bridge.js";
import { createChatSession, deleteChatSession, feedChunkToSession } from "./session.js";
import { dsDebug, dsDump, dsError } from "./debug.js";

const CAPTCHA_PATTERN = /captcha|shumei|数美|验证码|风控|verification/i;
// user is muted：账号被禁言/风控（上游对 completion 直接拒），切账号冷却，禁言期间不再打上游
const MUTED_PATTERN = /user is muted|account is muted|\bmuted\b|禁言/i;
// 「消息发送过于频繁」= 禁言前兆（TQZHR/deepseek2api 同款识别），命中即冷却换号，避免小病拖成禁言
const FREQUENCY_PATTERN = /消息发送过于频繁[\s，,、:：]*请稍后重试/;

function classifyProtocolFailure(text, status) {
  const t = String(text || "");
  if (FREQUENCY_PATTERN.test(t)) {
    return upstreamError("DeepSeek 上游提示「消息发送过于频繁」：该账号触发频率风控（禁言前兆），已自动冷却并切换账号", { status, rotateAuth: true, cooldownMs: COOLDOWN_PRESETS.frequency });
  }
  if (MUTED_PATTERN.test(t)) {
    return upstreamError("DeepSeek 账号被禁言/风控（user is muted）：已自动冷却该账号，请等待解除或 -provider deepseek login 追加账号", { status, rotateAuth: true, cooldownMs: COOLDOWN_PRESETS.muted });
  }
  return null;
}

function fmt(n) { return Number(n).toLocaleString("en-US"); }

function upstreamError(message, { status, rotateAuth, cooldownMs } = {}) {
  const err = new Error(message);
  err.status = status;
  if (rotateAuth) err._rotateAuth = true;
  if (cooldownMs) err._cooldownMs = cooldownMs;
  return err;
}

function classifyFailure(status, bodyText) {
  const text = String(bodyText || "");
  const muted = classifyProtocolFailure(text, status);
  if (muted) return muted;
  if (CAPTCHA_PATTERN.test(text)) {
    return upstreamError("DeepSeek 触发上游风控/验证码，请稍后再试或换账号（-provider deepseek login 追加）", { status, rotateAuth: true });
  }
  if (status === 401 || status === 403) {
    return upstreamError(`DeepSeek 凭据被拒 (http ${status})，自动切换下一个账号或重新 login`, { status, rotateAuth: true });
  }
  if (status === 429) {
    return upstreamError("DeepSeek 请求过于频繁 (429)，账号已冷却，稍后再试", { status, rotateAuth: true });
  }
  return upstreamError(`DeepSeek completion 失败 (http ${status}): ${text.slice(0, 300)}`, { status });
}

async function readBodyText(res) {
  try { return await res.text(); } catch { return ""; }
}

// 公共 completion 请求：netRetry + 非 SSE 检查 + INVALID_POW 一次重试（重解 challenge）
async function fetchCompletionWithPow({ token, base, body, pow, fetchImpl, dispatcher, connectTimeoutMs }) {
  const url = `${base}${DEEPSEEK_API_PREFIX}/chat/completion`;
  for (let powAttempt = 0; ; powAttempt++) {
    let res;
    try {
      res = await netRetry(() => fetchImpl(url, {
        method: "POST",
        headers: androidHeaders(token, { "x-ds-pow-response": pow.header }),
        body: JSON.stringify(body),
        ...(dispatcher ? { dispatcher } : {}),
      }), { attempts: 2, delayMs: 400 });
    } catch (err) {
      dsError("completion", err);
      throw upstreamError(`DeepSeek completion 网络失败: ${String(err?.message || err)}`, { rotateAuth: false });
    }
    dsDebug("completion", { event: "response", status: res.status, contentType: res.headers.get("content-type"), powAttempt, promptLen: body.prompt.length });

    if (res.ok) {
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const text = await readBodyText(res);
        const muted = classifyProtocolFailure(text, res.status);
        if (muted) { dsDump("completion", "muted", text, 400); throw muted; }
        let payload = null;
        try { payload = JSON.parse(text); } catch {}
        const bizMsg = payload?.data?.biz_msg || payload?.msg || text.slice(0, 200);
        dsDump("completion", "non-sse body", text, 1200);
        throw upstreamError(`DeepSeek completion 返回非 SSE: ${bizMsg}`, { status: res.status });
      }
      return res;
    }

    const text = await readBodyText(res);
    dsDump("completion", `error body http=${res.status}`, text, 1200);
    if (/INVALID_POW_RESPONSE/i.test(text) && powAttempt < 1) {
      const retryPow = await solveChallenge({ token, fetchImpl, dispatcher, baseUrl: base, connectTimeoutMs });
      pow.header = retryPow.header;
      continue;
    }
    throw classifyFailure(res.status, text);
  }
}

// 单发路径（不超阈值）
async function runOnce({ token, flags, prompt, isStream, fetchImpl, dispatcher, baseUrl, connectTimeoutMs }) {
  const base = String(baseUrl || DEEPSEEK_DEFAULT_BASE).replace(/\/+$/, "");
  const sessionId = await createChatSession({ token, fetchImpl, dispatcher, baseUrl: base, connectTimeoutMs });
  const pow = await solveChallenge({ token, fetchImpl, dispatcher, baseUrl: base, connectTimeoutMs });
  const completionBody = buildUpstreamBody({ sessionId, prompt, thinking: flags.thinking, search: flags.search, expert: flags.expert });
  dsDebug("completion", { event: "request", sessionId, thinking: flags.thinking, search: flags.search, expert: flags.expert, promptLen: prompt.length, promptHead: prompt.slice(0, 120), body: JSON.stringify(completionBody) });
  const res = await fetchCompletionWithPow({ token, base, body: completionBody, pow, fetchImpl, dispatcher, connectTimeoutMs });
  return { kind: isStream ? "stream" : "aggregate", res, sessionId, token };
}

// 分块喂养路径（expert 超阈值）：共享 session，非末块只喂历史（ready→stop_stream→drain），末块正常生成
async function runChunked({ token, flags, prompt, isStream, fetchImpl, dispatcher, baseUrl, connectTimeoutMs, threshold }) {
  const base = String(baseUrl || DEEPSEEK_DEFAULT_BASE).replace(/\/+$/, "");
  const chunks = splitPromptChunks(prompt, threshold);
  const sessionId = await createChatSession({ token, fetchImpl, dispatcher, baseUrl: base, connectTimeoutMs });
  dsDebug("chunked", { event: "start", sessionId, totalChunks: chunks.length, promptLen: prompt.length, threshold });
  let parentId = null;
  try {
    for (const chunk of chunks.slice(0, -1)) {
      const pow = await solveChallenge({ token, fetchImpl, dispatcher, baseUrl: base, connectTimeoutMs });
      const feedBody = buildUpstreamBody({ sessionId, prompt: chunk, thinking: false, search: false, expert: flags.expert, parentMessageId: parentId });
      dsDebug("chunked", { event: "feed", chunkLen: chunk.length, parentMessageId: parentId });
      const res = await fetchCompletionWithPow({ token, base, body: feedBody, pow, fetchImpl, dispatcher, connectTimeoutMs });
      parentId = await feedChunkToSession({ res, token, sessionId, fetchImpl, dispatcher, baseUrl, connectTimeoutMs });
      dsDebug("chunked", { event: "fed", parentMessageId: parentId });
    }
    const lastChunk = chunks[chunks.length - 1];
    const pow = await solveChallenge({ token, fetchImpl, dispatcher, baseUrl: base, connectTimeoutMs });
    const body = buildUpstreamBody({ sessionId, prompt: lastChunk, thinking: flags.thinking, search: flags.search, expert: flags.expert, parentMessageId: parentId });
    dsDebug("chunked", { event: "final", chunkLen: lastChunk.length, parentMessageId: parentId, thinking: flags.thinking, search: flags.search });
    const res = await fetchCompletionWithPow({ token, base, body, pow, fetchImpl, dispatcher, connectTimeoutMs });
    return { kind: isStream ? "stream" : "aggregate", res, sessionId, token };
  } catch (err) {
    dsError("chunked", err);
    await deleteChatSession({ token, sessionId, fetchImpl, dispatcher, baseUrl });
    throw err;
  }
}

export function aggregateFromText(sseText, model, { thinking = false } = {}) {
  const parse = createDeepseekSseParser({ startKind: thinking ? "reasoning" : "content" });
  let content = "";
  let reasoning = "";
  let finish = "stop";
  for (const ev of parse(String(sseText ?? ""))) {
    // 上游拒绝（hint error）：人话抛出，绝不返回空 200；频率风控/禁言命中时冷却换号
    if (ev.error) {
      const rotate = FREQUENCY_PATTERN.test(String(ev.error)) || MUTED_PATTERN.test(String(ev.error));
      throw upstreamError(`DeepSeek 上游拒绝: ${ev.error}${ev.finishReason ? ` (${ev.finishReason})` : ""}`, { status: 502, rotateAuth: rotate });
    }
    if (ev.content) content += ev.content;
    if (ev.reasoning) reasoning += ev.reasoning;
    if (ev.finish) finish = ev.finish;
  }
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id: `chatcmpl-deepseek-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export async function runDeepseekChat({ body, authPool, fetchImpl, dispatcher, baseUrl, connectTimeoutMs = 30_000, maxAuthRetries } = {}) {
  const model = body?.model || "deepseek/chat";
  const rawId = String(model).includes("/") ? String(model).split("/").pop() : String(model);
  const flags = mapModelToFlags(rawId);
  const prompt = buildPrompt(body?.messages || []);
  const isStream = body?.stream === true;
  const threshold = promptThresholdFor(flags);

  // 超限分流（ds-free-api 实测标定：default/vision 2,621,440 / expert 163,840，阈值取 75%）
  if (prompt.length > threshold) {
    if (!flags.expert) {
      throw upstreamError(`DeepSeek ${model} 输入超长：${fmt(prompt.length)} 字符，超过 ${fmt(threshold)} 上限（网页通道 default 模型上限 2,621,440 字符）。请压缩对话历史（opencode /compact）或改用 deepseek-*-expert-free（自动分块）`, { status: 413 });
    }
    dsDebug("oversize", { event: "chunked-mode", model, promptLen: prompt.length, threshold });
  }

  const maxAttempts = maxAuthRetries ?? Math.max(1, authPool.size);
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const token = authPool.requireToken();
    try {
      const out = prompt.length > threshold
        ? await runChunked({ token, flags, prompt, isStream, fetchImpl, dispatcher, baseUrl, connectTimeoutMs, threshold })
        : await runOnce({ token, flags, prompt, isStream, fetchImpl, dispatcher, baseUrl, connectTimeoutMs });
      if (out.kind === "stream") {
        return {
          kind: "stream",
          res: out.res,
          token,
          cleanup: () => deleteChatSession({ token: out.token, sessionId: out.sessionId, fetchImpl, dispatcher, baseUrl }),
        };
      }
      const sseText = await readBodyText(out.res);
      let data;
      try {
        data = aggregateFromText(sseText, model, { thinking: flags.thinking });
      } catch (err) {
        await deleteChatSession({ token: out.token, sessionId: out.sessionId, fetchImpl, dispatcher, baseUrl });
        throw err;
      }
      dsDump("aggregate", `sseText model=${model}`, sseText, 4000);
      if (!data.choices[0].message.content && !data.choices[0].message.reasoning_content) {
        dsDump("aggregate", "EMPTY aggregate content! full sseText", sseText, 8000);
      }
      await deleteChatSession({ token: out.token, sessionId: out.sessionId, fetchImpl, dispatcher, baseUrl });
      return { kind: "json", data };
    } catch (err) {
      dsError(`chat attempt=${attempt}`, err);
      if (err?._rotateAuth) authPool.onError(token, { cooldownMs: err._cooldownMs });
      if (!err?._rotateAuth || attempt >= maxAttempts - 1) throw err;
    }
  }
  throw upstreamError("DeepSeek: 所有账号均不可用", {});
}
