// raccoon 供应商工厂：keyring 多号轮换 + 差异化冷却（quota 长冷、auth/限流/服务端短冷）+ 临期自动续期。
// 冷却档位与话术对齐 qoder/zcode 先例（ADR-0044 同款口径）：限流绝不谎报成积分不足。
import { compatFetch } from "../../compat.js";
import { envInt } from "../base.js";
import { createKeyRing } from "../keyring.js";
import { createStickyPicker } from "./sticky.js";
import { loadProviderKeys } from "../../state.js";
import { forwardRaccoonChat } from "./chat.js";
import { buildRaccoonModelList, listRaccoonModels, mergeRaccoonCatalogIntoAllowlist } from "./models.js";
import { applyRaccoonRefresh, listRaccoonAccountDocs, raccoonCredentialFromDoc, readRaccoonAccountDoc, syncRaccoonKeys, writeRaccoonAccountFile } from "./account-store.js";
import { refreshRaccoonCredential } from "./login.js";
import { isRaccoonExpiringSoon, raccoonTokenFingerprint } from "./auth.js";
import { RACCOON_DEFAULT_COOLDOWN_MS, RACCOON_DEFAULT_QUOTA_COOLDOWN_MS } from "./const.js";

/** kind → 冷却档位。auth 走短冷（重登指引已由响应体给出）；quota 走长冷（按天回血）。 */
const COOLDOWN_BY_KIND = { auth: "short", rate_limit: "short", server: "short", quota: "long" };

