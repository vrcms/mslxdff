// ADR-0015：供应商路由分类三态 + EMA 纯函数（零依赖，防循环 import）
// local-only：本机账号绑定（workbuddy/cline 系），组员转发无效
// quota-pool：图额度不图速度（opencode free），直连先行、429 后组员兜底
// latency-compare：key/token 类，direct vs link+remote 比延迟
export function classifyProvider(id) {
  const s = String(id || "").trim().toLowerCase();
  if (s === "workbuddy" || s === "cline" || s === "codearts") return "local-only";
  if (s === "opencode") return "quota-pool";
  return "latency-compare";
}

// EMA（α=0.3）：prev 为空取 now；now 非法样本不参与；两者皆非法返 null
// 0ms 是合法样本（本地/瞬时响应），只有 null/undefined/NaN/负数才非法
export function emaMerge(prev, now, alpha = 0.3) {
  const norm = (v) => (v === null || v === undefined ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null));
  const a = norm(prev);
  const b = norm(now);
  if (a === null && b === null) return null;
  if (a === null) return Math.round(b);
  if (b === null) return Math.round(a);
  return Math.round(a * (1 - alpha) + b * alpha);
}
