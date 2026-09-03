import { DEFAULT_AUTO_MODELS, rankModels } from "../auto.js";

/**
 * RoutePlanner 纯决策 — 根据 Policy + auto 状态产 RoutePlan
 * 无网络副作用，供单测注入 FakeAuto
 */
export function planRoute(policy, autoState = {}) {
  const { requested, useAuto, lockModel } = policy;
  const { candidates = [], errors = {}, latencies = {}, viaRoute = null } = autoState;

  // 锁模型时直接单点
  if (lockModel) {
    return { strategy: "direct", order: [requested], concLimit: 1, hedgeDelayMs: 0 };
  }
  // ViaRoute 单路径（显式锁模型且 via 表命中）
  if (viaRoute && !useAuto && requested.includes("/")) {
    return { strategy: "via", order: [requested], via: viaRoute, concLimit: 1, hedgeDelayMs: 0 };
  }
  // Auto 并发择优
  if (useAuto && candidates.length > 1) {
    const concLimit = Math.min(candidates.length, 5);
    return { strategy: "autoRace", order: candidates, concLimit, hedgeDelayMs: 1000 };
  }
  // 显式模型回退链
  if (!useAuto && candidates.length) {
    const others = candidates.filter((m) => m !== requested);
    const order = requested ? [requested, ...others] : candidates;
    return { strategy: "direct", order, concLimit: 1, hedgeDelayMs: 0 };
  }
  return { strategy: "direct", order: requested ? [requested] : [""], concLimit: 1, hedgeDelayMs: 0 };
}
