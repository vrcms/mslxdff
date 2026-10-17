// v6pool · 槽位 dispatcher：每槽一个源地址 + 一个自带 `localAddress` 的 undici Agent。
//
// 契约与 warp-pool 的轮换 dispatcher 一致：`dispatch(opts, handler)` + `close()`，
// 注入点同为 `transport` 的 extDispatcher（legacy 与 SDK 两条路共用同一个对象，见 MODULES.md §1）。
//
// 与 WARP 池的差别只在「换出口」这一步：
//   WARP：重注册设备 + 重启隧道（实测 5~8 秒，还会被 CF 注册限流）
//   v6  ：从前缀里挑一个新地址（≈0 成本：只多一条 `ip addr add`，bind 模式下连这条都省）
// 判决表照旧复用 warp-pool/verdict.js（403 FreeTierError 与 429 FreeUsageLimitError 同一条件 ⇒ 强制换）。
//
// 两个刻意的设计：
//   ① 换址**不重置**旧槽的冷却账，而是把旧地址推进 retiring：先关旧 Agent、延后释放地址，
//      在飞请求（SSE 长连接）不会因为源地址被抽走而断。retiring 有硬上限 RETAIN_MAX。
//   ② 每次响应都记账（不只 403/429）：`fmtFirstOk` 那行「新地址首个 200」就是
//      「429 换 IP 到底有没有换来新额度」的直接证据——这正是本次要回答的问题。
import { getUndici } from "../compat.js";
import { headerValue, tapHandler } from "../warp-pool/rotate.js";
import { createSelector } from "../warp-pool/strategy.js";
import { SIGNAL_STATUSES, classifyWarpSignal } from "../warp-pool/verdict.js";
import { fmtDirect, fmtDispatch, fmtFirstOk, fmtNoRotate, fmtRetire, fmtSwap, fmtSwapFail, fmtVerdictNo } from "./report.js";

const SESSION_HEADER = "x-opencode-session";

/** 最多留几个「已换下但地址还在网卡上」的旧出口：保护在飞请求，同时给地址数量一个硬上限。 */
export const RETAIN_MAX = 8;
/** 挑新地址时最多重试几次（前缀太小/已在用的地址太多时会一直撞）。 */
export const PICK_TRIES = 16;

/**
 * @param {{ addrs?: string[], strategy?: "session"|"request", retireMs?: number, rotate?: boolean, debug?: boolean,
 *           now?: () => number, log?: (s: string) => void, claimer?: object|null, pickAddress?: () => string,
 *           agentFactory?: (addr: string) => object, agentOptions?: object, fallbackAgent?: object, selector?: object }} [opts]
 */
