// v6pool · 出口对照测试：回答「这台 VPS 的 IPv4 出口撞 429 时，换成 IPv6 出口还有没有额度」。
//
// 这才是 v6 池的**唯一价值判据**：opencode 免费层按**出口 IP** 计额。若本机 IPv4 已耗尽
// （打上游回 429 FreeUsageLimitError），而某个 IPv6 出口还能 200 ⇒ 池有用（换 IP 换到新额度）；
// 若 IPv6 出口也 429 ⇒ 要么上游按别的东西计额（账号/session），要么该段没真路由出去。
//
// 对照纪律：**除"源地址"外一切相同** —— 同 URL、同 UA、同模型、同 `stream:true`+五核心工具
// （否则会 403 FreeTierError 而非 429，测出来的不是额度）；差异只允许来自"哪个源地址出网"。
// 判定复用 `warp-pool/verdict.js` 的 classifyWarpSignal（与生产换址判决同源，不自造一套）。
//
// IO 全部注入（agentFactory/fetch/detect/claimer），零真机依赖，可单测。
import { getUndici, timeoutSignal } from "../compat.js";
import { classifyWarpSignal } from "../warp-pool/verdict.js";
import { opencodeUa } from "../opencode-identity.js";
import { CORE_AGENT_TOOL_NAMES } from "../free-lane.js";
import { detectPool } from "./detect.js";
import { resolveV6Config } from "./config.js";
import { createClaimer } from "./claim.js";
import { randomAddress, parsePrefix, hostBitsOf } from "./prefix.js";

/** 采样上限：抽查，不扫全段。 */
export const V6TEST_MAX = 64;
export const V6TEST_DEFAULT = 6;

/** 默认探测模型：免费池里最有代表性、额度最容易耗的一个。 */
export const DEFAULT_PROBE_MODEL = "deepseek-v4.1-flash-free";

/** 免费层请求体形状（stream:true + 五核心工具名），缺了会 403 而非 429 ⇒ 测不出额度。 */
export function freeLaneBody(model, prompt = "hi") {
  return {
    model,
    stream: true,
    max_tokens: 16,
    messages: [{ role: "user", content: prompt }],
    tools: CORE_AGENT_TOOL_NAMES.map((name) => ({
      type: "function",
      function: { name, description: `The ${name} tool.`, parameters: { type: "object", properties: {} } },
    })),
  };
}

/** 读响应正文（有上界，失败给空串——不读就无法判决 403/429 的具名类名）。 */
async function readBody(res, max = 2048) {
  try {
    const t = await res.text();
    return t.slice(0, max);
  } catch {
    return "";
  }
}

/**
 * 从某个源地址打一次免费层 chat，返回判决。
 * `addr=""` 表示**直连**（走本机默认路由 = IPv4 出口，或双栈默认）。
 * @returns {Promise<{addr, ok, status, kind, rotate, ms, body, error}>}
 */
