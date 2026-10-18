// 保热心跳（用户 2026-10-18 拍板）：每 ≤120s 主动访问一次「每个组员 + 每个在 picks 的上游供应商」，
// 保持连接热度，防「久未使用 → 首发 fetch failed / 上游冷启动 26s」。
//
// ⚠ 必须用**与 chat 完全相同的那条连接池**，否则白热（用户 2026-10-18 纠正）：
//   - 组员 → warmPeerHealth()（getPeerDispatcher，正是 peer 转发复用的池）；
//   - 供应商 → provider.preheat()（各家 preheat 经各自 agent/extDispatcher 打自己的 models 端点，
//     与 chat 同池：opencode 走 v6/warp 池、generic/custom 走各自 agent）。
//   绝不能裸 compatFetch / directProbe——那热的是全局池的 socket，真流量复用的是另一条，等于没热。
//
// 为什么需要它（现网取证 2026-10-18 16:16，req mvdjwol5-aysc）：三个组员同时 `fetch failed`（TCP 都没建立），
// 根因是两端 keep-alive 打架——服务端 Node 默认 5s 掐闲置连接，而组长 undici 池账面 30s 内以为 socket 还活着，
// 复用死 socket 即失败。已把服务端 keepAliveTimeout 提到 65s（server.js）治本；本心跳是**补强**：
// ① 间隔 120s < 家里 NAT/防火墙更短的空闲回收窗（很多路由 60~120s 就丢映射，单靠 65s keep-alive 挡不住）；
// ② 顺带让上游对我们出口保持"温热"（opencode 实测固定 session 1.2s、冷机器 26s+）。
//
// 零额度消耗（全部经各家 preheat：GET models / GET /health，不打 chat）。永不抛，只记事件。
import { warmPeerHealth } from "../routes/peers.js";

export function keepWarmIntervalMs(env = process.env) {
  const n = Number(env.MSLXDFF_KEEP_WARM_MS);
  return Number.isInteger(n) && n >= 0 ? n : 120_000; // 0 = 关闭
}

/**
 * 从 picks 里算出要保热的「供应商头」集合：裸 id（无 `/`）归 opencode（免费池）；带前缀取首段。
 * 只保留出现过的供应商，天然覆盖"每个在 picks 的接口"。opencode 恒排第一（免费池是主力、最该保热）。
 * @param {string[]} picks
 * @returns {string[]} 供应商 id 列表（含 "opencode"），已去重、opencode 置顶
 */
export function providerHeadsFromPicks(picks = []) {
  const heads = new Set();
  for (const id of picks) {
    const s = String(id || "").trim();
    if (!s) continue;
    heads.add(s.includes("/") ? s.slice(0, s.indexOf("/")) : "opencode");
  }
  const out = [...heads];
  if (out.includes("opencode")) return ["opencode", ...out.filter((h) => h !== "opencode")];
  return out;
}

/**
 * 单轮保热：组员各 warmPeerHealth、picks 供应商各 preheat。返回汇总（供事件取证）。绝不抛。
 * @param {{peers:{url:string}[], picks:string[], byId?:Map<string,{preheat?:Function}>, upstream?:{preheat?:Function},
 *          warmPeer?:Function, evt?:Function}} deps
 */
export async function warmOnce({
  peers = [],
  picks = [],
  byId = null,
  upstream = null,
  warmPeer = warmPeerHealth,
  evt = () => {},
} = {}) {
  const staticPeers = peers.filter((p) => p?.url && !String(p.url).startsWith("relay://")); // broadband 走 relay 队列，不直连
  let peerOk = 0, peerFail = 0;
  for (const p of staticPeers) {
    try {
      const r = await warmPeer(String(p.url));
      if (r?.ok) peerOk += 1; else peerFail += 1;
    } catch { peerFail += 1; }
  }
  const heads = providerHeadsFromPicks(picks);
  let provOk = 0, provFail = 0, provSkip = 0;
  for (const head of heads) {
    try {
      // 供应商预热一律走它自己的 preheat（chat 同池）。opencode 特判：**多 provider 装配**下
      // providers 数组里含 opencode，直接 byId 取；单 provider 模式下 byId 为空，退回 upstream.preheat。
      const inst = byId?.get?.(head);
      const preheat = inst?.preheat || (head === "opencode" ? upstream?.preheat : null);
      if (typeof preheat !== "function") { provSkip += 1; continue; } // 本地号型/无域名供应商：本就没有可保热的域
      const r = await preheat.call(inst || upstream);
      if (r?.ok) provOk += 1; else provFail += 1;
    } catch { provFail += 1; }
  }
  evt("keep-warm", { peers: staticPeers.length, peerOk, peerFail, providers: heads.length, provOk, provFail, provSkip });
  return { peers: staticPeers.length, peerOk, peerFail, providers: heads.length, provOk, provFail, provSkip };
}

/**
 * daemon 装配：起一个 unref 的定时器，每 keepWarmIntervalMs 跑一轮 warmOnce。
 * 关（=0）返回 null。依赖注入以便测试；生产用 setupProviders 的 ctx（providers/upstream/peers）。
 */
export function startKeepWarm({
  peers,
  providers = [],
  upstream,
  env = process.env,
  evt = () => {},
  logs,
  loadModelPicks,
  warmPeer = warmPeerHealth,
} = {}) {
  const interval = keepWarmIntervalMs(env);
  if (interval === 0) return null;
  const byId = new Map((providers || []).map((p) => [p.id, p]));
  const emit = (type, data) => {
    const entry = { ts: Date.now(), type, ...data };
    try { evt(type, data); } catch {}
    try { logs?.appendEvent?.(entry); } catch {}
  };
  const runTick = async () => {
    try {
      const picks = loadModelPicks ? loadModelPicks() : [];
      await warmOnce({
        peers: peers?.all?.() || [],
        picks: Array.isArray(picks) ? picks : [],
        byId,
        upstream,
        warmPeer,
        evt: emit,
      });
    } catch { /* 保热永不影响主链路 */ }
  };
  console.log(`[keep-warm] enabled: every ${Math.round(interval / 1000)}s 经 chat 同池访问每个组员(/health) + 每个 picks 供应商(preheat) 保热，设 MSLXDFF_KEEP_WARM_MS=0 关`);
  void runTick(); // 启动即热一次，别等第一个间隔
  const timer = setInterval(() => { void runTick(); }, interval);
  timer.unref?.();
  return { stop: () => clearInterval(timer), interval, tick: runTick };
}
