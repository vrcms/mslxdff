// Responses API 适配器（@ai-sdk/openai）：models.dev 里模型级 npm=@ai-sdk/openai 的模型
// （如 muse-spark*，打 /zen/v1/responses）。与 chat 适配器同契约：输出 OpenAI chat SSE 帧。
// 复用 attempt.js 的 baseURL 解析 / 错误映射 / 流序列化，不复制实现。
// 见 .scratch/ai-sdk-upstream/SPEC-p3-responses.md 与 docs/adr/0017。
import { toModelPrompt, toModelTools, toModelToolChoice, toModelParams } from "./convert.js";
import { sdkBaseFromUrl, sanitizeHeaders, errorResponseFromSdkError, streamResponseFromParts } from "./attempt.js";
import { ENGINE_MARKER } from "./chat.js";

export const RESPONSES_CHAT_PATH = "/zen/v1/responses";

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
  const provider = createOpenAI({
    name: providerName,
    baseURL,
    apiKey: "public",
    headers: sanitizeHeaders(headers),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const model = provider.responses(String(body?.model || ""));
  let res;
  try {
    res = await model.doStream({
      prompt: toModelPrompt(body?.messages),
      ...toModelParams(body, providerName),
      tools: toModelTools(body?.tools),
      toolChoice: toModelToolChoice(body?.tool_choice),
    });
  } catch (e) {
    const mapped = errorResponseFromSdkError(e, { marker });
    if (mapped) return mapped;
    throw e;
  }
  return streamResponseFromParts(res.stream, { marker, clock, t0 });
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
