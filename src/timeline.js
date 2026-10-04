// 人读请求时间线：只输出状态/耗时/出口，不输出 prompt、响应正文或凭据。
// Note: 渲染口径与失败路径 client-response 对账（result 与 client-response 条数须相等）— 见 .agents/notes/implemented/feature/2026-09-25-model-trace-log.md
function hostPort(value) {
  try { const u = new URL(String(value)); return u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { return String(value || "-").slice(0, 80); }
}
function short(value, n = 90) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return !s ? "-" : s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function outcome(status, reason) {
  if (status == null) return reason ? `- ${short(reason)}` : "-";
  return `${status}${reason ? ` ${short(reason)}` : ""}`;
}

 export function formatTimeline({ reqId, model, direct = [], peers = [], retries = 0, retryResult = null, result = null, totalMs = 0 } = {}) {
  const d = direct.length ? direct[direct.length - 1] : null;
  const ps = peers.map((p) => `[peer=${hostPort(p.peer)} ${p.ok ? "win" : "fail"} ${p.latencyMs != null ? `${p.latencyMs}ms` : "timing-"} ${short(p.message || p.status || "", 70)}]`);
  const r = result || {};
  const detail = r.detail || {};
  const res = r.status == null ? "-" : `${r.status}${detail.sawFinishReason ? ` ${detail.sawFinishReason}` : ""}${detail.toolCalls ? ` tools=${detail.toolCalls}` : ""}${detail.chars != null ? ` chars=${detail.chars}` : ""}${detail.interrupted ? " interrupted=1" : ""}${detail.timedOut ? " timedOut=1" : ""}`;
  const directText = d ? outcome(d.status, d.reason) : "-";
  // retry= 次数（保持既有 token 可 grep）；win=1 重试后救回，lost=1 重试用尽仍零正文。
  const _rc = retryResult === "ok" ? " [retry_win=1]" : retryResult === "lost" ? " [retry_lost=1]" : "";
  const retryTag = (retries || retryResult) ? ` [retry=${retries || 0}]${_rc}` : "";
  return `[req=${reqId || "-"}] [model=${model || "-"}] [direct=${directText}]${ps.length ? ` ${ps.join(" ")}` : ""}${retryTag} [result=${res}] [total=${Math.max(0, Math.round(Number(totalMs) || 0))}ms]`;
}
