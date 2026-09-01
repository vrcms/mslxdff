import { performance } from "node:perf_hooks";
import { injectReasoningContent, normalizeModel } from "../../reasoning.js";
import { isAutoModel } from "../../auto.js";
import { toInternalId as aliasToInternal } from "../../sync-opencode.js";
import { clientIp, json, readBody, parseHops, summarizePrompt, errMsg } from "../helpers.js";
import { hedgeDelayMs, shouldHedge } from "../hedge.js";
import { runHook } from "../../plugins.js";
import { parseShareKeysHeader, SHARE_KEYS_HEADER } from "../../providers/share-keys.js";
import { handleHedge } from "./hedge-handler.js";
import { handleLocalRelay } from "./local-handler.js";
import { handlePeerRelay } from "./peer-handler.js";
import { handleBroadbandRelay } from "./broadband-handler.js";
import { handleExhaustedLocal, handleExhaustedAll } from "./exhausted-handler.js";
import { normalizeFullId, getModelAlias } from "../../providers/model-id.js";

/**
 * ChatGateway 深模块：对外 1 handle，内部 Policy→Selector→Executor 三段编排
 * Policy: 别名/allowlist/header 透传
 * Selector: order 推导 + 并发择优 + 排序
 * Executor: 串行 trial → hedge → local → peer → broadband → exhausted
 * 两 adapter：Provider(upstream.chat) + Clock/Latency(auto) 可注入 fake
 */
