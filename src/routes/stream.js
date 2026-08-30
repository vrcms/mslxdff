import { performance } from "node:perf_hooks";
import { applyFallbackHeaders, enrichNonStreamJson, enrichSseChunkText } from "./fallback.js";
import { json } from "./helpers.js";

export const SLOW_TOTAL_MS = (() => {
  const n = Number(process.env.MSLXDFF_SLOW_TOTAL_MS);
  return Number.isInteger(n) && n > 0 ? n : 20_000;
})();

export const STREAM_TIMEOUT_MS = (() => {
  const n = Number(process.env.MSLXDFF_STREAM_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 25_000;
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

export async function relay(res, upRes, body, { onFirstChunk, onDownstreamAbort, streamTimeoutMs = STREAM_TIMEOUT_MS, fallback } = {}) {
  const t0 = performance.now();
  const contentType = upRes.headers.get("content-type") || "";
  const isStream = Boolean(body?.stream) || contentType.includes("text/event-stream");
  res.statusCode = upRes.status;
  // propagate workbuddy uid / allowlist headers
  try {
    const uid = upRes.headers.get("x-mslxdff-workbuddy-uid");
    if (uid) res.setHeader("x-mslxdff-workbuddy-uid", uid);
    const reason = upRes.headers.get("x-mslxdff-workbuddy-reason");
    if (reason) res.setHeader("x-mslxdff-workbuddy-reason", reason);
    const allow = upRes.headers.get("x-mslxdff-allowlist");
    if (allow) res.setHeader("x-mslxdff-allowlist", allow);
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
  };
  let prevChunkAt = t0;
  const onClose = () => {
    detail.downstreamClosed = true;
    if (!finishedNormally && onDownstreamAbort) onDownstreamAbort();
  };
  res.on("close", onClose);

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (fallback?.fallback) {
      try {
        res.write(`: mslxdff fallback ${fallback.requested_model} -> ${fallback.actual_model} (${fallback.reason})\n`);
        res.write(`: notice ${fallback.notice}\n\n`);
      } catch {}
    }
    if (upRes.body) {
      let first = true;
      let wroteAny = false;
      let timedOut = false;
      let stalled = false;
      let tooLong = false;
      let stallTimer = null;
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = STALL_TIMEOUT_MS
          ? setTimeout(() => {
              stalled = true;
              detail.exitReason = "stall";
              if (typeof upRes.body.cancel === "function") upRes.body.cancel().catch(() => {});
            }, STALL_TIMEOUT_MS)
          : null;
      };
      let firstTimer = setTimeout(() => {
        timedOut = true;
        detail.exitReason = "first-timeout";
        if (typeof upRes.body.cancel === "function") upRes.body.cancel().catch(() => {});
      }, streamTimeoutMs);
      const maxTimer = MAX_STREAM_MS
        ? setTimeout(() => {
            tooLong = true;
            detail.exitReason = "max";
            if (typeof upRes.body.cancel === "function") upRes.body.cancel().catch(() => {});
          }, MAX_STREAM_MS)
        : null;
      try {
        for await (const chunk of upRes.body) {
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
          try {
            const txt = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : typeof chunk === "string" ? chunk : "";
            if (txt.includes("[DONE]")) detail.sawDone = true;
            const m = txt.match(/"finish_reason"\s*:\s*"([^"]+)"/);
            if (m) detail.sawFinishReason = m[1];
            // 尝试提取 usage（流式末帧）
            if (txt.includes("\"usage\"") || txt.includes("prompt_tokens")) {
              try {
                const lines = txt.split("\n");
                for (const line of lines) {
                  const t = line.trim();
                  if (!t.startsWith("data:")) continue;
                  const d = t.slice(5).trim();
                  if (d === "[DONE]" || !d) continue;
                  const j = JSON.parse(d);
                  if (j && j.usage && typeof j.usage === "object") {
                    const u = j.usage;
                    const pt = Number(u.prompt_tokens ?? u.promptTokens ?? u.input_tokens);
                    const ct = Number(u.completion_tokens ?? u.completionTokens ?? u.output_tokens);
                    const tt = Number(u.total_tokens ?? u.totalTokens);
                    const cur = {};
                    if (Number.isFinite(pt)) cur.prompt_tokens = pt;
                    if (Number.isFinite(ct)) cur.completion_tokens = ct;
                    if (Number.isFinite(tt)) cur.total_tokens = tt;
                    if (Object.keys(cur).length) detail.usage = cur;
                    // 兜底 chars：从 choices 文本长度累加
                    const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || "";
                    if (delta) detail.chars += String(delta).length;
                  }
                }
              } catch {}
            } else {
              // 非 usage 的普通 delta 也累 chars
              try {
                const txt2 = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
                const ms = txt2.match(/"content"\s*:\s*"([^"]*)"/g);
                if (ms) for (const mm of ms) {
                  const c = JSON.parse(`{${mm}}`);
                  if (c.content) detail.chars += String(c.content).length;
                }
              } catch {}
            }
          } catch { /* ignore */ }
          if (timedOut || stalled || tooLong) break;
          if (first) {
            first = false;
            ttf = Math.round(now - t0);
            onFirstChunk?.(ttf);
            if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
          }
          let outChunk = chunk;
          if (first === false && fallback?.fallback && wroteAny === false) {
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
          detail.wroteChunks += 1;
          detail.wroteBytes += Buffer.isBuffer(outChunk) ? outChunk.length : (outChunk?.length ?? len);
          res.write(outChunk);
          armStall();
        }
        if (!detail.exitReason) detail.exitReason = "normal";
      } catch (err) {
        detail.upstreamError = String(err?.message || err).slice(0, 300);
        detail.exitReason = "upstream-error";
        if (!wroteAny) timedOut = true;
        else stalled = true;
      } finally {
        if (firstTimer) clearTimeout(firstTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (stallTimer) clearTimeout(stallTimer);
      }
      if (timedOut && !wroteAny) {
        res.removeListener("close", onClose);
        return { status: STREAM_TIMEOUT_MS, ttfMs: null, totalMs: Math.round(performance.now() - t0), aborted: true, interrupted: false, detail };
      }
      if ((stalled || tooLong) && wroteAny) {
        interrupted = true;
        detail.exitReason = detail.exitReason || (stalled ? "stall" : "max");
        res.removeListener("close", onClose);
        try { res.end(); } catch { /* ignore */ }
        return { status: 200, ttfMs: ttf, totalMs: Math.round(performance.now() - t0), aborted: false, interrupted, detail };
      }
    } else {
      detail.exitReason = "empty-body";
    }
    const totalMs = Math.round(performance.now() - t0);
    if (!detail.exitReason) detail.exitReason = "normal";
    finishedNormally = true;
    res.removeListener("close", onClose);
    try { res.end(); } catch { /* ignore */ }
    return { status: 200, ttfMs: ttf, totalMs, aborted: false, interrupted: false, detail };
  }

  finishedNormally = true;
  res.removeListener("close", onClose);
  const text = await upRes.text();
  detail.receivedBytes = Buffer.byteLength(text);
  detail.exitReason = "normal-non-stream";
  // 非流式 usage 与 chars 提取
  try {
    const parsed = JSON.parse(text);
    const u = parsed.usage;
    if (u && typeof u === "object") {
      const pt = Number(u.prompt_tokens ?? u.promptTokens ?? u.input_tokens);
      const ct = Number(u.completion_tokens ?? u.completionTokens ?? u.output_tokens);
      const tt = Number(u.total_tokens ?? u.totalTokens);
      const cur = {};
      if (Number.isFinite(pt)) cur.prompt_tokens = pt;
      if (Number.isFinite(ct)) cur.completion_tokens = ct;
      if (Number.isFinite(tt)) cur.total_tokens = tt;
      if (Object.keys(cur).length) detail.usage = cur;
      if (parsed.choices?.[0]?.message?.content) detail.chars = String(parsed.choices[0].message.content).length;
      else if (parsed.choices?.[0]?.text) detail.chars = String(parsed.choices[0].text).length;
    }
    const enriched = enrichNonStreamJson(parsed, fallback);
    json(res, upRes.status, enriched);
  } catch {
    res.statusCode = upRes.status;
    res.setHeader("Content-Type", contentType || "text/plain");
    res.end(text);
    // 纯文本时按长度估 chars
    try { detail.chars = text.length; } catch {}
  }
  // 非流式 ttf 视为 total（一次性返回）
  const totalMs = Math.round(performance.now() - t0);
  return { status: upRes.status, ttfMs: totalMs, totalMs, aborted: false, interrupted: false, detail };
}
