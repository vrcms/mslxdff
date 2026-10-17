// warp-pool · 节点健康：主动探活（经隧道打上游 models，不烧 token）+ 失败冷却 + 连续失败触发重拨换 IP。
import { probeTunnel } from "./wireproxy.js";
import { fmtHealth, fmtHeartbeat, dur, MARK } from "./report.js";

export function createHealthMonitor({
  dispatcher,
  baseUrl = "https://opencode.ai",
  probePath = "/zen/v1/models",
  unhealthyAfter = 3,
  intervalMs = 60_000,
  heartbeatEvery = 10,
  infoOf = null,
  cooldownMs = 600_000,
  onExhausted = null,
  probe = probeTunnel,
  headers = {},
  now = Date.now,
  log = () => {},
} = {}) {
  let timer = null;
  let rounds = 0;
  let ticks = 0;
  let lastAllDownAt = "";
  /** @type {Map<number, boolean>} 每端口上一轮通不通（用来只在「状态变化」时打日志） */
  const lastOk = new Map();
  const stamp = () => new Date(now()).toISOString().slice(11, 19);

  /**
   * 跑一轮全池探活。日志纪律：**只在「状态有变化」「全池不通」「心跳点」时打**——每分钟一行会把日志淹掉。
   * 每个不通的节点都要报全：HTTP 状态、错误原文、耗时、连续第几次、冷却多久（这样才不用靠猜）。
   */
  async function tick() {
    if (!dispatcher) return { checked: 0, healthy: 0 };
    const list = dispatcher.entries();
    let healthy = 0;
    let slowestMs = 0;
    const problems = [];
    const changes = [];
    for (const e of list) {
      const r = await probe({ port: e.port, baseUrl, path: probePath, headers }).catch((err) => ({
        ok: false,
        error: String(err?.message || err),
      }));
      if (Number(r.ms) > slowestMs) slowestMs = Number(r.ms);
      if (r.ok) {
        dispatcher.markOk(e.index);
        healthy += 1;
        if (lastOk.get(e.port) === false) changes.push(`:${e.port} 恢复（HTTP ${r.status}，${dur(r.ms)}）`);
        lastOk.set(e.port, true);
        continue;
      }
      dispatcher.markFailure(e.index);
      if (lastOk.get(e.port) !== false) {
        changes.push(`:${e.port} 掉线（HTTP ${r.status || 0}${r.error ? ` ${String(r.error).slice(0, 80)}` : ""}）`);
      }
      lastOk.set(e.port, false);
      problems.push({ port: e.port, status: r.status, error: r.error, ms: r.ms, fails: Number(e.fails || 0) + 1, cooldownMs });
    }
    const allDown = list.length > 0 && healthy === 0;
    ticks += 1;
    if (allDown) {
      rounds += 1;
      lastAllDownAt = stamp();
    } else {
      rounds = 0;
    }
    if (changes.length || allDown || ticks % heartbeatEvery === 0) {
      log(fmtHealth({ healthy, total: list.length, slowestMs, problems }));
    }
    for (const c of changes) log(`[warp-pool] ${MARK.warn} 状态变化：${c}`);
    if (ticks % heartbeatEvery === 0) {
      const extra = typeof infoOf === "function" ? infoOf() || {} : {};
      log(fmtHeartbeat({
        alive: extra.alive ?? list.length,
        total: list.length,
        pooled: extra.pooled ?? list.length,
        exits: extra.exits || [],
        cooling: list.filter((e) => Number(e.cooldownUntil) > now()).length,
        lastAllDown: lastAllDownAt,
      }));
    }
    if (allDown && rounds >= 2 && typeof onExhausted === "function") {
      rounds = 0;
      await onExhausted().catch((e) => log(`[warp-pool] 重拨失败：${String(e?.message || e)}`));
    }
    return { checked: list.length, healthy };
  }

  return {
    tick,
    start() {
      if (timer || !(intervalMs > 0)) return;
      timer = setInterval(() => {
        tick().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get running() {
      return !!timer;
    },
  };
}
