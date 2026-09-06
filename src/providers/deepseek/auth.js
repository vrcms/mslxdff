// DeepSeek 账号池 + 登录（Android 协议）
// 上游协议参考 iidamie/deepseek2api（GPL-3.0，协议事实）
import { compatFetch } from "../../compat.js";
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
export function createAuthPool({ tokens = [], cooldownMs = DEFAULT_COOLDOWN_MS, clock = Date.now } = {}) {
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

  return { next, onError, available, requireToken, size: list.length, cooldownMs, keys: [...list] };
}
