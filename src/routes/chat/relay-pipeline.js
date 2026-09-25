import { runHook } from "../../plugins.js";
import { recordModelStats } from "../../state.js";
import { normalizeFullId } from "../../providers/model-id.js";
import { computeMetrics } from "../../metrics.js";
import { recordChatUsage } from "../../usage/record.js"; // 窗口报表唯一写入点（canonical 名单记防双计）— 见 .agents/notes/implemented/feature/2026-09-19-usage-report-jsonl.md
import { recordOutput, computeOutputRow } from "../../providers/cline/usage.js"; // cline 专属旁路统计（账号×模型，流式也覆盖）

// 唯一/最后候选没有 failover 去向：首块闸门退化为纯"防连接泄漏"，放宽避免误杀慢模型
// （参考 opencode：zen 通道不设超时；openai responses 硬编码 300s headerTimeout）
export const LAST_CANDIDATE_TIMEOUT_MS = (() => {
  const n = Number(process.env.MSLXDFF_LAST_CANDIDATE_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 0 ? n : 120_000;
})();

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
    streamTimeoutMs: ctxStreamTimeoutMs,
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

    // 3. relay（唯一/最后候选：无 failover 去向 → 闸门放宽到防泄漏级别；显式 streamTimeoutMs 优先）
    const orderLen = handlerCtx?.orderLen;
    const curIdx = handlerCtx?.idx;
    const isLastCandidate =
      Number.isInteger(orderLen) && orderLen > 0 &&
      (orderLen === 1 || (Number.isInteger(curIdx) && curIdx >= orderLen - 1));
    const streamTimeoutMs = Number.isInteger(ctxStreamTimeoutMs) && ctxStreamTimeoutMs >= 0
      ? ctxStreamTimeoutMs
      : (isLastCandidate ? LAST_CANDIDATE_TIMEOUT_MS : C.STREAM_TIMEOUT_MS);
    const out = await _relay(res, upRes, body, {
      fallback,
      streamTimeoutMs,
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
      timedOut: out.timedOut ?? false,
      detail: out.detail ?? null,
    });

    // 5a0. 空转 200：流正常结束但零正文零工具调用 → 客户端会报 EMPTY_MODEL_RESPONSE
    // （"The model ended its turn without producing any output"）；转 failover 而不是
    // 把空轮递给客户端。chatShaped 是前置证据：只有看得出是 chat 轮才判空，
    // 非 chat SSE/无 choices JSON 透传是正式契约（chat-route 单测锁死），一律放行。
    // 工具轮豁免：tool_calls 无正文是合法 agent 形态；
    // finish=tool_calls/function_call 兜底豁免（防计数漏检误杀）；下游已断开不重试（写给谁看）。
    // 对标 dsh-cline-pass 的 EMPTY_RESPONSE 语义；不记 auto 冷却（空转≠模型坏，重试多半能好）。
    const _d = out.detail || {};
    const _emptyTurn = out.status === 200 && !out.timedOut && !out.interrupted && !_d.downstreamClosed &&
      _d.chatShaped === true &&
      (Number(_d.chars) || 0) === 0 && (Number(_d.toolCalls) || 0) === 0 &&
      !["tool_calls", "function_call"].includes(_d.sawFinishReason);
    if (_emptyTurn) {
      const _why = _d.sawFinishReason ? ` (finish_reason=${_d.sawFinishReason})` : " (no content, no tool calls)";
      try { _logError(actual, 502, `empty turn${_why}`); } catch {}
      _evt("upstream-error", { reqId, model: actual, status: 502, message: "empty turn", timing: null });
      _evt("fallback", { reqId, from: actual, to: null, reason: "empty turn" });
      return { handled: false, upRes: null, lastErr: { model: actual, upstream: null, status: 502, message: `EMPTY_MODEL_RESPONSE: upstream returned 200 with no content${_why} — retry or rephrase` } };
    }

    // 5a. 首块超时未写字节 → 回退（显式 timedOut 字段，status 只是 HTTP 语义展示）
    if (out.timedOut === true) {
      const why = out.detail?.upstreamError ? ` (upstream read error: ${out.detail.upstreamError})` : "";
      if (auto) try { await auto.recordError(actual, { status: 502, slow: true, note: `stream timeout ${streamTimeoutMs}ms` }); } catch {}
      try { _logError(actual, 502, `stream timeout ${streamTimeoutMs}ms${why}`); } catch {}
      _evt("upstream-error", { reqId, model: actual, status: 502, message: "stream timeout", timing: null });
      _evt("fallback", { reqId, from: actual, to: null, reason: "stream timeout" });
      return { handled: false, upRes: null, lastErr: { model: actual, upstream: null, status: 502, message: `stream timed out after ${streamTimeoutMs}ms${why}` } };
    }

    // 5b. 中断（stall 超时 / max 流时长）
    if (out.interrupted) {
      if (auto) {
        try { await auto.recordError(actual, { status: 200, slow: true, note: `stall ${C.STALL_TIMEOUT_MS}ms` }); } catch {}
        try { await auto.recordLatency(actual, out.totalMs ?? (Date.now() - curStartedAt)); } catch {}
      }
      _evt("slow-model", { reqId, model: actual, elapsedMs: out.totalMs ?? (Date.now() - curStartedAt), threshold: C.STALL_TIMEOUT_MS, interrupted: true, detail: out.detail ?? null });
      try { _logCall(actual, 200); } catch {}
      // interrupted 的 200 也是真实消耗（最贵的长生成）——照常落 usage 标 interrupted:1，口径与 5c 一致 — 见 .agents/notes/implemented/feature/2026-09-19-usage-report-jsonl.md
      if (out.status === 200) {
        try {
          const u = out.detail?.usage || null;
          const t1 = Number.isFinite(out.totalMs) && out.totalMs > 0 ? out.totalMs : (Date.now() - curStartedAt);
          const t0 = Number.isFinite(out.ttfMs) && out.ttfMs > 0 ? out.ttfMs : null;
          recordChatUsage({ model: normalizeFullId(actual), via, usage: u, interrupted: 1, ttfbMs: t0, totalMs: t1, tps: null }).catch(() => {});
        } catch {}
      }
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
        // 窗口报表：逐请求落 usage（行形状由 usage/record.js 拥有，含 prompt/total ——
        // state 的 modelStats 只存 completion 的 EMA）。只按 canonical 名记一次，避免双计。
        recordChatUsage({ model: fullId, via, usage, ttfbMs: ttfb, totalMs: total, tps: m.tps }).catch(() => {});
        // cline 旁路记账：流式时 provider 已把账号哈希挂在 upRes 上，这里用消费完的 usage 记一笔。
        // 纯旁路：只调 recordOutput，不改转发/切号/重试；无账号或非 cline 直接跳过。
        if (upRes?.clineAccountId) {
          const clineModel = upRes.clineModel || String(actual).replace(/^cline\//, "");
          const orow = computeOutputRow({ model: clineModel, accountId: upRes.clineAccountId, usage, chars });
          if (orow) recordOutput(orow).catch(() => {});
        }
      } catch {}
    }

    _evt("result", { reqId, model: actual, status: out.status, via, timing: upRes?._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback, requested, actual });
    _evt("client-response", { requested, actual, via, fallback, status: out.status, reqId });
    if (plugins?.length) runHook(plugins, "request:completed", { reqId, requested, useAuto, hops, stream: Boolean(body?.stream), durationMs: Date.now() - curStartedAt, via, status: out.status, actual, fallback }).catch(() => {});
    return { handled: true };
  }

  return { execute };
}