export function createV6Dispatcher({
  addrs = [],
  strategy = "session",
  retireMs = 60_000,
  rotate = true,
  debug = false,
  now = Date.now,
  log = () => {},
  claimer = null,
  pickAddress = () => "",
  agentFactory,
  agentOptions = { connections: 4, pipelining: 1, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 },
  fallbackAgent,
  selector = createSelector({ strategy }),
} = {}) {
  const { Agent } = getUndici();
  if (typeof agentFactory !== "function") {
    if (typeof Agent !== "function") throw new Error("undici Agent 不可用：无法建立 v6 出口池");
    agentFactory = (addr) => new Agent({ connect: { localAddress: addr }, ...agentOptions });
  }
  const fallback = fallbackAgent !== undefined ? fallbackAgent : typeof Agent === "function" ? new Agent(agentOptions) : null;

  let list = [];
  /** @type {Array<{addr:string, agent:object, at:number, release:null|Function, counts:object, swaps:number}>} */
  const retiring = [];
  const history = [];
  let directWarned = false;

  function buildSlot(index, addr) {
    return { index, addr, agent: agentFactory(addr), cooldownUntil: 0, swaps: 0, swapping: false, counts: {}, firstOkAt: 0 };
  }

  /** 装上源地址（bootstrap 探活通过后调用；空数组 = 池为空 ⇒ 直连兜底）。 */
  function setAddresses(next = []) {
    list = (next || []).map((a, i) => buildSlot(i, a));
    return list.length;
  }
  // 构造时就装上地址（与 warp-pool 的轮换 dispatcher 同形状：入参即初始池）。
  setAddresses(addrs);

  function availableIndexes() {
    const t = now();
    return list.filter((e) => e.cooldownUntil <= t && !e.swapping).map((e) => e.index);
  }

  /** 退休账结算：只有「已过退休时长」且「超出保留上限」的才真关+真释放（close 时 force 全清）。 */
  async function flushRetired({ force = false } = {}) {
    const sorted = [...retiring].sort((a, b) => a.at - b.at);
    const over = Math.max(0, sorted.length - RETAIN_MAX);
    const keep = [];
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const aged = now() - r.at >= retireMs;
      if (!force && !(aged && i < over)) {
        keep.push(r);
        continue;
      }
      try {
        await r.agent?.close?.();
      } catch {
        /* 关不掉旧 Agent 不影响新出口 */
      }
      if (r.release) {
        try {
          await r.release();
        } catch {
          /* 释放失败已由 claim.js 自己打日志 */
        }
      }
      history.push({ addr: r.addr, swaps: r.swaps, counts: { ...r.counts } });
      if (history.length > 32) history.shift();
      log(fmtRetire({ addr: r.addr }));
    }
    retiring.length = 0;
    retiring.push(...keep);
  }

  /** 换该槽的源地址：挑新地址 → 认领 → 建新 Agent → 旧 Agent 退休（先关 Agent 再延后释放地址）。 */
  async function swap(index, verdict = {}) {
    const e = list[index];
    if (!e) return { skipped: true };
    if (e.swapping) return { skipped: true, reason: "该槽已在换址中" };
    e.swapping = true;
    try {
      const taken = new Set(list.map((s) => s.addr));
      let addr = "";
      for (let i = 0; i < PICK_TRIES && (!addr || taken.has(addr)); i++) addr = pickAddress();
      if (!addr || taken.has(addr)) throw new Error(`前缀里连续 ${PICK_TRIES} 次都撞上已在用的地址（前缀太小？）`);
      if (claimer) await claimer.ensure(addr);
      const oldAddr = e.addr;
      const prevCounts = { ...e.counts };
      const prevSwaps = e.swaps;
      retiring.push({
        addr: oldAddr,
        agent: e.agent,
        at: now(),
        release: claimer ? () => claimer.release(oldAddr) : null,
        counts: prevCounts,
        swaps: prevSwaps,
      });
      e.addr = addr;
      e.agent = agentFactory(addr);
      e.cooldownUntil = 0;
      e.swaps = prevSwaps + 1;
      e.counts = {};
      e.firstOkAt = 0;
      log(fmtSwap({ from: oldAddr, to: addr, status: verdict.status, kind: verdict.kind, forced: verdict.forced, swaps: e.swaps, prevCounts }));
      await flushRetired();
      return { ok: true, from: oldAddr, to: addr };
    } finally {
      e.swapping = false;
    }
  }

  /** 上游响应旁听：记账 → 换址后首个 200 的取证行 → 配额信号才换址。 */
  function onTap(signal, e) {
    const status = Number(signal?.status);
    e.counts[status] = (e.counts[status] || 0) + 1;
    if (status === 200 && !e.firstOkAt) {
      e.firstOkAt = now();
      log(fmtFirstOk({ addr: e.addr, swaps: e.swaps, counts: e.counts }));
    }
    if (!SIGNAL_STATUSES.includes(status)) return;
    const v = classifyWarpSignal(signal);
    if (!rotate) {
      log(fmtNoRotate({ addr: e.addr, status, kind: v.kind }));
      return;
    }
    if (!v.rotate) {
      log(fmtVerdictNo({ addr: e.addr, status, kind: v.kind, why: v.why }));
      return;
    }
    const addr = e.addr;
    void swap(e.index, { ...v, status }).catch((err) => log(fmtSwapFail({ addr, error: String(err?.message || err) })));
  }

  return {
    /** 每次请求调一次 = 选槽粒度（session 策略下同会话粘同一源地址）。 */
    dispatch(opts, handler) {
      if (!list.length) {
        if (fallback) return fallback.dispatch(opts, handler);
        throw new Error("v6pool：源地址池为空且无直连兜底");
      }
      const avail = availableIndexes();
      if (!avail.length) {
        // 全池都在冷却/换址中 ⇒ 直连兜底优先：硬派给正在换址的槽 = 把请求挂到超时
        if (!directWarned) {
          directWarned = true;
          log(fmtDirect({ reason: `全部 ${list.length} 个源地址都在冷却/换址中（下一条恢复后自动回到池内）` }));
        }
        return (fallback || list[0].agent).dispatch(opts, handler);
      }
      directWarned = false;
      const sessionKey = strategy === "session" ? headerValue(opts?.headers, SESSION_HEADER) : "";
      const e = list[selector.pick(avail, sessionKey)];
      if (debug) log(fmtDispatch({ addr: e.addr, session: sessionKey || "(无)" }));
      return e.agent.dispatch(opts, tapHandler(handler, (sig) => onTap(sig, e)));
    },

    setAddresses,

    /** 手动换某个槽的源地址（供运维/测试；正常路径由配额信号触发）。 */
    swap,

    /** 只读快照（含已退休出口的最终计数——"换址到底有没有换来新额度"看这里）。 */
    stats() {
      const t = now();
      return {
        slots: list.map((e) => ({ addr: e.addr, cooling: e.cooldownUntil > t, swaps: e.swaps, swapping: e.swapping, counts: { ...e.counts }, firstOk: !!e.firstOkAt })),
        history: history.map((h) => ({ ...h, counts: { ...h.counts } })),
      };
    },

    entries() {
      return list.map((e) => ({ index: e.index, addr: e.addr, cooldownUntil: e.cooldownUntil, swaps: e.swaps }));
    },

    async close() {
      const slots = list;
      list = [];
      for (const e of slots) {
        try {
          await e.agent?.close?.();
        } catch {
          /* 收摊时关不掉就算了 */
        }
      }
      await flushRetired({ force: true });
      if (fallback) {
        try {
          await fallback.close?.();
        } catch {
          /* 同上 */
        }
      }
    },

    async destroy() {
      return this.close();
    },

    get size() {
      return list.length;
    },
  };
}
