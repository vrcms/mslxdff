// zcode 供应商工厂：keyring 多号轮换 + 差异化冷却（auth/限流/服务端=短冷却、1005=长冷却、3007/参数=不冷却）。
import { compatFetch } from "../../compat.js";
import { envInt } from "../base.js";
import { createKeyRing } from "../keyring.js";
import { loadProviderKeys } from "../../state.js";
import { createModelsService } from "./models.js";
import { forwardZcodeChat } from "./chat.js";
import { fetchZcodeBalance } from "./quota.js";
import { listZcodeAccountDocs } from "./account-store.js";

// 冷却策略：auth/限流/服务端/网络=短冷却；quota=长冷却（按日重置）；security/param/unknown=不冷却（换号无意义）
const COOLDOWN_BY_KIND = { auth: "short", rate_limit: "short", server: "short", network: "short", quota: "long" };

function notLoggedInResponse() {
  return new Response(
    JSON.stringify({ error: { message: "zcode: 无可用账号 —— 先运行 mslxdff -provider zcode login", type: "auth_error" } }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

function allCoolingResponse() {
  return new Response(
    JSON.stringify({ error: { message: "zcode: 账号暂不可用（冷却中，可能额度用尽或限流），请稍后重试", type: "all_cooling" } }),
    { status: 429, headers: { "Content-Type": "application/json", "x-mslxdff-zcode-all-cooling": "1" } },
  );
}

export function createZcodeProvider({
  id = "zcode",
  apiKeys,
  file,
  fetchImpl,
  cooldownMs = envInt("MSLXDFF_ZCODE_COOLDOWN_MS", 30_000),
  quotaCooldownMs = envInt("MSLXDFF_ZCODE_QUOTA_COOLDOWN_MS", 3_600_000),
  timeoutMs = Number(process.env.MSLXDFF_ZCODE_TIMEOUT_MS) || 120_000,
} = {}) {
  if (!fetchImpl) fetchImpl = compatFetch;
  const keys = (() => {
    if (Array.isArray(apiKeys) && apiKeys.length) return [...new Set(apiKeys.map((k) => String(k).trim()).filter(Boolean))];
    try {
      return loadProviderKeys(id, file ? { file } : {});
    } catch {
      return [];
    }
  })();
  const ring = createKeyRing(keys, { cooldownMs });

  // JWT → deviceMid 映射（设备身份跟账号走，取自 auths/zcode-<uid>.json）
  let midCache = null;
  function deviceMidFor(key) {
    if (midCache === null) {
      try {
        midCache = new Map(listZcodeAccountDocs().map((d) => [d.jwt, d.deviceMid]));
      } catch {
        midCache = new Map();
      }
    }
    return midCache.get(key) || "";
  }

  const modelsSvc = createModelsService({
    id,
    hasAccount: () => ring.keys.length > 0,
    // balance capabilities 探测：entitlement 名 → canonical 目录交集（失败/空 → 服务回退全量目录）
    probe: async () => {
      const token = ring.keys[0];
      if (!token) return [];
      const r = await fetchZcodeBalance({ token, deviceMid: deviceMidFor(token), fetchImpl });
      return r.ok ? r.modelIds : [];
    },
  });

  async function chat(body, opts = {}) {
    const total = ring.keys.length;
    if (!total) return notLoggedInResponse();
    let lastRes = null;
    for (let hop = 0; hop <= total; hop++) {
      const key = ring.next();
      if (!key) break;
      const res = await forwardZcodeChat({ body, token: key, deviceMid: deviceMidFor(key), fetchImpl, timeoutMs });
      const kind = res.headers.get("x-mslxdff-zcode-kind");
      if (!kind) return res;
      const mode = COOLDOWN_BY_KIND[kind] || "none";
      if (mode === "long") ring.onError(key, quotaCooldownMs);
      else if (mode === "short") ring.onError(key, cooldownMs);
      lastRes = res;
      if (mode === "none") break; // security/param/unknown：换号无意义，如实透出
      if (ring.available() === 0) break; // 没有别的可用号
    }
    if (lastRes) return lastRes;
    return allCoolingResponse();
  }

  async function listModels() {
    return modelsSvc.listModels();
  }

  async function preheat() {
    try {
      const list = await modelsSvc.listModels();
      return list.length ? { ok: true } : { ok: false, error: "no catalog" };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 120) };
    }
  }

  async function close() {}

  async function chatWithKeys(body, keysOverride, opts) {
    const tmp = createZcodeProvider({ id, apiKeys: keysOverride, file, fetchImpl, cooldownMs, quotaCooldownMs, timeoutMs });
    return tmp.chat(body, opts);
  }

  return {
    id,
    chat,
    chatWithKeys,
    listModels,
    preheat,
    close,
    keyRing: ring,
    baseUrl: "zcode://native",
  };
}
