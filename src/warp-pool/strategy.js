// warp-pool · 选节点策略。
//
// session（默认）：同一 `x-opencode-session` 恒粘同一出口。
//   依据 src/upstream.js L14-16 的实测注释——上游按 session 做粘性路由（固定 session 两次请求 ~1.2s；
//   每次随机时可能撞冷机器 26s+）。故"每请求换出口"会把请求打成冷启动。
// request：每请求轮转，仅供实验（延迟代价见上）。
const STICKY_MAX = 2000;

export function createSelector({ strategy = "session" } = {}) {
  const sticky = new Map();
  let cursor = 0;

  /** @param {number[]} available 可用节点下标 @param {string} sessionKey */
  function pick(available, sessionKey) {
    if (!Array.isArray(available) || available.length === 0) return null;
    if (strategy === "session" && sessionKey) {
      const hit = sticky.get(sessionKey);
      if (hit !== undefined && available.includes(hit)) return hit;
      const chosen = available[cursor++ % available.length];
      sticky.set(sessionKey, chosen);
      if (sticky.size > STICKY_MAX) {
        const oldest = sticky.keys().next().value;
        sticky.delete(oldest);
      }
      return chosen;
    }
    return available[cursor++ % available.length];
  }

  return {
    pick,
    forget(sessionKey) {
      if (sessionKey === undefined) sticky.clear();
      else sticky.delete(sessionKey);
    },
    get tracked() {
      return sticky.size;
    },
    get strategy() {
      return strategy;
    },
  };
}
