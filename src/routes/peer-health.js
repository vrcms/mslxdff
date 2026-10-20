// 组员健康探测与缓存：拉对方的 /v1/models/status，拿「该组员当前健康可用的模型」。
// 从 routes/peers.js 拆出（2026-10-20）：那个文件已到 20KB 硬闸，健康探测这块自洽
// （只依赖 compatFetch），拆走后 peers.js 回到闸内，也更好单测。
import { compatFetch, timeoutSignal } from "../compat.js";

const PEER_STATUS_TIMEOUT_MS = 2_000;

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
