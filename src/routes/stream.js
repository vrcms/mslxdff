import { performance } from "node:perf_hooks";
import { applyFallbackHeaders } from "./fallback.js";
import { json } from "./helpers.js";
import { scanSseChunk, flushScanRemainder, preflightMs, createTalkBucketIfEnabled, captureTalkFallback, isEmptyTurnDetail, holdableChunk } from "./stream-scan.js"; // 逐帧观测累加器 + 锚点偏移 + 对话正文 + 空轮判据 + 错误包络暂扣（纯函数与建桶判据全在 stream-scan；可撤销判据走 prefix.isTrivial）
import { holdEndEnabled, createRevocablePrefix, endEmptyTurnStream, endTruncatedStream, flushPrefixTail } from "./stream-hold.js"; // 空轮可撤销前缀 / 延后封口 / 终局收场（拆出去是为了不破 stream.js 20KB 硬门）
import { chunkText, cancelBody, hasPayload, bodyChunks, enrichFirstReply, scanNonStreamReply } from "./stream-body.js"; // 读取层工具（字节→文本 / 取消上游 / 注释帧判定 / 自持 reader 迭代 / 首块富化 / 非流式先判后写），为让本文件退回 20KB 以内而拆出

export const SLOW_TOTAL_MS = (() => {
  const n = Number(process.env.MSLXDFF_SLOW_TOTAL_MS);
  return Number.isInteger(n) && n > 0 ? n : 20_000;
})();

export const STREAM_TIMEOUT_MS = (() => {
  const n = Number(process.env.MSLXDFF_STREAM_TIMEOUT_MS);
  // 0 = 显式关闭首块超时（慢思考模型专用）；未设/非法值 → 默认 25s
  return Number.isInteger(n) && n >= 0 ? n : 25_000;
})();

// 等首块期间的心跳间隔（SSE 注释帧，标准客户端忽略）：上游偶发卡 90s+，避免客户端误判卡死/断连
export const KEEPALIVE_MS = (() => {
  const n = Number(process.env.MSLXDFF_KEEPALIVE_MS);
  return Number.isInteger(n) && n >= 0 ? n : 10_000;
})();

