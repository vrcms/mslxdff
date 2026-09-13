// ADR-0015 daemon 装配：60s 节拍轮转探针；0=完全关闭
import { probeTargetsFromState, rotateTick, nextCursor } from "./rotate.js";
import { loadProviderConfigs, loadProviderKeys, loadProviderBaseUrl } from "../state.js";
import { loadPeers } from "../state.js";

export function upstreamProbeIntervalMs() {
  const n = Number(process.env.MSLXDFF_UPSTREAM_PROBE_MS);
  return Number.isInteger(n) && n >= 0 ? n : 60_000;
}

export function startUpstreamProbe({ evt = () => {}, peers, file, delayMs } = {}) {
  const interval = upstreamProbeIntervalMs();
  if (interval === 0) return null;
  let cursor = 0;
  let busy = false;
  const loadTargets = () => {
    try {
      return probeTargetsFromState({
        loadProviderConfigs: () => loadProviderConfigs({}),
        loadProviderKeys: (id) => loadProviderKeys(id, {}),
        loadProviderBaseUrl: (id) => loadProviderBaseUrl(id, {}),
      });
    } catch {
      return [];
    }
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const targets = loadTargets();
      if (!targets.length) return;
      const out = await rotateTick({ targets, cursor, peers, evt, file, delayMs });
      if (out.probed != null) cursor = nextCursor(cursor, targets.length);
    } catch {
      // 探针永不影响主链路
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, interval);
  timer.unref?.();
  return { stop: () => clearInterval(timer), interval, tick };
}
