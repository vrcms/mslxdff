// Responses API 适配器（@ai-sdk/openai）：models.dev 里模型级 npm=@ai-sdk/openai 的模型
// （如 muse-spark*，打 /zen/v1/responses）。与 chat 适配器同契约：输出 OpenAI chat SSE 帧。
// 复用 attempt.js 的 baseURL 解析 / 错误映射 / 流序列化，不复制实现。
// 见 .scratch/ai-sdk-upstream/SPEC-p3-responses.md 与 docs/adr/0017。
import { toModelPrompt, toModelTools, toModelToolChoice, toModelParams } from "./convert.js";
import { sdkBaseFromUrl, sanitizeHeaders, errorResponseFromSdkError, streamResponseFromParts } from "./attempt.js";
import { ENGINE_MARKER } from "./chat.js";

export const RESPONSES_CHAT_PATH = "/zen/v1/responses";

// 降级阈值：加密思考块（encrypted_content）由上游按 caller（出口）签发，客户端跨出口回传
// （经组员/换代理/直连切换）会被拒 400 "reasoning `encrypted_content` was not issued to this caller"。
// 命中即剥掉加密态重试一次；仍失败原样返回，交上层转组员接力（保底不变差）。
const ENC_CALLER_400_RE = /encrypted_content[^"]*was not issued to this caller/i;

export function isEncryptedCallerError(text) {
  return typeof text === "string" && ENC_CALLER_400_RE.test(text);
}

// 上游 encrypted reasoning 只在 output_item.done 里给，而 AI SDK 仅在有 summary 文本时才透出到 parts
// （muse-spark 这类无 summary 的思考模型会被吞掉）。这里在 fetch 层 tee 一份原始 SSE 自行解析，
// 侧信道把加密思考交给序列化器，收尾帧补发。
function captureReasoningFetch(baseFetch, sink) {
  const dbg = process.env.MSLXDFF_RESPONSES_DEBUG === "1";
  return async (input, init) => {
    const res = await baseFetch(input, init);
    const ct = res.headers.get("content-type") || "";
    if (dbg) console.log(`[capture] enter ct=${ct} hasBody=${Boolean(res.body)}`);
    if (!ct.includes("text/event-stream") || !res.body) return res;
    const [passthrough, probe] = res.body.tee();
    (async () => {
      const reader = probe.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const d = line.slice(5).trim();
            if (!d || d === "[DONE]") continue;
            try {
              const j = JSON.parse(d);
              if (dbg && j.type === "response.output_item.done") console.log(`[capture] item.done type=${j.item?.type} enc=${typeof j.item?.encrypted_content}`);
              if (j.type === "response.output_item.done" && j.item?.type === "reasoning" && typeof j.item.encrypted_content === "string") {
                sink.reasoning = { id: j.item.id, encrypted: j.item.encrypted_content, summary: j.item.summary ?? [] };
                if (dbg) console.log(`[capture] hit id=${String(j.item.id).slice(0, 24)} len=${j.item.encrypted_content.length}`);
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
      if (dbg) console.log(`[capture] stream end captured=${sink.reasoning ? "yes" : "no"}`);
    })();
    return new Response(passthrough, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

let sdkPromise = null;

export function loadOpenAISdk() {
  if (!sdkPromise) sdkPromise = import("@ai-sdk/openai");
  return sdkPromise;
}

export async function attemptOnceResponsesSdk({
  url,
  body,
  headers = {},
  providerName = "opencode",
  marker = null,
  clock = Date.now,
  sdkLoader = loadOpenAISdk,
  fetchImpl,
} = {}) {
  const t0 = clock();
  const baseURL = sdkBaseFromUrl(url, "/responses");
  if (!baseURL) throw new Error(`sdk-channel: responsesPath 非 /responses，暂不支持（${url}）`);
  let createOpenAI;
  try {
    ({ createOpenAI } = await sdkLoader());
  } catch (e) {
    const err = new Error(`sdk-channel: @ai-sdk/openai 不可用（需 Node>=18 且已安装）: ${e?.message || e}`);
    err._sdkLoadFailed = true;
    throw err;
  }
  // headers 由调用方构造（含 Authorization），headers 优先于 apiKey 默认头
  const captured = { reasoning: null };
  const baseFetch = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  const provider = createOpenAI({
    name: providerName,
    baseURL,
    apiKey: "public",
    headers: sanitizeHeaders(headers),
    fetch: captureReasoningFetch(baseFetch, captured),
  });
  const model = provider.responses(String(body?.model || ""));
  const params = toModelParams(body, providerName);
  // 无状态 + 加密思考回传（thinking 跨轮）：上游把思考以加密块发回，客户端持有并每轮带回。
  // AI SDK responses 的 providerOptionsName 对非 azure 硬编码为 "openai"（dist/index.js:5240）。
  const providerOptions = {
    ...(params.providerOptions || {}),
    openai: {
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoningSummary: "auto",
      ...((params.providerOptions || {}).openai || {}),
    },
  };
  let res;
  let encRetry = false;
  const streamOnce = (prompt) => model.doStream({
    prompt,
    ...params,
    providerOptions,
    tools: toModelTools(body?.tools),
    toolChoice: toModelToolChoice(body?.tool_choice),
  });
  try {
    res = await streamOnce(toModelPrompt(body?.messages));
  } catch (e) {
    let mapped = errorResponseFromSdkError(e, { marker });
    if (mapped && mapped.status === 400) {
      let txt = "";
      try { txt = await mapped.clone().text(); } catch {}
      if (isEncryptedCallerError(txt)) {
        try {
          res = await streamOnce(toModelPrompt(body?.messages, { dropEncrypted: true }));
          mapped = null;
          encRetry = true;
        } catch (e2) {
          const mapped2 = errorResponseFromSdkError(e2, { marker });
          if (mapped2) return mapped2;
          throw e2;
        }
      }
    }
    if (mapped) return mapped;
  }
  const out = streamResponseFromParts(res.stream, { marker, clock, t0, captured });
  if (encRetry) { try { out._t.encRetry = true; } catch {} }
  return out;
}

export function createSdkResponses({
  baseUrl,
  chatPath = RESPONSES_CHAT_PATH,
  buildHeaders,
  providerName = "opencode",
  marker = ENGINE_MARKER,
  fetchImpl,
} = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return {
    async chat(body) {
      return attemptOnceResponsesSdk({
        url: `${base}${chatPath}`,
        body,
        headers: buildHeaders ? buildHeaders(body) : {},
        providerName,
        marker,
        fetchImpl,
      });
    },
  };
}
