import { performance } from "node:perf_hooks";
import { injectReasoningContent, normalizeModel } from "../../reasoning.js";
import { isAutoModel } from "../../auto.js";
import { clientIp, json, readBody, parseHops, summarizePrompt, errMsg } from "../helpers.js";
import { hedgeDelayMs, shouldHedge } from "../hedge.js";
import { runHook } from "../../plugins.js";
import { parseShareKeysHeader, SHARE_KEYS_HEADER } from "../../providers/share-keys.js";
import { handleHedge } from "./hedge-handler.js";
import { handleLocalRelay } from "./local-handler.js";
import { handlePeerRelay } from "./peer-handler.js";
import { handleBroadbandRelay } from "./broadband-handler.js";
import { handleExhaustedLocal, handleExhaustedAll } from "./exhausted-handler.js";

export async function chatHandler({ req, res, upstream, auto, logs, peers, maxHops, groups, bus, token, plugins }) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  if (plugins?.length) {
    const rc = await runHook(plugins, "request:received", { ip: clientIp(req), hops: parseHops(req.headers["x-mslxdff-hops"]), headers: { "content-type": req.headers["content-type"] }, body });
    for (const e of rc.errors) logs?.appendEvent?.({ ts: Date.now(), type: "plugin-hook-error", hook: "request:received", plugin: e.plugin, error: e.error });
    const respond = rc.value?.respond;
    if (respond && typeof respond === "object") {
      return json(res, respond.status || 200, respond.body ?? {});
    }
  }

  const startedAt = Date.now();
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const perf0 = performance.now();
  const stages = [];
  const mark = (name) => stages.push([name, Math.round(performance.now() - perf0)]);
  const hops = parseHops(req.headers["x-mslxdff-hops"]);
  // ADR-0008：瞬时共享 key（组员侧接收）。本请求内有效，用完即弃。
  const shareKeys = parseShareKeysHeader(req.headers[SHARE_KEYS_HEADER] || "");
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
  const done = (info) => {
    if (!plugins?.length) return;
    runHook(plugins, "request:completed", { reqId, requested, useAuto, hops, stream: Boolean(body.stream), durationMs: Date.now() - startedAt, ...info }).catch(() => {});
  };
  evt("request", { reqId, hops, ip: clientIp(req), stream: Boolean(body.stream), prompt: summarizePrompt(body), rawModel, requested, lockModel: lockModel || null });
  if (Object.keys(shareKeys).length) evt("share-keys", { reqId, providers: Object.keys(shareKeys) });
  evt("ordered", { reqId, order, canFallback, canForwardPeers, useAuto, statuses: auto?.statuses?.() ?? null });

  if (plugins?.length && !lockModel) {
    const sel = await runHook(plugins, "model:select", { reqId, requested, useAuto, order: [...order], hops, stream: Boolean(body.stream) });
    if (sel.changed && Array.isArray(sel.value) && sel.value.length) {
      order = sel.value.filter(Boolean);
      if (!order.length) order = [requested];
      evt("plugin-hook", { reqId, hook: "model:select", applied: true, order: [...order] });
    }
    for (const e of sel.errors) evt("plugin-hook-error", { reqId, hook: "model:select", plugin: e.plugin, error: e.error });
  }

  const handlerCtx = { reqId, model: null, body, hops, peers, plugins, evt, logError, logCall };

  let lastErr = null;
  for (let idx = 0; idx < order.length; idx++) {
    const model = order[idx];
    handlerCtx.model = model;
    evt("model-try", { reqId, model, idx, remaining: order.length - idx });
    if (plugins?.length) {
      const bt = await runHook(plugins, "model:beforeTry", { reqId, requested, model, idx, hops });
      for (const e of bt.errors) evt("plugin-hook-error", { reqId, hook: "model:beforeTry", plugin: e.plugin, error: e.error });
      if (bt.value === false || bt.value?.skip === true) {
        evt("plugin-hook", { reqId, hook: "model:beforeTry", applied: true, skipped: model });
        continue;
      }
    }
    let upRes = null;
    let forwarded = { ...injectReasoningContent(model, body), model };
    if (plugins?.length) {
      const ur = await runHook(plugins, "upstream:request", { reqId, requested, model, payload: forwarded, stream: Boolean(body.stream) });
      for (const e of ur.errors) evt("plugin-hook-error", { reqId, hook: "upstream:request", plugin: e.plugin, error: e.error });
      if (ur.changed && ur.value?.payload && typeof ur.value.payload === "object") {
        forwarded = ur.value.payload;
        evt("plugin-hook", { reqId, hook: "upstream:request", applied: true, model, rewrittenModel: forwarded.model ?? null });
      }
    }
    const tUp = performance.now();
    evt("upstream-try", { reqId, model, attempt: idx + 1 });
    try {
      upRes = await upstream.chat(forwarded, { shareKeys: Object.keys(shareKeys).length ? shareKeys : undefined });
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
      // 白名单 403 直通，不计冷却、不 fallback
      const isAllowlistBlock = upRes.status === 403 && (upRes.headers?.get?.("x-mslxdff-allowlist") === "1");
      if (isAllowlistBlock) {
        let bodyText = null;
        try { bodyText = await upRes.clone().text(); } catch {}
        let errBody = { error: `model not allowed for provider` };
        try { errBody = bodyText ? JSON.parse(bodyText) : errBody; } catch { errBody = { error: bodyText || "model not allowed" }; }
        logError(model, 403, errBody.error || "model not allowed");
        evt("upstream-error", { reqId, model, status: 403, message: errBody.error, timing: upRes._t ?? null });
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
        const hr = await handleHedge({ upRes, model, body, order, idx, lastErr, requested, useAuto, lockModel, auto, peers, handlerCtx, evt, logCall, logError, mark, perf0, stages, startedAt, plugins, res, hedgeDelayMs: d });
        if (hr.handled) return;
        if (hr.lastErr) lastErr = hr.lastErr;
        if (hr.upRes === null) upRes = null;
        else if (hr.upRes) upRes = hr.upRes;
        if (upRes === null) {
          // hedge 触发后走下面的 peer/broadband 分支，不再走本地串行
        } else {
          // hedge 未决出胜负，回退到串行本地
        }
      }
      if (upRes) {
        const lr = await handleLocalRelay({ upRes, model, body, order, idx, lastErr, requested, useAuto, lockModel, auto, handlerCtx, evt, logCall, logError, mark, perf0, stages, startedAt, plugins, res });
        if (lr.handled) return;
        if (lr.lastErr) { lastErr = lr.lastErr; continue; }
        return;
      }
    }

    if (canForwardPeers) {
      const pr = await handlePeerRelay({ model, body, lastErr, requested, useAuto, lockModel, auto, peers, handlerCtx, evt, logCall, mark, perf0, stages, startedAt, plugins, res });
      if (pr.handled) return;
    }

    if (groups) {
      const br = await handleBroadbandRelay({ model, body, hops, lastErr, requested, useAuto, lockModel, auto, groups, token, bus, logs, handlerCtx, evt, mark, perf0, stages, res, startedAt, plugins });
      if (br.handled) return;
    }

    if (canFallback) {
      evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: lastErr?.message || `upstream ${lastErr?.status ?? 502}` });
      continue;
    }
    await handleExhaustedLocal({ res, body, lastErr, order, handlerCtx: { ...handlerCtx, model, reqId }, evt, logCall, mark, perf0, stages, done, requested, useAuto });
    return;
  }

  await handleExhaustedAll({ res, body, lastErr, order, requested, handlerCtx: { ...handlerCtx, reqId, startedAt }, evt, logCall, mark, perf0, stages });
}
