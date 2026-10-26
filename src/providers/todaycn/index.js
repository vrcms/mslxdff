// todaycn（Today AI · 今日工作助手）供应商工厂：
//   多号轮换（keyring 多枚 refreshCredential）+ 分档冷却 + 目录（pricing/status 的 modelOptions）
//   + 模型位（账号级，故按「号↔模型」绑定：能切就切，切不了就换号）。
//
// 冷却分档（kind 由 chat.js 经内部头交回）：
//   auth → 长冷却（号失效，refresh 也失败）           quota → 长冷却（限流/额度，按日重置口径）
//   empty → 中冷却 + **当场换号**（发出去但超时无 final：本号此刻不出话，Today 特有的一类）
//   server/network → 短冷却；param/unknown → 不冷却（换号无意义，如实透出）

import { compatFetch } from "../../compat.js";
import { envInt } from "../base.js";
import { createKeyRing } from "../keyring.js";
import { loadProviderKeys } from "../../state.js";
import { createTokenStore } from "./token.js";
import { createModelsService, parseModelStatus } from "./models.js";
import { buildHeaders, forwardTodaycnChat, TODAYCN_ACCOUNT_HEADER, TODAYCN_KIND_HEADER } from "./chat.js";
import { listTodaycnAccountDocs, setTodaycnAccountOption } from "./account-store.js";
import {
  TODAYCN_API_BASE,
  TODAYCN_DEFAULT_OPTION,
  TODAYCN_DEFAULT_DEVICE_ID,
  TODAYCN_POLL_INTERVAL_MS,
  TODAYCN_POLL_TIMEOUT_MS,
  toPlatformOptionId,
} from "./const.js";

const COOLDOWN_BY_KIND = { auth: "long", quota: "long", empty: "empty", server: "short", network: "short" };

function jsonRes(status, payload, extra = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...extra } });
}

