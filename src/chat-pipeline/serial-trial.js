import { performance } from "node:perf_hooks";
import { injectReasoningContent } from "../reasoning.js";
import { runHook } from "../plugins.js";
import { errMsg, json } from "../routes/helpers.js";
import { hedgeDelayMs, shouldHedge } from "../routes/hedge.js";
import { handleHedge } from "../routes/chat/hedge-handler.js";
import { handleLocalRelay } from "../routes/chat/local-handler.js";
import { handlePeerRelay } from "../routes/chat/peer-handler.js";
import { handleBroadbandRelay } from "../routes/chat/broadband-handler.js";
import { handleViaRoute } from "../routes/chat/via-route-handler.js";
import { handleExhaustedLocal, handleExhaustedAll } from "../routes/chat/exhausted-handler.js";

/**
 * 串行 trial — 从 engine.js 抽出的第二段：via-route 单路径 → 串行 trial →
 * hedge/local/peer/broadband/exhausted。恒终结，返回 { done:true }。
 */
export async function runSerialTrial(ctx, deps = {}) {
  const {
    viaRoute = handleViaRoute,
    hedge = handleHedge,
    localRelay = handleLocalRelay,
    peerRelay = handlePeerRelay,
    broadbandRelay = handleBroadbandRelay,
    exhaustedLocal = handleExhaustedLocal,
    exhaustedAll = handleExhaustedAll,
  } = deps;
  const {
    order, reqId, requested, body, hops, useAuto, lockModel, plugins,
    auto, upstream, peers, groups, bus, token, canFallback, canForwardPeers,
    perf0, stages, mark, evt, logCall, logError, done, handlerCtx,
    res, startedAt, logs,
  } = ctx;
  const shareKeys = ctx.shareKeys ?? ctx.policy?.shareKeys ?? {};
  const workbuddyUid = ctx.workbuddyUid ?? ctx.policy?.workbuddyUid ?? null;

  let viaRouteLastErr = null;
  if (!useAuto && requested && requested.includes("/") && canForwardPeers && !lockModel && peers) {
    try {
      const vr = await viaRoute({ model: requested, body, peers, handlerCtx, evt, logCall, logError, mark, perf0, stages, startedAt, plugins, res, requested, useAuto, lockModel, auto });
      if (vr.handled) return { done: true };
      if (vr.lastErr) viaRouteLastErr = vr.lastErr;
    } catch (e) {
      evt("via-route-exception", { reqId, model: requested, error: errMsg(e) });
    }
  }

  let lastErr = viaRouteLastErr;
  for (let idx = 0; idx < order.length; idx++) {
    const model = order[idx];
    handlerCtx.model = model;
    evt("model-try", { reqId, model, idx, remaining: order.length - idx });
    if (plugins?.length) {
      const bt = await runHook(plugins, "model:beforeTry", { reqId, requested, model, idx, hops });
      for (const e of bt.errors) evt("plugin-hook-error", { reqId, hook: "model:beforeTry", plugin: e.plugin, error: e.error });
      if (bt.value === false || bt.value?.skip === true) { evt("plugin-hook", { reqId, hook: "model:beforeTry", applied: true, skipped: model }); continue; }
    }
    let upRes = null;
    let forwarded = { ...injectReasoningContent(model, body), model };
    if (plugins?.length) {
      const ur = await runHook(plugins, "upstream:request", { reqId, requested, model, payload: forwarded, stream: Boolean(body.stream) });
      for (const e of ur.errors) evt("plugin-hook-error", { reqId, hook: "upstream:request", plugin: e.plugin, error: e.error });
      if (ur.changed && ur.value?.payload && typeof ur.value.payload === "object") { forwarded = ur.value.payload; evt("plugin-hook", { reqId, hook: "upstream:request", applied: true, model, rewrittenModel: forwarded.model ?? null }); }
    }
    const tUp = performance.now();
    evt("upstream-try", { reqId, model, attempt: idx + 1 });
    try {
      const chatOpts = {};
      if (Object.keys(shareKeys).length) chatOpts.shareKeys = shareKeys;
      if (workbuddyUid) chatOpts.workbuddyUid = workbuddyUid;
      upRes = await upstream.chat(forwarded, Object.keys(chatOpts).length ? chatOpts : undefined);
      evt("upstream-done", { reqId, model, ok: !(upRes instanceof Error) && upRes.status < 400, status: upRes instanceof Error ? null : upRes.status, timing: upRes._t ?? null, error: null });
    } catch (err) {
      if (auto) await auto.recordError(model, { message: errMsg(err) });
      lastErr = { model, upstream: null, status: 502, message: errMsg(err) };
      logError(model, 502, errMsg(err));
      evt("upstream-error", { reqId, model, status: 502, message: errMsg(err), timing: err._t ?? { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - tUp) } });
    }
    if (plugins?.length) {
      runHook(plugins, "upstream:response", {
        reqId, requested, model,
        status: upRes instanceof Error ? null : upRes instanceof Object ? (upRes.status ?? null) : null,
        ok: !(upRes instanceof Error) && upRes ? upRes.status < 400 : false,
        error: upRes instanceof Error ? errMsg(upRes) : null,
        timing: upRes?._t ?? null,
      }).catch(() => {});
    }
    mark(`up-${model}`);
    if (upRes && upRes.status >= 400) {
      const isAllowlistBlock = upRes.status === 403 && (upRes.headers?.get?.("x-mslxdff-allowlist") === "1");
      if (isAllowlistBlock) {
        let bodyText = null; try { bodyText = await upRes.clone().text(); } catch {}
        let errBody = { error: `model not allowed for provider` };
        try { errBody = bodyText ? JSON.parse(bodyText) : errBody; } catch { errBody = { error: bodyText || "model not allowed" }; }
        if (useAuto) {
          logError(model, 403, errBody.error || "model not allowed");
          evt("upstream-error", { reqId, model, status: 403, message: errBody.error, timing: upRes._t ?? null, allowlist: true, skipped: true });
          lastErr = { model, upstream: upRes, status: 403, message: errBody.error || "model not allowed" };
          if (canFallback && idx < order.length - 1) { evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: `allowlist skip ${errBody.error || "blocked"}` }); continue; }
          return json(res, 403, errBody);
        }
        logError(model, 403, errBody.error || "model not allowed");
        evt("upstream-error", { reqId, model, status: 403, message: errBody.error, timing: upRes._t ?? null, allowlist: true });
        return json(res, 403, errBody);
      }
      if (auto) await auto.recordError(model, { status: upRes.status });
      lastErr = { model, upstream: upRes, status: upRes.status, message: null };
      logError(model, upRes.status, `upstream ${upRes.status}`);
      evt("upstream-error", { reqId, model, status: upRes.status, message: null, timing: upRes._t ?? null });
      upRes = null;
    }
    if (upRes) {
      const isStream = Boolean(body.stream);
      const d = hedgeDelayMs();
      const hasPeers = Boolean(peers) && peers.ordered().length > 0;
      const doHedge = shouldHedge({ isStream, canForwardPeers, hedgeDelayMs: d, hasPeers }) && upRes.status === 200 && upRes.body;
      if (doHedge) {
        const hr = await hedge({ upRes, model, body, order, idx, lastErr, requested, useAuto, lockModel, auto, peers, handlerCtx, evt, logCall, logError, mark, perf0, stages, startedAt, plugins, res, hedgeDelayMs: d });
        if (hr.handled) return { done: true };
        if (hr.lastErr) lastErr = hr.lastErr;
        if (hr.upRes === null) upRes = null;
        else if (hr.upRes) upRes = hr.upRes;
      }
      if (upRes) {
        const lr = await localRelay({ upRes, model, body, order, idx, lastErr, requested, useAuto, lockModel, auto, handlerCtx, evt, logCall, logError, mark, perf0, stages, startedAt, plugins, res });
        if (lr.handled) return { done: true };
        if (lr.lastErr) { lastErr = lr.lastErr; continue; }
        return { done: true };
      }
    }
    if (canForwardPeers) {
      const pr = await peerRelay({ model, body, lastErr, requested, useAuto, lockModel, auto, peers, handlerCtx, evt, logCall, mark, perf0, stages, startedAt, plugins, res });
      if (pr.handled) return { done: true };
    }
    if (groups) {
      const br = await broadbandRelay({ model, body, hops, lastErr, requested, useAuto, lockModel, auto, groups, token, bus, logs, handlerCtx, evt, mark, perf0, stages, res, startedAt, plugins });
      if (br.handled) return { done: true };
    }
    if (canFallback) { evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: lastErr?.message || `upstream ${lastErr?.status ?? 502}` }); continue; }
    await exhaustedLocal({ res, body, lastErr, order, handlerCtx: { ...handlerCtx, model, reqId }, evt, logCall, mark, perf0, stages, done, requested, useAuto });
    return { done: true };
  }
  await exhaustedAll({ res, body, lastErr, order, requested, handlerCtx: { ...handlerCtx, reqId, startedAt }, evt, logCall, mark, perf0, stages });
  return { done: true };
}
