import { performance } from "node:perf_hooks";
import { isAutoModel } from "../auto.js";
import { errMsg } from "./helpers.js";
import { runHook } from "../plugins.js";
import { buildShareKeysHeader, SHARE_KEYS_HEADER } from "../providers/share-keys.js";
import { compatFetch, timeoutSignal, getUndici } from "../compat.js";

const PEER_TIMEOUT_MS = 30_000;
// peer 阶段总预算：三批候选（ordered / orderedByLastError / coolingByLastError）共享同一个
// 截止时间，而不是每批各吃满一次等头超时。实测最坏路径是三批串行各 30s（≈90s），
// 客户端表现为"随机转圈"；预算到点即停，把余下时间还给本地兜底。
const DEFAULT_PEER_RACE_BUDGET_MS = 45_000;
const PEER_STATUS_TIMEOUT_MS = 2_000;
const DEFAULT_PEER_CONNECT_TIMEOUT_MS = 3_000;
// SSE 响应体数据间隔超时（undici bodyTimeout）。慢模型首块后可静默思考远超 30s，
// 沿用 30s 会把组内转发的中继活流掐成 "terminated"（实测首块后 ~31s 必断，本地直连
// 无此限制——组内因此比直连"不流畅"）。与 provider 请求级超时同量级（注意：**不是**与应用层
// MAX_STREAM_MS 对齐——后者默认 0=关，见 src/routes/stream.js 的实测依据）：
// undici 层只做最后兜底，掐流交给应用层的首块/总时长策略。
import { summarizeRequest } from "../model-trace.js";
const PEER_BODY_TIMEOUT_MS = 120_000;
export { PEER_BODY_TIMEOUT_MS };

