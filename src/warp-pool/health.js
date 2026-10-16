// warp-pool · 节点健康：主动探活（经隧道打上游 models，不烧 token）+ 失败冷却 + 连续失败触发重拨换 IP。
import { probeTunnel } from "./wireproxy.js";

export function createHealthMonitor({
  dispatcher,
  baseUrl = "https://opencode.ai",
  probePath = "/zen/v1/models",
  unhealthyAfter = 3,
  intervalMs = 60_000,
  onExhausted = null,
  probe = probeTunnel,
  headers = {},
  log = () => {},
} = {}) {
  let timer = null;
  let rounds = 0;

  /** 跑一轮全池探活。返回 { checked, healthy }。 */
  async function tick() {
    if (!dispatcher) return { checked: 0, healthy: 0 };
    const list = dispatcher.entries();
    let healthy = 0;
    for (const e of list) {
      const r = await probe({ port: e.port, baseUrl, path: probePath, headers }).catch((err) => ({
        ok: false,
        error: String(err?.message || err),
      }));
      if (r.ok) {
        dispatcher.markOk(e.index);
        healthy += 1;
      } else {
        dispatcher.markFailure(e.index);
      }
    }
    if (list.length > 0 && healthy === 0) {
      rounds += 1;
      log(`[warp-pool] 全池 ${list.length} 个节点均不可用（连续第 ${rounds} 轮）`);
      if (rounds >= 2 && typeof onExhausted === "function") {
        rounds = 0;
        await onExhausted().catch((e) => log(`[warp-pool] 重拨失败：${String(e?.message || e)}`));
      }
    } else {
      rounds = 0;
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