/** 会话粘号 TTL：允 0（=关，退回每次调用轮转），故不能用只收正数的 envInt。 */
function stickyMsFromEnv(env = process.env) {
  const raw = env?.MSLXDFF_RACCOON_STICKY_MS;
  if (raw === undefined || String(raw).trim() === "") return 1_800_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1_800_000;
}

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

  // 会话粘号：同一段对话（opts.sessionId）固定用同一个号，换会话才轮转到下一个号。
  // 为什么不是每次调用轮转：积分按号均摊靠「会话之间」轮换就够了，而同一会话逐轮换号会丢掉上游
  // 的 prompt 缓存亲和，也让排障时分不清「这个号到底好不好」。无会话标识时退回 reqId（同请求重试不换号）
  // 与纯轮转，行为与旧版一致。TTL 内每次命中续期；`MSLXDFF_RACCOON_STICKY_MS=0` 关掉退回逐调用轮转。
  const pickKey = createStickyPicker({
    pick: () => ring.next(),
    // 被 replace() 换掉的旧 token 已不在 ring 里 → 同样视为不可用，会话会前进到新号而不是粘住废 token
    isCooling: (k) => !ring.keys.includes(k) || ring.isCooling(k),
    ttlMs: stickyMsFromEnv(),
  });

  // access_token → 账号文档（office_identity / device_id / refresh_token 跟号走，取自 auths/raccoon-<uid>.json）
  // 缓存**可失效**：重登与续期都会换盘上的 token，只建一次会让本进程永远停在旧号（见 healKeyFromDocs）
  let docCache = null;
  function reloadDocs() {
    try {
      docCache = new Map(listRaccoonAccountDocs().map((d) => [d.accessToken, d]));
    } catch {
      docCache = new Map();
    }
    return docCache;
  }
  function accountFor(token) {
    if (docCache === null) reloadDocs();
    return docCache.get(token);
  }

  /**
   * 「内存号 ↔ 账号文档」对齐。daemon 只在启动时读一次 keys（providers-setup 显式传 apiKeys），重登换了盘上
   * token 后内存那份已被上游作废（code 200003）——用户重登也没用、只能重启，这里以文档为准当场换回来。
   * 返回换上的新 token；文档无可用新号（或候选号都在冷却）返回 null，交回既有失败路径。取舍见 ADR-0050。
   */
  async function healKeyFromDocs(staleToken) {
    const fresh = [...reloadDocs().values()].find((d) => d.accessToken && d.accessToken !== staleToken && !ring.isCooling(d.accessToken));
    if (!fresh) return null;
    ring.replace(staleToken, fresh.accessToken);
    console.error(`[raccoon] 内存 token(${raccoonTokenFingerprint(staleToken)}) 已不在账号文档里 → 换用文档号(${raccoonTokenFingerprint(fresh.accessToken)}) 并同步 keys`);
    try { await syncRaccoonKeys(file ? { file } : {}); } catch {}
    return fresh.accessToken;
  }

  function credentialFor(token) {
    // 映射的单一源在 account-store.raccoonCredentialFromDoc（曾各自内联，漏 expires_at 会让续期判定静默失效）
    return raccoonCredentialFromDoc(accountFor(token) || { accessToken: token });
  }

  // 同一 token 的并发续期必须合并成一次请求 —— refresh_token 是一次性轮换的（2026-10-10 实测：
  // 续期成功后旧值立刻失效），并发各刷各的等于自己把号烧了。姿势对齐 workbuddy/auth.js 的 inflightRefresh。
  const inflightRefresh = new Map();

  /** 临期即续期；续期成功把新 token 回写账号文档并替换 keyring 里的旧键。失败不阻断（让上游如实报）。 */
  async function ensureFresh(token, scope) {
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
          // 粘号表跟着换 token：否则该会话下一轮会认为旧 token 不可用而漂到别的号（同一账号被拆成两半）
          pickKey.remember(scope, next.access_token);
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
        // 不静默：续期失败会让该号在内存与盘上同时变旧，症状必须能在 daemon.log 里看见（只允许指纹）
        console.error(`[raccoon] 续期失败（继续用旧 token，过期即 401）token(${raccoonTokenFingerprint(token)}): ${String(e?.message || e).slice(0, 160)}`);
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
    // 会话优先：一段对话固定一个号（积分按会话轮换均摊）；没有会话标识时才退到「同请求粘号」
    const scope = opts?.sessionId ? `sess:${opts.sessionId}` : opts?.reqId ? `req:${opts.reqId}` : null;
    let lastRes = null;
    let healed = false; // 一次请求内只自愈一次：防重试风暴，也防「文档里那份同样不可用」时打旋
    for (let hop = 0; hop <= total + 1; hop++) {
      let pick = "rr";
      const key = pickKey(scope, (d) => { pick = d; });
      if (!key) break;
      if (pick !== "sticky" && pick !== "rr") {
        console.error(`[raccoon] 会话选号 pick=${pick} account=${raccoonTokenFingerprint(key)} ${scope || ""}`);
      }
      const credential = await ensureFresh(key, scope);
      const res = await forwardRaccoonChat({ body, credential, fetchImpl, timeoutMs, effort: opts?.effort ?? effort });
      const kind = res.headers.get("x-mslxdff-raccoon-kind");
      if (!kind) return res; // 成功或未分类：直接交出去
      lastRes = res;
      if (kind === "auth" && !healed) {
        healed = true;
        // 自愈成功就换号重试；不给失效号记冷却（ring.replace 也不把冷却带给新号）
        const healedKey = await healKeyFromDocs(key);
        if (healedKey) {
          pickKey.remember(scope, healedKey); // 本会话钉到救回来的号，别在下一轮又漂走
          continue;
        }
      }
      const mode = COOLDOWN_BY_KIND[kind] || "none";
      if (mode === "long") ring.onError(key, quotaCooldownMs);
      else if (mode === "short") ring.onError(key, cooldownMs);
      if (mode === "none") break; // 换号无意义，如实透出
      if (ring.available() === 0) break; // 没有别的可用号
    }
    if (lastRes) return lastRes;
    return allCoolingResponse();
  }

  let catalogMergeTried = false;
  async function listModels() {
    let token = ring.keys[0];
    // 内存号已不在文档里（重登换号）时先对齐，否则目录撞 401 后静默回落内置表，表现为「列表不是最新的」
    if (token && !accountFor(token)) token = (await healKeyFromDocs(token)) || token;
    if (!token) return [];
    const { models, source } = await listRaccoonModels({ credential: credentialFor(token), fetchImpl });
    // 上游目录是这家唯一真相（模型 id 全由上游定义、按账号下发）：每进程首次成功拉到就只增不减
    // 并入 allowlist，否则 dispatcher 会拿登录时播种的静态白名单把新上架模型（如 …-1017）挡掉。
    // 只在 source=upstream 时做：回落兜底表时并入的仍是静态 id，没有意义还会白写盘。
    if (source === "upstream" && !catalogMergeTried) {
      catalogMergeTried = true;
      try {
        const { added } = mergeRaccoonCatalogIntoAllowlist(models, file ? { file } : {});
        if (added.length) console.error(`[raccoon] 上游目录新模型并入白名单: ${added.join(", ")}`);
      } catch (e) {
        console.error(`[raccoon] 目录并入白名单失败（列表照常返回）: ${String(e?.message || e).slice(0, 160)}`);
      }
    }
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
