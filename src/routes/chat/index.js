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
  const workbuddyUid = (req.headers["x-mslxdff-workbuddy-uid"] || req.headers["x-workbuddy-uid"] || "").toString().trim();
  const lockModel = req.headers["x-mslxdff-model-lock"] || "";
  const rawModel = body.model || "";
  let normalizedRequested = normalizeModel(lockModel || rawModel || "");
  // WorkBuddy 别名还原：clinebot-z-ai-glm-5.3-flash → clinebot/z-ai/glm-5.3-flash
  const aliasResolved = getModelAlias(normalizedRequested);
  if (aliasResolved) {
    normalizedRequested = aliasResolved;
    body = { ...body, model: aliasResolved };
  }
  // alias 还原：mslxdff-deepseek -> deepseek（原名仍兼容，双向支持 mslxdff/mslxdff-deepseek 与裸 mslxdff-deepseek/裸 deepseek）
  let requested = normalizedRequested;
  let aliasInfo = null;
  if (requested.startsWith("mslxdff-")) {
    const internal = aliasToInternal(requested);
    if (internal) {
      aliasInfo = `${requested} -> ${internal}`;
      requested = internal;
    }
  } else if (requested.includes("/")) {
    const slashIdx = requested.indexOf("/");
    const rawPart = requested.slice(slashIdx + 1);
    const providerPart = requested.slice(0, slashIdx);
    if (rawPart.startsWith("mslxdff-")) {
      const internal = aliasToInternal(rawPart);
      if (internal) {
        aliasInfo = `${requested} -> ${providerPart}/${internal} (alias stripped)`;
        requested = `${providerPart}/${internal}`;
        if (providerPart === "mslxdff") {
          requested = internal;
          aliasInfo = `${rawModel} -> ${internal} (mslxdff alias stripped)`;
        }
      }
    } else if (providerPart === "mslxdff") {
      // mslxdff/deepseek 原名直用 -> deepseek（原名兼容，provider 前缀剥离）
      aliasInfo = `${requested} -> ${rawPart} (mslxdff provider stripped, 原名兼容)`;
      requested = rawPart;
    }
  }
  const useAuto = isAutoModel(requested);
  mark("parsed");
  if (aliasInfo) {
    // 供日志与 header 透传
    try { res.setHeader("x-mslxdff-alias", aliasInfo); } catch {}
  }

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

  // 首次 auto 并发测速：勾选的供应商并发比谁快，谁快下次优先（跳过明知故障的模型）
  // 胜者会同时写入 preferredModel + auto 成功，下次 plugin 会将其排首位
  if (useAuto && order.length > 1 && auto && !lockModel) {
    const statuses = auto.statuses?.() ?? {};
    const hasPriorSuccess = Object.values(statuses).some((e) => e && typeof e === "object" && e.status === "normal");
    const nonCoolingOrder = order.filter((m) => {
      try { return !auto.isCooling(m); } catch { return true; }
    });
    // 首次（无 normal）且至少 2 个非冷却候选 → 并发赛跑
    if (!hasPriorSuccess && nonCoolingOrder.length > 1) {
      const concLimit = (() => {
        const v = Number(process.env.MSLXDFF_AUTO_CONCURRENT);
        if (Number.isInteger(v) && v > 0) return Math.min(v, nonCoolingOrder.length);
        return Math.min(nonCoolingOrder.length, 5);
      })();
      const raceModels = nonCoolingOrder.slice(0, concLimit);
      evt("auto-concurrent-race", { reqId, models: raceModels, skippedFaulty: order.length - nonCoolingOrder.length, limit: concLimit });
      // 并发发起 upstream.chat，取首个 200 成功者
      const raceStart = performance.now();
      const attempts = raceModels.map(async (m) => {
        const fwd = { ...injectReasoningContent(m, body), model: m };
        let r = null;
        try {
          const chatOpts = {};
          if (Object.keys(shareKeys).length) chatOpts.shareKeys = shareKeys;
          if (workbuddyUid) chatOpts.workbuddyUid = workbuddyUid;
          r = await upstream.chat(fwd, Object.keys(chatOpts).length ? chatOpts : undefined);
        } catch (err) {
          return { model: m, ok: false, error: errMsg(err), status: 502, timing: err?._t ?? null };
        }
        if (r && r.status >= 400) {
          const isAllow = r.status === 403 && r.headers?.get?.("x-mslxdff-allowlist") === "1";
          if (isAllow) return { model: m, ok: false, error: "allowlist", status: 403, allowlist: true };
          return { model: m, ok: false, error: `upstream ${r.status}`, status: r.status, res: r, timing: r._t ?? null };
        }
        if (r instanceof Error) return { model: m, ok: false, error: errMsg(r), status: 502 };
        return { model: m, ok: true, res: r, status: r.status, timing: r._t ?? null };
      });
      // 首个成功优先：轮询 settled，首个 ok 即胜；若全 fail 则走原串行兜底
      let winner = null;
      let winnerIdx = -1;
      const pending = new Set(attempts.map((p, i) => ({ p, i })));
      // 用 allSettled + 最快成功挑选（最小 timing 或最先 settled 的 ok）
      const results = await Promise.allSettled(attempts);
      // 按实际成功且 timing 最小排序（首包/总耗时最小者胜）
      const okList = results.map((r, i) => ({ r, i, model: raceModels[i] }))
        .filter(({ r }) => r.status === "fulfilled" && r.value?.ok)
        .map(({ r, i, model }) => ({ model, idx: i, val: r.value, t: r.value.timing?.totalMs ?? r.value.timing?.ms ?? Number.MAX_SAFE_INTEGER }));
      if (okList.length) {
        okList.sort((a, b) => a.t - b.t);
        const best = okList[0];
        winner = best.val.res;
        winnerIdx = best.idx;
        const winModel = best.model;
        evt("auto-concurrent-win", { reqId, model: winModel, timing: best.val.timing, totalMs: Math.round(performance.now() - raceStart), tried: raceModels.length });
        // 记录优胜者为 normal + 设为 preferred（下次 plugin 排首位），其余失败者计 error 但不影响优先
        for (const { r, i } of results.map((r, i) => ({ r, i }))) {
          const m = raceModels[i];
          if (r.status === "fulfilled" && r.value?.ok) {
            if (m === winModel) {
              const latencyMs = r.value.timing?.totalMs ?? Math.round(performance.now() - raceStart);
              await auto.recordOk(m, { latencyMs });
              try {
                const { savePreferredModel } = await import("../../state.js");
                savePreferredModel(m);
                evt("auto-concurrent-preferred", { reqId, model: m });
              } catch {}
            }
          } else if (r.status === "fulfilled" && !r.value?.ok && !r.value?.allowlist) {
            // 非 allowlist 的失败才计 error（跳过的 allowlist 不计）
            await auto.recordError(m, { status: r.value.status || 502 });
          } else if (r.status === "rejected") {
            await auto.recordError(m, { status: 502 });
          }
        }
        // 直接中继优胜者
        handlerCtx.model = winModel;
        const isStream = Boolean(body.stream);
        // 复用本地中继逻辑（不走 hedge，直接 relay）
        const { handleLocalRelay: _relay } = await import("./local-handler.js");
        const lr = await _relay({
          upRes: winner,
          model: winModel,
          body,
          order: raceModels,
          idx: winnerIdx,
          lastErr: null,
          requested,
          useAuto,
          lockModel,
          auto,
          handlerCtx,
          evt,
          logCall,
          logError,
          mark,
          perf0,
          stages,
          startedAt,
          plugins,
          res,
        });
        if (lr.handled) return;
        // 若中继未 handled（如 interrupted），按原逻辑继续
        if (lr.lastErr) {
          // 优胜者中继失败，降级为串行兜底（剩余 order 中未测的继续）
        } else {
          return;
        }
      } else {
        evt("auto-concurrent-all-fail", { reqId, tried: raceModels.length, totalMs: Math.round(performance.now() - raceStart) });
        // 全失败：记录失败并继续走原串行（会按 order 逐个重试，含未并发的尾部）
        for (const { r, i } of results.map((r, i) => ({ r, i }))) {
          const m = raceModels[i];
          if (r.status === "fulfilled" && !r.value?.ok && !r.value?.allowlist) await auto.recordError(m, { status: r.value.status || 502 });
          else if (r.status === "rejected") await auto.recordError(m, { status: 502 });
        }
      }
      // 并发未决出胜者或中继失败，回落到原串行循环（会跳过已试的 raceModels，继续 trial 剩余 order）
      // 为避免重复试已失败的 raceModels，过滤 order
      const triedSet = new Set(raceModels);
      order = order.filter((m) => !triedSet.has(m));
      if (!order.length) {
        // 首次并发已试全部且全失败 → 按“所有勾选都不通”直接失败
        const last = { model: raceModels[0] || requested, status: 502, message: "all concurrent candidates failed" };
        await handleExhaustedAll({ res, body, lastErr: last, order: raceModels, requested, handlerCtx: { ...handlerCtx, reqId, startedAt }, evt, logCall, mark, perf0, stages });
        return;
      }
      // 继续走下方串行 for 循环（新 order）
    }
  }

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
        let bodyText = null;
        try { bodyText = await upRes.clone().text(); } catch {}
        let errBody = { error: `model not allowed for provider` };
        try { errBody = bodyText ? JSON.parse(bodyText) : errBody; } catch { errBody = { error: bodyText || "model not allowed" }; }
        // 白名单 403：显式模型直通 403；auto 时跳过该候选继续往下走（不打断多供应商 auto）
        if (useAuto) {
          // auto：软错跳过，不计冷却，继续试下一个供应商/模型
          logError(model, 403, errBody.error || "model not allowed");
          evt("upstream-error", { reqId, model, status: 403, message: errBody.error, timing: upRes._t ?? null, allowlist: true, skipped: true });
          lastErr = { model, upstream: upRes, status: 403, message: errBody.error || "model not allowed" };
          if (canFallback && idx < order.length - 1) {
            evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: `allowlist skip ${errBody.error || "blocked"}` });
            continue;
          }
          // auto 已到末尾仍全被拦 → 直通 403
          return json(res, 403, errBody);
        }
        // 非 auto：显式指定被拦 → 硬 403，不 fallback（防绕过 allowlist）
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
