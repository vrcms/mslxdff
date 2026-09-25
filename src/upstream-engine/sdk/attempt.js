// AI SDK 请求执行器（共用）：@ai-sdk/openai-compatible 的懒加载与调用点。
// 契约：attemptOnceSdk({url, body, headers, providerName, marker, fetchImpl}) → Response（OpenAI SSE）。
// headers 由调用方完整构造（Authorization 原样透传，不走 apiKey 注入）；
// HTTP 错误就地映射为带状态码的 Response；装载失败抛 _sdkLoadFailed 由引擎回退 legacy。
// responses 适配器（sdk/responses.js）复用本文件的 baseURL 解析、错误映射与流序列化。
// 见 .scratch/ai-sdk-upstream/{SPEC.md,SPEC-p3-responses.md} 与 docs/adr/0017。
// Headers 超时（防 SDK 通道挂死）：doStream 裸 await 曾因上游连接半死永不 resolve
//（cline muse-spark 2026-09-25 17:48 悬空 27min+，无 upstream-done/error/result）。
// 默认 120s（覆盖慢模型首块握手的合理上限），MSLXDFF_SDK_HEADERS_TIMEOUT_MS=0 关闭。
// 注意错误文案不得含 "timed out"：cline runChat 靠该子串做网络重试，命中会把挂死放大 3 倍。
import { toModelPrompt, toModelTools, toModelToolChoice, toModelParams } from "./convert.js";
import { createSseSerializer } from "./sse.js";
import { diagnoseToolSequence, compactSequence } from "./diagnose.js";
import { getUndici } from "../../compat.js";
function headersTimeoutMs(env = process.env) {
  const n = Number(env.MSLXDFF_SDK_HEADERS_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
}

// race 包裹：超时 reject mkErr()；先赢路径清定时器并吞掉迟到的 rejection（防 unhandled）。
export function withHeadersTimeout(promise, ms, mkErr) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(mkErr()), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; },
    ),
    guard,
  ]).catch((e) => {
    // 超时赢后原 promise 仍可能 reject：静默兜住，不让其变成 unhandled rejection。
    if (promise && typeof promise.catch === "function") promise.catch(() => {});
    throw e;
  });
}


let sdkPromise = null;

export function loadOpenAICompatibleSdk() {
  if (!sdkPromise) sdkPromise = import("@ai-sdk/openai-compatible");
  return sdkPromise;
}

// legacy 的 keep-alive 连接池以 fetch 形式注入 SDK（P4 转正：延迟与 legacy 同量级，不另建连接）。
export function dispatcherFetch(dispatcher) {
  const f = getUndici().fetch;
  return (url, init = {}) => f(url, { ...init, dispatcher });
}

