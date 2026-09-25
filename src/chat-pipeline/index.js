import { performance } from "node:perf_hooks";
import { analyzePolicy } from "./policy.js";
import { createEngine } from "./engine.js";
import { runHook } from "../plugins.js";
import { isFreeModel } from "../models.js";
import { clientIp, summarizePrompt } from "../routes/helpers.js";
import { formatTimeline } from "../timeline.js";
import { summarizeRequest, shouldTraceModel } from "../model-trace.js";

/**
 * ChatPipeline 深模块门面 — 对外 execute(req) 单一 inlet
 * 内部组合 Policy→Engine：解析 header/model → 产 order → 委托 engine 执行
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
    const { requested, useAuto, autoProvider, lockModel, hops, shareKeys, workbuddyUid, aliasInfo } = policy;
    mark("parsed");
    if (aliasInfo) { try { res?.setHeader?.("x-mslxdff-alias", aliasInfo); } catch {} }
    // mslxdff/ 前缀或 alias 命中时，把 body.model 改写为还原后的模型（与原 gateway 语义一致）
    const timeline = { direct: [], peers: [], retries: 0, result: null };
    if (aliasInfo && req?.body && req.body.model !== requested) {
      req.body = { ...req.body, model: requested };
    }

    // 事件/日志帮手先于 order 推导声明：evt 在 auto-scope 分支即被使用，
    // 声明置后会让 useAuto && autoProvider 的请求在 TDZ 上崩（线上 -chat 回退路径）
    const logCall = (model, status) => logs?.appendCall({ reqId, model, auto: useAuto, status, durationMs: Date.now() - startedAt, stream: Boolean(req?.body?.stream), stages });
    const logError = (model, status, message) => logs?.appendError({ reqId, model, auto: useAuto, status, message, stages });
    const evt = (type, data) => {
      const entry = { ts: Date.now(), reqId, type, ...data, model: data.model ?? requested, auto: useAuto, durationMs: Date.now() - startedAt, stages: [...stages] };
      const traceModel = entry.model || requested;
      if (shouldTraceModel(type)) {
        // Note: 模型日志只投影安全字段，不能把含 prompt 的 entry 原样下传 — 见 .agents/notes/implemented/feature/2026-09-25-model-trace-log.md
        const safeTraceData = { ...entry };
        if (safeTraceData.prompt !== undefined) delete safeTraceData.prompt;
        logs?.appendModelTrace?.(traceModel, { type, reqId, model: traceModel, data: safeTraceData, request: type === "request" ? summarizeRequest(req?.body) : null, totalMs: entry.durationMs });
      }
      if (type === "peer-forward") timeline.peers.push({ peer: entry.peer, ok: entry.ok === true, status: entry.status, latencyMs: entry.latencyMs, message: entry.message || entry.error || "" });
      if (type === "upstream-done" || type === "upstream-error") timeline.direct.push({ status: entry.status, reason: entry.message || entry.error || "" });
      if (type === "peer-error") {
        const known = timeline.peers.find((p) => p.peer === entry.peer);
        if (known) { known.ok = false; known.status = entry.status ?? known.status; known.message = entry.message || entry.error || known.message; }
        else timeline.peers.push({ peer: entry.peer, ok: false, status: entry.status, message: entry.message || entry.error || "" });
      }
      if (type === "empty-turn-retry") timeline.retries += 1;
      if (type === "result" || (type === "client-response" && !timeline.result)) {
        timeline.result = { status: entry.status, detail: entry.detail || null };
        try { logs?.appendTimeline?.(formatTimeline({ reqId, model: entry.model || requested, ...timeline, totalMs: Date.now() - startedAt })); } catch {}
      }
      if (bus) bus.emit(entry);
      logs?.appendEvent?.(entry);
    };
    const done = (info) => {
      if (!plugins?.length) return;
      runHook(plugins, "request:completed", { reqId, requested, useAuto, hops, stream: Boolean(req?.body?.stream), durationMs: Date.now() - startedAt, ...info }).catch(() => {});
    };

    // order 推导 + plugin model:select 可改
    // 语义：指定模型 = 死锁单模型（本机→组员同款，挂了就报挂，不兜其他 picks）；只有 auto 才轮 picks
    // x-mslxdff-auto-provider 头可把 auto 候选限定到单供应商（opencode=裸 id 免费池），-chat 默认带
    let order;
    if (lockModel) order = [requested];
    else if (useAuto) {
      let cands = auto ? await auto.candidates() : [""];
      if (autoProvider) {
        const before = cands.length;
        cands = cands.filter((m) => (autoProvider === "opencode"
          ? !String(m).includes("/") && isFreeModel(m)
          : String(m).startsWith(`${autoProvider}/`)));
        evt("auto-scope", { reqId, provider: autoProvider, before, after: cands.length });
      }
      order = cands;
    } else {
      if (auto && requested) { try { await auto.candidatesFor(requested); } catch {} }
      order = [requested];
    }
    if (!order.length) order = [""];
    const canFallback = order.length > 1;
    const canForwardPeers = Boolean(peers) && hops < (maxHops ?? 3);
    mark("ordered");

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

    // 客户端会话标识（opencode 插件 chat.headers 注入）→ 透传上游做粘性路由/缓存亲和；
    // 无头时由 upstream.js 按对话首两条消息哈希兜底（不再每请求随机）
    const clientSession = String(req?.headers?.["x-session-affinity"] || req?.headers?.["x-session-id"] || "").trim() || null;
    const handlerCtx = { reqId, model: null, body: req?.body, hops, peers, plugins, evt, logError, logCall, logs, workbuddyUid, sessionId: clientSession };
    if (clientSession) evt("client-session", { reqId, sessionId: clientSession.slice(0, 24) });

    await engine.run({
      reqId, startedAt, req, res, body: req?.body, policy,
      useAuto, lockModel, requested, hops,
      canFallback, canForwardPeers,
      perf0, stages, mark, evt, logCall, logError, done, handlerCtx,
      auto, upstream, peers, groups, bus, token, plugins, logs,
      order,
    });
  }

  return { execute, _policy: analyzePolicy, _engine: engine };
}