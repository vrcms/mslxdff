import { performance } from "node:perf_hooks";
import { injectReasoningContent } from "../reasoning.js";
import { runHook } from "../plugins.js";
import { errMsg } from "../routes/helpers.js";
import { handleLocalRelay } from "../routes/chat/local-handler.js";
import { handleExhaustedAll } from "../routes/chat/exhausted-handler.js";

/**
 * auto 首次并发择优 — 从 engine.js 抽出的第一段。
 * 无 prior-success 且多非冷却候选时并发竞速，胜者走 local relay。
 * 返回 { done:true } 表示已终结（handled/exhausted），调用方直接 return；
 * 返回 { done:false, order } 表示未终结，调用方用过滤后的 order 继续。
 */
export async function runAutoRace(ctx, deps = {}) {
  const { localRelay = handleLocalRelay, exhaustedAll = handleExhaustedAll } = deps;
  const {
    reqId, requested, body, hops, useAuto, lockModel, plugins,
    auto, upstream, perf0, stages, mark, evt, logCall, logError,
    startedAt, handlerCtx, res,
  } = ctx;
  let order = ctx.order;
  const shareKeys = ctx.shareKeys ?? ctx.policy?.shareKeys ?? {};
  const workbuddyUid = ctx.workbuddyUid ?? ctx.policy?.workbuddyUid ?? null;

  if (!(useAuto && order.length > 1 && auto && !lockModel)) return { done: false, order };
  const statuses = auto.statuses?.() ?? {};
  const hasPriorSuccess = Object.values(statuses).some((e) => e && typeof e === "object" && e.status === "normal");
  const nonCoolingOrder = order.filter((m) => { try { return !auto.isCooling(m); } catch { return true; } });
  if (hasPriorSuccess || nonCoolingOrder.length <= 1) return { done: false, order };

  const concLimit = (() => {
    const v = Number(process.env.MSLXDFF_AUTO_CONCURRENT);
    if (Number.isInteger(v) && v > 0) return Math.min(v, nonCoolingOrder.length);
    return Math.min(nonCoolingOrder.length, 5);
  })();
  let raceModels = nonCoolingOrder.slice(0, concLimit);
  if (plugins?.length) {
    const k = [];
    for (const m of raceModels) {
      const b = await runHook(plugins, "model:beforeTry", { reqId, requested, model: m, hops });
      if (b.value === false || b.value?.skip) continue;
      k.push(m);
    }
    raceModels = k;
  }
  if (!raceModels.length) {
    order = order.filter((m) => !new Set(nonCoolingOrder.slice(0, concLimit)).has(m));
    if (!order.length) {
      await exhaustedAll({ res, body, lastErr: { model: requested, status: 502, message: "all concurrent candidates skipped by plugin" }, order: nonCoolingOrder.slice(0, concLimit), requested, handlerCtx: { ...handlerCtx, reqId, startedAt }, evt, logCall, mark, perf0, stages });
      return { done: true };
    }
    return { done: false, order };
  }

  evt("auto-concurrent-race", { reqId, models: raceModels, skippedFaulty: order.length - nonCoolingOrder.length, limit: concLimit });
  const raceStart = performance.now();
  const attempts = raceModels.map(async (m) => {
    let f = { ...injectReasoningContent(m, body), model: m };
    if (plugins?.length) {
      const u = await runHook(plugins, "upstream:request", { reqId, requested, model: m, payload: f, stream: Boolean(body.stream) });
      if (u.changed && u.value?.payload) f = u.value.payload;
    }
    let r = null;
    try {
      const o = {};
      if (Object.keys(shareKeys).length) o.shareKeys = shareKeys;
      if (workbuddyUid) o.workbuddyUid = workbuddyUid;
      r = await upstream.chat(f, Object.keys(o).length ? o : undefined);
    } catch (e) {
      if (plugins?.length) runHook(plugins, "upstream:response", { reqId, requested, model: m, status: null, ok: false, error: errMsg(e), timing: e?._t ?? null }).catch(() => {});
      return { model: m, ok: false, error: errMsg(e), status: 502, timing: e?._t ?? null };
    }
    if (plugins?.length) runHook(plugins, "upstream:response", { reqId, requested, model: m, status: r instanceof Error ? null : r?.status ?? null, ok: !(r instanceof Error) && r ? r.status < 400 : false, error: r instanceof Error ? errMsg(r) : null, timing: r?._t ?? null }).catch(() => {});
    if (r && r.status >= 400) {
      const a = r.status === 403 && r.headers?.get?.("x-mslxdff-allowlist") === "1";
      if (a) return { model: m, ok: false, error: "allowlist", status: 403, allowlist: true };
      return { model: m, ok: false, error: `upstream ${r.status}`, status: r.status, res: r, timing: r._t ?? null };
    }
    if (r instanceof Error) return { model: m, ok: false, error: errMsg(r), status: 502 };
    return { model: m, ok: true, res: r, status: r.status, timing: r._t ?? null };
  });
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
          try { const { savePreferredModel } = await import("../state.js"); savePreferredModel(m); evt("auto-concurrent-preferred", { reqId, model: m }); } catch {}
        }
      } else if (r.status === "fulfilled" && !r.value?.ok && !r.value?.allowlist) await auto.recordError(m, { status: r.value.status || 502 });
      else if (r.status === "rejected") await auto.recordError(m, { status: 502 });
    }
    handlerCtx.model = winModel;
    const lr = await localRelay({ upRes: best.val.res, model: winModel, body, order: raceModels, idx: best.idx, lastErr: null, requested, useAuto, lockModel, auto, handlerCtx, evt, logCall, logError, mark, perf0, stages, startedAt, plugins, res });
    if (lr.handled) return { done: true };
    if (!lr.lastErr) return { done: true };
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
    await exhaustedAll({ res, body, lastErr: last, order: raceModels, requested, handlerCtx: { ...handlerCtx, reqId, startedAt }, evt, logCall, mark, perf0, stages });
    return { done: true };
  }
  return { done: false, order };
}
