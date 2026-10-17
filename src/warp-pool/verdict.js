// warp-pool · 上游失败信号的「换不换出口」判决（纯函数，零 IO）。
//
// 判据逐字对齐参照实现 kyomufs/zen-router：
//   - internal/zen/errors.go 的 Kind 分类表（哪些错误算「按出口 IP 计的限额」）；
//   - internal/router/stage.go 的 NextAttempt 决策表（每种 Kind 该换什么、要不要绕过冷却）。
//
// 立此模块的原因（2026-10-17 十次修订）：我原先只在 rotate.js 的 onStatus 里认 `status === 429`，
// 漏掉了参照实现表里**最重要的一格**——`403 FreeTierError` 与 `429 FreeUsageLimitError` 是
// **同一个条件的两种状态码**（上游按自己的窗口状态二选一，文案完全相同）。参照实现实测：
// 同一身份连发 3 次 429，**身份一换同一个请求立刻 200**（errors.go:32-42）；
// 而它最初把 403 当通用 403 不重试，代价是整轮请求直接死掉（errors.go:50-61 记录得很清楚）。
// 我这边更糟：`terminal-verdict.js` 把 FreeTierError 判成**终局**（跳过接力），
// warp-pool 又只认 429 ⇒ **403 FreeTierError 从来没有任何换出口动作**。
//
// 反向护栏同样照抄：`BlackUsageLimitError` 是真正的**账号日配额**，换出口抬不动，
// 参照实现明确「绝不旋转身份」（stage.go:125-128、errors.go:28-31）；换 key 才是它的正解。
// 裸 403（正文没有 FreeTier 判决）也不旋转：参照实现的 kindByStatus 把 403 归为
// KindClient（不可重试），换出口对形状/区域/凭据类 403 毫无用处。
//
// 读不到正文时的退路也照抄 kindByStatus：429 → 当出口 IP 限流（换）；403 → 不换。

/** 上游失败正文里判定免费层资格的具名判决（与 terminal-verdict.js 的 FREE_TIER_PATTERNS 同源口径）。 */
const FREE_TIER_RE = /FreeTierError|free tier can only be used/i;
/** 匿名免费层 429（参照实现实测：按出口 IP 计，换身份即换桶）。 */
const FREE_QUOTA_RE = /FreeUsageLimitError|GoUsageLimitError/i;
/** 黑名单层：真账号日配额，换出口抬不动。 */
const BLACK_QUOTA_RE = /BlackUsageLimitError/i;

/** 只这两类状态码参与判决；其余（含 200）一律不参与、也不许刷日志。 */
export const SIGNAL_STATUSES = [403, 429];

/** 正文捕获上限（判据只需要文案里的类名，2KB 足够，且防大 body 拖成慢扫描）。 */
export const SIGNAL_MAX_BYTES = 2048;

/** 正文里出现了具名判决（供 tapHandler 一凑够就提前判决，不必等整条 body 读完）。 */
export function looksLikeQuotaSignal(text) {
  const t = typeof text === "string" ? text : "";
  return FREE_TIER_RE.test(t) || FREE_QUOTA_RE.test(t) || BLACK_QUOTA_RE.test(t);
}

/**
 * 一次上游失败该不该换出口。
 * @param {{ status?: number, text?: string }} signal 上游状态码 + 正文（≤ SIGNAL_MAX_BYTES；读不到给空串）
 * @returns {{ kind: "free-tier"|"free-quota"|"black-quota"|"ip-limit"|"none", rotate: boolean,
 *            forced: boolean, why: string }}
 *   forced=true 表示必须**跳过**冷却（参照实现的 RotateForced：冷却曾把第一次真实反应吞掉，
 *   于是重试复用了同一个已限额的出口 —— stage.go:315-324）。
 */
export function classifyWarpSignal({ status, text = "" } = {}) {
  const code = Number(status);
  const body = typeof text === "string" ? text : "";
  if (!SIGNAL_STATUSES.includes(code)) {
    return { kind: "none", rotate: false, forced: false, why: `上游 ${code || "?"} 不是 403/429，与出口限额无关` };
  }
  // 顺序即优先级，照抄 errors.go 的 classify()：先认正文里的具名判决，再退回状态码。
  if (BLACK_QUOTA_RE.test(body)) {
    return { kind: "black-quota", rotate: false, forced: false, why: "BlackUsageLimitError 是真正的账号日配额，换出口抬不动（参照实现同样绝不旋转）——该换 key，不是换 IP" };
  }
  if (FREE_TIER_RE.test(body)) {
    return { kind: "free-tier", rotate: true, forced: true, why: "403 FreeTierError 与 429 FreeUsageLimitError 是同一条件的两种状态码；参照实现实测换身份后同一个请求立刻 200 ⇒ 强制换出口，跳过冷却" };
  }
  if (FREE_QUOTA_RE.test(body)) {
    return { kind: "free-quota", rotate: true, forced: true, why: "匿名免费层 429 实测是**按出口 IP** 计的限额（同一身份连发 3 次全 429，换身份立刻 200）⇒ 强制换出口，跳过冷却" };
  }
  if (code === 429) {
    return { kind: "ip-limit", rotate: true, forced: false, why: "裸 429（正文无配额判决）= 出口 IP 限流信号 ⇒ 换出口；保留冷却，防 429 风暴把 CF 注册刷爆" };
  }
  return { kind: "none", rotate: false, forced: false, why: "403 但正文没有 FreeTier 判决 ⇒ 不是配额信号（形状/区域/凭据类），换出口无用" };
}
