// warp-pool · 轮换 dispatcher：把每个请求委派给不同出口节点的 ProxyAgent。
// 契约（MODULES.md §1）：只需 dispatch(opts, handler) + close()/destroy()。
// 注入点：src/transport/index.js 的 extDispatcher —— legacy（transport.request）与 SDK（sdk/attempt.js
// 的 dispatcherFetch）两条路共用同一个 dispatcher 对象，故一处实现、两条路生效。
//
// 空池语义：bootstrap（注册设备/起隧道）完成前 list 为空 → 走直连兜底，行为与未启用本功能时一致；
// bootstrap 完成后 setNodes() 换上真实出口。这样 daemon 启动不会因注册/下载而被阻塞。
import { getUndici } from "../compat.js";
import { createSelector } from "./strategy.js";

const SESSION_HEADER = "x-opencode-session";

/** undici 的 dispatch opts.headers 是扁平数组 [k, v, k, v, ...]。 */
export function headerValue(headers, name) {
  if (!Array.isArray(headers)) return "";
  const target = String(name).toLowerCase();
  for (let i = 0; i + 1 < headers.length; i += 2) {
    if (String(headers[i]).toLowerCase() === target) return String(headers[i + 1] ?? "");
  }
  return "";
}

/** 让 dispatcher 看见上游状态码：复制一层 handler，只截 onHeaders，其余方法原样转发（全部调用都落在副本上，this 一致）。 */
export function tapHandler(handler, tap) {
  if (!tap || !handler || typeof handler !== "object") return handler;
  const out = Object.assign(Object.create(Object.getPrototypeOf(handler)), handler);
  const orig = handler.onHeaders;
  out.onHeaders = function (statusCode, headers, resume, statusText) {
    try { tap(statusCode); } catch {}
    return typeof orig === "function" ? orig.call(this, statusCode, headers, resume, statusText) : undefined;
  };
  return out;
}

/**
 * @param {{ nodes?: Array<{port:number, uri:string}>, strategy?: "session"|"request",
 *           cooldownMs?: number, now?: () => number, log?: (s:string)=>void, onStatus?: (status:number, port:number)=>void,
 *           agentOptions?: object, selector?: object }} [opts]
 */
export function createRotatingDispatcher({
  nodes = [],
  strategy = "session",
  cooldownMs = 600_000,
  now = Date.now,
  log = () => {},
  onStatus = null,
  agentFactory,
  fallbackAgent,
  agentOptions = { connections: 8, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, pipelining: 1 },
  selector = createSelector({ strategy }),
} = {}) {
  const { ProxyAgent, Agent } = getUndici();
  if (typeof ProxyAgent !== "function") throw new Error("undici ProxyAgent 不可用：无法建立出口池");
  // 空池兜底：直连（等价 R3 里被顶掉的 keepAlive 池）。
  const fallback = fallbackAgent !== undefined ? fallbackAgent : typeof Agent === "function" ? new Agent(agentOptions) : null;
  let list = build(nodes);

  function build(nodesIn) {
    return (nodesIn || []).map((n, i) => ({
      index: i,
      port: Number(n.port),
      uri: String(n.uri),
      agent: agentFactory ? agentFactory(n.uri) : new ProxyAgent({ uri: n.uri, ...agentOptions }),
      cooldownUntil: 0,
      fails: 0,
    }));
  }

  function availableIndexes() {
    const t = now();
    const out = [];
    for (const e of list) if (e.cooldownUntil <= t) out.push(e.index);
    return out;
  }

  function markFailure(index) {
    const e = list[index];
    if (!e) return;
    e.fails += 1;
    e.cooldownUntil = now() + cooldownMs;
    if (e.fails === 1 || e.fails % 10 === 0) log(`[warp-pool] 节点 :${e.port} 连续失败 ${e.fails} 次，冷却 ${Math.round(cooldownMs / 1000)}s（中间次数静默：健康探活每分钟一轮，一个不通的节点曾把日志刷成 12 行/分钟）`);
  }

  function markOk(index) {
    const e = list[index];
    if (e) {
      e.fails = 0;
      e.cooldownUntil = 0;
    }
  }

  async function closePool(entries) {
    await Promise.all(
      entries.map((e) => {
        try {
          return Promise.resolve(e.agent.close?.()).catch(() => {});
        } catch {
          return Promise.resolve();
        }
      }),
    );
  }

  return {
    /** 每次请求调一次 = 轮换粒度。 */
    dispatch(opts, handler) {
      if (!list.length) {
        if (fallback) return fallback.dispatch(opts, handler);
        throw new Error("warp-pool：节点池为空且无直连兜底");
      }
      const avail = availableIndexes();
      // 全池冷却 ⇒ 直连兜底优先：硬派给已知不可用的节点 = 把请求挂到超时。
      if (!avail.length) return (fallback || list[0].agent).dispatch(opts, handler);
      const sessionKey = strategy === "session" ? headerValue(opts?.headers, SESSION_HEADER) : "";
      const e = list[selector.pick(avail, sessionKey)];
      return e.agent.dispatch(opts, tapHandler(handler, onStatus ? (sc) => onStatus(sc, e.port) : null));
    },

    /** 运行期换上一批出口（bootstrap 完成后调用）；旧 Agent 池关闭。 */
    async setNodes(nodesIn) {
      const old = list;
      list = build(nodesIn);
      await closePool(old);
      return list.length;
    },

    /** 只读快照，供 health 探活用。 */
    entries() {
      return list.map((e) => ({ index: e.index, port: e.port, uri: e.uri, cooldownUntil: e.cooldownUntil, fails: e.fails }));
    },

    async close() {
      await closePool(list);
      list = [];
      if (fallback) {
        try {
          await fallback.close?.();
        } catch {}
      }
    },

    async destroy() {
      return this.close();
    },

    stats() {
      const t = now();
      return list.map((e) => ({
        port: e.port,
        uri: e.uri,
        cooling: e.cooldownUntil > t,
        cooldownMsLeft: Math.max(0, e.cooldownUntil - t),
        fails: e.fails,
      }));
    },

    markFailure,
    markOk,
    get size() {
      return list.length;
    },
  };
}
