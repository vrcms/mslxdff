// multi-ip-pool · 槽位 dispatcher：每槽一条隧道 + 一个把源地址绑到 tun 地址的 undici Agent。
//
// 契约与 v6pool/warp-pool 的 dispatcher 完全一致：`dispatch(opts, handler)` + `close()`，
// 注入点同为 transport 的 extDispatcher（legacy 与 SDK 两条路共用同一个对象）。
// 与 v6 池的差别只在「换出口」这一步里干了什么：
//   v6  ：换个源地址（≈0 成本）
//   这里：拆掉旧隧道 + 用下一个 VPNGate 节点起新隧道（秒级；所以**绝不用于请求内换址**）
//
// 判决表复用 warp-pool/verdict.js（403 FreeTierError 与 429 FreeUsageLimitError 同判、强制换，
// BlackUsageLimitError 绝不换）——与生产同源，不自造一套。
import { getUndici } from "../compat.js";
import { headerValue, tapHandler } from "../warp-pool/rotate.js";
import { createSelector } from "../warp-pool/strategy.js";
import { SIGNAL_STATUSES, classifyWarpSignal } from "../warp-pool/verdict.js";
import { fmtDirect, fmtExitIp, fmtExitIpFail, fmtFirstOk, fmtNoRotate, fmtSwap, fmtSwapFail, fmtVerdictNo } from "./report.js";

const SESSION_HEADER = "x-opencode-session";

/** 每槽 Agent 的连接池参数（与 v6pool 同口径：注入 dispatcher 后 transport 不自带池）。 */
export const AGENT_OPTIONS = { connections: 4, pipelining: 1, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 };

/** 误关旧 Agent 不影响新出口，但也不该静默吞掉（只在 debug 里报）。 */
function closeQuietly(agent, log) {
  try {
    Promise.resolve(agent?.close?.()).catch((e) => log(`[multi-ip-pool] 关旧出口 Agent 失败：${String(e?.message || e)}`));
  } catch (e) {
    log(`[multi-ip-pool] 关旧出口 Agent 抛错：${String(e?.message || e)}`);
  }
}

/**
 * @param {{ slots?: object[], strategy?: "session"|"request", cooldownMs?: number, rotate?: boolean,
 *           now?: () => number, log?: (s: string) => void,
 *           agentFactory?: (addr: string) => object, fallbackAgent?: object, agentOptions?: object,
 *           selector?: object, rebuild?: (index: number, prev: object) => Promise<object>,
 *           verifyExit?: (t: object) => Promise<{ ok: boolean, ip?: string, ms?: number, error?: string }> }} [opts]
 */
