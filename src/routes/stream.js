import { performance } from "node:perf_hooks";
import { applyFallbackHeaders, enrichNonStreamJson, enrichSseChunkText } from "./fallback.js";
import { json } from "./helpers.js";
import { extractUsageFromJson, extractUsageFromSseText } from "../metrics.js";

// SDK 通道（TextEncoder）产出 Uint8Array，legacy 通道为 Buffer；
// 统一转文本，避免 [DONE]/finish_reason/usage/chars 统计在 SDK 路径下静默失效。
function chunkText(chunk) {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return "";
}

// body.cancel() 可能返回非 Promise（自定义/AI SDK 流）——同步异常与 rejection 双路径都要吞掉
function cancelBody(body) {
  try {
    const p = typeof body?.cancel === "function" ? body.cancel() : null;
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* ignore */ }
}

// 注释帧（": keepalive" 等）不是模型输出：不算首块、不解除闸门、不触发超时救回，但照常透传
function hasPayload(text) {
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith(":")) continue;
    return true;
  }
  return false;
}

// 自持 reader 优先：for-await 会锁定 ReadableStream，使 body.cancel() 必 reject（真流上等于空操作），
// 超时/断下游要真能掐上游必须走 reader.cancel()
async function* bodyChunks(body, reader) {
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
  for await (const c of body) yield c;
}

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

export const MAX_STREAM_MS = (() => {
  const n = Number(process.env.MSLXDFF_MAX_STREAM_MS);
  return Number.isInteger(n) && n > 0 ? n : 0;
})();

