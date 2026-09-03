import { runHook } from "../../plugins.js";
import { recordModelStats } from "../../state.js";
import { normalizeFullId } from "../../providers/model-id.js";
import { computeMetrics, extractUsageFromJson, extractUsageFromSseText } from "../../metrics.js";

/**
 * RelayPipeline 深模块
 * 把 5 个 handler 各自的 fallback→relay→scoring→事件 6段流水收敛为单一真相。
 * 对外 1 接口：createRelayPipeline(deps) => { execute(ctx) }
 * 设计要点：全部外部可注入，便于在 pipeline seam 上做行为测试；constants 注入便于单测加速。
 */
export function createRelayPipeline({
  relay,
  buildFallbackInfo,
  auto,
  plugins,
  evt,
  mark,
  logCall,
  logError,
  constants,
  startedAt: defaultStartedAt,
  stages: defaultStages,
  perfNow,
} = {}) {
  const C = {
    STREAM_TIMEOUT_MS: 25_000,
    SLOW_TOTAL_MS: 20_000,
    STALL_TIMEOUT_MS: 0,
    SCORE_STALL_MS: 15_000,
    ...(constants || {}),
  };
  const _relay = relay;
  const _build = buildFallbackInfo;
  const _evt = evt || (() => {});
  const _mark = mark || (() => {});
  const _logCall = logCall || (() => {});
  const _logError = logError || (() => {});
  const _perfNow = perfNow || (() => Date.now());

  async function execute({
    res,
    upRes,
    body,
    requested,
    actual,
    lastErr,
    via,
    lockModel,
    useAuto,
    handlerCtx,
    mark: m2,
    perf0,
    stages: s2,
    startedAt: sa2,
  } = {}) {
    const markFn = m2 || _mark;
    const curStartedAt = sa2 ?? defaultStartedAt ?? Date.now();
    const curStages = s2 ?? defaultStages ?? [];
    const reqId = handlerCtx?.reqId;
    const hops = handlerCtx?.hops;

    // 1. logCall(pre) — 保持原 handler 的 logCall→fallback→relay-start 时序
    try { _logCall(actual, upRes?.status); } catch {}
    // 2. fallback + relay-start
    let fallback = null;
    try {
      if (_build) fallback = _build({ requested, actual, lastErr, via, useAuto, lockModel });
    } catch {}
    if (fallback?.fallback) {
      _evt("fallback-notice", { reqId, requested, actual, reason: fallback.reason, notice: fallback.notice, via, fallback: true });
    }
    _evt("relay-start", { reqId, model: actual, via, isStream: Boolean(body?.stream), fallback });

    // 3. relay
    const out = await _relay(res, upRes, body, {
      fallback,
      onFirstChunk: (delta) => {
        try { markFn(`ttf-${actual}`); } catch {}
        _evt("relay-first-chunk", { reqId, model: actual, ttfMs: delta, via });
        if (plugins?.length) runHook(plugins, "relay:first-chunk", { reqId, requested, model: actual, via, ttfMs: delta }).catch(() => {});
      },
      onDownstreamAbort: () => {
        _evt("client-abort", { reqId, model: actual, totalMs: Math.round(_perfNow() - (perf0 ?? 0)), stages: [...curStages] });
      },
    });

    // 4. relay-done
    _evt("relay-done", {
      reqId,
      model: actual,
      via,
      status: out.status,
      ttfMs: out.ttfMs,
      totalMs: out.totalMs,
      aborted: out.aborted,
      interrupted: out.interrupted ?? false,
      detail: out.detail ?? null,
    });

    // 5a. 首块超时未写字节 → 回退
    if (out.status === C.STREAM_TIMEOUT_MS) {
      if (auto) try { await auto.recordError(actual, { status: 502, slow: true, note: `stream timeout ${C.STREAM_TIMEOUT_MS}ms` }); } catch {}
      try { _logError(actual, 502, `stream timeout ${C.STREAM_TIMEOUT_MS}ms`); } catch {}
      _evt("upstream-error", { reqId, model: actual, status: 502, message: "stream timeout", timing: null });
      _evt("fallback", { reqId, from: actual, to: null, reason: "stream timeout" });
      return { handled: false, upRes: null, lastErr: { model: actual, upstream: null, status: 502, message: `stream timed out after ${C.STREAM_TIMEOUT_MS}ms` } };
    }

    // 5b. 中断（stall 超时 / max 流时长）
    if (out.interrupted) {
      if (auto) {
        try { await auto.recordError(actual, { status: 200, slow: true, note: `stall ${C.STALL_TIMEOUT_MS}ms` }); } catch {}
        try { await auto.recordLatency(actual, out.totalMs ?? (Date.now() - curStartedAt)); } catch {}
      }
      _evt("slow-model", { reqId, model: actual, elapsedMs: out.totalMs ?? (Date.now() - curStartedAt), threshold: C.STALL_TIMEOUT_MS, interrupted: true, detail: out.detail ?? null });
      try { _logCall(actual, 200); } catch {}
      _evt("result", { reqId, model: actual, status: out.status, via, timing: upRes?._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, interrupted: true, detail: out.detail ?? null, fallback, requested, actual });
      _evt("client-response", { requested, actual, via, fallback, status: out.status, reqId, interrupted: true });
      if (plugins?.length) runHook(plugins, "request:completed", { reqId, requested, useAuto, hops, stream: Boolean(body?.stream), durationMs: Date.now() - curStartedAt, via, status: out.status, actual, interrupted: true, fallback }).catch(() => {});
      return { handled: true };
    }

    // 5c. 慢速计分 + ok
    const elapsed = Date.now() - curStartedAt;
    const latencyMs = out.totalMs ?? elapsed;
    let scoredSlow = false;

    if (C.SLOW_TOTAL_MS && auto && elapsed > C.SLOW_TOTAL_MS && out.status === 200) {
      try { await auto.recordError(actual, { status: 200, slow: true, note: `slow ${elapsed}ms` }); } catch {}
      try { await auto.recordLatency(actual, latencyMs); } catch {}
      _evt("slow-model", { reqId, model: actual, elapsedMs: elapsed, threshold: C.SLOW_TOTAL_MS, reason: "total", detail: out.detail ?? null });
      scoredSlow = true;
    }
    if (out.detail?.stallHits > 0 && auto && out.status === 200) {
      try { await auto.recordError(actual, { status: 200, slow: true, note: `stall ${out.detail.stallHits}x gap>${C.SCORE_STALL_MS}ms maxGap ${out.detail.maxGapMs}ms` }); } catch {}
      try { await auto.recordLatency(actual, latencyMs); } catch {}
      _evt("slow-model", { reqId, model: actual, elapsedMs: elapsed, threshold: C.SCORE_STALL_MS, reason: "stall", stallHits: out.detail.stallHits, maxGapMs: out.detail.maxGapMs, detail: out.detail ?? null });
      scoredSlow = true;
    }
    if (!scoredSlow && auto && out.status === 200) {
      try { await auto.recordOk(actual, { latencyMs }); } catch {}
    } else if (!scoredSlow && auto) {
      try { await auto.recordLatency(actual, latencyMs); } catch {}
    }

    // 每次 8989 正常返回都落体检：count/首字/总耗时/速度（供 -status TopN）
    if (out.status === 200) {
      try {
        const isStream = Boolean(body?.stream);
        let ttfb = isStream ? (out.ttfMs ?? upRes?._t?.ttfbMs ?? null) : null;
        // out.totalMs 为 0 时（非流式 <1ms 四舍五入）回退到 elapsed/durationMs
        const elapsedFallback = Date.now() - curStartedAt;
        let total = out.totalMs;
        if (!Number.isFinite(total) || total <= 0) total = elapsedFallback;
        if (!Number.isFinite(total) || total <= 0) total = latencyMs;
        if (!Number.isFinite(total) || total <= 0) total = Date.now() - curStartedAt;
        if (isStream && (!Number.isFinite(ttfb) || ttfb <= 0)) ttfb = null;
        const usage = out.detail?.usage || null;
        const chars = out.detail?.chars ?? null;
        const compTok = usage?.completion_tokens ?? null;
        const m = computeMetrics({ ttfbMs: ttfb, totalMs: total, completionTokens: compTok, chars });
        const tps = m.tps ?? m.charsPerSec ?? null;
        const fullId = normalizeFullId(actual);
        recordModelStats(fullId, { ttfbMs: ttfb, totalMs: total, tps, completionTokens: compTok });
        if (fullId !== actual) recordModelStats(actual, { ttfbMs: ttfb, totalMs: total, tps, completionTokens: compTok });
      } catch {}
    }

    _evt("result", { reqId, model: actual, status: out.status, via, timing: upRes?._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback, requested, actual });
    _evt("client-response", { requested, actual, via, fallback, status: out.status, reqId });
    if (plugins?.length) runHook(plugins, "request:completed", { reqId, requested, useAuto, hops, stream: Boolean(body?.stream), durationMs: Date.now() - curStartedAt, via, status: out.status, actual, fallback }).catch(() => {});
    return { handled: true };
  }

  return { execute };
}
