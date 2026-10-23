// raccoon 会话粘号：一段对话（sessionId）固定用一个号，换会话才轮转下一个号 —— 积分按会话均摊。
// 语义与 qoder 的同请求粘号一致（只有该号进冷却 401/403/429/5xx 才换），差别在多两个能力：
//   · scope 由会话（opts.sessionId）优先，没有会话标识时退到 reqId，两者都无则退回纯 round-robin；
//   · remember()：续期换 token / 换号自愈后把本会话重新钉到那个号，避免同一账号被拆成两半。
// 本文件是独立实现（qoder 只用同请求粘号且无需 remember），不改 qoder 的粘号逻辑。
export function createStickyPicker({ pick, isCooling = () => false, now = Date.now, ttlMs = 600_000, maxEntries = 200 } = {}) {
  const seen = new Map(); // scope → { key, at }

  function evict() {
    const t = now();
    for (const [scope, hit] of seen) if (t - hit.at >= ttlMs) seen.delete(scope);
    while (seen.size > maxEntries) seen.delete(seen.keys().next().value);
  }

  // onDecision（可选）：把"这次为什么选它"回报给调用方 —— 决定必须可观测。
  // sticky=同会话复用 / new=新会话轮转选中 / switch=上次的号在冷却(或 TTL 过期)故换 / rr=无 scope 退回轮转
  function pickSticky(scope, onDecision) {
    if (!scope) {
      onDecision?.("rr");
      return pick();
    }
    const hit = seen.get(scope);
    // 粘住：同一会话内复用上次的号，除非它已被冷却（那时必须换）
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
  }
  // forget：丢弃 scope 的粘号记录（令牌刷新换了 key 后必须丢弃，否则同会话还粘旧 key）
  pickSticky.forget = (scope) => { seen.delete(scope); };
  // remember：把 scope 的粘号改钉到指定 key（换号自愈 / 续期换 token 后，让同一会话继续留在同一个号上）
  pickSticky.remember = (scope, key) => {
    if (!scope || !key) return;
    seen.set(scope, { key, at: now() });
    if (seen.size > maxEntries) evict();
  };
  return pickSticky;
}
