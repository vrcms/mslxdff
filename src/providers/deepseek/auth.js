// DeepSeek 账号池 + 登录（Android 协议）
// 上游协议参考 iidamie/deepseek2api（GPL-3.0，协议事实）
// 并发闸门参考 Chat2API-WXS per-account guard：每 token 在途限 1，全忙 FIFO 排队，流结束释放
import { compatFetch } from "../../compat.js";
import { envInt } from "../base.js";
import { androidHeaders } from "./pow.js";
import { DEEPSEEK_DEFAULT_BASE, DEEPSEEK_API_PREFIX } from "./pow.js";
import { dsDebug } from "./debug.js";

export { androidHeaders };

const DEFAULT_COOLDOWN_MS = 30_000;
// 差异化冷却（防禁言体系）：频率前兆 60s（TQZHR 重试间隔同量级）、禁言 5min；防同号轰炸拖成禁言
export const COOLDOWN_PRESETS = Object.freeze({ default: DEFAULT_COOLDOWN_MS, frequency: 60_000, muted: 300_000 });

function isEmail(v) {
  return String(v || "").includes("@");
}

export async function loginDeepseek({ loginValue, password, areaCode = "+86", fetchImpl, dispatcher, baseUrl = DEEPSEEK_DEFAULT_BASE, connectTimeoutMs = 30_000 } = {}) {
  const doFetch = fetchImpl || compatFetch;
  const email = isEmail(loginValue);
  const payload = {
    email: email ? String(loginValue).trim() : "",
    mobile: email ? "" : String(loginValue).trim(),
    area_code: email ? "" : areaCode,
    password: String(password ?? ""),
    device_id: "mslxdff",
    os: "android",
  };
  const url = `${String(baseUrl).replace(/\/+$/, "")}${DEEPSEEK_API_PREFIX}/users/login`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("DeepSeek 登录超时")), connectTimeoutMs);
  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: androidHeaders(null),
      body: JSON.stringify(payload),
      ...(dispatcher ? { dispatcher } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`DeepSeek 登录失败: ${String(err?.message || err)}`);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch {}
  const biz = data?.data;
  const bizCode = biz?.biz_code ?? data?.code;
  if (!res.ok || bizCode !== 0 || !biz?.biz_data?.user?.token) {
    const msg = biz?.biz_msg || data?.msg || (biz?.biz_data?.user ? "响应缺少 token" : "登录响应格式错误");
    throw new Error(`DeepSeek 登录失败: ${msg}${res.ok ? "" : ` (http ${res.status})`}`);
  }
  return { token: biz.biz_data.user.token, userId: biz.biz_data.user.id };
}

