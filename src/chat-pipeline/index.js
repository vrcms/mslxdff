import { performance } from "node:perf_hooks";
import { analyzePolicy } from "./policy.js";
import { planRoute } from "./planner.js";
import { createEngine } from "./engine.js";
import { runHook } from "../plugins.js";
import { clientIp, summarizePrompt } from "../routes/helpers.js";

/**
 * ChatPipeline 深模块门面 — 对外 execute(req) 单一 inlet
 * 内部组合 Policy→Planner→Engine：解析 header/model → 产 order → 委托 engine 执行
 * gateway 仅薄适配：readBody + request:received hook + 调 execute
 */
export function createChatPipeline({ upstream, auto, logs, peers, groups, bus, token, plugins, maxHops } = {}) {
  const engine = createEngine();

  async function execute({ req, res } = {}) {
    const startedAt = Date.now();
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const perf0 = performance.now();
    const stages = [];
    const mark = (name) => stages.push([name, Math.round(performance.now() - perf0)]);

    const policy = analyzePolicy({ headers: req?.headers || {}, body: req?.body || {} });
    const { requested, useAuto, lockModel, hops, shareKeys, workbuddyUid, aliasInfo } = policy;
    mark("parsed");
    if (aliasInfo) { try { res?.setHeader?.("x-mslxdff-alias", aliasInfo); } catch {} }
    // mslxdff/ 前缀或 alias 命中时，把 body.model 改写为还原后的模型（与原 gateway 语义一致）
    if (aliasInfo && req?.body && req.body.model !== requested) {
      req.body = { ...req.body, model: requested };
    }

    // order 推导 + plugin model:select 可改
    let order;
    if (lockModel) order = [requested];
    else if (useAuto) order = auto ? await auto.candidates() : [""];
    else order = auto ? await auto.candidatesFor(requested) : [requested];
    if (!order.length) order = [""];
    const canFallback = order.length > 1;
    const canForwardPeers = Boolean(peers) && hops < (maxHops ?? 3);
    mark("ordered");

    const logCall = (model, status) => logs?.appendCall({ reqId, model, auto: useAuto, status, durationMs: Date.now() - startedAt, stream: Boolean(req?.body?.stream), stages });
    const logError = (model, status, message) => logs?.appendError({ reqId, model, auto: useAuto, status, message, stages });
    const evt = (type, data) => {
      const entry = { ts: Date.now(), reqId, type, ...data, model: data.model ?? requested, auto: useAuto, durationMs: Date.now() - startedAt, stages: [...stages] };
      if (bus) bus.emit(entry);
      logs?.appendEvent?.(entry);
    };
    const done = (info) => {
      if (!plugins?.length) return;
      runHook(plugins, "request:completed", { reqId, requested, useAuto, hops, stream: Boolean(req?.body?.stream), durationMs: Date.now() - startedAt, ...info }).catch(() => {});
    };

    evt("request", { reqId, hops, ip: clientIp(req), stream: Boolean(req?.body?.stream), prompt: summarizePrompt(req?.body), rawModel: policy.rawModel, requested, lockModel: lockModel || null });
    if (aliasInfo) evt("alias", { reqId, alias: aliasInfo, rawModel: policy.rawModel, requested });
    if (Object.keys(shareKeys).length) evt("share-keys", { reqId, providers: Object.keys(shareKeys) });
    evt("ordered", { reqId, order, canFallback, canForwardPeers, useAuto, statuses: auto?.statuses?.() ?? null });

    if (plugins?.length && !lockModel) {
      const sel = await runHook(plugins, "model:select", { reqId, requested, useAuto, order: [...order], hops, stream: Boolean(req?.body?.stream) });
      if (sel.changed && Array.isArray(sel.value) && sel.value.length) {
        order = sel.value.filter(Boolean);
        if (!order.length) order = [requested];
        evt("plugin-hook", { reqId, hook: "model:select", applied: true, order: [...order] });
      }
      for (const e of sel.errors) evt("plugin-hook-error", { reqId, hook: "model:select", plugin: e.plugin, error: e.error });
    }

    const handlerCtx = { reqId, model: null, body: req?.body, hops, peers, plugins, evt, logError, logCall, logs, workbuddyUid };

    const plan = planRoute(policy, {
      candidates: order,
      viaRoute: Boolean(!useAuto && requested.includes("/") && canForwardPeers) ? { via: true } : null,
    });
    await engine.run(plan, {
      reqId, startedAt, req, res, body: req?.body, policy,
      useAuto, lockModel, requested, hops,
      canFallback, canForwardPeers,
      perf0, stages, mark, evt, logCall, logError, done, handlerCtx,
      auto, upstream, peers, groups, bus, token, plugins, logs,
      order,
    });
  }

  return { execute, _policy: analyzePolicy, _plan: planRoute, _engine: engine };
}