function peerConnectTimeoutMs() {
  const n = Number(process.env.MSLXDFF_PEER_CONNECT_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PEER_CONNECT_TIMEOUT_MS;
}

// peer 阶段总预算（MSLXDFF_PEER_RACE_BUDGET_MS，0=不限）：一次 peer 阶段（同批或若干批候选）
// 共享同一个截止时刻。调用方用 peerStageCtx() 起一个阶段，别把 deadline 挂在整个请求上下文上——
// 否则前一个候选把预算吃光，后一个候选一进 peer 阶段就直接放弃。
function peerRaceBudgetMs() {
  const raw = process.env.MSLXDFF_PEER_RACE_BUDGET_MS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PEER_RACE_BUDGET_MS;
  const s = String(raw).trim().toLowerCase();
  if (s === "0" || s === "off" || s === "false" || s === "no") return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PEER_RACE_BUDGET_MS;
}

/**
 * 起一个 peer 阶段：返回带本阶段截止时刻的上下文副本。
 * `triedUrls`（去重集合）必须**原样沿用源 ctx 的同一引用**：它在副本上新建会让
 * "同一请求内不重复试同一 peer" 的契约失效——换下一个候选时集合是空的，死节点被反复竞速。
 */
export function peerStageCtx(ctx = {}) {
  const budgetMs = peerRaceBudgetMs();
  const tried = ctx.triedUrls ?? (ctx.triedUrls = new Set());
  return { ...ctx, triedUrls: tried, peerRaceDeadline: budgetMs > 0 ? Date.now() + budgetMs : 0, peerRaceBudgetMs: budgetMs };
}

// 连接级超时（DNS + TCP/TLS 握手）：黑洞节点（端口挂起）必须快速失败，
// 不能占用 30s 的响应超时（曾把一次请求拖到 92s）。仅 undici 可用时生效。
let peerDispatcher = null;
export function getPeerDispatcher() {
  if (peerDispatcher) return peerDispatcher;
  const { Agent } = getUndici();
  if (!Agent) return null;
  try {
    peerDispatcher = new Agent({
      connect: { timeout: peerConnectTimeoutMs() },
      headersTimeout: PEER_TIMEOUT_MS,
      bodyTimeout: PEER_BODY_TIMEOUT_MS,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
  } catch { peerDispatcher = null; }
  return peerDispatcher;
}

/**
 * 保热：用**组员转发同一条连接池**（getPeerDispatcher）打 GET /health，把 (本机→组员) 的连接
 * 保持在温热、且**正是 chat 会复用的那条 socket**（裸 fetch 的全局池热的是另一条，等于白热）。
 * /health 无鉴权、无副作用、零额度。绝不抛；返回 {ok}。
 */
export async function warmPeerHealth(url, { timeoutMs = 5000 } = {}) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "no url" };
  const dispatcher = getPeerDispatcher();
  try {
    const res = await compatFetch(`${base}/health`, {
      headers: { Accept: "application/json" },
      signal: timeoutSignal(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    });
    try { if (res.body) await res.text().catch(() => {}); } catch {}
    return { ok: Boolean(res?.ok), status: res?.status };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// 跨 caller 中继必须剥离 reasoning 加密态：encrypted_content 由上游按 caller（出口）签发，
// 换个节点转发会被拒（400 "reasoning encrypted_content was not issued to this caller"）。
// 明文 reasoning_content 保留（不绑定 caller，thinking 模式需要）。
export function stripCallerBoundReasoning(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return body;
  let changed = false;
  const out = messages.map((m) => {
    if (!m || m.role !== "assistant") return m;
    if (!Array.isArray(m.reasoning_items) || !m.reasoning_items.length) return m;
    changed = true;
    const copy = { ...m };
    delete copy.reasoning_items;
    return copy;
  });
  return changed ? { ...body, messages: out } : body;
}

function peerHealthTtlMs() {
  const n = Number(process.env.MSLXDFF_PEER_HEALTH_TTL_MS);
  return Number.isInteger(n) && n >= 0 ? n : 30_000;
}

const healthCache = new Map(); // url -> { at, data }
const healthInflight = new Map(); // url -> Promise

export function clearPeerHealthCache() {
  healthCache.clear();
  healthInflight.clear();
}

export async function peerHealthyModels(peer, { timeoutMs = PEER_STATUS_TIMEOUT_MS, fetchImpl = compatFetch } = {}) {
  const key = peer?.url || "";
  const ttl = peerHealthTtlMs();
  if (ttl > 0) {
    const hit = healthCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    const inflight = healthInflight.get(key);
    if (inflight) return inflight;
  }
  const p = (async () => {
    try {
      const res = await fetchImpl(`${peer.url}/v1/models/status`, {
        headers: {
          "Authorization": `Bearer ${peer.token || ""}`,
          "Accept": "application/json",
        },
        signal: timeoutSignal(timeoutMs),
      });
      if (!res.ok) return [];
      const j = await res.json().catch(() => ({}));
      return (j.data || [])
        .filter((m) => m && typeof m.id === "string" && m.status === "normal")
        .map((m) => m.id);
    } catch {
      return [];
    }
  })();
  if (ttl > 0) {
    healthInflight.set(key, p);
    try {
      const data = await p;
      healthCache.set(key, { at: Date.now(), data });
      return data;
    } finally {
      healthInflight.delete(key);
    }
  }
  return p;
}

// controller 由调用方持有：赛跑 winner 确定后可主动 abort 其余 in-flight，
// 避免迟到流挂满 bodyTimeout（并给对方省下无用负载）。
//
// ⚠ 这个 timer 名义上"仅覆盖等响应头"，但组员节点自己也会**压着响应头等首块**
// （ADR-0043 空轮留口 / 首块前不 flush），于是"等头"实际就是"等对方首块"。
// 实测（mimo-v2.6-flash-free，2026-10-17）：本地 9.7s 拿到头、首块 30~60s 才到；组员侧
// 全部恰好卡在 30001ms 被 abort —— 30s 只够本地拿头，组员永远等不到，组网兜底退化成
// "每次白等 30s"。故这里的等待上限与 bodyTimeout 同档（120s），真正的时间闸门交给
// 阶段总预算（见 startPeerStage / MSLXDFF_PEER_RACE_BUDGET_MS）。
const DEFAULT_PEER_HEADERS_TIMEOUT_MS = 120_000;

async function forwardToPeer(peer, body, model, hops, controller = new AbortController(), waitMs = DEFAULT_PEER_HEADERS_TIMEOUT_MS) {
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.round(waitMs)));
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer.token}`,
      "x-mslxdff-hops": String(hops + 1),
      "x-mslxdff-model-lock": model,
      "Accept": "text/event-stream",
    };
    // ADR-0019：命中供应商的 key 随转发自动借出（组内互信，无开关；opencode/workbuddy/cline 硬排除）
    const shareHeader = buildShareKeysHeader(model);
    if (shareHeader) headers[SHARE_KEYS_HEADER] = shareHeader;
    const dispatcher = getPeerDispatcher();
    return await compatFetch(`${peer.url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...stripCallerBoundReasoning(body), model }),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (err) {
    return err;
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePeerTarget(ctx, peer) {
  const prevModel = ctx.peers.stat(peer.url)?.model;
  const hot = ctx.peers.isHot(peer.url) && prevModel === ctx.model;
  if (hot) return { peer, target: prevModel };
  const isExplicit = !!ctx.model && !isAutoModel(ctx.model);
  if (isExplicit) {
    const healthy = await peerHealthyModels(peer);
    if (!healthy.length) {
      ctx.evt("peer-health", { peer: peer.url, healthy: [], count: 0, strict: true });
      return { peer, target: ctx.model };
    }
    ctx.evt("peer-health", { peer: peer.url, healthy, count: healthy.length, strict: true });
    return { peer, target: ctx.model };
  }
  const healthy = await peerHealthyModels(peer);
  if (!healthy.length) {
    await ctx.peers.recordError(peer.url);
    ctx.logError(ctx.model, 0, `peer ${peer.url} has no healthy models`);
    ctx.evt("peer-health", { peer: peer.url, healthy: [], count: 0 });
    return null;
  }
  ctx.evt("peer-health", { peer: peer.url, healthy, count: healthy.length });
  return { peer, target: healthy.includes(ctx.model) ? ctx.model : healthy[0] };
}

export const PEER_RACE_LIMIT = Number(process.env.MSLXDFF_PEER_RACE_LIMIT) > 0
  ? Number(process.env.MSLXDFF_PEER_RACE_LIMIT)
  : 3;

// 串行记账队列：失败/迟到成功的记录不阻塞赢家返回，同时避免并发写盘互相覆盖。
let peerRecordChain = Promise.resolve();
function recordLater(fn) {
  peerRecordChain = peerRecordChain.then(fn).catch(() => {});
}

// 节点显示名：事件里同时带上 name 与 url，多组员时不必再对着 state.json 认 IP
// （同一个 peer 对象在 prepare 后会被拷进 order，故按 url 回查）。
function peerName(peer) {
  return String(peer?.name || "").trim() || null;
}

export async function racePeerCandidates(candidates, ctx) {
  const tried = (ctx.triedUrls ??= new Set());
  const fresh = candidates.filter((p) => !tried.has(p.url));
  // 阶段总预算：由 ctx.peerRaceDeadline 提供（调用方经 peerStageCtx() 起阶段）。
  // 没传的阶段（单批调用）不带预算——保持旧行为，不外溢到整条请求。
  const budgetMs = ctx.peerRaceBudgetMs ?? 0;
  const deadline = Number(ctx.peerRaceDeadline) || 0;
  for (let i = 0; i < fresh.length; i += PEER_RACE_LIMIT) {
    if (deadline > 0 && Date.now() >= deadline) {
      ctx.evt("peer-budget-out", { peer: null, reason: `peer 阶段总预算 ${budgetMs}ms 用尽`, budgetMs, remaining: fresh.length - i });
      break;
    }
    const batch = fresh.slice(i, i + PEER_RACE_LIMIT);
    const prepared = (await Promise.all(batch.map((peer) => resolvePeerTarget(ctx, peer)))).filter(Boolean);
    if (!prepared.length) continue;
    const completed = await new Promise((resolve) => {
      const order = [];
      const total = prepared.length;
      const ctrls = new Map(); // url -> controller（winner 后统一取消其余）
      let settled = false;
      const finish = (winner) => {
        if (settled) return;
        settled = true;
        if (winner) {
          for (const c of ctrls.values()) {
            if (c === winner.ctrl) continue;
            c.killedByUs = true;
            c.abort();
          }
        }
        resolve({ list: order, winner });
      };
      for (const { peer, target } of prepared) {
        tried.add(peer.url);
        const ctrl = new AbortController();
        ctrls.set(peer.url, ctrl);
        const name = peerName(peer);
        ctx.evt("peer-request", { peer: peer.url, name, model: target, hops: ctx.hops + 1, payload: summarizeRequest(ctx.body) });
        // 插件 hook：peer:beforeForward — 转发给组员前观察
        if (ctx.plugins?.length) {
          runHook(ctx.plugins, "peer:beforeForward", { reqId: ctx.reqId, peer: peer.url, model: target, hops: ctx.hops + 1 }).catch(() => {});
        }
        // 单次等待上限 = 阶段剩余预算（未超预算时用默认 120s）；预算耗尽即 abort，不再空等
        const remainingMs = deadline > 0 ? deadline - Date.now() : 0;
        const waitMs = deadline > 0 ? Math.max(1, Math.min(DEFAULT_PEER_HEADERS_TIMEOUT_MS, remainingMs)) : DEFAULT_PEER_HEADERS_TIMEOUT_MS;
        const t0 = performance.now();
        forwardToPeer(peer, ctx.body, target, ctx.hops, ctrl, waitMs).then((res) => {
          const latencyMs = Math.round(performance.now() - t0);
          const failed = res instanceof Error || res.status >= 400;
          // winner 已定后被我们主动取消：静默，不记账不报错（否则污染健康统计与错误日志）
          if (res instanceof Error && ctrl.killedByUs) {
            order.push({ ok: false, peer, target, res, status: 0, killed: true });
            if (order.length === total) finish(null);
            return;
          }
          // 插件 hook：peer:result — 组员响应后观察
          if (ctx.plugins?.length) {
            runHook(ctx.plugins, "peer:result", { reqId: ctx.reqId, peer: peer.url, model: target, ok: !failed, status: failed ? (res instanceof Error ? 502 : res.status) : res.status, latencyMs }).catch(() => {});
          }
          if (failed) {
            const status = res instanceof Error ? 502 : res.status;
            const rawMsg = res instanceof Error ? errMsg(res) : null;
            const msg = rawMsg ? rawMsg.slice(0, 200) : null;
            const failRec = { peer: peer.url, status, message: rawMsg };
            if (Array.isArray(ctx.peerErrors)) ctx.peerErrors.push(failRec);
            // ⚠ 事件名与语义对齐：peer-forward 字面是"已转发成功"，失败不再占用它，
            // 否则成功率统计（按名字 grep）会把失败也算成转发成功（现网 229 条全量里混着大量失败）。
            ctx.evt("peer-attempt", { peer: peer.url, name, model: target, hops: ctx.hops + 1, latencyMs, ok: false, status, message: msg });
            // 中间失败只进 events（debug 流），不进 errors.log：这条请求最终可能由别处成功送达，
            // 写进 errors.log 会把「已恢复的中间失败」算成错误率（实测 200 成功的请求仍在 errors.log 留 4 条 502）。
            ctx.evt("peer-error", { peer: peer.url, name, model: target, status, message: msg });
            order.push({ ok: false, peer, target, res, status });
            recordLater(() => ctx.peers.recordError(peer.url, { status, message: msg }));
            recordLater(() => ctx.peers.recordResult(peer.url, { ok: false }));
            if (order.length === total) finish(null);
          } else {
            ctx.evt("peer-forward", { peer: peer.url, name, model: target, hops: ctx.hops + 1, latencyMs, ok: true, status: res.status });
            const entry = { ok: true, peer, target, res, latencyMs, ctrl };
            order.push(entry);
            if (!settled) {
              // 第一个成功立即返回：不等慢/黑洞候选（迟到者的记账由各分支自理）
              finish(entry);
            } else {
              recordLater(() => ctx.peers.recordResult(peer.url, { ok: true, latencyMs, model: target }));
            }
          }
        });
      }
    });
    const winner = completed.winner;
    if (winner) {
      return { peer: winner.peer, target: winner.target, res: winner.res, latencyMs: winner.latencyMs };
    }
    // 全失败：补读失败响应体（诊断 + 调用者详情）。仅在"本轮无 winner"时执行，
    // 不拖慢成功路径；并行读、每 peer 上限 600ms，body 里才有 400/429 的真实原因。
    await Promise.all(completed.list.map(async (o) => {
      if (o.ok || !o.res || typeof o.res !== "object" || o.res instanceof Error) return;
      try {
        const snip = String(await Promise.race([
          o.res.clone().text(),
          new Promise((r) => { const t = setTimeout(() => r(""), 600); t.unref?.(); }),
        ])).replace(/\s+/g, " ").slice(0, 300);
        if (!snip) return;
        if (Array.isArray(ctx.peerErrors)) {
          const rec = ctx.peerErrors.find((x) => x.peer === o.peer.url && x.status === o.status && !x.message);
          if (rec) rec.message = snip;
        }
        // 同上：中继失败只进 events（debug 流），不写 errors.log —— 这条请求还可能由本地/下一批兜住
        ctx.evt("peer-error", { peer: o.peer.url, name: peerName(o.peer), model: o.target, status: o.status, message: `body=${snip}` });
      } catch {}
    }));
  }
  return null;
}