export async function probeUpstreamFrom({ addr = "", model, baseUrl = "https://opencode.ai", agentFactory, fetchImpl, timeoutMs = 20_000, prompt } = {}) {
  const t0 = Date.now();
  let agent = null;
  try {
    agent = addr ? agentFactory(addr) : null; // 直连：不注入 dispatcher，走系统默认出口
    const f = fetchImpl || getUndici().fetch;
    const res = await f(`${baseUrl}/zen/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": opencodeUa(), Accept: "text/event-stream" },
      body: JSON.stringify(freeLaneBody(model, prompt)),
      ...(agent ? { dispatcher: agent } : {}),
      signal: timeoutSignal(timeoutMs),
    });
    const body = await readBody(res);
    const v = classifyWarpSignal({ status: res.status, text: body });
    return { addr, ok: res.status >= 200 && res.status < 300, status: res.status, kind: v.kind, rotate: v.rotate, ms: Date.now() - t0, body };
  } catch (e) {
    return { addr, ok: false, status: 0, kind: "network", rotate: true, ms: Date.now() - t0, body: "", error: String(e?.message || e) };
  } finally {
    if (agent) { try { await agent.close?.(); } catch { /* 一次性 Agent */ } }
  }
}

/**
 * 跑一次出口对照测试。返回结构化结果，由 CLI 渲染（本模块不打印）。
 *
 * @param {{ env?: object, count?: number, model?: string, baseUrl?: string,
 *           onProgress?: (ev: object) => void,
 *           deps?: { detect?, claimer?, agentFactory?, fetchImpl?, probe?, randomAddress? } }} opts
 */
export async function runV6PoolCompare({
  env = process.env,
  count = V6TEST_DEFAULT,
  model = DEFAULT_PROBE_MODEL,
  baseUrl = "https://opencode.ai",
  onProgress,
  deps = {},
} = {}) {
  const cfg = resolveV6Config(env);
  const tick = (ev) => { try { onProgress?.(ev); } catch { /* 渲染出错不打断测试 */ } };

  const detect = deps.detect || detectPool;
  const d = detect({ cfg, env });
  if (!d.ok) return { status: "skip", reason: d.reason, hint: d.hint };
  const prefix = parsePrefix(`${d.prefix}`);
  if (!prefix) return { status: "skip", reason: `前缀解析失败：${d.prefix}`, hint: "用 MSLXDFF_V6_PREFIX=<段>/<位数> 显式指定" };

  const { Agent } = getUndici();
  const agentFactory = deps.agentFactory || ((addr) => new Agent({ connect: { localAddress: addr }, connections: 1, keepAliveTimeout: 5_000 }));
  const probe = deps.probe || probeUpstreamFrom;
  const pick = deps.randomAddress || ((p) => randomAddress(p));

  // ① 基准：直连（IPv4 / 系统默认出口），记下它的额度状态作为对照基线
  tick({ phase: "baseline-start", prefix: d.prefix, model });
  const baseline = await probe({ addr: "", model, baseUrl, agentFactory, fetchImpl: deps.fetchImpl });
  tick({ phase: "baseline-done", ...baseline });

  // ② IPv6 池采样：每个随机源地址打同一条请求
  const n = Math.max(1, Math.min(V6TEST_MAX, Number(count) || V6TEST_DEFAULT));
  const claimer = deps.claimer ? deps.claimer(d, cfg) : createClaimer({ iface: d.iface, mode: d.mode, dir: cfg.dir });
  const mineSet = new Set(d.mine || []);
  const v6 = [];
  try {
    for (let i = 0; i < n; i++) {
      let addr = pick(prefix);
      for (let k = 0; k < 16 && mineSet.has(addr); k++) addr = pick(prefix);
      await claimer.ensure(addr);
      tick({ phase: "v6-start", i: i + 1, n, addr });
      const r = await probe({ addr, model, baseUrl, agentFactory, fetchImpl: deps.fetchImpl });
      v6.push(r);
      tick({ phase: "v6-done", i: i + 1, n, ...r });
    }
  } finally {
    try { await claimer.releaseAll(); } catch { /* 释放失败交给下次 sweepStale */ }
  }

  // ③ 判语：对照基线
  const baseLimited = baseline.status === 429 || baseline.kind === "free-quota" || baseline.kind === "free-tier" || baseline.kind === "ip-limit";
  const v6Ok = v6.filter((r) => r.ok);
  const v6Limited = v6.filter((r) => r.status === 429);
  const v6Net = v6.filter((r) => !r.status);

  let verdict;
  const allOk = v6Ok.length === v6.length && v6.length > 0;
  if (allOk) verdict = "v6-works";                                  // 全部 v6 出口都有额度
  else if (v6Limited.length === v6.length) verdict = "v6-also-limited"; // 全部 429 ⇒ 没换到新额度
  else if (v6Net.length === v6.length) verdict = "v6-unreachable";  // 全部够不着 ⇒ 段没路由过来
  else verdict = "mixed";                                           // 有的成有的不成

  return {
    status: "ok",
    prefix: d.prefix, iface: d.iface, mode: d.mode, hostBits: hostBitsOf(prefix.bits), model, baseUrl,
    baseline, baseLimited,
    v6, requested: n,
    v6OkCount: v6Ok.length, v6LimitedCount: v6Limited.length, v6NetCount: v6Net.length,
    verdict,
  };
}
