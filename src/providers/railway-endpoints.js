// railway 的多出口选路：同一套 zen 契约、不同出口 IP（免费额度按出口 IP 计 ⇒ 多份额度）。
// 缺省顺序固定为「新隧道（instabox）→ 原 railway 反代」——新出口先用，用完/挂掉即下沉到下一个。
//
// 失败分档（2026-10-25 用户裁决）：
//   429（额度被上游收走）      → 该出口长冷却 1 小时；本请求内出局，换另一个出口**不等待**
//   5xx / 连不上 / 超时        → 该出口短冷却 3s；本请求内**等 3s 再换另一个出口**（两侧轮流重试）
//   其它 4xx（400/401/403）    → 原样交回（换出口没用；FreeTierError / 模型不存在的终局判决靠它）
//   每出口最多试 N 次（缺省 2）→ 最多 4 发、最多等 3×3s = 9s，然后交回最后那条错误
//
// env：
//   MSLXDFF_RAILWAY_BASES                    —— 逗号分隔，**完整替换**出口列表（顺序=优先级）
//   MSLXDFF_RAILWAY_ENDPOINT_COOLDOWN_MS     —— 非 429 失败的出口短冷却（缺省 3000，0=不冷却）
//   MSLXDFF_RAILWAY_ENDPOINT_QUOTA_COOLDOWN_MS —— 429 的出口长冷却（缺省 3600000 = 1h）
//   MSLXDFF_RAILWAY_ENDPOINT_RETRY_DELAY_MS  —— 换出口前的等待（缺省 3000，0=不等待）
//   MSLXDFF_RAILWAY_ENDPOINT_ROUNDS          —— 每出口最多试几次（缺省 2）
//
// 纯逻辑模块：无 fs / 无 HTTP，便于单测（sleep 可注入）。
import { envInt } from "./base.js";

/** 新隧道出口（用户 2026-10-25 提供，缺省第一优先）。 */
export const INSTABOX_RAILWAY_BASE = "https://3000-agqxlhk7jgtegt4n5acnqyrndi.instabox.tech/ai-api";
/** 原 railway 反代出口（兜底）。 */
export const UPSTREAM_RAILWAY_BASE = "https://mytestip-production.up.railway.app/ai-api";
/** 缺省出口列表面（顺序=优先级）。 */
export const DEFAULT_RAILWAY_BASES = [INSTABOX_RAILWAY_BASE, UPSTREAM_RAILWAY_BASE];

