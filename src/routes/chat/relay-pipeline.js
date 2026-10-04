import { runHook } from "../../plugins.js";
import { recordModelStats } from "../../state.js";
import { normalizeFullId } from "../../providers/model-id.js";
import { computeMetrics } from "../../metrics.js";
import { recordChatUsage } from "../../usage/record.js"; // 窗口报表唯一写入点（canonical 名单记防双计）— 见 .agents/notes/implemented/feature/2026-09-19-usage-report-jsonl.md
import { recordOutput, computeOutputRow } from "../../providers/cline/usage.js"; // cline 专属旁路统计（账号×模型，流式也覆盖）
import { upstreamEcho } from "../../model-trace.js"; // 回显头→日志字段（谁上的/哪个号/为什么/是否冷却）单一来源
import { recordRelayTalk } from "../../talk-log.js"; // 环形对话日志（问答全文，最近 1 小时）：五段流水在此汇合，落盘点只这一个
import { isEmptyTurnDetail } from "../stream-scan.js"; // 空轮判据单一真相（stream.js 用它决定封不封口，这里用它决定交不交回重试）

// 唯一/最后候选没有 failover 去向：首块闸门退化为纯"防连接泄漏"，放宽避免误杀慢模型
// （参考 opencode：zen 通道不设超时；openai responses 硬编码 300s headerTimeout）
export const LAST_CANDIDATE_TIMEOUT_MS = (() => {
  const n = Number(process.env.MSLXDFF_LAST_CANDIDATE_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 0 ? n : 120_000;
})();

/** 空转 200 判定（serial-trial 同模型重试用）：与 execute 内 _emptyTurn 产生的 lastErr 同源 */
export function isEmptyTurnError(err) {
  return Number(err?.status) === 502 && String(err?.message || "").startsWith("EMPTY_MODEL_RESPONSE");
}

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
    attemptStartMs,
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
      attemptStartMs, // 本次上游尝试起点（performance.now 同源），relay 用它算 preflightMs
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
      ...upstreamEcho(upRes),
      detail: out.detail ?? null,
    });

    // 环形对话日志：只记有真实输出的轮次（空轮交给下面的空转判定另行报错）。
    // 纯旁路：不改闸门、不改计时、不改返回体；任何异常都吞掉，绝不影响转发。
    try { recordRelayTalk({ reqId, model: actual, via, hops, body, out, echo: upstreamEcho(upRes) }); } catch {}

    // 5a0. 空转 200：流正常结束但零正文零工具调用 → 客户端会报 EMPTY_MODEL_RESPONSE
    // （"The model ended its turn without producing any output"）；转 failover 而不是
    // 把空轮递给客户端。chatShaped 是前置证据：只有看得出是 chat 轮才判空，
    // 非 chat SSE/无 choices JSON 透传是正式契约（chat-route 单测锁死），一律放行。
    // 工具轮豁免：tool_calls 无正文是合法 agent 形态；
    // finish=tool_calls/function_call 兜底豁免（防计数漏检误杀）；下游已断开不重试（写给谁看）。
    // 对标 dsh-cline-pass 的 EMPTY_RESPONSE 语义；不记 auto 冷却（空转≠模型坏，重试多半能好）。
    // 判据单一真相在 stream-scan.js:isEmptyTurnDetail —— relay 侧「要不要封口」与这里「要不要重拉」必须同源，否则会出现留了口却不再救、或已终结却仍重拉的错拍
    // heldOpen 也计入：非流式留口返回的是上游原状态码（2xx 变体或中继的 ≥400），只认 200 会漏判 → 没人收场，连接挂死
    const _d = out.detail || {};
    const _emptyTurn = (out.status === 200 || out.heldOpen === true) && !out.timedOut && !out.interrupted && !_d.downstreamClosed && isEmptyTurnDetail(_d);
    if (_emptyTurn) {
      const _why = _d.sawFinishReason ? ` (finish_reason=${_d.sawFinishReason})` : " (no content, no tool calls)";
      // 错误包络暂扣后下游不再直观看到上游原文：把摘要带进最终报错（截断 200 字），排障不断线。
      const _err = _d.upstreamErrorText ? ` upstream=${String(_d.upstreamErrorText).slice(0, 200)}` : "";
      // 零正文的成因直接写进报错（不只给现象）：finish_reason=length + 大量思考 = 额度被 reasoning 吃光
      // （实测 cline-free deepseek reasoningChars=28151、completion_tokens=8192=max_tokens、chars=0）。
      // 同参重拉必复现，故 serial-trial 的空转重试会顺手把 max_tokens 抬一档（见 emptyRaiseCap）。
      const _lenCapped = _d.sawFinishReason === "length";
      const _hint = _lenCapped && (Number(_d.reasoningChars) || 0) > 0
        ? ` [思考 ${Number(_d.reasoningChars) || 0} 字刷满 max_tokens，正文 0 字]`
        : "";
      try { _logError(actual, 502, `empty turn${_why}${_err}${_hint}`); } catch {}
      _evt("upstream-error", { reqId, model: actual, status: 502, message: "empty turn", timing: null, finish: _d.sawFinishReason || null, reasoningChars: Number(_d.reasoningChars) || 0, wroteFrames: Number(_d.wroteChunks) || 0, heldOpen: out.heldOpen === true, ...upstreamEcho(upRes) });
      _evt("fallback", { reqId, from: actual, to: null, reason: "empty turn" });
      let _errMsg = `EMPTY_MODEL_RESPONSE: upstream returned 200 with no content${_why}${_err}${_hint} — retry or rephrase`;
      if (_d.upstreamErrorText && _d.upstreamErrorText.includes("retryAfterSeconds")) {
        _errMsg = _d.upstreamErrorText;
      }
      return { handled: false, upRes: null, lastErr: { model: actual, upstream: null, status: 502, message: _errMsg, emptyTurn: true, heldOpen: out.heldOpen === true } };
    }

    // 上报锚点偏移：relay 入口之前消耗掉的等待（上游排队、建连、provider 为取判决预读的首帧）。
    // 只加给 usage 行的时长；闸门计时与 recordModelStats 一律不碰 —— 见 design D2 与 Non-Goals。
    const anchorMs = Number.isFinite(out?.preflightMs) && out.preflightMs > 0 ? out.preflightMs : 0;
    // 5a. 首块超时未写字节 → 回退（显式 timedOut 字段，status 只是 HTTP 语义展示）
    if (out.timedOut === true) {
      const why = out.detail?.upstreamError ? ` (upstream read error: ${out.detail.upstreamError})` : "";
      if (auto) try { await auto.recordError(actual, { status: 502, slow: true, note: `stream timeout ${streamTimeoutMs}ms` }); } catch {}
      try { _logError(actual, 502, `stream timeout ${streamTimeoutMs}ms${why}`); } catch {}
      _evt("upstream-error", { reqId, model: actual, status: 502, message: "stream timeout", timing: null, ...upstreamEcho(upRes) });
      _evt("fallback", { reqId, from: actual, to: null, reason: "stream timeout" });
      return { handled: false, upRes: null, lastErr: { model: actual, upstream: null, status: 502, message: `stream timed out after ${streamTimeoutMs}ms${why}` } };
    }

    // 5b. 中断（stall 超时 / max 流时长）
    if (out.interrupted) {
      if (auto) {
        try { await auto.recordError(actual, { status: 200, slow: true, note: `stall ${C.STALL_TIMEOUT_MS}ms` }); } catch {}
        try { await auto.recordLatency(actual, out.totalMs ?? (Date.now() - curStartedAt)); } catch {}
      }
      _evt("slow-model", { reqId, model: actual, elapsedMs: out.totalMs ?? (Date.now() - curStartedAt), threshold: C.STALL_TIMEOUT_MS, interrupted: true, detail: out.detail ?? null, ...upstreamEcho(upRes) });
      try { _logCall(actual, 200); } catch {}
      // interrupted 的 200 也是真实消耗（最贵的长生成）——照常落 usage 标 interrupted:1，口径与 5c 一致 — 见 .agents/notes/implemented/feature/2026-09-19-usage-report-jsonl.md
      if (out.status === 200) {
        try {
          const u = out.detail?.usage || null;
          const endMs = Number.isFinite(out.totalMs) && out.totalMs >= 0 ? out.totalMs + anchorMs : (Date.now() - curStartedAt);
          const firstMs = Number.isFinite(out.ttfMs) && out.ttfMs >= 0 ? out.ttfMs + anchorMs : null;
          recordChatUsage({ model: normalizeFullId(actual), via, usage: u, interrupted: 1, ttfbMs: firstMs, totalMs: endMs, tps: null, reasoningChars: out.detail?.reasoningChars ?? 0, stream: Boolean(body?.stream) }).catch(() => {});
        } catch {}
      }
      _evt("result", { reqId, model: actual, status: out.status, via, timing: upRes?._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, interrupted: true, ...upstreamEcho(upRes), detail: out.detail ?? null, fallback, requested, actual });
      _evt("client-response", { requested, actual, via, fallback, status: out.status, reqId, interrupted: true });
      if (plugins?.length) runHook(plugins, "request:completed", { reqId, requested, useAuto, hops, stream: Boolean(body?.stream), durationMs: Date.now() - curStartedAt, via, status: out.status, actual, interrupted: true, fallback }).catch(() => {});
      return { handled: true, wrotePayload: out.detail?.wrotePayload === true };
    }

    // 5c. 慢速计分 + ok
    const elapsed = Date.now() - curStartedAt;
    const latencyMs = out.totalMs ?? elapsed;
    let scoredSlow = false;

    if (C.SLOW_TOTAL_MS && auto && elapsed > C.SLOW_TOTAL_MS && out.status === 200) {
      try { await auto.recordError(actual, { status: 200, slow: true, note: `slow ${elapsed}ms` }); } catch {}
      try { await auto.recordLatency(actual, latencyMs); } catch {}
      _evt("slow-model", { reqId, model: actual, elapsedMs: elapsed, threshold: C.SLOW_TOTAL_MS, reason: "total", detail: out.detail ?? null, ...upstreamEcho(upRes) });
      scoredSlow = true;
    }
    if (out.detail?.stallHits > 0 && auto && out.status === 200) {
      try { await auto.recordError(actual, { status: 200, slow: true, note: `stall ${out.detail.stallHits}x gap>${C.SCORE_STALL_MS}ms maxGap ${out.detail.maxGapMs}ms` }); } catch {}
      try { await auto.recordLatency(actual, latencyMs); } catch {}
      _evt("slow-model", { reqId, model: actual, elapsedMs: elapsed, threshold: C.SCORE_STALL_MS, reason: "stall", stallHits: out.detail.stallHits, maxGapMs: out.detail.maxGapMs, detail: out.detail ?? null, ...upstreamEcho(upRes) });
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
        // —— 状态口径（-status / -model stats 的终生 EMA）：本期刻意不动，仍按转发入口量 ——
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
        // —— 报表口径（usage 行 = -stats 的唯一数据源）：把 relay 之前消耗掉的等待补回来 ——
        // 首字 = 本次上游尝试起点 → 网关转发首帧；0ms 是有效样本，只有负值判无效；
        // transport 的 _t.ttfbMs 本就从 fetch 起算，不再叠加锚点（否则双计）。
        const rowTtfb = !isStream ? null
          : Number.isFinite(out.ttfMs) ? (out.ttfMs < 0 ? null : out.ttfMs + anchorMs)
          : (Number.isFinite(upRes?._t?.ttfbMs) ? upRes._t.ttfbMs : null);
        const rowTotal = Number.isFinite(total) ? total + anchorMs : total;
        // 速度恒等：首字与总耗时同加一个常数 → (总−首字) 不变，故沿用 m.tps。
        // 窗口报表：逐请求落 usage（行形状由 usage/record.js 拥有，含 prompt/total ——
        // state 的 modelStats 只存 completion 的 EMA）。只按 canonical 名记一次，避免双计。
        recordChatUsage({ model: fullId, via, usage, ttfbMs: rowTtfb, totalMs: rowTotal, tps: m.tps, reasoningChars: out.detail?.reasoningChars ?? 0, stream: isStream }).catch(() => {});
        // cline 旁路记账：流式时 provider 已把账号哈希挂在 upRes 上，这里用消费完的 usage 记一笔。
        // 纯旁路：只调 recordOutput，不改转发/切号/重试；无账号或非 cline 直接跳过。
        if (upRes?.clineAccountId) {
          const clineModel = upRes.clineModel || String(actual).replace(/^cline\//, "");
          const orow = computeOutputRow({ model: clineModel, accountId: upRes.clineAccountId, usage, chars });
          if (orow) recordOutput(orow).catch(() => {});
        }
      } catch {}
    }

    _evt("result", { reqId, model: actual, status: out.status, via, timing: upRes?._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, ...upstreamEcho(upRes), detail: out.detail ?? null, fallback, requested, actual });
    _evt("client-response", { requested, actual, via, fallback, status: out.status, reqId });
    if (plugins?.length) runHook(plugins, "request:completed", { reqId, requested, useAuto, hops, stream: Boolean(body?.stream), durationMs: Date.now() - curStartedAt, via, status: out.status, actual, fallback }).catch(() => {});
    return { handled: true, wrotePayload: out.detail?.wrotePayload === true };
  }

  return { execute };
}
