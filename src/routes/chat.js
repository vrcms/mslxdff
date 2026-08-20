import { performance } from "node:perf_hooks";
import { injectReasoningContent, normalizeModel } from "../reasoning.js";
import { isAutoModel } from "../auto.js";
import { clientIp, json, readBody, parseHops, summarizePrompt, errMsg } from "./helpers.js";
import { buildFallbackInfo } from "./fallback.js";
import { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS } from "./stream.js";
import { racePeerCandidates } from "./peers.js";
import { tryBroadbandRelay } from "./relay-queue.js";

export async function chatHandler({ req, res, upstream, auto, logs, peers, maxHops, groups, bus, token }) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const startedAt = Date.now();
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const perf0 = performance.now();
  const stages = [];
  const mark = (name) => stages.push([name, Math.round(performance.now() - perf0)]);
  const hops = parseHops(req.headers["x-mslxdff-hops"]);
  const lockModel = req.headers["x-mslxdff-model-lock"] || "";
  const rawModel = body.model || "";
  const requested = normalizeModel(lockModel || rawModel || "");
  const useAuto = isAutoModel(requested);
  mark("parsed");

  let order;
  if (lockModel) {
    order = [requested];
  } else if (useAuto) {
    order = auto ? await auto.candidates() : [""];
  } else {
    order = auto ? await auto.candidatesFor(requested) : [requested];
  }
  if (!order.length) order = [""];
  const canFallback = order.length > 1;
  const canForwardPeers = Boolean(peers) && hops < maxHops;
  mark("ordered");

  const logCall = (model, status) =>
    logs?.appendCall({ reqId, model, auto: useAuto, status, durationMs: Date.now() - startedAt, stream: Boolean(body.stream), stages });
  const logError = (model, status, message) =>
    logs?.appendError({ reqId, model, auto: useAuto, status, message, stages });
  const evt = (type, data) => {
    const entry = { ts: Date.now(), reqId, type, ...data, model: data.model ?? requested, auto: useAuto, durationMs: Date.now() - startedAt, stages: [...stages] };
    if (bus) bus.emit(entry);
    logs?.appendEvent?.(entry);
  };
  evt("request", { reqId, hops, ip: clientIp(req), stream: Boolean(body.stream), prompt: summarizePrompt(body), rawModel, requested, lockModel: lockModel || null });
  evt("ordered", { reqId, order, canFallback, canForwardPeers, useAuto, statuses: auto?.statuses?.() ?? null });

  const handlerCtx = {
    model: null,
    body,
    hops,
    peers,
    evt,
    logError,
    logCall,
  };

  let lastErr = null;
  for (let idx = 0; idx < order.length; idx++) {
    const model = order[idx];
    handlerCtx.model = model;
    evt("model-try", { reqId, model, idx, remaining: order.length - idx });
    let upRes = null;
    const forwarded = { ...injectReasoningContent(model, body), model };
    const tUp = performance.now();
    evt("upstream-try", { reqId, model, attempt: idx + 1 });
    try {
      upRes = await upstream.chat(forwarded);
      evt("upstream-done", { reqId, model, ok: !(upRes instanceof Error) && upRes.status < 400, status: upRes instanceof Error ? null : upRes.status, timing: upRes._t ?? null, error: null });
    } catch (err) {
      if (auto) await auto.recordError(model, { message: errMsg(err) });
      lastErr = { model, upstream: null, status: 502, message: errMsg(err) };
      logError(model, 502, errMsg(err));
      evt("upstream-error", { reqId, model, status: 502, message: errMsg(err), timing: err._t ?? { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - tUp) } });
    }
    mark(`up-${model}`);
    if (upRes && upRes.status >= 400) {
      if (auto) await auto.recordError(model, { status: upRes.status });
      lastErr = { model, upstream: upRes, status: upRes.status, message: null };
      logError(model, upRes.status, `upstream ${upRes.status}`);
      evt("upstream-error", { reqId, model, status: upRes.status, message: null, timing: upRes._t ?? null });
      upRes = null;
    }
    if (upRes) {
      logCall(model, upRes.status);
      const fallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "local", useAuto, lockModel });
      if (fallback?.fallback) evt("fallback-notice", { reqId, requested, actual: model, reason: fallback.reason, notice: fallback.notice, via: "local" });
      evt("relay-start", { reqId, model, via: "local", isStream: Boolean(body.stream), fallback });
      const out = await relay(res, upRes, body, {
        fallback,
        onFirstChunk: (delta) => {
          mark(`ttf-${model}`);
          evt("relay-first-chunk", { reqId, model, ttfMs: delta });
        },
        onDownstreamAbort: () => {
          evt("client-abort", { reqId, model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] });
        },
      });
      evt("relay-done", { reqId, model, via: "local", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
      if (out.status === STREAM_TIMEOUT_MS) {
        if (auto) await auto.recordError(model, { status: 502, slow: true, note: `stream timeout ${STREAM_TIMEOUT_MS}ms` });
        lastErr = { model, upstream: null, status: 502, message: `stream timed out after ${STREAM_TIMEOUT_MS}ms` };
        logError(model, 502, `stream timeout ${STREAM_TIMEOUT_MS}ms`);
        evt("upstream-error", { reqId, model, status: 502, message: "stream timeout", timing: null });
        evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: "stream timeout" });
        upRes = null;
        continue;
      }
      if (out.interrupted) {
        if (auto) {
          await auto.recordError(model, { status: 200, slow: true, note: `stall ${STALL_TIMEOUT_MS}ms` });
          await auto.recordLatency(model, out.totalMs ?? (Date.now() - startedAt));
        }
        evt("slow-model", { model, elapsedMs: out.totalMs ?? (Date.now() - startedAt), threshold: STALL_TIMEOUT_MS, interrupted: true, detail: out.detail ?? null });
        logCall(model, 200);
        evt("result", { model, status: out.status, via: "local", timing: upRes._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, interrupted: true, detail: out.detail ?? null, fallback, requested, actual: model });
        evt("client-response", { requested, actual: model, via: "local", fallback, status: out.status, interrupted: true, reqId });
        return;
      }
      const elapsed = Date.now() - startedAt;
      const latencyMs = out.totalMs ?? elapsed;
      let scoredSlow = false;
      if (SLOW_TOTAL_MS && auto && elapsed > SLOW_TOTAL_MS && out.status === 200) {
        void auto.recordError(model, { status: 200, slow: true, note: `slow ${elapsed}ms` });
        void auto.recordLatency(model, latencyMs);
        evt("slow-model", { model, elapsedMs: elapsed, threshold: SLOW_TOTAL_MS, reason: "total", detail: out.detail ?? null });
        scoredSlow = true;
      }
      if (out.detail?.stallHits > 0 && auto && out.status === 200) {
        void auto.recordError(model, { status: 200, slow: true, note: `stall ${out.detail.stallHits}x gap>${SCORE_STALL_MS}ms maxGap ${out.detail.maxGapMs}ms` });
        void auto.recordLatency(model, latencyMs);
        evt("slow-model", { model, elapsedMs: elapsed, threshold: SCORE_STALL_MS, reason: "stall", stallHits: out.detail.stallHits, maxGapMs: out.detail.maxGapMs, detail: out.detail ?? null });
        scoredSlow = true;
      }
      if (!scoredSlow && auto && out.status === 200) {
        await auto.recordOk(model, { latencyMs });
      } else if (!scoredSlow && auto) {
        await auto.recordLatency(model, latencyMs);
      }
      evt("result", { model, status: out.status, via: "local", timing: upRes._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback, requested, actual: model });
      evt("client-response", { requested, actual: model, via: "local", fallback, status: out.status, reqId });
      return;
    }

    if (canForwardPeers) {
      evt("peer-race-start", { reqId, model, peers: peers.ordered().length });
      const win =
        (await racePeerCandidates(peers.ordered(), handlerCtx)) ||
        (await racePeerCandidates(peers.orderedByLastError(), handlerCtx));
      if (win) {
        evt("peer-race-win", { reqId, model, winPeer: win.peer.url, winTarget: win.target, latencyMs: win.latencyMs });
        await peers.recordResult(win.peer.url, { ok: true, latencyMs: win.latencyMs, model: win.target });
        logCall(win.target, win.res.status);
        const peerFallback = buildFallbackInfo({ requested, actual: win.target, lastErr, via: "peer", useAuto, lockModel });
        if (peerFallback?.fallback) evt("fallback-notice", { reqId, requested, actual: win.target, reason: peerFallback.reason, notice: peerFallback.notice, via: "peer" });
        evt("relay-start", { reqId, model: win.target, via: "peer", isStream: Boolean(body.stream), fallback: peerFallback });
        const out = await relay(res, win.res, body, {
          fallback: peerFallback,
          onFirstChunk: (d) => mark(`ttf-peer-${win.target}`),
          onDownstreamAbort: () => evt("client-abort", { reqId, model: win.target, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
        });
        evt("relay-done", { reqId, model: win.target, via: "peer", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
        if (auto && out.status === 200) {
          const latencyMs = out.totalMs ?? win.latencyMs;
          if (out.detail?.stallHits > 0 || (latencyMs && latencyMs > SLOW_TOTAL_MS)) {
            void auto.recordError(win.target, { status: 200, slow: true, note: `peer slow ${latencyMs}ms` });
            void auto.recordLatency(win.target, latencyMs);
          } else {
            await auto.recordOk(win.target, { latencyMs });
          }
        }
        evt("result", { model: win.target, status: out.status, via: "peer", timing: win.res._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: peerFallback, requested, actual: win.target });
        evt("client-response", { requested, actual: win.target, via: "peer", fallback: peerFallback, status: out.status, reqId });
        return;
      }
      evt("peer-race-lose", { reqId, model });
    }

    if (groups) {
      const bb = await tryBroadbandRelay({ groups, token, model, body, hops, bus, logs, reqId, evt, res, mark, perf0, stages });
      if (bb) {
        const isResponse = bb.result && typeof bb.result.status === "number" && typeof bb.result.headers?.get === "function";
        if (isResponse) {
          const bbFallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "broadband", useAuto, lockModel });
          if (bbFallback?.fallback) evt("fallback-notice", { reqId, requested, actual: model, reason: bbFallback.reason, notice: bbFallback.notice, via: "broadband" });
          evt("relay-start", { reqId, model, via: "broadband", target: bb.target, group: bb.group, fallback: bbFallback });
          const out = await relay(res, bb.result, body, {
            fallback: bbFallback,
            onFirstChunk: (d) => mark(`ttf-bb-${model}`),
            onDownstreamAbort: () => evt("client-abort", { reqId, model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
          });
          evt("relay-done", { reqId, model, via: "broadband", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
          if (auto && out.status === 200) {
            const latencyMs = out.totalMs ?? 0;
            if (out.detail?.stallHits > 0 || (latencyMs && latencyMs > SLOW_TOTAL_MS)) {
              void auto.recordError(model, { status: 200, slow: true, note: `broadband slow ${latencyMs}ms` });
              void auto.recordLatency(model, latencyMs);
            } else {
              await auto.recordOk(model, { latencyMs });
            }
          }
          evt("result", { model, status: out.status, via: "broadband", timing: bb.result._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: bbFallback, requested, actual: model });
          evt("client-response", { requested, actual: model, via: "broadband", fallback: bbFallback, status: out.status, reqId });
          return;
        } else if (bb.result && typeof bb.result.status === "number") {
          const fakeRes = {
            status: bb.result.status,
            headers: { get: (k) => bb.result.headers?.[k] || bb.result.headers?.[k.toLowerCase()] || null },
            text: async () => typeof bb.result.body === "string" ? bb.result.body : JSON.stringify(bb.result.body),
            body: (() => {
              const b = bb.result.body || "";
              const str = typeof b === "string" ? b : JSON.stringify(b);
              const isSSE = bb.result.headers?.["Content-Type"]?.includes("text/event-stream");
              if (isSSE) {
                return (async function* () { yield Buffer.from(str); })();
              }
              return null;
            })(),
          };
          const bbLocalFallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "broadband", useAuto, lockModel });
          if (bbLocalFallback?.fallback) evt("fallback-notice", { reqId, requested, actual: model, reason: bbLocalFallback.reason, notice: bbLocalFallback.notice, via: "broadband" });
          evt("relay-start", { reqId, model, via: "broadband-local", target: bb.target, group: bb.group, fallback: bbLocalFallback });
          const out = await relay(res, fakeRes, body, {
            fallback: bbLocalFallback,
            onFirstChunk: (d) => mark(`ttf-bb-${model}`),
            onDownstreamAbort: () => evt("client-abort", { reqId, model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
          });
          evt("relay-done", { reqId, model, via: "broadband-local", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
          evt("result", { model, status: out.status, via: "broadband", timing: null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: bbLocalFallback, requested, actual: model });
          evt("client-response", { requested, actual: model, via: "broadband", fallback: bbLocalFallback, status: out.status, reqId });
          return;
        }
      }
      evt("relay-miss", { reqId, model });
    }

    if (canFallback) {
      evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: lastErr?.message || `upstream ${lastErr?.status ?? 502}` });
      continue;
    }
    evt("exhausted-local", { reqId, lastModel: lastErr?.model ?? model, lastStatus: lastErr?.status ?? 502, order });
    logCall(lastErr?.model ?? model, lastErr?.status ?? 502);
    if (lastErr?.upstream) {
      evt("relay-start", { reqId, model: lastErr.model, via: "local-exhausted", isStream: Boolean(body.stream) });
      const out = await relay(res, lastErr.upstream, body, {
        onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
        onDownstreamAbort: () => evt("client-abort", { reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
      });
      evt("relay-done", { reqId, model: lastErr.model, via: "local-exhausted", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
      evt("result", { reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
      return;
    }
    evt("result", { reqId, model, status: lastErr?.status ?? 502, via: "none", timing: null });
    return json(res, 502, { error: lastErr?.message || "all auto models failed" });
  }

  evt("exhausted-all", { reqId, lastModel: lastErr?.model ?? requested, lastStatus: lastErr?.status ?? 502, order });
  logCall(lastErr?.model ?? requested, lastErr?.status ?? 502);
  if (lastErr?.upstream) {
    evt("relay-start", { reqId, model: lastErr.model, via: "local-final", isStream: Boolean(body.stream) });
    const out = await relay(res, lastErr.upstream, body, {
      onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
      onDownstreamAbort: () => evt("client-abort", { reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
    });
    evt("relay-done", { reqId, model: lastErr.model, via: "local-final", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
    evt("result", { reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
    return;
  }
  evt("result", { reqId, model: lastErr?.model ?? requested, status: lastErr?.status ?? 502, via: "none", timing: null });
  return json(res, 502, { error: lastErr?.message || "all auto models failed" });
}
