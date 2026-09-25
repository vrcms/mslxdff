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
import { shouldUseGroupForModel, isHardLocalOnly, isKeyProviderDirectOnly } from "../state/schemas/use-group.js";
import { isEmptyTurnError } from "../routes/chat/relay-pipeline.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 空转重试档位（每次请求读取 env，单测可覆盖）：默认同模型最多重试 2 次、间隔 1s；
// MSLXDFF_EMPTY_TURN_RETRIES=0 关闭（回旧行为：空转直接换候选/终结）。
function emptyRetryCfg() {
  const r = Number(process.env.MSLXDFF_EMPTY_TURN_RETRIES);
  const d = Number(process.env.MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS);
  return {
    max: Number.isInteger(r) && r >= 0 ? r : 2,
    delayMs: Number.isFinite(d) && d >= 0 ? d : 1000,
  };
}

function groupSkipReason(model) {
  if (isHardLocalOnly(model)) return "provider local-only（禁组员，仅本机直连）";
  if (isKeyProviderDirectOnly(model)) return "key provider default direct（仅本机直连，MSLXDFF_USE_GROUP_KEYS=1 可开组员）";
  return "useGroup=off";
}

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
  if (!useAuto && requested && requested.includes("/") && canForwardPeers && !lockModel && peers && shouldUseGroupForModel(requested)) {
    try {
      const vr = await viaRoute({ model: requested, body, peers, handlerCtx, evt, logCall, logError, mark, perf0, stages, startedAt, plugins, res, requested, useAuto, lockModel, auto });
      if (vr.handled) return { done: true };
      if (vr.lastErr) viaRouteLastErr = vr.lastErr;
    } catch (e) {
      evt("via-route-exception", { reqId, model: requested, error: errMsg(e) });
    }
  } else if (!useAuto && requested && requested.includes("/") && canForwardPeers && !lockModel && peers) {
    evt("group-skip", { reqId, model: requested, reason: `${groupSkipReason(requested)} (via-route)` });
  }

  let lastErr = viaRouteLastErr;
  candidate: for (let idx = 0; idx < order.length; idx++) {
    const model = order[idx];
    handlerCtx.model = model;
    handlerCtx.orderLen = order.length;
    handlerCtx.idx = idx;
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
    const chatOpts = {};
    if (Object.keys(shareKeys).length) chatOpts.shareKeys = shareKeys;
    if (workbuddyUid) chatOpts.workbuddyUid = workbuddyUid;
    if (handlerCtx?.sessionId) chatOpts.sessionId = handlerCtx.sessionId;
    const chatOptsArg = Object.keys(chatOpts).length ? chatOpts : undefined;
    // 空转 200（模型无输出）同模型暂停重试：默认 2 次、间隔 1s；仅 EMPTY_MODEL_RESPONSE，
    // 429/403/500 与 fetch 异常走原有切号/failover（防烧额度）。MSLXDFF_EMPTY_TURN_RETRIES=0 关闭。
    const emptyCfg = emptyRetryCfg();
    let emptyRetried = 0;
    for (;;) {
      const tUp = performance.now();
      evt("upstream-try", { reqId, model, attempt: idx + 1, emptyRetry: emptyRetried });
      try {
        upRes = await upstream.chat(forwarded, chatOptsArg);
        evt("upstream-done", { reqId, model, ok: !(upRes instanceof Error) && upRes.status < 400, status: upRes instanceof Error ? null : upRes.status, timing: upRes._t ?? null, error: null });
      } catch (err) {
        if (auto) await auto.recordError(model, { message: errMsg(err) });
        lastErr = { model, upstream: null, status: 502, message: errMsg(err) };
        logError(model, 502, errMsg(err));
        evt("upstream-error", { reqId, model, status: 502, message: errMsg(err), timing: err._t ?? { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - tUp) } });
        upRes = null;
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
            if (canFallback && idx < order.length - 1) { evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: `allowlist skip ${errBody.error || "blocked"}` }); continue candidate; }
            return json(res, 403, errBody);
          }
          logError(model, 403, errBody.error || "model not allowed");
          evt("upstream-error", { reqId, model, status: 403, message: errBody.error, timing: upRes._t ?? null, allowlist: true });
          return json(res, 403, errBody);
        }
        if (auto) await auto.recordError(model, { status: upRes.status });
        // 读失败响应体（clone 不影响后续 relay 转发原响应；1s 上限防流式错误体拖慢）
        let upBody = "";
        try {
          upBody = String(await Promise.race([
            upRes.clone().text(),
            new Promise((r) => { const t = setTimeout(() => r(""), 1000); t.unref?.(); }),
          ])).replace(/\s+/g, " ").slice(0, 400);
        } catch {}
        const upMsg = upBody || `upstream ${upRes.status}`;
        lastErr = { model, upstream: upRes, status: upRes.status, message: upMsg };
        logError(model, upRes.status, `upstream ${upRes.status}${upBody ? ` body=${upBody.slice(0, 300)}` : ""}`);
        evt("upstream-error", { reqId, model, status: upRes.status, message: upMsg.slice(0, 300), timing: upRes._t ?? null });
        upRes = null;
        break;
      }
      if (upRes) {
        const isStream = Boolean(body.stream);
        const d = hedgeDelayMs();
        const hasPeers = Boolean(peers) && peers.ordered().length > 0;
        const canUseGroup = shouldUseGroupForModel(model);
        const doHedge = canUseGroup && shouldHedge({ isStream, canForwardPeers, hedgeDelayMs: d, hasPeers, model }) && upRes.status === 200 && upRes.body;
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
          if (lr.lastErr && isEmptyTurnError(lr.lastErr) && emptyRetried < emptyCfg.max) {
            emptyRetried++;
            evt("empty-turn-retry", { reqId, model, retry: emptyRetried, max: emptyCfg.max, delayMs: emptyCfg.delayMs });
            await sleep(emptyCfg.delayMs);
            continue;
          }
          if (lr.lastErr) { lastErr = lr.lastErr; continue candidate; }
          return { done: true };
        }
        break;
      }
      break;
    }
    if (canForwardPeers) {
      if (!shouldUseGroupForModel(model)) {
        evt("group-skip", { reqId, model, reason: `${groupSkipReason(model)} (peer)` });
      } else {
        const pr = await peerRelay({ model, body, lastErr, requested, useAuto, lockModel, auto, peers, handlerCtx, evt, logCall, mark, perf0, stages, startedAt, plugins, res });
        if (pr.handled) return { done: true };
        if (pr.lastErr) lastErr = pr.lastErr;
      }
    }
    if (groups) {
      if (!shouldUseGroupForModel(model)) {
        evt("group-skip", { reqId, model, reason: `${groupSkipReason(model)} (broadband)` });
      } else {
        const br = await broadbandRelay({ model, body, hops, lastErr, requested, useAuto, lockModel, auto, groups, token, bus, logs, handlerCtx, evt, mark, perf0, stages, res, startedAt, plugins });
        if (br.handled) return { done: true };
      }
    }
    if (canFallback) { evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: lastErr?.message || `upstream ${lastErr?.status ?? 502}` }); continue; }
    await exhaustedLocal({ res, body, lastErr, order, handlerCtx: { ...handlerCtx, model, reqId }, evt, logCall, mark, perf0, stages, done, requested, useAuto });
    return { done: true };
  }
  await exhaustedAll({ res, body, lastErr, order, requested, handlerCtx: { ...handlerCtx, reqId, startedAt }, evt, logCall, mark, perf0, stages });
  return { done: true };
}