export function createChatGateway({ upstream, auto, logs, peers, maxHops, groups, bus, token, plugins }) {
  async function handle({ req, res }) {
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
      if (respond && typeof respond === "object") return json(res, respond.status || 200, respond.body ?? {});
    }

    const startedAt = Date.now();
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const perf0 = performance.now();
    const stages = [];
    const mark = (name) => stages.push([name, Math.round(performance.now() - perf0)]);

    // ===== Policy =====
    const hops = parseHops(req.headers["x-mslxdff-hops"]);
    const shareKeys = parseShareKeysHeader(req.headers[SHARE_KEYS_HEADER] || "");
    const workbuddyUid = (req.headers["x-mslxdff-workbuddy-uid"] || req.headers["x-workbuddy-uid"] || "").toString().trim();
    const lockModel = req.headers["x-mslxdff-model-lock"] || "";
    const rawModel = body.model || "";
    let normalizedRequested = normalizeModel(lockModel || rawModel || "");
    const aliasResolved = getModelAlias(normalizedRequested);
    if (aliasResolved) { normalizedRequested = aliasResolved; body = { ...body, model: aliasResolved }; }
    let requested = normalizedRequested;
    let aliasInfo = null;
    if (requested.startsWith("mslxdff-")) {
      const internal = aliasToInternal(requested);
      if (internal) { aliasInfo = `${requested} -> ${internal}`; requested = internal; }
    } else if (requested.includes("/")) {
      const slashIdx = requested.indexOf("/");
      const rawPart = requested.slice(slashIdx + 1);
      const providerPart = requested.slice(0, slashIdx);
      if (rawPart.startsWith("mslxdff-")) {
        const internal = aliasToInternal(rawPart);
        if (internal) {
          aliasInfo = `${requested} -> ${providerPart}/${internal} (alias stripped)`;
          requested = `${providerPart}/${internal}`;
          if (providerPart === "mslxdff") { requested = internal; aliasInfo = `${rawModel} -> ${internal} (mslxdff alias stripped)`; }
        }
      } else if (providerPart === "mslxdff") {
        aliasInfo = `${requested} -> ${rawPart} (mslxdff provider stripped, 原名兼容)`;
        requested = rawPart;
      }
    }
    const useAuto = isAutoModel(requested);
    mark("parsed");
    if (aliasInfo) { try { res.setHeader("x-mslxdff-alias", aliasInfo); } catch {} }

    // ===== Selector: order 推导 =====
    let order;
    if (lockModel) order = [requested];
    else if (useAuto) order = auto ? await auto.candidates() : [""];
    else order = auto ? await auto.candidatesFor(requested) : [requested];
    if (!order.length) order = [""];
    const canFallback = order.length > 1;
    const canForwardPeers = Boolean(peers) && hops < maxHops;
    mark("ordered");

    const logCall = (model, status) => logs?.appendCall({ reqId, model, auto: useAuto, status, durationMs: Date.now() - startedAt, stream: Boolean(body.stream), stages });
    const logError = (model, status, message) => logs?.appendError({ reqId, model, auto: useAuto, status, message, stages });
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
    if (aliasInfo) evt("alias", { reqId, alias: aliasInfo, rawModel, requested });
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

    const handlerCtx = { reqId, model: null, body, hops, peers, plugins, evt, logError, logCall, logs };

    // ===== Selector: 首次 auto 并发择优 =====
    if (useAuto && order.length > 1 && auto && !lockModel) {
      const statuses = auto.statuses?.() ?? {};
      const hasPriorSuccess = Object.values(statuses).some((e) => e && typeof e === "object" && e.status === "normal");
      const nonCoolingOrder = order.filter((m) => { try { return !auto.isCooling(m); } catch { return true; } });
      if (!hasPriorSuccess && nonCoolingOrder.length > 1) {
        const concLimit = (() => {
          const v = Number(process.env.MSLXDFF_AUTO_CONCURRENT);
          if (Number.isInteger(v) && v > 0) return Math.min(v, nonCoolingOrder.length);
          return Math.min(nonCoolingOrder.length, 5);
        })();
        let raceModels=nonCoolingOrder.slice(0,concLimit);
        if(plugins?.length){const k=[];for(const m of raceModels){const b=await runHook(plugins,"model:beforeTry",{reqId,requested,model:m,hops});if(b.value===false||b.value?.skip)continue;k.push(m);}raceModels=k;}
        if(!raceModels.length){order=order.filter(m=>!new Set(nonCoolingOrder.slice(0,concLimit)).has(m));if(!order.length){await handleExhaustedAll({res,body,lastErr:{model:requested,status:502,message:"all concurrent candidates skipped by plugin"},order:nonCoolingOrder.slice(0,concLimit),requested,handlerCtx:{...handlerCtx,reqId,startedAt},evt,logCall,mark,perf0,stages});return;}}else{evt("auto-concurrent-race",{reqId,models:raceModels,skippedFaulty:order.length-nonCoolingOrder.length,limit:concLimit});const raceStart=performance.now();const attempts=raceModels.map(async m=>{let f={...injectReasoningContent(m,body),model:m};if(plugins?.length){const u=await runHook(plugins,"upstream:request",{reqId,requested,model:m,payload:f,stream:Boolean(body.stream)});if(u.changed&&u.value?.payload) f=u.value.payload;}let r=null;try{const o={};if(Object.keys(shareKeys).length)o.shareKeys=shareKeys;if(workbuddyUid)o.workbuddyUid=workbuddyUid;r=await upstream.chat(f,Object.keys(o).length?o:undefined);}catch(e){if(plugins?.length)runHook(plugins,"upstream:response",{reqId,requested,model:m,status:null,ok:false,error:errMsg(e),timing:e?._t??null}).catch(()=>{});return{model:m,ok:false,error:errMsg(e),status:502,timing:e?._t??null};}if(plugins?.length)runHook(plugins,"upstream:response",{reqId,requested,model:m,status:r instanceof Error?null:r?.status??null,ok:!(r instanceof Error)&&r?r.status<400:false,error:r instanceof Error?errMsg(r):null,timing:r?._t??null}).catch(()=>{});if(r&&r.status>=400){const a=r.status===403&&r.headers?.get?.("x-mslxdff-allowlist")==="1";if(a)return{model:m,ok:false,error:"allowlist",status:403,allowlist:true};return{model:m,ok:false,error:`upstream ${r.status}`,status:r.status,res:r,timing:r._t??null};}if(r instanceof Error)return{model:m,ok:false,error:errMsg(r),status:502};return{model:m,ok:true,res:r,status:r.status,timing:r._t??null};});
        const results = await Promise.allSettled(attempts);
        const okList = results.map((r, i) => ({ r, i, model: raceModels[i] }))
          .filter(({ r }) => r.status === "fulfilled" && r.value?.ok)
          .map(({ r, i, model }) => ({ model, idx: i, val: r.value, t: r.value.timing?.totalMs ?? r.value.timing?.ms ?? Number.MAX_SAFE_INTEGER }));
        if (okList.length) {
          okList.sort((a, b) => a.t - b.t);
          const best = okList[0];
          const winModel = best.model;
          evt("auto-concurrent-win", { reqId, model: winModel, timing: best.val.timing, totalMs: Math.round(performance.now() - raceStart), tried: raceModels.length });
          for (const { r, i } of results.map((r, i) => ({ r, i }))) {
            const m = raceModels[i];
            if (r.status === "fulfilled" && r.value?.ok) {
              if (m === winModel) {
                const latencyMs = r.value.timing?.totalMs ?? Math.round(performance.now() - raceStart);
                await auto.recordOk(m, { latencyMs });
                try { const { savePreferredModel } = await import("../../state.js"); savePreferredModel(m); evt("auto-concurrent-preferred", { reqId, model: m }); } catch {}
              }
            } else if (r.status === "fulfilled" && !r.value?.ok && !r.value?.allowlist) await auto.recordError(m, { status: r.value.status || 502 });
            else if (r.status === "rejected") await auto.recordError(m, { status: 502 });
          }
          handlerCtx.model = winModel;
          const { handleLocalRelay: _relay } = await import("./local-handler.js");
          const lr = await _relay({
            upRes: best.val.res, model: winModel, body, order: raceModels, idx: best.idx,
            lastErr: null, requested, useAuto, lockModel, auto, handlerCtx, evt, logCall, logError, mark, perf0, stages, startedAt, plugins, res,
          });
          if (lr.handled) return;
          if (!lr.lastErr) return;
        } else {
          evt("auto-concurrent-all-fail", { reqId, tried: raceModels.length, totalMs: Math.round(performance.now() - raceStart) });
          for (const { r, i } of results.map((r, i) => ({ r, i }))) {
            const m = raceModels[i];
            if (r.status === "fulfilled" && !r.value?.ok && !r.value?.allowlist) await auto.recordError(m, { status: r.value.status || 502 });
            else if (r.status === "rejected") await auto.recordError(m, { status: 502 });
          }
        }
        const triedSet = new Set(raceModels);
        order = order.filter((m) => !triedSet.has(m));
        if (!order.length) {
          const failedStatuses = results.map((r) => (r.status === "fulfilled" ? r.value?.status : null)).filter((s) => Number.isInteger(s));
          const lastStatus = failedStatuses[failedStatuses.length - 1] || failedStatuses[0] || 502;
          const last = { model: raceModels[0] || requested, status: lastStatus, message: "all concurrent candidates failed" };
          await handleExhaustedAll({ res, body, lastErr: last, order: raceModels, requested, handlerCtx: { ...handlerCtx, reqId, startedAt }, evt, logCall, mark, perf0, stages });
          return;
        }
        } // close else (raceModels not empty)
      }
    }

    // ===== Executor: 串行 trial =====
    let lastErr = null;
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
          const hr = await handleHedge({ upRes, model, body, order, idx, lastErr, requested, useAuto, lockModel, auto, peers, handlerCtx, evt, logCall, logError, mark, perf0, stages, startedAt, plugins, res, hedgeDelayMs: d });
          if (hr.handled) return;
          if (hr.lastErr) lastErr = hr.lastErr;
          if (hr.upRes === null) upRes = null;
          else if (hr.upRes) upRes = hr.upRes;
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
      if (canFallback) { evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: lastErr?.message || `upstream ${lastErr?.status ?? 502}` }); continue; }
      await handleExhaustedLocal({ res, body, lastErr, order, handlerCtx: { ...handlerCtx, model, reqId }, evt, logCall, mark, perf0, stages, done, requested, useAuto });
      return;
    }
    await handleExhaustedAll({ res, body, lastErr, order, requested, handlerCtx: { ...handlerCtx, reqId, startedAt }, evt, logCall, mark, perf0, stages });
  }

  return { handle };
}

// 薄适配：保持原 chatHandler 签名兼容
export async function chatHandler(ctx) {
  const gw = createChatGateway(ctx);
  return gw.handle(ctx);
}
