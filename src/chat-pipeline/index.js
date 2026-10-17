import { performance } from "node:perf_hooks";
import { analyzePolicy } from "./policy.js";
import { createEngine } from "./engine.js";
import { runHook } from "../plugins.js";
import { isFreeModel } from "../models.js";
import { clientIp, summarizePrompt } from "../routes/helpers.js";
import { formatTimeline } from "../timeline.js";
import { summarizeRequest, shouldTraceModel } from "../model-trace.js";
import { apiKindOf } from "../api-kind.js";

/**
 * ChatPipeline 深模块门面 — 对外 execute(req) 单一 inlet
 * 内部组合 Policy→Engine：解析 header/model → 产 order → 委托 engine 执行
 * gateway 仅薄适配：readBody + request:received hook + 调 execute
 */
/**
 * 指定 free 模型时是否允许横向切同池兄弟（BUG-7）。
 * 缺省开：opencode 免费池的裸 id 模型（`mimo-v2.6-flash-free` 等）语义上就是"免费额度内随便用"，
 * 单个模型额度耗尽不该让整条链路失败。逃生阀 `MSLXDFF_FREE_POOL_FALLBACK=0` 回到"显式指定即锁死"。
 * 只在**非 lockModel**（即不经组内 model-lock 转发）时生效。
 */
// 同池互备最多横向试几个（含首个指定的那个）：额度类失败常见于"整池都满"，
// 扫全池只会把快速失败拖成分钟级，试前几个足够区分"这个模型满"与"这池满"。
const FREE_POOL_MAX = 4;

export function freePoolFallbackOn(env = process.env) {
  const raw = env.MSLXDFF_FREE_POOL_FALLBACK;
  if (raw === undefined || raw === null || raw === "") return true;
  const s = String(raw).trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "off" || s === "no");
}

export function createChatPipeline({ upstream, auto, logs, peers, groups, bus, token, plugins, maxHops } = {}) {
  const engine = createEngine();

  async function execute({ req, res } = {}) {
    const startedAt = Date.now();
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // 入站协议门（chat|responses|messages|other）：全场只在这里判一次，之后随 handlerCtx 透传；
    // 各日志写点不得再各自匹配路径（第二份判定迟早漂移）—— 见 src/api-kind.js
    const api = apiKindOf(req);
    const perf0 = performance.now();
    const stages = [];
    const mark = (name) => stages.push([name, Math.round(performance.now() - perf0)]);

    const policy = analyzePolicy({ headers: req?.headers || {}, body: req?.body || {} });
    const { requested, useAuto, autoProvider, lockModel, hops, shareKeys, workbuddyUid, aliasInfo } = policy;
    mark("parsed");
    if (aliasInfo) { try { res?.setHeader?.("x-mslxdff-alias", aliasInfo); } catch {} }
    // mslxdff/ 前缀或 alias 命中时，把 body.model 改写为还原后的模型（与原 gateway 语义一致）
    const timeline = { direct: [], peers: [], retries: 0, retryResult: null, result: null };
    if (aliasInfo && req?.body && req.body.model !== requested) {
      req.body = { ...req.body, model: requested };
    }

    // 事件/日志帮手先于 order 推导声明：evt 在 auto-scope 分支即被使用，
    // 声明置后会让 useAuto && autoProvider 的请求在 TDZ 上崩（线上 -chat 回退路径）
    const logCall = (model, status) => logs?.appendCall({ reqId, api, model, auto: useAuto, status, durationMs: Date.now() - startedAt, stream: Boolean(req?.body?.stream), stages });
    const logError = (model, status, message) => logs?.appendError({ reqId, api, model, auto: useAuto, status, message, stages });
    const evt = (type, data) => {
      const entry = { ts: Date.now(), reqId, type, ...data, api, model: data.model ?? requested, auto: useAuto, durationMs: Date.now() - startedAt, stages: [...stages] };
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
      // 空转重试必须交代结局：只记次数的话，"重试后救回来"和"重试到死"在日志里长得一模一样
      if (type === "empty-turn-recovered") timeline.retryResult = "ok";
      if (type === "empty-turn-exhausted") timeline.retryResult = timeline.retryResult || "lost";
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
    // 例外：opencode 免费池的裸 id free 模型（mimo-v2.6-flash-free / deepseek-v4.1-flash-free…）
    // 额度耗尽时允许**同池互备**——见 freePoolFallbackOn()（BUG-7 用户点名诉求）。
    // x-mslxdff-auto-provider 头可把 auto 候选限定到单供应商（opencode=裸 id 免费池），-chat 默认带
    let order;
    let poolFallback = false; // 指定 free 模型时的「同池互备」标记：只有额度类失败才允许继续换兄弟
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
      // 指定模型的常态是死锁单模型。**唯一例外**：裸 id 的 free 模型（opencode 免费池），
      // 且只在**额度类**失败（429 / 具名额度判决）时才横向切同池兄弟——参数错/5xx 照旧原样透传，
      // 不把「客户端发错了」伪装成换模型成功，也不白烧别的模型额度（见 isPoolSwitchWorthy）。
      // candidatesFor 的持久化副作用（把指定模型加入勾选集）在任何分支都必须保留。
      const wantFreePool = Boolean(auto && requested && freePoolFallbackOn() && isFreeModel(requested) && !String(requested).includes("/"));
      if (auto && requested) {
        try {
          const cands = await auto.candidatesFor(requested);
          if (wantFreePool && Array.isArray(cands) && cands.length) {
            // 上限截断：串行换人是"试一试"不是"扫全池"，太多候选会把额度类失败也拖成分钟级
            const samePool = cands
              .filter((m) => m === requested || (isFreeModel(m) && !String(m).includes("/")))
              .slice(0, FREE_POOL_MAX);
            if (samePool.length > 1) {
              order = samePool;
              poolFallback = true;
              evt("free-pool-fallback", { reqId, model: requested, pool: samePool, size: samePool.length });
            }
          }
        } catch {}
      }
      if (!order) order = [requested];
    }
    if (!order.length) order = [""];
    const canFallback = order.length > 1;
    const canForwardPeers = Boolean(peers) && hops < (maxHops ?? 3);
    mark("ordered");

    const reqIp = clientIp(req); // 一次解析两处用：request 事件的 ip 字段 + 回路语料的 clientIp（routes/helpers.js 取 x-forwarded-for 首段）
    evt("request", { reqId, hops, ip: reqIp, stream: Boolean(req?.body?.stream), prompt: summarizePrompt(req?.body), rawModel: policy.rawModel, requested, lockModel: lockModel || null });
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
    // triedUrls 挂请求级并**按引用**共享：同一请求内"同一组员不重复试"的契约跨候选生效
    // （peer 阶段各分支会 spread 出上下文副本，集合在这里建一次才不会各存一份）。
    const handlerCtx = { reqId, api, model: null, body: req?.body, hops, peers, plugins, evt, logError, logCall, logs, workbuddyUid, sessionId: clientSession, clientIp: reqIp, triedUrls: new Set() };
    if (clientSession) evt("client-session", { reqId, sessionId: clientSession.slice(0, 24) });

    await engine.run({
      reqId, startedAt, req, res, body: req?.body, policy,
      useAuto, lockModel, requested, hops,
      canFallback, canForwardPeers, poolFallback,
      perf0, stages, mark, evt, logCall, logError, done, handlerCtx,
      auto, upstream, peers, groups, bus, token, plugins, logs,
      order,
    });
  }

  return { execute, _policy: analyzePolicy, _engine: engine };
}