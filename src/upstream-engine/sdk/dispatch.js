// 供应商级 SDK 分派（薄壳）：通用 OpenAI 兼容上游的"请求发出口"共用。
// 缺省 sdk（attemptOnceSdk 走 @ai-sdk/openai-compatible）；varName 显式设 legacy/关闭词即回退，
// 未设置则继承全局 MSLXDFF_UPSTREAM_ENGINE（一键熔断）。
// SDK 不可用抛 _sdkLoadFailed → 回退原生并告警一次；其它错误 rethrow 交调用方重试语义。
// 见 .scratch/ai-sdk-providers-rest/SPEC.md 与 docs/adr/0017。
import { resolveEngineMode } from "../mode.js";
import { attemptOnceSdk } from "./attempt.js";

export function sdkEnvName(id) {
  return `MSLXDFF_${String(id || "").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_SDK`;
}

export function createSdkDispatch({
  id,
  varName,
  providerName,
  markerName = "x-mslxdff-upstream-engine",
  label,
  env = process.env,
  logger = console,
  attemptImpl = attemptOnceSdk,
} = {}) {
  const name = varName || sdkEnvName(id);
  const provider = providerName || id || "provider";
  const tag = label || provider;
  const mode = resolveEngineMode(env, name);
  let fallbackLogged = false;

  return {
    varName: name,
    enabled: mode === "sdk",
    // 成功返回 Response；_sdkLoadFailed → null（调用方回退原生）；其它错误 rethrow
    async trySdk({ url, body, headers, fetchImpl, clock } = {}) {
      try {
        return await attemptImpl({
          url,
          body,
          headers,
          providerName: provider,
          marker: markerName ? { name: markerName, value: "sdk" } : null,
          fetchImpl,
          clock,
        });
      } catch (e) {
        if (e && e._sdkUnsupported) return null; // 异形 chatPath：静默回退原生
        if (!e || !e._sdkLoadFailed) throw e;
        if (!fallbackLogged) {
          fallbackLogged = true;
          try { logger.error(`[${tag}] ${e.message} — 回退原生通道`); } catch {}
        }
        return null;
      }
    },
  };
}