export const STALL_TIMEOUT_MS = (() => {
  const n = Number(process.env.MSLXDFF_STALL_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 0;
})();

export const SCORE_STALL_MS = (() => {
  const raw = process.env.MSLXDFF_SCORE_STALL_MS ?? process.env.MSLXDFF_STALL_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 15_000;
})();

// 流式总时长上限。**默认关闭（0）是刻意且有实测依据的**：agent 长任务单次 relay 合法地远超 120s
// ——扫全量模型日志 6157 条 relay-done，**103 条（1.67%）单次 >120s**，且主体是 `finish=tool_calls`
// 的完整成功流（实测 144s/207s/228s/249s/308s/326s/343s/449s；其中 326s 那条正文 6933 字、客户端 200）。
// 若默认设 120s，这些请求会被腰斩成截断——代价远大于「防挂死」的收益。
// 真正的挂死已有三道约束：首块闸门 STREAM_TIMEOUT_MS（25s）、provider 自身请求级超时（raccoon 300s）、
// 以及被腰斩时的 STREAM_TRUNCATED 错误帧（见 stream-hold.js，客户端至少能识别截断而不会误当完整结果）。
// 需要硬上限时显式设 MSLXDFF_MAX_STREAM_MS=<ms>；`0`=显式关闭。
export const MAX_STREAM_MS = (() => {
  const n = Number(process.env.MSLXDFF_MAX_STREAM_MS);
  return Number.isInteger(n) && n > 0 ? n : 0;
})();

export async function relay(res, upRes, body, { onFirstChunk, onDownstreamAbort, streamTimeoutMs = STREAM_TIMEOUT_MS, keepaliveMs = KEEPALIVE_MS, fallback, attemptStartMs } = {}) {
  const t0 = performance.now();
  // 上报锚点偏移：只加给「上报用时长」（usage 行），闸门计时仍从上面的 t0 起算，两者不得混用
  const preflight = preflightMs(t0, attemptStartMs);
  const contentType = upRes.headers.get("content-type") || "";
  // 需同时满足：客户端要流 + 上游真的是 SSE；避免 muse-spark 聚合 JSON 被误判为流式，或 workbuddy SSE 被聚合
  const isStream = Boolean(body?.stream) && contentType.includes("text/event-stream");
  // 重入同一条连接（空轮留口后同模型重拉 / 换候选）时 headers 可能已 flush（前一发发过 keepalive 注释帧）：
  // 此时 statusCode 与自定义头都不可再设，否则 setHeader 抛 ERR_HTTP_HEADERS_SENT，重拉直接炸在半路
  if (!res.headersSent) {
    res.statusCode = upRes.status;
    // propagate workbuddy uid / allowlist headers
    try {
      const uid = upRes.headers.get("x-mslxdff-workbuddy-uid");
      if (uid) res.setHeader("x-mslxdff-workbuddy-uid", uid);
      const reason = upRes.headers.get("x-mslxdff-workbuddy-reason");
      if (reason) res.setHeader("x-mslxdff-workbuddy-reason", reason);
      const allow = upRes.headers.get("x-mslxdff-allowlist");
      if (allow) res.setHeader("x-mslxdff-allowlist", allow);
      const engine = upRes.headers.get("x-mslxdff-upstream-engine");
      if (engine) res.setHeader("x-mslxdff-upstream-engine", engine);
    } catch {}
    if (fallback) applyFallbackHeaders(res, fallback);
  }

  let ttf = null;
  let interrupted = false;
  let finishedNormally = false;
  let commitPendingPrefix = () => {};
  let flushHeldTail = () => {}; // 把暂扣的 [DONE] 补写出去（错误帧必须能先站在它前面）
  const detail = {
    receivedChunks: 0,
    receivedBytes: 0,
    wroteChunks: 0,
    wroteBytes: 0,
    sawDone: false,
    sawFinishReason: null,
    lastChunkAtMs: null,
    lastChunkGapMs: null,
    maxGapMs: 0,
    stallHits: 0,
    exitReason: null,
    upstreamError: null,
    downstreamClosed: false,
    usage: null,
    chars: 0,
    reasoningChars: 0, // 思考内容字符数（与 chars 分列，相加会重复计数）
    toolCalls: 0,
    chatShaped: false,
    talk: createTalkBucketIfEnabled(), // 正文桶：talk.log 或回路捕获任一开就建，上限单一真相 talkCapChars()
    heldErrorChunks: 0,
    upstreamErrorText: null,
    recoveries: 0,
    wrotePayload: false, // 是否已向下游写出真实数据帧（注释帧不算）：决定空转还能不能靠重试救
  };
  let prevChunkAt = t0;
  // 断下游即掐上游：流式分支装配真实取消，非流式保持 no-op
  let cancelUpstream = () => {};
  const onClose = () => {
    detail.downstreamClosed = true;
    if (!finishedNormally) {
      cancelUpstream();
      if (onDownstreamAbort) onDownstreamAbort();
    }
  };
  res.on("close", onClose);
  // 入口即已断开/已收场：先落账，否则这一发会把留口当成「下游还活着」，重拉写给消失的读者
  if (res.writableEnded || res.destroyed) detail.downstreamClosed = true;

  if (isStream) {
    // failover 重入时 headers 可能已发（前一个候选只发过 keepalive 注释帧就被掐）——已发则不可再设
    if (!res.headersSent) {
      try {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
      } catch { /* ignore */ }
    }
    if (fallback?.fallback) {
      try {
        res.write(`: mslxdff fallback ${fallback.requested_model} -> ${fallback.actual_model} (${fallback.reason})\n`);
        res.write(`: notice ${fallback.notice}\n\n`);
      } catch {}
    }
    if (upRes.body) {
      let first = true;
      let wroteAny = false;
      let wrotePayload = false; // 真实数据帧（注释帧不算）：决定能否安全 failover
      const revocableHold = holdEndEnabled(); // HOLD_END=0 时连缓冲都不做（逐字节复现旧行为，含时机）
      // 可撤销前缀缓冲（策略见 stream-hold.js）：模型产出出现前，空 delta 帧与 [DONE] 先不入下游，
      // 这样同模型重拉 / 换候选的正文还能顺着同一条连接送出去；上限兜底防异常形状囤内存。
      const prefix = createRevocablePrefix(res, detail);
      commitPendingPrefix = () => prefix.commit();
      flushHeldTail = () => flushPrefixTail(prefix);
      let timedOut = false;
      let stalled = false;
      let tooLong = false;
      let stallTimer = null;
      // 自持 reader：超时/断下游时 reader.cancel() 才真的掐得断上游
      // Note: 闸门真取消 + 注释帧不算首块 + wrotePayload 判据 — 见 .agents/notes/implemented/bug-fix/2026-09-17-relay-first-chunk-gate-real-cancel.md
      const reader = typeof upRes.body.getReader === "function" ? upRes.body.getReader() : null;
      let cancelled = false;
      cancelUpstream = () => {
        if (cancelled) return;
        cancelled = true;
        if (reader) { try { reader.cancel().catch(() => {}); } catch { /* ignore */ } }
        else cancelBody(upRes.body);
      };
      let pingTimer = keepaliveMs > 0
        ? setInterval(() => {
            if (wroteAny) return;
            try { res.write(": keepalive\n\n"); } catch { /* ignore */ }
          }, keepaliveMs)
        : null;
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = STALL_TIMEOUT_MS
          ? setTimeout(() => {
              stalled = true;
              detail.exitReason = "stall";
              cancelUpstream();
            }, STALL_TIMEOUT_MS)
          : null;
      };
      let firstTimer = streamTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            detail.exitReason = "first-timeout";
            cancelUpstream();
          }, streamTimeoutMs)
        : null;
      const maxTimer = MAX_STREAM_MS
        ? setTimeout(() => {
            tooLong = true;
            detail.exitReason = "max";
            cancelUpstream();
          }, MAX_STREAM_MS)
        : null;
      try {
        for await (const chunk of bodyChunks(upRes.body, reader)) {
          const now = performance.now();
          detail.receivedChunks += 1;
          const len = chunk?.length ?? chunk?.byteLength ?? 0;
          detail.receivedBytes += len;
          const gap = Math.round(now - prevChunkAt);
          detail.lastChunkAtMs = Math.round(now - t0);
          detail.lastChunkGapMs = gap;
          if (gap > detail.maxGapMs) detail.maxGapMs = gap;
          if (gap > SCORE_STALL_MS) detail.stallHits += 1;
          prevChunkAt = now;
          const txt = chunkText(chunk);
          // 错误包络暂扣：本轮尚未写出真实输出时错误帧不写下游（下游 UI 不再展示瞬时错误），
          // 摘要记 detail.upstreamErrorText 供空转判定与最终报错；已写出真实内容后的错误帧照常透传。
          const holdErr = !wrotePayload ? holdableChunk(txt) : null;
          if (holdErr) {
            detail.heldErrorChunks += 1;
            if (!detail.upstreamErrorText) detail.upstreamErrorText = String(holdErr).slice(0, 500);
          }
          const isPayload = hasPayload(txt);
          const prevChars = detail.chars, prevTools = detail.toolCalls, prevReason = detail.reasoningChars;
          scanSseChunk(detail, txt);
          // 「模型产出」＝正文/工具调用/思考三者本轮有新增。思考也算：已发出的思考撤不回，
          // 从它出现的那刻起这次尝试就提交了（现网空轮多数正是「思考刷满、正文为零」）。
          const gained = Number(detail.chars) > prevChars || Number(detail.toolCalls) > prevTools || Number(detail.reasoningChars) > prevReason;
          // 首块/空闲超时后上游仍吐出了真实数据 → 只是慢，不是死：撤销超时判定，照常转发
          //（cancel 是异步的，竞态窗口内已到达的数据是纯收益；丢掉是纯损失）
          // 注释帧（keepalive）不算：否则对端只要在发心跳，闸门就永远解除
          if (isPayload && !holdErr && (timedOut || stalled)) {
            timedOut = false;
            stalled = false;
            detail.recoveries = (detail.recoveries || 0) + 1;
            if (detail.exitReason === "first-timeout" || detail.exitReason === "stall") detail.exitReason = null;
            if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
          }
          if (timedOut || stalled || tooLong) break;
          if (isPayload && first && !holdErr) {
            first = false;
            ttf = Math.round(now - t0);
            onFirstChunk?.(ttf);
            if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
          }
          const outChunk = first === false && wrotePayload === false ? enrichFirstReply(chunk, fallback) : chunk;
          if (!holdErr) {
            const size = Buffer.isBuffer(outChunk) ? outChunk.length : (outChunk?.length ?? len);
            if (!isPayload) {
              // 注释帧等非数据帧：与改前一致直写（客户端视作噪声，不影响可撤销性）
              wroteAny = true;
              prefix.writeNow(outChunk, size);
            } else if (gained || !revocableHold || !prefix.isTrivial(txt)) {
              // 有模型产出、留口已关、或看不懂的异形帧：按序补写暂扣前缀 + 本帧，此流就此提交不可撤销
              //（透传契约：解析失败的帧必须原样走，绝不为救空轮扣下）。
              // 可撤销判定走 prefix.isTrivial 而非裸 isTrivialFrame：半截终止行扣在 prefix 的 carry 里，
              // 只看本块会把它的续块判成非空，留口静默失效（BUG-40）。
              wroteAny = true;
              wrotePayload = true; detail.wrotePayload = true;
              prefix.submit(outChunk, size);
            } else if (!prefix.hold(outChunk, size)) {
              // 可撤销前缀按序暂扣（[DONE] 进 tail 槽让位给错误帧；终止帧识别收进 prefix，见 holdFrame）
              wroteAny = true;
              wrotePayload = true; detail.wrotePayload = true;
              prefix.submit(outChunk, size); // 暂扣超上限（异常形状）→ 被迫提交，退回旧行为
            }
          }
          armStall();
        }
        if (!detail.exitReason) detail.exitReason = detail.downstreamClosed ? "downstream-closed" : "normal";
      } catch (err) {
        detail.upstreamError = String(err?.message || err).slice(0, 300);
        detail.exitReason = "upstream-error";
        if (!wrotePayload) timedOut = true;
        else stalled = true;
      } finally {
        if (firstTimer) clearTimeout(firstTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (stallTimer) clearTimeout(stallTimer);
        if (pingTimer) clearInterval(pingTimer);
        // 末帧常无收尾换行：不回收残行，切块/缺换行的 finish_reason 就永远读不到，
        // 下面所有依赖它的判定（截断收场、空轮判据）全都会被带偏。
        try { flushScanRemainder(detail); } catch { /* 观测旁路：绝不外溢成转发失败 */ }
      }
      // 任一闸门到点且未写出真实数据 → 可安全 failover（注释帧对客户端无意义，不算已响应）
      if ((timedOut || stalled || tooLong) && !wrotePayload) {
        res.removeListener("close", onClose);
        // Note: 超时是显式字段（timedOut），别再用 status 数值当信号 — 见 .agents/notes/implemented/architecture/2026-09-17-relay-timedout-explicit-and-metrics-seam.md
        return { status: 504, timedOut: true, ttfMs: null, totalMs: Math.round(performance.now() - t0), aborted: true, interrupted: false, preflightMs: preflight, detail };
      }
      if ((stalled || tooLong || detail.exitReason === "upstream-error") && wrotePayload) {
        interrupted = true;
        detail.exitReason = detail.exitReason || (stalled ? "stall" : "max");
        // 这一段是**服务端主动掐的**，不是客户端跑的：收场后必须与正常收场同样摘掉 close 监听并置
        // finishedNormally，否则 res.end() 触发的那次 close 会把 onClose 当「下游断开」执行，
        // 让上层把这次截断记成一条 client-abort（`format.js` 渲染成「client abort」）——
        // 服务端自己砍的流，错误归因到客户端身上。实测三形态对照：正常收场监听=0、截断收场监听=1。
        finishedNormally = true;
        res.removeListener("close", onClose);
        // 上游从未给过终止标记就断了 ⇒ 客户端手里的是一份**被腰斩**的回答，必须补错误帧让它可识别
        //（BUG-17：300s 腰斩 416KB 输出，旧行为只补 [DONE] 并按 200 返回，errors.log 零记录）。
        if (endTruncatedStream(res, detail, flushHeldTail)) {
          return { status: 200, timedOut: false, ttfMs: ttf, totalMs: Math.round(performance.now() - t0), aborted: false, interrupted, truncated: true, preflightMs: preflight, detail };
        }
        flushHeldTail(); // 断流收场也要把 [DONE] 按序补上，别让客户端等一个不存在的终止符
        try { res.end(); } catch { /* ignore */ }
        return { status: 200, timedOut: false, ttfMs: ttf, totalMs: Math.round(performance.now() - t0), aborted: false, interrupted, preflightMs: preflight, detail };
      }
    } else {
      detail.exitReason = "empty-body";
    }
    const totalMs = Math.round(performance.now() - t0);
    if (!detail.exitReason) detail.exitReason = "normal";
    finishedNormally = true;
    // 留口期间不摘 close 监听（close 只发一次，摘了客户端窗口内断开就永久盲窗、照烧额度）
    const heldOpen = holdEndEnabled() && detail.wrotePayload !== true && !detail.downstreamClosed && isEmptyTurnDetail(detail);
    if (!heldOpen) res.removeListener("close", onClose);
    let terminalForm = null;
    if (heldOpen) {
      detail.exitReason = "empty-turn-hold";
    } else {
      if (!detail.downstreamClosed) {
        commitPendingPrefix(); // 不留口 = 补写暂扣前缀（HOLD_END=0 时逐字节复现改前行为）
        // 思考刷满 max_tokens、正文为零（现网主流）：思考撤不回，错误帧必须排在 [DONE] 之前才看得见
        const reasoningOnly = Number(detail.chars) === 0 && Number(detail.toolCalls) === 0 && Number(detail.reasoningChars) > 0;
        if (reasoningOnly && holdEndEnabled()) {
          detail.exitReason = "reasoning-only";
          terminalForm = "sse-error-tail";
          endEmptyTurnStream(res, `EMPTY_MODEL_RESPONSE: 只产出思考 ${detail.reasoningChars} 字、正文为零（额度被思考吃满），已重试仍无正文 — raise max_tokens or rephrase`, () => flushHeldTail());
        } else {
          flushHeldTail(); // 没有错误帧要插队，[DONE] 按原序发出
          try { res.end(); } catch { /* ignore */ }
        }
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
    return { status: 200, timedOut: false, ttfMs: ttf, totalMs, aborted: false, interrupted: false, heldOpen, terminalForm, preflightMs: preflight, detail };
  }

  finishedNormally = true;
  res.removeListener("close", onClose);
  const text = await upRes.text();
  detail.receivedBytes = Buffer.byteLength(text);
  detail.exitReason = "normal-non-stream";
  // 非流式同样「先判后写」：此刻 headers 还没 flush，body 一写下去就再无退路（判据实现见 stream-body.js）。
  const ns = scanNonStreamReply(detail, text, { fallback, holdEnd: holdEndEnabled, isEmptyTurn: isEmptyTurnDetail, captureFallback: captureTalkFallback });
  const enriched = ns.enriched;
  if (ns.emptyTurn) {
    detail.exitReason = "empty-turn-hold";
    return { status: upRes.status, timedOut: false, ttfMs: null, totalMs: Math.round(performance.now() - t0), aborted: false, interrupted: false, heldOpen: true, preflightMs: preflight, detail };
  }
  detail.wrotePayload = true; // 真写下去了：从此撤不回，也不再判空轮
  const nsTotalMs = Math.round(performance.now() - t0);
  if (enriched !== null) {
    json(res, upRes.status, enriched);
  } else {
    res.statusCode = upRes.status;
    res.setHeader("Content-Type", contentType || "text/plain");
    res.end(text);
  }
  // 非流式 ttf 视为 total（一次性返回）
  return { status: upRes.status, timedOut: false, ttfMs: nsTotalMs, totalMs: nsTotalMs, aborted: false, interrupted: false, heldOpen: false, preflightMs: preflight, detail };
}
