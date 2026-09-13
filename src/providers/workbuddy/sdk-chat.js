// workbuddy SDK 实验通道（薄壳）：转调共用执行器 upstream-engine/sdk/attempt.js。
// 契约保持：attemptOnceSdk({url, body, key, auth, buildHeaders}) → Response（SSE）。
// HTTP 错误映射与 _sdkLoadFailed 语义在共用层；本壳只注入 workbuddy 特有参数。
// 见 .scratch/workbuddy-sdk-channel/SPEC.md。
import { attemptOnceSdk as attemptGeneric, sdkBaseFromUrl } from "../../upstream-engine/sdk/attempt.js";

export { sdkBaseFromUrl };

let channelLogged = false;

export async function attemptOnceSdk({ url, body, key, auth, buildHeaders, clock = Date.now } = {}) {
  const out = await attemptGeneric({
    url,
    body,
    headers: buildHeaders ? buildHeaders(key, auth) : {},
    providerName: "workbuddy",
    marker: { name: "x-mslxdff-workbuddy-channel", value: "sdk" },
    clock,
  });
  if (!channelLogged) {
    channelLogged = true;
    try { console.error(`[workbuddy-sdk-channel] active via @ai-sdk/openai-compatible (model=${body?.model || ""} uid=${auth?.uid || ""})`); } catch {}
  }
  return out;
}
