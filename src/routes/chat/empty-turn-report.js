// 空转 200 的收场记账（从 relay-pipeline.js 抽出：那儿是 20KB 硬门的存量超标文件，先拆后写）。
// 只做「把这一轮判成空转后该记什么、该把 lastErr 造成什么形状」，不碰网络/闸门/响应体。
// 判据本身不在这里：单一真相是 stream-scan.js 的 isEmptyTurnDetail（relay 侧「要不要封口」与
// 这里「要不要重拉」必须同源，否则会出现留了口却不再救、或已终结却仍重拉的错拍）。
import { upstreamEcho } from "../../model-trace.js";

/**
 * 空转 200 收场：记 errors.log + upstream-error/fallback 事件，返回交给 serial-trial 的 lastErr。
 * @param {{ out: object, actual: string, reqId: string, upRes: object, logError: Function, evt: Function }} p
 * @returns {{ handled: false, upRes: null, lastErr: object }}
 */
export function reportEmptyTurn({ out, actual, reqId, upRes, logError, evt }) {
  const d = out.detail || {};
  const why = d.sawFinishReason ? ` (finish_reason=${d.sawFinishReason})` : " (no content, no tool calls)";
  // 错误包络暂扣后下游不再直观看到上游原文：把摘要带进最终报错（截断 200 字），排障不断线。
  const err = d.upstreamErrorText ? ` upstream=${String(d.upstreamErrorText).slice(0, 200)}` : "";
  // 零正文的成因直接写进报错（不只给现象）：finish_reason=length + 大量思考 = 额度被 reasoning 吃光
  // （实测 cline-free deepseek reasoningChars=28151、completion_tokens=8192=max_tokens、chars=0）。
  // 同参重拉必复现，故 serial-trial 的空转重试会顺手把 max_tokens 抬一档（见 emptyRaiseCap）。
  const lenCapped = d.sawFinishReason === "length";
  const hint = lenCapped && (Number(d.reasoningChars) || 0) > 0
    ? ` [思考 ${Number(d.reasoningChars) || 0} 字刷满 max_tokens，正文 0 字]`
    : "";
  try { logError(actual, 502, `empty turn${why}${err}${hint}`); } catch {}
  evt("upstream-error", { reqId, model: actual, status: 502, message: "empty turn", timing: null, finish: d.sawFinishReason || null, reasoningChars: Number(d.reasoningChars) || 0, wroteFrames: Number(d.wroteChunks) || 0, heldOpen: out.heldOpen === true, ...upstreamEcho(upRes) });
  evt("fallback", { reqId, from: actual, to: null, reason: "empty turn" });
  let errMsg = `EMPTY_MODEL_RESPONSE: upstream returned 200 with no content${why}${err}${hint} — retry or rephrase`;
  // 上游报了 retryAfterSeconds：原样透出（客户端等得起），别被我们的包装话术盖掉。
  if (d.upstreamErrorText && d.upstreamErrorText.includes("retryAfterSeconds")) errMsg = d.upstreamErrorText;
  return { handled: false, upRes: null, lastErr: { model: actual, upstream: null, status: 502, message: errMsg, emptyTurn: true, heldOpen: out.heldOpen === true } };
}