// 多账号轮换池：空闲最久优先 + 冷却 + onError；轮换语义对齐 NIyueeE/ds-free-api（选空闲最久者，最大化每次使用间隔）
export function createAuthPool({ tokens = [], cooldownMs = DEFAULT_COOLDOWN_MS, clock = Date.now, maxConcurrentPerToken: maxConcParam } = {}) {
  const list = [...new Set((tokens || []).map((t) => String(t).trim()).filter(Boolean))];
  const until = new Map(); // token → 冷却到期时刻
  const lastUsedAt = new Map(); // token → 最近一次被取用时刻（空闲最久排序依据）

  function isCooling(token) {
    const u = until.get(token);
    return u != null && clock() < u;
  }

  // 空闲最久优先：平局按 list 顺序（与 round-robin 常规场景兼容，间隔拉开时倾向复用久未用号）
  function next() {
    if (!list.length) return null;
    let best = null;
    let bestIdle = -1;
    for (const token of list) {
      if (isCooling(token)) continue;
      const idle = clock() - (lastUsedAt.get(token) || 0);
      if (idle > bestIdle) {
        bestIdle = idle;
        best = token;
      }
    }
    if (best) lastUsedAt.set(best, clock());
    return best;
  }

  // cooldownMsOverride 可覆盖池默认（frequency/muted 走差异化冷却）
  function onError(token, { cooldownMs: cooldownMsOverride } = {}) {
    if (!list.includes(token)) return;
    const ms = Number(cooldownMsOverride) > 0 ? Number(cooldownMsOverride) : cooldownMs;
    until.set(token, clock() + ms);
    dsDebug("auth", { event: "rotate", tokenTail: String(token).slice(-6), cooldownMs: ms, cooling: list.length - available(), total: list.length });
  }

  function available() {
    return list.filter((t) => !isCooling(t)).length;
  }

  function requireToken() {
    const token = next();
    if (!token) {
      const err = new Error(list.length
        ? `DeepSeek: 所有账号都在冷却中（${list.length} 个），稍后再试或 -provider deepseek login 追加`
        : "缺少 DeepSeek 凭据，请先 -provider deepseek login 或设置 providerConfigs.deepseek.keys");
      err._deepseekNoAuth = true;
      throw err;
    }
    return token;
  }

  // ---------------------------------------------------------------------------
  // 并发闸门：每 token 最多 maxConcurrentPerToken 个在途请求（默认 1 = 禁止并发）
  // acquireSlot → { token, release } | null(超时)；release 幂等，流式在 cleanup 链释放
  // ---------------------------------------------------------------------------
  const maxConcurrentPerToken = Math.max(1, Number(maxConcParam) > 0 ? Number(maxConcParam) : envInt("MSLXDFF_DEEPSEEK_MAX_CONCURRENT", 1));
  const inFlight = new Map(); // token → 在途数
  const waiters = []; // FIFO 等待队列：{ resolve, timer }

  function inflightOf(token) {
    return inFlight.get(token) || 0;
  }

  // 空闲（未冷却且在途未满）的号里选空闲最久者；无 → null
  function nextIdle() {
    let best = null;
    let bestIdle = -1;
    for (const token of list) {
      if (isCooling(token) || inflightOf(token) >= maxConcurrentPerToken) continue;
      const idle = clock() - (lastUsedAt.get(token) || 0);
      if (idle > bestIdle) {
        bestIdle = idle;
        best = token;
      }
    }
    return best;
  }

  function makeRelease(token) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight.set(token, Math.max(0, inflightOf(token) - 1));
      dsDebug("gate", { event: "release", tokenTail: String(token).slice(-6), inFlight: inflightOf(token) });
      wakeNext();
    };
  }

  // 有槽位释放 → 唤醒队首等待者重新竞争（重新走 nextIdle，天然跳过冷却/满载号）
  function wakeNext() {
    while (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      const token = nextIdle();
      if (!token) { waiters.unshift(w); break; } // 没有可用槽位，塞回队首等下次 release
      lastUsedAt.set(token, clock());
      inFlight.set(token, inflightOf(token) + 1);
      dsDebug("gate", { event: "wakeup", tokenTail: String(token).slice(-6), queue: waiters.length });
      w.resolve({ token, release: makeRelease(token) });
    }
  }

  async function acquireSlot({ timeoutMs } = {}) {
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : envInt("MSLXDFF_DEEPSEEK_QUEUE_TIMEOUT_MS", 30_000);
    const token = nextIdle();
    if (token) {
      lastUsedAt.set(token, clock());
      inFlight.set(token, inflightOf(token) + 1);
      dsDebug("gate", { event: "acquire-direct", tokenTail: String(token).slice(-6), inFlight: inflightOf(token) });
      return { token, release: makeRelease(token) };
    }
    if (!list.length) {
      const err = new Error("缺少 DeepSeek 凭据，请先 -provider deepseek login 或设置 providerConfigs.deepseek.keys");
      err._deepseekNoAuth = true;
      throw err;
    }
    // 全忙：入 FIFO 队列等待 release 唤醒；超时返回 null。
    // 定时器不 unref：有请求在排队 = 有未完成工作，事件循环必须等它（unref 会让进程提前退出）
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        dsDebug("gate", { event: "acquire-timeout", queue: waiters.length });
        resolve(null);
      }, timeout);
      const w = { resolve, timer };
      waiters.push(w);
      dsDebug("gate", { event: "enqueue", queue: waiters.length, timeoutMs: timeout });
    });
  }

  return { next, onError, available, requireToken, acquireSlot, maxConcurrentPerToken, size: list.length, cooldownMs, keys: [...list] };
}