export function createTodaycnProvider({
  id = "todaycn",
  apiKeys,
  file,
  fetchImpl,
  cooldownMs = envInt("MSLXDFF_TODAYCN_COOLDOWN_MS", 30_000),
  quotaCooldownMs = envInt("MSLXDFF_TODAYCN_QUOTA_COOLDOWN_MS", 3_600_000),
  emptyCooldownMs = envInt("MSLXDFF_TODAYCN_EMPTY_COOLDOWN_MS", 120_000),
  pollIntervalMs = envInt("MSLXDFF_TODAYCN_POLL_INTERVAL_MS", TODAYCN_POLL_INTERVAL_MS),
  pollTimeoutMs = envInt("MSLXDFF_TODAYCN_POLL_TIMEOUT_MS", TODAYCN_POLL_TIMEOUT_MS),
  apiBase = TODAYCN_API_BASE,
  switchModel = process.env.MSLXDFF_TODAYCN_SWITCH_MODEL !== "0",
} = {}) {
  const keys = (() => {
    if (Array.isArray(apiKeys) && apiKeys.length) return [...new Set(apiKeys.map((k) => String(k).trim()).filter(Boolean))];
    try { return loadProviderKeys(id, file ? { file } : {}); } catch { return []; }
  })();
  const ring = createKeyRing(keys, { cooldownMs });
  const tokenStore = createTokenStore({ fetchImpl });
  // 切模型位的串行队列：同号并发请求不能同时改账号级设置（改串行，避免互相踩）
  const switchLocks = new Map();

  function accountFor(credential) {
    try {
      const hit = listTodaycnAccountDocs().find((d) => d.refreshCredential === credential);
      return hit || null;
    } catch {
      return null;
    }
  }

  /** 404 说明账号文档缺 uid；此时仍可发（uid 只用于回显/记账）。 */
  function identityFor(credential) {
    const acct = accountFor(credential);
    return { uid: acct?.uid || "", deviceId: acct?.deviceId || "", optionId: acct?.optionId || "" };
  }

  async function callApi(path, { method = "GET", token, body } = {}) {
    const call = fetchImpl || compatFetch;
    const res = await call(`${apiBase}${path}`, {
      method,
      headers: {
        ...buildHeaders(token, ""),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }

  const modelsSvc = createModelsService({
    id,
    hasAccount: () => ring.keys.length > 0,
    loadOptions: async () => {
      const seen = new Map(); // optionId → option（多号并集：谁有哪个模型谁顶上）
      for (const key of ring.keys) {
        try {
          const tok = await tokenStore.getToken(key);
          if (!tok.ok) continue;
          const r = await callApi("/v1/pricing/status", { token: tok.token });
          if (r.status !== 200) continue;
          for (const o of parseModelStatus(r.json).options) if (!seen.has(o.optionId)) seen.set(o.optionId, o);
        } catch {}
      }
      return [...seen.values()];
    },
  });

  /**
   * 让本号处于请求的模型位：已是目标位直接通过；否则切设置（账号级、控制面免费）。
   * 切不动（400）说明该号没有这个模型 → 交调用方换号。
   */
  async function ensureOption(credential, want, current) {
    if (!want || want === current) return { ok: true, switched: false };
    if (!switchModel) return { ok: false, reason: "MSLXDFF_TODAYCN_SWITCH_MODEL=0 且本号未绑定该模型" };
    const prev = switchLocks.get(credential) || Promise.resolve();
    const task = prev.then(async () => {
      const tok = await tokenStore.getToken(credential);
      if (!tok.ok) return { ok: false, reason: `令牌获取失败（${tok.reason}）` };
      const r = await callApi("/v1/pricing/model-option", { method: "PUT", token: tok.token, body: { optionId: want } });
      if (r.status === 200) {
        const acct = accountFor(credential);
        if (acct?.uid) { try { await setTodaycnAccountOption({ uid: acct.uid, optionId: want }); } catch {} }
        return { ok: true, switched: true };
      }
      return { ok: false, reason: `切模型位失败 ${r.status} ${String(r.text || "").slice(0, 120)}`, status: r.status };
    });
    switchLocks.set(credential, task.catch(() => {}));
    return task;
  }

  async function chat(body, opts = {}) {
    if (!ring.keys.length) {
      return jsonRes(401, { error: { message: "todaycn: 无可用账号 —— 先运行 mslxdff -provider todaycn login", type: "auth_error" } });
    }
    const want = toPlatformOptionId(String(body?.model || "").replace(/^todaycn\//, "")) || TODAYCN_DEFAULT_OPTION;
    const total = ring.keys.length;
    let lastRes = null;
    for (let hop = 0; hop <= total; hop += 1) {
      const key = ring.next();
      if (!key) break;
      const cx = identityFor(key);
      const bind = await ensureOption(key, want, cx.optionId);
      if (!bind.ok) {
        lastRes = jsonRes(400, { error: { message: `todaycn: ${bind.reason}`, type: "model_unavailable" } }, { "x-mslxdff-todaycn-model-unavailable": want });
        continue; // 该号没有这个模型：换号，不冷却
      }
      const res = await forwardTodaycnChat({
        body,
        credential: key,
        uid: cx.uid,
        deviceId: cx.deviceId || TODAYCN_DEFAULT_DEVICE_ID,
        tokenStore,
        fetchImpl,
        pollIntervalMs,
        pollTimeoutMs,
        contentMaxChars: envInt("MSLXDFF_TODAYCN_MAX_CHARS", 120_000),
      });
      const kind = res.headers.get(TODAYCN_KIND_HEADER);
      if (!kind) return res; // 成功（或非可冷却错误）
      const mode = COOLDOWN_BY_KIND[kind] || "none";
      if (mode === "long") ring.onError(key, quotaCooldownMs);
      else if (mode === "empty") ring.onError(key, emptyCooldownMs);
      else if (mode === "short") ring.onError(key, cooldownMs);
      lastRes = res;
      if (opts?.onAttempt) { try { opts.onAttempt({ credential: key, kind, uid: cx.uid }); } catch {} }
      if (mode === "none") break;
      if (ring.available() === 0) break;
    }
    if (lastRes) return lastRes;
    return jsonRes(429, { error: { message: "todaycn: 账号暂不可用（冷却中，可能额度用尽或限流），请稍后重试", type: "all_cooling" } }, { "x-mslxdff-todaycn-all-cooling": "1" });
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
    const tmp = createTodaycnProvider({ id, apiKeys: keysOverride, file, fetchImpl, cooldownMs, quotaCooldownMs, emptyCooldownMs, pollIntervalMs, pollTimeoutMs, apiBase, switchModel });
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
    tokenStore,
    baseUrl: "todaycn://native",
    // 测试/CLI 用：账号与号↔模型绑定的读出入口
    accounts: () => ring.keys.map((k) => ({ credential: k, ...identityFor(k) })),
    _accountHeader: TODAYCN_ACCOUNT_HEADER,
  };
}