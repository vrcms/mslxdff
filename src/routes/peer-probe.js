// 组员「打一个 hi」探针：备选时打一次、轮到它时再打一次，回不来就当它不行。
//
// 为什么要打 hi 而不是 /health：额度只体现在真实 chat 调用上。实测（2026-10-20，本机出口已知 429）
//   GET /health 与 GET /zen/v1/models **都照样 200**，只有 POST chat 才回 429 FreeUsageLimitError。
// 为什么要挑在「备选」和「轮到」两个时刻：
//   备选是上一次切换时定的，中间上一个节点可能已在大 body 上撞墙几十秒（实测 1.5MB 撞 429 要
//   28~62s），那时有额度不代表现在还有 ⇒ 轮到它时必须再确认一次。
// 开销：hi + max_tokens=8，拿响应头即掐断，不等正文，也不触发对端空轮重试。
import { compatFetch, timeoutSignal } from "../compat.js";
import { buildShareKeysHeader, SHARE_KEYS_HEADER } from "../providers/share-keys.js";

// 等 hi 的上限。超时按「没判过」处理（交主流程照常试），绝不因为探针慢就错杀一个能用的节点。
export function peerProbeTimeoutMs(env = process.env) {
  const n = Number(env.MSLXDFF_PEER_PROBE_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 10_000;
}

/**
 * 给一个组员打一句 hi，只关心它活不活。
 * @returns {Promise<{ok: boolean, status: number, ms: number, unknown?: boolean}>} 永不抛
 *   ok=false 只在「明确不该再试」时给：拿到 4xx/5xx 响应。
 *   连不上/超时一律 ok=true + unknown=true（那是主流程 forwardToPeer 的账，探针不越权判死）。
 */
export async function probePeer(peer, { model, timeoutMs = peerProbeTimeoutMs(), dispatcher, fetchImpl = compatFetch } = {}) {
  const t0 = Date.now();
  if (!peer?.url || !model) return { ok: true, status: 0, ms: 0, unknown: true };
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${peer.token || ""}`,
    "x-mslxdff-hops": "1",
    "x-mslxdff-model-lock": model,
    // 探针必须可识别：组员侧据此知道这是「体检」不是真实业务（不落 usage、不参与空轮重试），
    // 日志/测试也能把它与真实转发分开，否则「一次请求打了几次组员」这类断言会被探针污染。
    "x-mslxdff-probe": "1",
    "Accept": "text/event-stream",
  };
  const share = buildShareKeysHeader(model);
  if (share) headers[SHARE_KEYS_HEADER] = share;
  try {
    const res = await fetchImpl(`${String(peer.url).replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, stream: true, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
      signal: timeoutSignal(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    });
    // 拿到响应头就够判了：立刻掐断，不等正文
    try { const c = res.body?.cancel?.(); if (c && typeof c.catch === "function") c.catch(() => {}); } catch {}
    return { ok: res.status < 400, status: res.status, ms: Date.now() - t0 };
  } catch {
    return { ok: true, status: 0, ms: Date.now() - t0, unknown: true };
  }
}
