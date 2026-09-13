// SDK 引擎的 chat 适配器工厂：拼 URL → attemptOnceSdk。
// buildHeaders(body) 由调用方注入（身份头随供应商而异，单一来源在引擎侧）。
import { attemptOnceSdk } from "./attempt.js";

export const ENGINE_MARKER = { name: "x-mslxdff-upstream-engine", value: "sdk" };

export function createSdkChat({
  baseUrl,
  chatPath = "/zen/v1/chat/completions",
  buildHeaders,
  providerName = "opencode",
  marker = ENGINE_MARKER,
  fetchImpl,
} = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return {
    async chat(body) {
      return attemptOnceSdk({
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
