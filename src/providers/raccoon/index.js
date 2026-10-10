// raccoon 供应商工厂：keyring 多号轮换 + 差异化冷却（quota 长冷、auth/限流/服务端短冷）+ 临期自动续期。
// 冷却档位与话术对齐 qoder/zcode 先例（ADR-0044 同款口径）：限流绝不谎报成积分不足。
import { compatFetch } from "../../compat.js";
import { envInt } from "../base.js";
import { createKeyRing } from "../keyring.js";
import { loadProviderKeys } from "../../state.js";
import { forwardRaccoonChat } from "./chat.js";
import { buildRaccoonModelList, listRaccoonModels } from "./models.js";
import { applyRaccoonRefresh, listRaccoonAccountDocs, raccoonCredentialFromDoc, readRaccoonAccountDoc, syncRaccoonKeys, writeRaccoonAccountFile } from "./account-store.js";
import { refreshRaccoonCredential } from "./login.js";
import { isRaccoonExpiringSoon } from "./auth.js";
import { RACCOON_DEFAULT_COOLDOWN_MS, RACCOON_DEFAULT_QUOTA_COOLDOWN_MS } from "./const.js";

/** kind → 冷却档位。auth 走短冷（重登指引已由响应体给出）；quota 走长冷（按天回血）。 */
const COOLDOWN_BY_KIND = { auth: "short", rate_limit: "short", server: "short", quota: "long" };