export function createMultiIpDispatcher({
  slots = [],
  strategy = "session",
  cooldownMs = 600_000,
  rotate = true,
  now = Date.now,
  log = () => {},
  agentFactory,
  fallbackAgent,
  agentOptions = AGENT_OPTIONS,
  selector = createSelector({ strategy }),
  rebuild = null,
  verifyExit = null,
} = {}) {
  const { Agent } = getUndici();
  if (typeof agentFactory !== "function") {
    if (typeof Agent !== "function") throw new Error("undici Agent 不可用：无法建立多出口池");
    agentFactory = (addr) => new Agent({ connect: { localAddress: addr }, ...agentOptions });
  }
  // 空池兜底 = 直连：池还没建好（或全槽不可用）时行为与未启用完全一致。
  const fallback = fallbackAgent !== undefined ? fallbackAgent : typeof Agent === "function" ? new Agent(agentOptions) : null;

  let list = [];
  const history = [];
  let directWarned = false;

  function buildSlot(index, t) {
    return {
      index,
      node: t.node || null,
      dev: t.dev,
      tunIp: t.tunIp || "",
      table: t.table,
      priority: t.priority,
      stop: t.stop,
      exitIp: t.exitIp || "",
      agent: t.tunIp ? agentFactory(t.tunIp) : null,
      cooldownUntil: 0,
      swapping: false,
      swaps: 0,
      counts: {},
      firstOkAt: 0,
    };
  }

  /** 装上初始槽（bootstrap 探活通过后调用；空数组 = 池为空 ⇒ 直连兜底）。 */
  async function setSlots(next = []) {
    const old = list;
    list = (next || []).map((t, i) => buildSlot(i, t));
    for (const e of old) closeQuietly(e.agent, log);
    return list.length;
  }

  function availableIndexes() {
    const t = now();
    return list.filter((e) => e.agent && e.cooldownUntil <= t && !e.swapping).map((e) => e.index);
  }

  function markFailure(index) {
    const e = list[index];
    if (!e) return;
    e.cooldownUntil = now() + cooldownMs;
  }

  function markOk(index) {
    const e = list[index];
    if (e) e.cooldownUntil = 0;
  }

  /**
   * 换该槽的出口：挑下一个候选节点起新隧道（rebuild 由 index.js 提供，含拆旧/起新/探活）。
   * 失败时**绝不假装成功**：把该槽标记为无出口（tunIp 置空 ⇒ 不再被选中），并如实报错。
   * @returns {Promise<{ok?: boolean, skipped?: boolean, from?: string, to?: string, reason?: string}>}
   */
  async function swap(index, verdict = {}) {
    const e = list[index];
    if (!e) return { skipped: true, reason: "槽不存在" };
    if (e.swapping) return { skipped: true, reason: "该槽已在换出口中" };
    if (!rebuild) return { skipped: true, reason: "没有配置换出口实现（rebuild）" };
    e.swapping = true;
    const prev = { dev: e.dev, tunIp: e.tunIp, node: e.node, agent: e.agent, stop: e.stop, exitIp: e.exitIp, counts: { ...e.counts }, swaps: e.swaps };
    try {
      const t = await rebuild(index, prev);
      if (!t || !t.tunIp) throw new Error("换出口没拿到可用的新隧道");
      const exit = verifyExit ? await verifyExit(t) : null;
      e.node = t.node || null;
      e.dev = t.dev || e.dev;
      e.tunIp = t.tunIp;
      e.table = t.table ?? e.table;
      e.priority = t.priority ?? e.priority;
      e.stop = t.stop || null;
      e.exitIp = exit?.ip || t.exitIp || e.exitIp;
      e.agent = agentFactory(t.tunIp);
      e.cooldownUntil = 0;
      e.swaps = prev.swaps + 1;
      e.counts = {};
      e.firstOkAt = 0;
      closeQuietly(prev.agent, log);
      log(fmtSwap({ dev: e.dev, from: prev.tunIp, to: e.tunIp, status: verdict.status, kind: verdict.kind, forced: verdict.forced, swaps: e.swaps }));
      if (exit && !exit.ok) log(fmtExitIpFail({ dev: e.dev, error: exit.error }));
      else if (exit) log(fmtExitIp({ dev: e.dev, ip: exit.ip, ms: exit.ms, prev: prev.exitIp }));
      history.push({ dev: e.dev, tunIp: e.tunIp, swaps: e.swaps, counts: { ...prev.counts }, exitIp: e.exitIp });
      if (history.length > 32) history.shift();
      return { ok: true, from: prev.tunIp, to: e.tunIp, node: e.node };
    } catch (err) {
      // 旧隧道可能已经被拆掉了 ⇒ 这槽当前没有出口，必须置空（否则会被选中并挂到超时）
      e.agent = null;
      e.tunIp = "";
      e.cooldownUntil = now() + cooldownMs;
      log(fmtSwapFail({ dev: prev.dev, error: String(err?.message || err) }));
      return { skipped: false, error: String(err?.message || err) };
    } finally {
      e.swapping = false;
    }
  }

  /** 上游响应旁听：记账 → 换出口后首个 200 的取证行 → 配额信号才换出口。 */
  function onTap(signal, e) {
    const status = Number(signal?.status);
    e.counts[status] = (e.counts[status] || 0) + 1;
    if (status === 200 && !e.firstOkAt) {
      e.firstOkAt = now();
      log(fmtFirstOk({ dev: e.dev, ip: e.exitIp || e.tunIp, swaps: e.swaps, counts: e.counts }));
    }
    if (!SIGNAL_STATUSES.includes(status)) return;
    const v = classifyWarpSignal(signal);
    if (!rotate) {
      log(fmtNoRotate({ dev: e.dev, status, kind: v.kind }));
      return;
    }
    if (!v.rotate) {
      log(fmtVerdictNo({ dev: e.dev, status, kind: v.kind, why: v.why }));
      return;
    }
    const dev = e.dev;
    void swap(e.index, { ...v, status }).catch((err) => log(fmtSwapFail({ dev, error: String(err?.message || err) })));
  }

  return {
    /** 每次请求调一次 = 选槽粒度（session 策略下同会话粘同一出口）。 */
    dispatch(opts, handler) {
      const avail = availableIndexes();
      if (!avail.length) {
        // 空池/全槽不可用 ⇒ 直连兜底（行为与未启用一致），绝不硬派给已知不可用的槽。
        if (!list.length || !list.some((e) => e.agent)) {
          if (fallback) return fallback.dispatch(opts, handler);
          throw new Error("multi-ip-pool：出口池为空且无直连兜底");
        }
        if (!directWarned) {
          directWarned = true;
          log(fmtDirect({ reason: `全部 ${list.length} 条隧道都在冷却/换出口中（下一条恢复后自动回到池内）` }));
        }
        return (fallback || list[0].agent).dispatch(opts, handler);
      }
      directWarned = false;
      const sessionKey = strategy === "session" ? headerValue(opts?.headers, SESSION_HEADER) : "";
      const e = list[selector.pick(avail, sessionKey)];
      return e.agent.dispatch(opts, tapHandler(handler, (sig) => onTap(sig, e)));
    },

    setSlots,

    /** 手动换某槽出口（供运维/测试；正常路径由配额信号触发）。 */
    swap,

    /** 只读快照（换出口后首个 200 是否出现 = 「换 IP 有没有换来新额度」的证据）。 */
    stats() {
      const t = now();
      return {
        slots: list.map((e) => ({
          dev: e.dev,
          tunIp: e.tunIp,
          exitIp: e.exitIp,
          node: e.node?.hostName || "",
          cooling: e.cooldownUntil > t,
          swapping: e.swapping,
          swaps: e.swaps,
          counts: { ...e.counts },
          firstOk: !!e.firstOkAt,
        })),
        history: history.map((h) => ({ ...h, counts: { ...h.counts } })),
      };
    },

    entries() {
      return list.map((e) => ({ index: e.index, dev: e.dev, tunIp: e.tunIp, cooldownUntil: e.cooldownUntil, swaps: e.swaps }));
    },

    async close() {
      const old = list;
      list = [];
      for (const e of old) closeQuietly(e.agent, log);
      if (fallback) closeQuietly(fallback, log);
    },

    async destroy() {
      return this.close();
    },

    markFailure,
    markOk,

    get size() {
      return list.length;
    },
  };
}