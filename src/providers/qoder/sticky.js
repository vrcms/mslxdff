// qoder 同请求粘号：一个客户端请求内的多次上游调用（空转重试/换路重试）复用同一个号，
// 只有该号进入冷却（401/403/429/5xx → ring.onError）才切到下一个号。
// 背景：keyring 每次 next() 都前进一格，而 qoder 两个号分属 cn/global 两区（region 决定 URL），
// 于是「重试」会把同一个请求甩到另一个区——排障时表现为"URL 莫名在切"。粘号把"切号"收回到
// 唯一正当理由：该号已被冷却。无 scope（拿不到请求标识）时退化为原 round-robin，与旧行为一致。
// Note: 切号的唯一正当理由是冷却（401/403/429/5xx）——空转等其它失败不换号，故选择器要能问 keyring "上次这个号还在冷却吗" — 见 .agents/notes/implemented/feature/2026-09-27-qoder-per-request-sticky-account.md
export function createStickyPicker({ pick, isCooling = () => false, now = Date.now, ttlMs = 600_000, maxEntries = 200 } = {}) {
  const seen = new Map(); // scope → { key, at }

  function evict() {
    const t = now();
    for (const [scope, hit] of seen) if (t - hit.at >= ttlMs) seen.delete(scope);
    while (seen.size > maxEntries) seen.delete(seen.keys().next().value);
  }

  // onDecision（可选）：把"这次为什么选它"回报给调用方 —— 决定必须可观测。
  // sticky=同请求复用 / new=新请求轮转选中 / switch=上次的号在冷却(或 TTL 过期)故换 / rr=无 scope 退回轮转
  return function pickSticky(scope, onDecision) {
    if (!scope) {
      onDecision?.("rr");
      return pick();
    }
    const hit = seen.get(scope);
    // 粘住：同一请求内复用上次的号，除非它已被冷却（那时必须换）
    if (hit && now() - hit.at < ttlMs && !isCooling(hit.key)) {
      hit.at = now();
      onDecision?.("sticky");
      return hit.key;
    }
    const key = pick();
    onDecision?.(hit ? "switch" : "new");
    if (key) {
      seen.set(scope, { key, at: now() });
      if (seen.size > maxEntries) evict();
    }
    return key;
  };
}