export async function relay(res, upRes, body, { onFirstChunk, onDownstreamAbort, streamTimeoutMs = STREAM_TIMEOUT_MS, keepaliveMs = KEEPALIVE_MS, fallback } = {}) {
  const t0 = performance.now();
  const contentType = upRes.headers.get("content-type") || "";
  // 需同时满足：客户端要流 + 上游真的是 SSE；避免 muse-spark 聚合 JSON 被误判为流式，或 workbuddy SSE 被聚合
  const isStream = Boolean(body?.stream) && contentType.includes("text/event-stream");
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

  let ttf = null;
  let interrupted = false;
  let finishedNormally = false;
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
    toolCalls: 0,
    chatShaped: false,
    recoveries: 0,
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
          const isPayload = hasPayload(txt);
          try {
            if (txt.includes("[DONE]")) detail.sawDone = true;
            const m = txt.match(/"finish_reason"\s*:\s*"([^"]+)"/);
            if (m) detail.sawFinishReason = m[1];
            // chat 形状证据：只有看得出是 chat 轮才配判空（非 chat SSE/JSON 透传是正式契约，不得误伤）
            if (!detail.chatShaped && (txt.includes('"choices"') || txt.includes('"delta"') || txt.includes('"finish_reason"') || txt.includes('"usage"') || txt.includes('"prompt_tokens"') || txt.includes("[DONE]"))) detail.chatShaped = true;
            // 工具调用计数（空数组不算）：tool_calls 无正文是合法 agent 轮，
            // 空转闸门必须豁免它，否则所有工具轮都会被误判为空轮——见 relay-pipeline 4b。
            const tc = txt.match(/"tool_calls"\s*:\s*\[\s*\{/g);
            if (tc) detail.toolCalls = (detail.toolCalls || 0) + tc.length;
            // 尝试提取 usage（流式末帧）：口径收口到 metrics.js，与未流式分支共用
            if (txt.includes("\"usage\"") || txt.includes("\"prompt_tokens\"")) {
              try {
                const lines = txt.split("\n");
                for (const line of lines) {
                  const t = line.trim();
                  if (!t.startsWith("data:")) continue;
                  const d = t.slice(5).trim();
                  if (d === "[DONE]" || !d) continue;
                  // 行级隔离：单行坏 JSON 不拖累同 chunk 其余行
                  try {
                    const j = JSON.parse(d);
                    if (!j || typeof j !== "object") continue;
                    const u = extractUsageFromJson(j);
                    if (u) detail.usage = u;
                    // 兜底 chars：从 choices 文本长度累加
                    const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || "";
                    if (delta) detail.chars += String(delta).length;
                  } catch { /* 单行坏帧忽略 */ }
                }
              } catch {}
            } else {
              // 非 usage 的普通 delta 也累 chars
              try {
                const ms = txt.match(/"content"\s*:\s*"([^"]*)"/g);
                if (ms) for (const mm of ms) {
                  const c = JSON.parse(`{${mm}}`);
                  if (c.content) detail.chars += String(c.content).length;
                }
              } catch {}
            }
          } catch { /* ignore */ }
          // 首块/空闲超时后上游仍吐出了真实数据 → 只是慢，不是死：撤销超时判定，照常转发
          //（cancel 是异步的，竞态窗口内已到达的数据是纯收益；丢掉是纯损失）
          // 注释帧（keepalive）不算：否则对端只要在发心跳，闸门就永远解除
          if (isPayload && (timedOut || stalled)) {
            timedOut = false;
            stalled = false;
            detail.recoveries = (detail.recoveries || 0) + 1;
            if (detail.exitReason === "first-timeout" || detail.exitReason === "stall") detail.exitReason = null;
            if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
          }
          if (timedOut || stalled || tooLong) break;
          if (isPayload && first) {
            first = false;
            ttf = Math.round(now - t0);
            onFirstChunk?.(ttf);
            if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
          }
          let outChunk = chunk;
          if (first === false && fallback?.fallback && wrotePayload === false) {
            try {
              let txt = "";
              if (Buffer.isBuffer(chunk)) txt = chunk.toString("utf8");
              else if (chunk instanceof Uint8Array) txt = Buffer.from(chunk).toString("utf8");
              else if (typeof chunk === "string") txt = chunk;
              if (txt.includes("data:")) {
                const enriched = enrichSseChunkText(txt, fallback);
                if (enriched !== txt) outChunk = Buffer.from(enriched, "utf8");
              }
            } catch {}
          }
          wroteAny = true;
          if (isPayload) wrotePayload = true;
          detail.wroteChunks += 1;
          detail.wroteBytes += Buffer.isBuffer(outChunk) ? outChunk.length : (outChunk?.length ?? len);
          try { res.write(outChunk); } catch { /* 下游已断开：onClose 已掐上游 */ }
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
      }
      // 任一闸门到点且未写出真实数据 → 可安全 failover（注释帧对客户端无意义，不算已响应）
      if ((timedOut || stalled || tooLong) && !wrotePayload) {
        res.removeListener("close", onClose);
        // Note: 超时是显式字段（timedOut），别再用 status 数值当信号 — 见 .agents/notes/implemented/architecture/2026-09-17-relay-timedout-explicit-and-metrics-seam.md
        return { status: 504, timedOut: true, ttfMs: null, totalMs: Math.round(performance.now() - t0), aborted: true, interrupted: false, detail };
      }
      if ((stalled || tooLong) && wrotePayload) {
        interrupted = true;
        detail.exitReason = detail.exitReason || (stalled ? "stall" : "max");
        res.removeListener("close", onClose);
        try { res.end(); } catch { /* ignore */ }
        return { status: 200, timedOut: false, ttfMs: ttf, totalMs: Math.round(performance.now() - t0), aborted: false, interrupted, detail };
      }
    } else {
      detail.exitReason = "empty-body";
    }
    const totalMs = Math.round(performance.now() - t0);
    if (!detail.exitReason) detail.exitReason = "normal";
    finishedNormally = true;
    res.removeListener("close", onClose);
    try { res.end(); } catch { /* ignore */ }
    return { status: 200, timedOut: false, ttfMs: ttf, totalMs, aborted: false, interrupted: false, detail };
  }

  finishedNormally = true;
  res.removeListener("close", onClose);
  const text = await upRes.text();
  detail.receivedBytes = Buffer.byteLength(text);
  detail.exitReason = "normal-non-stream";
  // 非流式 usage 与 chars 提取（口径与流式分支共用 metrics.js）
  try {
    const parsed = JSON.parse(text);
    const u = extractUsageFromJson(parsed);
    if (u) detail.usage = u;
    if (parsed.choices?.[0]?.message?.content) detail.chars = String(parsed.choices[0].message.content).length;
    else if (parsed.choices?.[0]?.text) detail.chars = String(parsed.choices[0].text).length;
    // 非流式同样只判 chat 形状：无 choices 的任意 JSON 是透传契约（chat-route 单测锁死），不得判空
    if (Array.isArray(parsed?.choices)) detail.chatShaped = true;
    const _tcList = parsed.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(_tcList) && _tcList.length) detail.toolCalls = _tcList.length;
    const enriched = enrichNonStreamJson(parsed, fallback);
    json(res, upRes.status, enriched);
  } catch {
    res.statusCode = upRes.status;
    res.setHeader("Content-Type", contentType || "text/plain");
    res.end(text);
    // 纯文本时按长度估 chars；若文本其实是 SSE（client 未要流但上游给流）仍尝试提 usage
    try { detail.chars = text.length; } catch {}
    try { const u = extractUsageFromSseText(text); if (u) detail.usage = u; } catch {}
  }
  // 非流式 ttf 视为 total（一次性返回）
  const totalMs = Math.round(performance.now() - t0);
  return { status: upRes.status, timedOut: false, ttfMs: totalMs, totalMs, aborted: false, interrupted: false, detail };
}
