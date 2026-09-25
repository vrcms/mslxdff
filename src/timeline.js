// 人读请求时间线：只输出状态/耗时/出口，不输出 prompt、响应正文或凭据。
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

export function formatTimeline({ reqId, model, direct = [], peers = [], retries = 0, result = null, totalMs = 0 } = {}) {
  const d = direct.length ? direct[direct.length - 1] : null;
  const ps = peers.map((p) => `[peer=${hostPort(p.peer)} ${p.ok ? "win" : "fail"} ${p.latencyMs != null ? `${p.latencyMs}ms` : "timing-"} ${short(p.message || p.status || "", 70)}]`);
  const r = result || {};
  const detail = r.detail || {};
  const res = r.status == null ? "-" : `${r.status}${detail.sawFinishReason ? ` ${detail.sawFinishReason}` : ""}${detail.toolCalls ? ` tools=${detail.toolCalls}` : ""}${detail.chars != null ? ` chars=${detail.chars}` : ""}${detail.interrupted ? " interrupted=1" : ""}${detail.timedOut ? " timedOut=1" : ""}`;
  const directText = d ? outcome(d.status, d.reason) : "-";
  return `[req=${reqId || "-"}] [model=${model || "-"}] [direct=${directText}]${ps.length ? ` ${ps.join(" ")}` : ""}${retries ? ` [retry=${retries}]` : ""} [result=${res}] [total=${Math.max(0, Math.round(Number(totalMs) || 0))}ms]`;
}
