// v6pool · 日志文案（纯函数，零 IO）。
//
// 判据（ADR-0059）：**看完日志还需要的下一个命令，就是日志没写好的地方**。
// 所以每一行都必须自带定位信息：哪个源地址、哪个前缀、第几次换、旧地址当时打了多少发什么状态。
// 行首标记沿用 warp-pool/report.js 的 MARK（▸步骤 / ✓正常 / ✗失败 / ⚠警告）。
export const MARK = { step: "▸", ok: "✓", fail: "✗", warn: "⚠" };
const TAG = "[v6pool]";

/** `{200: 3, 429: 1}` → `200×3 429×1`（按次数降序；空则"无响应"）。 */
export function fmtCounts(counts = {}) {
  const parts = Object.entries(counts)
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([s, n]) => `${s}×${n}`);
  return parts.length ? parts.join(" ") : "无响应";
}

export function fmtConfig(cfg = {}) {
  return `${TAG} ${MARK.step} 配置 开关=${cfg.enabled ? "开" : "关"} 槽位=${cfg.count} 策略=${cfg.strategy} 换址=${cfg.rotate ? "开" : "关"} 认领=${cfg.claim} 冷却=${Math.round((cfg.cooldownMs || 0) / 1000)}s 退休=${Math.round((cfg.retireMs || 0) / 1000)}s 前缀=${cfg.prefix || "(自动判断)"}`;
}

export function fmtDisabled() {
  return `${TAG} ${MARK.step} 出口池关着（MSLXDFF_V6_POOL=0）⇒ 请求走直连或 WARP 池`;
}

export function fmtDetect(d = {}) {
  return `${TAG} ${MARK.step} 自检 网卡=${d.iface || "?"} 前缀=${d.prefix} 主机位=${d.hostBits}（可用地址 2^${d.hostBits}） 认领=${d.mode === "bind" ? "bind（ip_nonlocal_bind=1，不碰网卡）" : "add（root，ip addr add）"} 来源=${d.source}`;
}

export function fmtSkip({ reason = "", hint = "" } = {}) {
  return `${TAG} ${MARK.fail} 出口池本次不启用（请求走直连）：${reason}｜下一步：${hint}`;
}

export function fmtClaim({ addr, iface }) {
  return `${TAG} ${MARK.step} 认领源地址 ${addr}/128 dev ${iface} nodad（记进认领账，收摊时释放）`;
}

export function fmtClaimFail({ addr, iface, error }) {
  return `${TAG} ${MARK.fail} 认领源地址失败 ${addr} dev ${iface}：${error}`;
}

export function fmtSweep({ iface, removed = [], failed = [] } = {}) {
  const r = removed.length ? `删掉 ${removed.length} 个：${removed.slice(0, 4).join(" ")}${removed.length > 4 ? " …" : ""}` : "无";
  const f = failed.length ? `｜失败 ${failed.length} 个：${failed.map((x) => `${x.addr}（${x.error}）`).join(" ")}` : "";
  return `${TAG} ${MARK.step} 清上一代残留地址（dev ${iface}）：${r}${f}`;
}

export function fmtProbe({ addr, i, n, ok, status, ms, error }) {
  return ok
    ? `${TAG} ${MARK.step} 探活 ${i}/${n} 源=${addr} → HTTP ${status} ${ms}ms`
    : `${TAG} ${MARK.warn} 探活 ${i}/${n} 源=${addr} → 失败 ${ms}ms ${error || `HTTP ${status}`}`;
}

export function fmtPool({ prefix, addrs = [], claimed, mode }) {
  return `${TAG} ${MARK.ok} 出口池就绪：前缀 ${prefix}｜源地址 ${addrs.length} 个：${addrs.join(" ")}｜认领方式 ${mode}｜配额信号即换新地址（不重注册、不握手，成本≈0）`;
}

export function fmtPoolEmpty({ tried = 0 } = {}) {
  return `${TAG} ${MARK.fail} 池里 ${tried} 个源地址**全部**探活失败（内核接受了地址，但整段没真路由到本机）⇒ 本次走直连。下一步：① 确认机房把整段路由到本机；② 或设 MSLXDFF_V6_POOL=0 恢复 WARP 池；③ 或 MSLXDFF_V6_PREFIX=<真正路由过来的段>/<位数>`;
}

export function fmtReadyFail({ error }) {
  return `${TAG} ${MARK.fail} 建池过程出错，本次走直连：${error}`;
}

export function fmtSwap({ from, to, status, kind, forced, swaps, prevCounts }) {
  return `${TAG} ${MARK.warn} 源 ${from} 上游 ${status} 判为「${kind}」⇒ 换源地址 ${to}（本槽第 ${swaps} 次${forced ? "，强制跳过冷却" : ""}；旧地址计数 ${fmtCounts(prevCounts)}）`;
}

export function fmtSwapFail({ addr, error }) {
  return `${TAG} ${MARK.fail} 源 ${addr} 换址失败（该槽保持原地址，继续用）：${error}`;
}

export function fmtFirstOk({ addr, swaps, counts }) {
  return swaps > 0
    ? `${TAG} ${MARK.ok} 源 ${addr} 首个响应 200 ⇒ **换址后立刻恢复**（第 ${swaps} 次换址有效；新地址计数 ${fmtCounts(counts)}）`
    : `${TAG} ${MARK.ok} 源 ${addr} 首个响应 200（池内地址工作正常）`;
}

export function fmtNoRotate({ addr, status, kind }) {
  return `${TAG} ${MARK.warn} 源 ${addr} 上游 ${status}（${kind}）—— 换址开关关着（MSLXDFF_V6_ROTATE=0），不换源地址`;
}

export function fmtVerdictNo({ addr, status, kind, why }) {
  return `${TAG} ${MARK.step} 源 ${addr} 上游 ${status} 判为「${kind}」⇒ 不换源地址：${why}`;
}

export function fmtRetire({ addr }) {
  return `${TAG} ${MARK.step} 退休旧出口 ${addr}（关 Agent + 释放地址；留到最后是为让在飞请求走完）`;
}

export function fmtClose({ released = [] } = {}) {
  return released.length
    ? `${TAG} ${MARK.step} 收摊：释放源地址 ${released.length} 个：${released.join(" ")}`
    : `${TAG} ${MARK.step} 收摊：没有需要释放的源地址（bind 模式不碰网卡）`;
}

export function fmtDispatch({ addr, session }) {
  return `${TAG} · 源=${addr} 会话=${session}`;
}

export function fmtDirect({ reason }) {
  return `${TAG} ${MARK.warn} 本次走直连：${reason}`;
}