// 剥掉 url 末尾的协议段，得到 SDK baseURL（chat 走 /chat/completions，responses 走 /responses）。
export function sdkBaseFromUrl(url, suffix = "/chat/completions") {
  const s = String(url || "");
  const esc = String(suffix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc}/?$`);
  if (!re.test(s)) return null;
  return s.replace(re, "");
}

// 只剥 Content-Type（由 SDK 固定 application/json）；其余头（含 Authorization）原样透传
export function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === "content-type") continue;
    out[k] = v;
  }
  return out;
}

export function markerHeaders(marker) {
  return marker && marker.name ? { [marker.name]: marker.value } : {};
}

// 错误路径诊断：AI SDK 的 APICallError 对 HTTP 4xx 的 requestBodyValues 是空对象（provider-utils 实测），
// 故用包装 fetch 捕获真实发出的 body，在上游非 2xx 时打印 tool 序列断裂点与尾部序列。
function logRequestDiagnosis(bodyText, status) {
  if (!bodyText || typeof bodyText !== "string") return;
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { return; }
  const msgs = parsed?.messages;
  if (!Array.isArray(msgs)) return;
  const { issues, summary } = diagnoseToolSequence(msgs);
  console.error(`[sdk-upstream] ${status} ${summary} issues=${issues.length ? issues.join(" | ") : "none"}`);
  console.error(`[sdk-upstream] head: ${compactSequence(msgs, 0, 6)}`);
  console.error(`[sdk-upstream] tail: ${compactSequence(msgs, Math.max(0, msgs.length - 40))}`);
}

// SDK 抛出的 APICallError → 带状态码的 Response；非 HTTP 错误返回 null 由调用方 rethrow。
export function errorResponseFromSdkError(e, { marker = null } = {}) {
  const status = Number(e?.statusCode ?? e?.status);
  if (!Number.isFinite(status) || status < 400) return null;
  const text = typeof e.responseBody === "string"
    ? e.responseBody
    : JSON.stringify({ error: { message: e?.message || String(e) } });
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...markerHeaders(marker) },
  });
}

// SDK parts → OpenAI SSE Response（chat/responses 共用同一序列化器；captured 为 responses 侧信道）。
export function streamResponseFromParts(parts, { marker = null, clock = Date.now, t0 = clock(), captured = null } = {}) {
  const ser = createSseSerializer(captured);
  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const part of parts) {
          if (cancelled) break;
          // 侧信道（captured）可能落后几毫秒：收尾前给 encrypted 一点就绪时间（最多 150ms）
          if (captured && !captured.reasoning && part?.type === "finish") {
            const tw = Date.now();
            while (!captured.reasoning && Date.now() - tw < 150) await new Promise((r) => setTimeout(r, 10));
          }
          const text = ser.push(part);
          if (text) controller.enqueue(enc.encode(text));
        }
      } catch (e) {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: String(e?.message || e) } })}\n\n`)); } catch {}
      }
      try { controller.enqueue(enc.encode(ser.end())); controller.close(); } catch {}
    },
    cancel() {
      // 客户端断开时 parts 仍被 start 的 for-await 锁定：直接 cancel 会抛 ERR_INVALID_STATE，
      // 且异常经内部 promise 回调逃出同步 try/catch → unhandled rejection 崩进程（v0.1.111 实测 9 次）。
      // 修复：置标志让迭代自然收尾，并同时吞掉同步异常与 promise rejection 两条路径。
      cancelled = true;
      try {
        const p = parts?.cancel?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {}
    },
  });
  const out = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...markerHeaders(marker) },
  });
  try { out._t = { attempts: [{ type: "http200", ms: Math.round(clock() - t0) }], waitMs: 0, totalMs: Math.round(clock() - t0) }; } catch {}
  return out;
}

export async function attemptOnceSdk({
  url,
  body,
  headers = {},
  providerName = "opencode",
  marker = null,
  clock = Date.now,
  sdkLoader = loadOpenAICompatibleSdk,
  fetchImpl,
} = {}) {
  const t0 = clock();
  const baseURL = sdkBaseFromUrl(url);
  if (!baseURL) {
    // 异形 chatPath（非 /chat/completions 结尾）：标 _sdkUnsupported 由分派层静默回退原生
    const err = new Error(`sdk-channel: chatPath 非 /chat/completions，暂不支持（${url}）`);
    err._sdkUnsupported = true;
    throw err;
  }
  let createOpenAICompatible;
  try {
    ({ createOpenAICompatible } = await sdkLoader());
  } catch (e) {
    const err = new Error(`sdk-channel: @ai-sdk/openai-compatible 不可用（需 Node>=18 且已安装）: ${e?.message || e}`);
    err._sdkLoadFailed = true;
    throw err;
  }
  // 包装注入的 fetch 以捕获真实请求体（诊断用）：不改变调用语义，仅在非 2xx 时被读取。
  let lastBodyText = null;
  const capturedFetch = fetchImpl
    ? async (u, init) => {
        try { if (init && typeof init.body === "string") lastBodyText = init.body; } catch {}
        return fetchImpl(u, init);
      }
    : undefined;
  const provider = createOpenAICompatible({
    name: providerName,
    baseURL,
    headers: sanitizeHeaders(headers),
    ...(capturedFetch ? { fetch: capturedFetch } : {}),
  });
  const model = provider.chatModel(String(body?.model || ""));
  const htMs = headersTimeoutMs();
  const aborter = htMs > 0 ? new AbortController() : null;
  let res;
  try {
    res = await withHeadersTimeout(
      model.doStream({
        prompt: toModelPrompt(body?.messages),
        ...toModelParams(body, providerName),
        tools: toModelTools(body?.tools),
        toolChoice: toModelToolChoice(body?.tool_choice),
        ...(aborter ? { abortSignal: aborter.signal } : {}),
      }),
      htMs,
      () => new Error(`sdk-channel: headers timeout after ${htMs}ms（上游未返回响应头，防挂死；MSLXDFF_SDK_HEADERS_TIMEOUT_MS=0 关闭）`),
    );
  } catch (e) {
     try { aborter?.abort(); } catch {}
    const mapped = errorResponseFromSdkError(e, { marker });
    if (mapped) {
      try { logRequestDiagnosis(lastBodyText, mapped.status); } catch {}
      return mapped;
    }
    throw e;
  }
  return streamResponseFromParts(res.stream, { marker, clock, t0 });
}