export function normalizeBase(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

function dedupe(list) {
  const out = [];
  for (const item of list) {
    const u = normalizeBase(item);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** 各档时长/轮数的单一真相（显式入参 ＞ env ＞ 缺省）。 */
export function endpointTuning(overrides = {}) {
  const nums = {
    shortCooldownMs: overrides.shortCooldownMs ?? envInt("MSLXDFF_RAILWAY_ENDPOINT_COOLDOWN_MS", 3_000),
    quotaCooldownMs: overrides.quotaCooldownMs ?? envInt("MSLXDFF_RAILWAY_ENDPOINT_QUOTA_COOLDOWN_MS", 3_600_000),
    retryDelayMs: overrides.retryDelayMs ?? envInt("MSLXDFF_RAILWAY_ENDPOINT_RETRY_DELAY_MS", 3_000),
    rounds: Math.max(1, overrides.rounds ?? envInt("MSLXDFF_RAILWAY_ENDPOINT_ROUNDS", 2)),
  };
  return nums;
}

/**
 * 解析该供应商的出口列表（顺序 = 优先级）。
 * ① env `MSLXDFF_RAILWAY_BASES` —— 完整替换（运维逃生阀）
 * ② 显式 `baseUrl` 为数组 —— 完整替换；为字符串且**不在**缺省列表里 —— 该地址排第一 + 缺省列表兜底
 * ③ 字符串等于缺省之一（state 里的播种值、或用户显式指到缺省）—— 用缺省顺序（保证新出口仍优先）
 * ④ 都没有 —— 缺省顺序
 */
export function resolveRailwayBases({ baseUrl, env = process.env } = {}) {
  const fromEnv = dedupe(String(env?.MSLXDFF_RAILWAY_BASES ?? "").split(","));
  if (fromEnv.length) return fromEnv;
  if (Array.isArray(baseUrl)) {
    const list = dedupe(baseUrl);
    if (list.length) return list;
  }
  const one = normalizeBase(baseUrl);
  if (one) {
    if (DEFAULT_RAILWAY_BASES.includes(one)) return [...DEFAULT_RAILWAY_BASES];
    return dedupe([one, ...DEFAULT_RAILWAY_BASES]);
  }
  return [...DEFAULT_RAILWAY_BASES];
}

/** 额度耗尽（429）：换出口=换额度池，值得换、且该出口要歇很久。 */
export function isQuotaStatus(status) {
  return Number(status) === 429;
}

/**
 * 出口侧故障（5xx）：值得换出口。
 * 其余 4xx —— 400 参数错、401/403 身份与形状错 —— 换出口只会把同一堵墙撞两次，交回原样。
 */
export function isSwapWorthyStatus(status) {
  const s = Number(status);
  if (!Number.isFinite(s)) return false;
  return s >= 500 && s < 600;
}

/**
 * 出口冷却账：`order()` 把未冷却的按原相对顺序排前、冷却中的排后（全冷却时就是原顺序）。
 * 短冷却（非 429）与长冷却（429）共用一张截止时刻表，只是时长不同。
 */
export function createEndpointRing(
  bases,
  {
    cooldownMs = endpointTuning().shortCooldownMs,
    quotaCooldownMs = endpointTuning().quotaCooldownMs,
    clock = Date.now,
  } = {},
) {
  const list = dedupe(bases);
  const cooling = new Map(); // base -> 冷却截止时刻
  const isCooling = (base, now) => (cooling.get(normalizeBase(base)) || 0) > now;
  return {
    bases: [...list],
    cooldownMs,
    quotaCooldownMs,
    /** 当前尝试顺序（顺序=优先级，冷却者沉底但仍在列）。 */
    order() {
      const now = clock();
      const ready = [];
      const cooled = [];
      for (const b of list) (isCooling(b, now) ? cooled : ready).push(b);
      return [...ready, ...cooled];
    },
    cooldownUntil(base) { return cooling.get(normalizeBase(base)) || 0; },
    /** 出口侧故障（5xx/连不上）：短冷却，轮转几发后又会优先试它。 */
    noteExhausted(base) { cooling.set(normalizeBase(base), clock() + cooldownMs); },
    /** 额度耗尽（429）：长冷却（缺省 1 小时），期间不再排前。 */
    noteQuotaExhausted(base) { cooling.set(normalizeBase(base), clock() + quotaCooldownMs); },
    /** 出口可用：清冷却（额度回血后立刻恢复优先级）。 */
    noteOk(base) { cooling.delete(normalizeBase(base)); },
  };
}

const defaultSleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * 出口轮流重试编排（实际发请求由 `attempt` 注入）。
 *
 * 顺序 = A→B→A→B（每个出口最多 `rounds` 次机会），直到成功或用完机会：
 *   - `{kind:"ok", result}`    —— 成功，立刻返回（不再试别的出口）
 *   - `{kind:"quota", result}` —— 429：该出口本请求内出局 + `onQuota`（长冷却），换出口**不等待**
 *   - `{kind:"swap", ...}`     —— 5xx/连不上/超时：`onSwap`（短冷却），还有机会就**等 retryDelayMs** 换下一个
 *   - `{kind:"fatal", result}` —— 其它 4xx：立刻交回原响应，不冷却、不换出口
 *   - attempt 抛错视作 `swap`（连不上）
 *
 * 只有「确定放弃这一发、还要继续试」时才取消它的 body；**最后交回的那一发 body 保持完好**，
 * 上层（终局判决/错误文案）才能读到上游原文。
 */
export async function runEndpointRotation({
  bases,
  rounds = endpointTuning().rounds,
  retryDelayMs = endpointTuning().retryDelayMs,
  sleep = defaultSleep,
  attempt,
  onOk,
  onSwap,
  onQuota,
} = {}) {
  const list = Array.isArray(bases) ? bases.filter(Boolean) : [];
  if (!list.length || typeof attempt !== "function") return { kind: "none", err: new Error("railway: no endpoint available") };
  const totalRounds = Math.max(1, Number(rounds) || 1);
  const left = new Map(list.map((b) => [b, totalRounds]));
  let last = { kind: "none", err: new Error("railway: no endpoint available") };
  for (let round = 0; round < totalRounds; round++) {
    let progressed = false;
    for (const base of list) {
      if ((left.get(base) || 0) <= 0) continue;
      progressed = true;
      const remaining = [...left.values()].reduce((a, b) => a + b, 0);
      const isFinal = remaining <= 1;                    // 这是最后一次机会 → 结果必须原样带回
      let outcome;
      try {
        outcome = await attempt(base);
      } catch (err) {
        outcome = { kind: "swap", err };
      }
      const kind = outcome?.kind || "swap";
      if (kind === "ok") {
        onOk?.(base);
        return { kind: "ok", base, result: outcome.result };
      }
      if (kind === "fatal") return { kind: "fatal", base, result: outcome.result, err: outcome.err };
      // 失败（quota=429 / swap=5xx·连不上·超时）：先记账冷却（最后一发同样要记），再决定交回还是继续
      if (kind === "quota") onQuota?.(base);
      else onSwap?.(base);
      const record = { kind, base, result: outcome.result, err: outcome.err };
      if (isFinal) return record;                         // 最后一次机会：原样交回（body 不能动）
      // 还有后续机会：释放这一发的 body，再决定等不等
      try { await outcome.result?.body?.cancel?.(); } catch {}
      last = record;
      if (kind === "quota") {
        left.set(base, 0);                               // 额度耗尽：本请求内不再试它
        continue;                                        // 换出口不等待
      }
      left.set(base, (left.get(base) || 0) - 1);
      await sleep(retryDelayMs);                         // 其它失败：等一会再换另一个 URL
    }
    if (!progressed) break;
  }
  return last;
}