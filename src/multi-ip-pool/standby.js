// multi-ip-pool · 备选出口池：**定时预拨** 不多于 N 条已验通的隧道，429 一到立刻有干净 IP 可上。
//
// 用户 2026-10-25 的裁决（本模块存在的唯一理由）：
//   「启用时定时准备不多于 5 个备选 IP（例如每小时找 5 个备用），一旦组长触发 429，
//    可以**立即**启用其中的备用 IP；启用备用 IP 时要打一个 hi 到 opencode.ai，要它 200。」
// ⇒ 换出口那一刻绝不能再现场拨号（openvpn 握手秒级 + 候选可能全不通，429 现场等 = 用户在等），
//   而是**平时就把备用隧道起好、并逐条用 hi 验过有 200**，429 时只做"取一条"。
//
// 备用条目两条铁律：
//   ① 只有 hi 回 200 的才算"备用"（有额度的 IP），429/403 的当场拆掉重拨下一条；
//   ② 交付前**再验一次** hi——免费节点的出口 IP 是别人在用的，一小时里可能已经被别人吃光额度。
//      验不过就丢掉取下一条（宁可少一条出口，也不把一个没额度的 IP 交给请求路径）。
import { fmtStandbyAdd, fmtStandbyDrop, fmtStandbyRefill, fmtStandbySkip, fmtStandbyUse } from "./report.js";

/** 备用槽的索引偏移：设备名/表号与正式槽彻底错开（正式槽 mltun0..、备用 mltun100..、表 baseTable+100..）。 */
export const STANDBY_INDEX_BASE = 100;
/** 备用槽索引循环上限（设备名 ≤15 字符：mltun + 3 位）。 */
export const STANDBY_INDEX_SPAN = 100;
/** 一轮补位最多拨多少次（防候选全不通时把 VPNGate 与本机刷成灾）。 */
export const REFILL_DIAL_CAP = 12;

/**
 * @param {{ cfg: object, log?: Function, dialer: object,
 *           schedule?: (fn: Function, ms: number) => any, cancel?: (h: any) => void, now?: () => number }} opts
 *   dialer 需要提供：openSlot(index) / ensureCandidates({force}) / hiProbe(entry) / drop(entry) / tunnels(Set)
 */
export function createStandby({ cfg, log = () => {}, dialer, schedule = (fn, ms) => setInterval(fn, ms), cancel = (h) => clearInterval(h), now = Date.now } = {}) {
  /** @type {object[]} 已验通的备用出口（FIFO，最旧的先交出去） */
  const ready = [];
  let timer = null;
  let busy = null;
  let counter = 0;

  function want() {
    return Math.max(0, Math.min(5, Number(cfg.standby) || 0)); // 用户定的硬上限：不多于 5
  }

  function stats() {
    return {
      want: want(),
      have: ready.length,
      everyMs: Number(cfg.standbyEveryMs) || 0,
      exits: ready.map((e) => ({ dev: e.dev, node: e.node?.hostName || "", tunIp: e.tunIp, exitIp: e.exitIp || "", verifiedAt: e.verifiedAt || 0 })),
    };
  }

  /** 拨一条新备用隧道并验它（不 200 就地拆掉，调用方继续下一条）。 */
  async function dialOne() {
    const index = STANDBY_INDEX_BASE + (counter++ % STANDBY_INDEX_SPAN);
    const e = await dialer.openSlot(index, { dev: "" });
    if (!e) return null;
    e.verifiedAt = now();
    ready.push(e);
    log(fmtStandbyAdd({ dev: e.dev, node: e.node?.hostName || "", exitIp: e.exitIp || "", tunIp: e.tunIp, have: ready.length, want: want() }));
    return e;
  }

  /**
   * 补到 want() 条。同一时刻只跑一轮（定时器与 429 后的补位会撞车）；每轮开头强制重取节点表——
   * 免费节点掉得快，一小时前的候选表多半已经拨不通了。
   * @returns {Promise<{added: number, have: number, want: number}>}
   */
  function refill({ force = false } = {}) {
    if (!want()) return Promise.resolve({ added: 0, have: 0, want: 0 });
    if (busy) return busy;
    const run = async () => {
      if (force || ready.length < want()) {
        try {
          await dialer.ensureCandidates({ force: force || ready.length === 0 });
        } catch (e) {
          log(fmtStandbySkip({ why: `取节点表失败：${String(e?.message || e)}` }));
        }
      }
      let dialed = 0;
      const before = ready.length;
      while (ready.length < want() && dialed < REFILL_DIAL_CAP) {
        dialed++;
        try {
          const got = await dialOne();
          if (!got) break; // 候选用尽（openSlot 内部已换过一轮）
        } catch (e) {
          log(fmtStandbySkip({ why: `拨备用隧道出错：${String(e?.message || e)}` }));
        }
      }
      log(fmtStandbyRefill({ added: ready.length - before, have: ready.length, want: want(), dialed }));
      return { added: ready.length - before, have: ready.length, want: want() };
    };
    busy = run().finally(() => {
      busy = null;
    });
    return busy;
  }

  /** 复验一条备用出口：交出去之前必须**这一秒**还是 200。 */
  async function verify(entry) {
    const p = await dialer.hiProbe(entry);
    if (p.status === 200) {
      entry.exitIp = p.ip || entry.exitIp || "";
      entry.verifiedAt = now();
      return entry;
    }
    log(fmtStandbyDrop({ dev: entry.dev, node: entry.node?.hostName || "", status: p.status, kind: p.kind, error: p.error || "" }));
    await dialer.drop(entry, "备用出口复验未过 200");
    return null;
  }

  /**
   * 取一条备用出口（429 路径调这个）：逐条复验、验不过就丢；池空了先补一轮再取。
   * @returns {Promise<null | object>} 验通的出口条目（可直接当新槽用）
   */
  async function take() {
    for (let guard = 0; guard < 2 && !ready.length; guard++) await refill();
    while (ready.length) {
      const e = ready.shift();
      const okEntry = await verify(e);
      if (okEntry) {
        log(fmtStandbyUse({ dev: okEntry.dev, tunIp: okEntry.tunIp, exitIp: okEntry.exitIp || "", node: okEntry.node?.hostName || "", left: ready.length }));
        void refill().catch(() => {}); // 用完立刻补位，下一发 429 还得有备胎
        return okEntry;
      }
    }
    return null;
  }

  /** 起定时器（每小时刷新）。`MSLXDFF_MULTI_IP_STANDBY=0` ⇒ 完全不起。 */
  function start() {
    const w = want();
    const every = Number(cfg.standbyEveryMs) || 0;
    if (!w || !every || timer) return;
    timer = schedule(() => {
      void refreshAll().catch((e) => log(fmtStandbySkip({ why: `定时刷新失败：${String(e?.message || e)}` })));
    }, every);
  }

  /** 周期到点：把旧的备用全部拆掉重拨一批（出口 IP 换新，才叫"每小时找 5 个备用"）。 */
  async function refreshAll() {
    const stale = ready.splice(0, ready.length);
    for (const e of stale) await dialer.drop(e, "备选池整批刷新");
    return refill({ force: true });
  }

  /** 收摊：停定时器 + 拆掉所有备用隧道（一条都不许留给下次启动当残留）。 */
  async function stop() {
    if (timer) {
      try {
        cancel(timer);
      } catch {
        /* 忽略 */
      }
      timer = null;
    }
    const all = ready.splice(0, ready.length);
    for (const e of all) await dialer.drop(e, "收摊");
  }

  return { refill, take, start, stop, refreshAll, stats, get size() { return ready.length; } };
}