function notLoggedInResponse() {
  return new Response(
    JSON.stringify({ error: { message: "raccoon: 无可用账号 —— 先运行 mslxdff -provider raccoon login", type: "auth_error" } }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

function allCoolingResponse() {
  return new Response(
    JSON.stringify({ error: { message: "raccoon: 账号暂不可用（冷却中，可能积分不足或限流），请稍后重试", type: "all_cooling" } }),
    { status: 429, headers: { "Content-Type": "application/json", "x-mslxdff-raccoon-all-cooling": "1" } },
  );
}

export function createRaccoonProvider({
  id = "raccoon",
  apiKeys,
  file,
  fetchImpl,
  cooldownMs = envInt("MSLXDFF_RACCOON_COOLDOWN_MS", RACCOON_DEFAULT_COOLDOWN_MS),
  quotaCooldownMs = envInt("MSLXDFF_RACCOON_QUOTA_COOLDOWN_MS", RACCOON_DEFAULT_QUOTA_COOLDOWN_MS),
  timeoutMs = Number(process.env.MSLXDFF_RACCOON_TIMEOUT_MS) || 300_000,
  effort,
} = {}) {
  if (!fetchImpl) fetchImpl = compatFetch;
  const explicitKeys = Array.isArray(apiKeys) && apiKeys.length;
  let keys = explicitKeys
    ? [...new Set(apiKeys.map((k) => String(k).trim()).filter(Boolean))]
    : (() => {
        try {
          return loadProviderKeys(id, file ? { file } : {});
        } catch {
          return [];
        }
      })();
  if (!explicitKeys) {
    // ⚠ 自愈：keys 一律以 auths/ 文档为准。续期只回写文档，两者一旦分叉，重启后 ring 拿的就是已过期
    //   token，症状是「明明登录过、积分还在，却恒 401 / 429 全号冷却」，只能重扫码。显式传 apiKeys 的
    //   调用方（chatWithKeys、单测）尊重入参，不覆盖。
    try {
      const fromDocs = [...new Set(listRaccoonAccountDocs().map((d) => String(d.accessToken || "").trim()).filter(Boolean))];
      if (fromDocs.length && fromDocs.join("\n") !== keys.join("\n")) {
        keys = fromDocs;
        syncRaccoonKeys({}).catch(() => {});
      }
    } catch {}
  }
  const ring = createKeyRing(keys, { cooldownMs });

  // access_token → 账号文档（office_identity / device_id / refresh_token 跟号走，取自 auths/raccoon-<uid>.json）
  let docCache = null;
  function accountFor(token) {
    if (docCache === null) {
      try {
        docCache = new Map(listRaccoonAccountDocs().map((d) => [d.accessToken, d]));
      } catch {
        docCache = new Map();
      }
    }
    return docCache.get(token);
  }

  function credentialFor(token) {
    // 映射的单一源在 account-store.raccoonCredentialFromDoc（曾各自内联，漏 expires_at 会让续期判定静默失效）
    return raccoonCredentialFromDoc(accountFor(token) || { accessToken: token });
  }

  // 同一 token 的并发续期必须合并成一次请求 —— refresh_token 是一次性轮换的（2026-10-10 实测：
  // 续期成功后旧值立刻失效），并发各刷各的等于自己把号烧了。姿势对齐 workbuddy/auth.js 的 inflightRefresh。
  const inflightRefresh = new Map();

  /** 临期即续期；续期成功把新 token 回写账号文档并替换 keyring 里的旧键。失败不阻断（让上游如实报）。 */
  async function ensureFresh(token) {
    const credential = credentialFor(token);
    if (!credential.refresh_token || !isRaccoonExpiringSoon(credential)) return credential;
    const pending = inflightRefresh.get(token);
    if (pending) return pending;
    const p = (async () => {
      try {
        const next = await refreshRaccoonCredential(credential, { fetchImpl });
        if (next.access_token !== token) {
          ring.replace(token, next.access_token);
          docCache?.delete(token);
        }
        // ⚠ 同 token 也必须刷新到期时间：否则 docCache 永远停在旧 expires_at，每个请求都会重复调一次 refresh
        docCache?.set(next.access_token, { ...credential, accessToken: next.access_token, refreshToken: next.refresh_token, expiresAt: next.expires_at || "" });
        try {
          if (credential.uid) {
            const existing = readRaccoonAccountDoc(credential.uid) || {}; const merged = applyRaccoonRefresh(existing.auth || {}, { accessToken: next.access_token, refreshToken: next.refresh_token, expiresAt: next.expires_at });
            writeRaccoonAccountFile({
              uid: credential.uid,
              accessToken: merged.access_token,
              refreshToken: merged.refresh_token,
              expiresAt: merged.expires_at || "",
              officeIdentity: credential.office_identity,
              deviceId: credential.device_id,
              name: existing.account?.name || "",
              phone: existing.account?.phone || "",
            });
            syncRaccoonKeys({}).catch(() => {}); // 文档里 token 换了，keys 必须跟上，否则重启即拿旧值撞 401
          }
        } catch (e) {
          // 绝不静默：内存里还能用，但进程一重启、盘上那份已作废的 refresh_token 就成了废号。
          console.error(`[raccoon] token 落盘失败（刷新已成功，重启将丢失）: ${String(e?.message || e).slice(0, 200)}`);
        }
        return next;
      } catch (e) {
        if (e?.authExpired) ring.onError(token, cooldownMs);
        return credential;
      } finally {
        inflightRefresh.delete(token);
      }
    })();
    inflightRefresh.set(token, p);
    return p;
  }

  async function chat(body, opts = {}) {
    const total = ring.keys.length;
    if (!total) return notLoggedInResponse();
    let lastRes = null;
    for (let hop = 0; hop <= total; hop++) {
      const key = ring.next();
      if (!key) break;
      const credential = await ensureFresh(key);
      const res = await forwardRaccoonChat({ body, credential, fetchImpl, timeoutMs, effort: opts?.effort ?? effort });
      const kind = res.headers.get("x-mslxdff-raccoon-kind");
      if (!kind) return res; // 成功或未分类：直接交出去
      const mode = COOLDOWN_BY_KIND[kind] || "none";
      if (mode === "long") ring.onError(key, quotaCooldownMs);
      else if (mode === "short") ring.onError(key, cooldownMs);
      lastRes = res;
      if (mode === "none") break; // 换号无意义，如实透出
      if (ring.available() === 0) break; // 没有别的可用号
    }
    if (lastRes) return lastRes;
    return allCoolingResponse();
  }

  async function listModels() {
    const token = ring.keys[0];
    if (!token) return [];
    const { models } = await listRaccoonModels({ credential: credentialFor(token), fetchImpl });
    return buildRaccoonModelList({ id, models });
  }

  async function preheat() {
    try {
      const list = await listModels();
      return list.length ? { ok: true } : { ok: false, error: "no catalog" };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 120) };
    }
  }

  async function close() {}

  async function chatWithKeys(body, keysOverride, opts) {
    const tmp = createRaccoonProvider({ id, apiKeys: keysOverride, file, fetchImpl, cooldownMs, quotaCooldownMs, timeoutMs, effort });
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
    baseUrl: "raccoon://native",
  };
}
