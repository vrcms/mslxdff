// 网关 live 模型列表：allowAny 且空白名单的供应商（qoder/codearts 类）不写 allowlist，
// 其模型只存在于 daemon 聚合的 /v1/models 里；交互式 `-models` 必须并入这些 id，
// 否则该供应商「一个模型都挑不到」（用户视角：-models 什么也没有）。
import { compatFetch, timeoutSignal } from "../../../compat.js";
import { effectivePort, effectiveHost } from "../../policy.js";
import { loadToken } from "../../../state.js";

export async function fetchDaemonModelIds({ fetchImpl = compatFetch, port, host, token, timeoutMs = 6000 } = {}) {
  try {
    const p = port ?? effectivePort([]);
    const h = host ?? effectiveHost() ?? "127.0.0.1";
    const tk = (token ?? (await loadToken())?.token) || "";
    const res = await fetchImpl(`http://${h}:${p}/v1/models?all=1`, {
      headers: tk ? { Authorization: `Bearer ${tk}` } : {},
      signal: timeoutSignal(timeoutMs),
    });
    if (!res?.ok) return [];
    const json = await res.json().catch(() => ({}));
    return (json?.data || []).map((m) => m?.id).filter(Boolean);
  } catch {
    // 网关没跑 / 超时 / 鉴权失败：静默降级（候选列表退回 allowlist + picks）
    return [];
  }
}
