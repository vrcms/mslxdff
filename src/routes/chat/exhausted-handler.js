// Note: 失败收尾四分支在 result 后补 client-response，与成功路径对账口径一致（result 条数 == client-response 条数）— 见 .agents/notes/implemented/bug-fix/2026-09-25-sdk-headers-timeout-and-failure-client-response.md
import { relay } from "../stream.js";
import { endHeldFailure } from "../stream-hold.js"; // 终局收场出口（502 JSON 或 SSE 错误帧 + [DONE]）
import { json } from "../helpers.js";
import { performance } from "node:perf_hooks";
import { recordRelayTalk } from "../../talk-log.js"; // 环形对话日志：exhausted 收尾直连 relay，落盘点必须自己补一份

// 最后一站的收场：relay 的「不写响应」路径（超时 / 空轮延后封口）都汇到这里，没有上层 failover 了，
// 必须把响应「恰好一次」地关掉。形状由 endHeldFailure 按 headers 是否已 flush 决定
// （未 flush → 502 JSON；已 flush 的 SSE → 错误帧 + [DONE]），这里不再自己 json() 打已 flush 的流。
function terminal(res, message) {
  endHeldFailure(res, message || "all auto models failed");
}

export async function handleExhaustedLocal({ res, body, lastErr, order, handlerCtx, evt, logCall, mark, perf0, stages, done, requested, useAuto, deps = {} }) {
  const { relay: relayImpl = relay } = deps;
  const model = lastErr?.model ?? handlerCtx.model;
  evt("exhausted-local", { reqId: handlerCtx.reqId, lastModel: lastErr?.model ?? model, lastStatus: lastErr?.status ?? 502, order });
  logCall(lastErr?.model ?? model, lastErr?.status ?? 502);
  if (lastErr?.upstream) {
    evt("relay-start", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-exhausted", isStream: Boolean(body.stream) });
    const out = await relayImpl(res, lastErr.upstream, body, {
      onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
      onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
    });
    evt("relay-done", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-exhausted", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
    // 绕过 relay-pipeline 的最后一站：对话日志照常落盘（正文只进 talk/*.log，不进 events.log）
    try { recordRelayTalk({ reqId: handlerCtx.reqId, model: lastErr.model, via: "local-exhausted", body, out }); } catch {}
    evt("result", { reqId: handlerCtx.reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
    evt("client-response", { requested, actual: lastErr.model, via: "local", fallback: false, status: out.status, reqId: handlerCtx.reqId });
    // 最后一站：relay 超时/空轮留口路径都不写响应，这里没有上层，必须自己收尾
    if (out.timedOut || out.heldOpen) {
      terminal(res, out.detail?.exitReason === "empty-turn-hold"
        ? "EMPTY_MODEL_RESPONSE: 空轮重拉与换候选全部用尽，仍无正文"
        : out.detail?.upstreamError ? `upstream error: ${out.detail.upstreamError}` : `stream timed out after ${out.totalMs}ms`);
    }
    return true;
  }
  evt("result", { reqId: handlerCtx.reqId, model, status: lastErr?.status ?? 502, via: "none", timing: null });
  evt("client-response", { requested, actual: model, via: "none", fallback: false, status: lastErr?.status ?? 502, reqId: handlerCtx.reqId });
  done({ via: "none", status: lastErr?.status ?? 502, error: lastErr?.message || "all auto models failed" });
  terminal(res, lastErr?.message);
  return true;
}

export async function handleExhaustedAll({ res, body, lastErr, order, requested, handlerCtx, evt, logCall, mark, perf0, stages, deps = {} }) {
  const { relay: relayImpl = relay } = deps;
  evt("exhausted-all", { reqId: handlerCtx.reqId, lastModel: lastErr?.model ?? requested, lastStatus: lastErr?.status ?? 502, order });
  logCall(lastErr?.model ?? requested, lastErr?.status ?? 502);
  if (lastErr?.upstream) {
    evt("relay-start", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-final", isStream: Boolean(body.stream) });
    const out = await relayImpl(res, lastErr.upstream, body, {
      onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
      onDownstreamAbort: () => evt("client-abort", { reqId: handlerCtx.reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
    });
    evt("relay-done", { reqId: handlerCtx.reqId, model: lastErr.model, via: "local-final", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
    // 同上：全链耗尽的最终转发也要留下问答原文
    try { recordRelayTalk({ reqId: handlerCtx.reqId, model: lastErr.model, via: "local-final", body, out }); } catch {}
    evt("result", { reqId: handlerCtx.reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
    evt("client-response", { requested, actual: lastErr.model, via: "local", fallback: false, status: out.status, reqId: handlerCtx.reqId });
    // 最后一站：relay 超时/空轮留口路径不写响应，这里没有上层 failover，必须自己收尾
    if (out.timedOut || out.heldOpen) {
      terminal(res, out.detail?.upstreamError ? `upstream error: ${out.detail.upstreamError}` : `stream timed out after ${out.totalMs}ms`);
    }
    return true;
  }
  evt("result", { reqId: handlerCtx.reqId, model: lastErr?.model ?? requested, status: lastErr?.status ?? 502, via: "none", timing: null });
  evt("client-response", { requested, actual: lastErr?.model ?? requested, via: "none", fallback: false, status: lastErr?.status ?? 502, reqId: handlerCtx.reqId });
  terminal(res, lastErr?.message);
  return true;
}
