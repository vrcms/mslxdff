// globalqwenwork provider 门面：多号 keyring 轮转 + 401/403 refresh 重试 + 额度长冷却换号。
// 协议细节全部下沉到 cosy/upstream/payload/sse/stream；这里只做编排（对齐 qwenwork/index.js 形状）。
// vendor 自 src/providers/qwenwork/index.js，改动面 = 命名空间（id/env/响应头/提示语）+ 默认模型名，
// 中继逻辑逐字同构：实测国际站接受 cn 同款 COSY 签名与 chat body（2026-10-01 现网 200 出词）。
// Note: 为何独立 provider 而非 qwenwork 的新 region — 见 docs/adr/0041-globalqwenwork-international-provider.md
import { loadProviderKeys, loadProviderConfig } from "../../state.js";
import { listAccountDocs, accountFromBlob, updateGlobalQwenworkTokens } from "./account-store.js";
import { createKeyRing } from "../keyring.js";
import { envInt } from "../base.js";
import { compatFetch, timeoutSignal } from "../../compat.js";
import { joinModelId } from "../model-id.js";
import { buildBody, mapModel } from "./payload.js";
import { chatRequest, modelList, refreshDeviceToken, expiryUnix, userInfo } from "./upstream.js";
import { invalidateSession } from "./cosy.js";
import { collectSync, isCreditsExhausted, creditsExhaustedText } from "./sse.js";
import { transformStream } from "./stream.js";
import { KNOWN_MODELS, MODELS_CACHE_MS, CHAT_URL, CONTEXT_LENGTH, DEFAULT_MODEL } from "./constants.js";

const ID_PREFIX = "globalqwenwork/";

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return "-"; }
}

function errRes(status, msg, type = "upstream_error", extra = {}) {
  return new Response(JSON.stringify({ error: { message: msg, type } }), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

export function createGlobalQwenworkProvider({
  id = "globalqwenwork",
  apiKeys,
  file,
  fetchImpl,
  cooldownMs = envInt("MSLXDFF_GLOBALQWENWORK_COOLDOWN_MS", 30_000),
  quotaCooldownMs = envInt("MSLXDFF_GLOBALQWENWORK_QUOTA_COOLDOWN_MS", 3600_000),
  connectTimeoutMs = Number(process.env.MSLXDFF_GLOBALQWENWORK_TIMEOUT_MS) || 120_000,
} = {}) {
  // 单测隔离（MSLXDFF_TEST=1 / NODE_ENV=test / --test 进程）：state 与 auth 目录走测试替身，
  // 与你个人真实账号完全隔离（防止单测把真号读进来、把真 refreshToken 写回去）。
  // 教训继承自 qwenwork：构造传了 `apiKeys: []`，门面却从 state.json 读出真号 → 无号测试打了现网。
  const testIsolated = process.env.MSLXDFF_TEST === "1" || process.env.NODE_ENV === "test" || String(process.execArgv || []).includes("--test") || process.argv.slice(1).some((a) => String(a).includes("--test"));
  const keys = (() => {
    if (testIsolated && file === undefined && apiKeys !== undefined) {
      return [...new Set((Array.isArray(apiKeys) ? apiKeys : []).map((k) => String(k).trim()).filter(Boolean))];
    }
    if (Array.isArray(apiKeys) && apiKeys.length) return [...new Set(apiKeys.map((k) => String(k).trim()).filter(Boolean))];
    try { return loadProviderKeys(id, file ? { file } : {}); } catch { return []; }
  })();
  let authList = [];
  if (!testIsolated) {
  try { authList = loadProviderConfig(id, file ? { file } : {})?.auths || []; } catch {}
  try {
    const docs = listAccountDocs();
    for (const d of docs) {
      const row = authList.find((a) => String(a?.uid) === String(d.uid));
      if (!row) authList.push({ uid: d.uid, refreshToken: d.doc?.auth?.refreshToken || "", name: d.doc?.account?.name || "" });
    }
  } catch {}
  }
  const ring = createKeyRing(keys, { cooldownMs });
  const exhaustedByQuota = new Set();
  if (!fetchImpl) fetchImpl = compatFetch;
  const cdbg = (...a) => { if (process.env.GLOBALQWENWORK_DEBUG === "1") console.log("[globalqwenwork-chat]", ...a); };

  // blob → 上游 account（含 uid/nickname/email，供 COSY 身份 payload 用）
  function accountFor(key) {
    const blob = accountFromBlob(key);
    if (!blob?.accessToken) return null;
    const auth = authList.find((a) => String(a?.refreshToken || "") === String(blob.refreshToken || "")) || {};
    let doc = null;
    try {
      const docs = listAccountDocs();
      doc = docs.find((d) => String(d.uid) === String(auth.uid)) || docs.find((d) => d.doc?.auth?.refreshToken === blob.refreshToken) || null;
    } catch {}
    return {
      id: auth.uid || doc?.uid || "",
      uid: auth.uid || doc?.uid || "",
      nickname: auth.name || doc?.doc?.account?.name || "",
      email: doc?.doc?.account?.email || "",
      accessToken: blob.accessToken,
      refreshToken: blob.refreshToken || auth.refreshToken || doc?.doc?.auth?.refreshToken || "",
    };
  }

  function withEcho(res, account, upstreamStatus) {
    try {
      res.headers.set("x-mslxdff-upstream", hostOf(CHAT_URL));
      if (account?.uid) res.headers.set("x-mslxdff-globalqwenwork-account", String(account.uid).slice(-8));
      if (upstreamStatus) res.headers.set("x-mslxdff-globalqwenwork-upstream-status", String(upstreamStatus));
    } catch {}
    return res;
  }
  function withQuota(res) {
    try { res.headers.set("x-mslxdff-globalqwenwork-quota", "1"); } catch {}
    return res;
  }

  async function tryRefresh(account) {
    if (!account?.refreshToken) return false;
    try {
      // 实测 .ai 的 /api/v1/deviceToken/refresh 接受 cn 原形状 {refresh_token}（200，且轮换 refresh_token）
      const data = await refreshDeviceToken(account.refreshToken, fetchImpl);
      const access = data.token || data.device_token;
      const refresh = data.refresh_token || account.refreshToken;
      const expiresAt = expiryUnix(data);
      account.accessToken = access;
      account.refreshToken = refresh;
      try { await updateGlobalQwenworkTokens({ uid: account.uid, accessToken: access, refreshToken: refresh, expiresAt, file }); }
      catch { invalidateSession(account); }
      // 同步 ring 里的 blob（token 轮换后旧 blob 即失效）
      try {
        const oldKey = ring.keys.find((k) => { const b = accountFromBlob(k); return b && b.refreshToken === data.refresh_token; }) || null;
        const newBlob = JSON.stringify({ device_token: access, refresh_token: refresh });
        const cur = ring.keys.find((k) => accountFromBlob(k)?.accessToken === account.accessToken);
        if (cur) ring.replace(cur, newBlob);
        else if (oldKey) ring.replace(oldKey, newBlob);
      } catch {}
      return true;
    } catch (e) {
      cdbg(`[refresh-fail] uid=${String(account.uid).slice(-8)} ${String(e?.message || e).slice(0, 160)}`);
      return false;
    }
  }

  async function chat(body, opts) {
    const stream = body?.stream !== false;
    const wantModel = typeof body?.model === "string" && body.model.startsWith(ID_PREFIX)
      ? body.model.slice(ID_PREFIX.length)
      : (body?.model || DEFAULT_MODEL);
    const modelKey = mapModel(wantModel);
    const stripped = { ...body, model: wantModel };
    const total = ring.keys.length;
    // 构造参数无号但 auth 目录有号：不视为"无号"，直接按 401 引导 login——调用方先 login 落盘再 chat
    if (!total) {
      return errRes(401, "globalqwenwork: 无可用账号 — 先跑 mslxdff -provider globalqwenwork login", "auth_error");
    }
    let lastRes = null;
    const refreshed = new Set();
    for (let hop = 0; hop <= total; hop++) {
      const key = ring.next();
      if (!key) break;
      if (exhaustedByQuota.has(key)) {
        if (ring.isCooling(key)) {
          if (ring.available() > 0) continue;
          break;
        }
        exhaustedByQuota.delete(key);
      }
      let account = accountFor(key);
      if (!account) { try { ring.onError(key); } catch {} continue; }
      // 身份缺失（手动配 key、未走 login）时补一次 userinfo：COSY 身份 payload 的 uid/name/email 为空
      // 会被上游判 `code 101 Signature invalid`（cn 实测同 token 空身份 403、有身份 200；.ai 同构）。
      if (!account.uid) {
        try {
          const info = await userInfo(account.accessToken, fetchImpl);
          if (info?.id) account.uid = String(info.id);
          if (info?.name) account.nickname = String(info.name);
          if (info?.email) account.email = String(info.email);
          if (account.uid) {
            try {
              const { saveGlobalQwenworkAccount } = await import("./account-store.js");
              await saveGlobalQwenworkAccount({ uid: account.uid, accessToken: account.accessToken, refreshToken: account.refreshToken || "", name: account.nickname || "", email: account.email || "", file });
            } catch {}
          }
        } catch (e) {
          cdbg(`[identity-enrich-fail] ${String(e?.message || e).slice(0, 160)}`);
        }
        if (!account.uid) { try { ring.onError(key); } catch {} lastRes = withEcho(errRes(401, "globalqwenwork: 账号身份缺失且 userinfo 失败，该 key 不可用", "auth_error"), account, 401); continue; }
      }
      const bodyStr = buildBody(stripped, modelKey);
      let upRes;
      try {
        upRes = await chatRequest(account, modelKey, bodyStr, timeoutSignal(connectTimeoutMs), fetchImpl);
      } catch (e) {
        try { ring.onError(key); } catch {}
        lastRes = withEcho(errRes(502, `globalqwenwork: 上游连接失败 ${String(e?.message || e).slice(0, 200)}`), account, 502);
        continue;
      }
      if (!upRes.ok) {
        const text = await upRes.text().catch(() => "");
        const quota = isCreditsExhausted(upRes.status, text);
        if (quota) {
          try { ring.onError(key, quotaCooldownMs); } catch {}
          exhaustedByQuota.add(key);
          lastRes = withQuota(withEcho(errRes(429, `globalqwenwork: 账号积分耗尽 ${text.slice(0, 200)}`, "quota_exhausted"), account, upRes.status));
          if (ring.available() > 0) continue;
          break;
        }
        if ((upRes.status === 401 || upRes.status === 403) && account.refreshToken && !refreshed.has(key)) {
          refreshed.add(key);
          const ok = await tryRefresh(account);
          if (ok) { hop -= 1; continue; }
          try { ring.onError(key); } catch {}
          lastRes = withEcho(errRes(upRes.status, `globalqwenwork: 授权失效 ${text.slice(0, 200)}`, "auth_error"), account, upRes.status);
          continue;
        }
        try { ring.onError(key); } catch {}
        lastRes = withEcho(errRes(upRes.status >= 500 ? 502 : upRes.status, `globalqwenwork: 上游 ${upRes.status} ${text.slice(0, 200)}`), account, upRes.status);
        if (ring.available() > 0 && (upRes.status === 429 || upRes.status >= 500)) continue;
        return lastRes;
      }
      // 200：流内仍可能裹着业务错（信封 statusCodeValue / code），非流式聚合时由 collectSync 判决；
      // 流式路径照 transform 透传（错误帧由 sse.handleLine 转成流内 error 事件）。
      if (stream) {
        const out = new Response(transformStream(upRes.body, wantModel, () => {}), {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
        return withEcho(out, account, 0);
      }
      const result = await collectSync(upRes.body, wantModel);
      if (result.error) {
        if (creditsExhaustedText(result.error)) {
          try { ring.onError(key, quotaCooldownMs); } catch {}
          exhaustedByQuota.add(key);
          lastRes = withQuota(withEcho(errRes(429, `globalqwenwork: 账号积分耗尽 ${result.error}`, "quota_exhausted"), account, 429));
          if (ring.available() > 0) continue;
          break;
        }
        try { ring.onError(key); } catch {}
        lastRes = withEcho(errRes(502, `globalqwenwork: 上游流内错误 ${result.error}`), account, 502);
        continue;
      }
      const completion = result.completion;
      completion.model = wantModel;
      return withEcho(new Response(JSON.stringify(completion), { status: 200, headers: { "Content-Type": "application/json" } }), account, 0);
    }
    if (total > 0 && ring.keys.every((k) => exhaustedByQuota.has(k))) {
      return errRes(429, "globalqwenwork: 所有账号积分已用完，请更换账号或等待额度恢复", "quota_exhausted", { "x-mslxdff-globalqwenwork-quota-exhausted": "1" });
    }
    if (lastRes) return lastRes;
    if (!ring.available()) {
      return errRes(429, "globalqwenwork: 账号暂不可用（上游限流/排队冷却中），请稍后重试", "all_cooling", { "x-mslxdff-globalqwenwork-all-cooling": "1" });
    }
    return errRes(401, "globalqwenwork: 无可用账号 — 先跑 mslxdff -provider globalqwenwork login", "auth_error");
  }

  // 全号聚合：逐号拉 qwork 切片求并集（国际站实测该切片 2 个模型，多号互相印证）
  let cache = null;
  let fetchedAt = 0;
  function eachAccount() {
    const out = [];
    const seen = new Set();
    const push = (key, auth) => {
      const account = accountFor(key);
      if (!account?.accessToken || seen.has(account.accessToken)) return;
      seen.add(account.accessToken);
      out.push(account);
    };
    for (const k of keys) {
      const blob = accountFromBlob(k);
      if (!blob?.accessToken) continue;
      const auth = authList.find((a) => String(a?.refreshToken || "") === String(blob.refreshToken || "")) || {};
      push(k, auth);
    }
    if (!out.length) {
      try {
        for (const { uid, doc } of listAccountDocs()) {
          const a = doc?.auth || {};
          if (!a.accessToken) continue;
          const account = { id: uid, uid, nickname: doc?.account?.name || "", email: doc?.account?.email || "", accessToken: a.accessToken, refreshToken: a.refreshToken || "" };
          if (seen.has(account.accessToken)) continue;
          seen.add(account.accessToken);
          out.push(account);
        }
      } catch {}
    }
    return out;
  }

  async function listModels() {
    const now = Date.now();
    if (cache && now - fetchedAt < MODELS_CACHE_MS) return cache;
    const accounts = eachAccount();
    if (!accounts.length) return [];
    const seen = new Set();
    const out = [];
    for (const account of accounts) {
      try {
        const list = await modelList(account, fetchImpl);
        for (const m of list) {
          if (!m?.key || seen.has(m.key)) continue;
          seen.add(m.key);
          out.push({
            id: joinModelId(id, m.key),
            object: "model",
            created: 1790000000,
            owned_by: "globalqwenwork",
            name: m.name || m.key,
            context_length: m.maxInputTokens || CONTEXT_LENGTH,
            price_factor: m.priceFactor || 0,
            is_reasoning: !!m.isReasoning,
          });
        }
      } catch {}
    }
    if (out.length) { cache = out; fetchedAt = now; }
    // 取数失败时用实测快照兜底（国际站 qwork 切片恒为 2 个，不会空）
    if (!out.length && !cache) {
      return KNOWN_MODELS.map((m) => ({
        id: joinModelId(id, m.key),
        object: "model",
        created: 1790000000,
        owned_by: "globalqwenwork",
        name: m.name,
        context_length: CONTEXT_LENGTH,
        price_factor: m.priceFactor,
        is_reasoning: false,
      }));
    }
    return out.length ? out : (cache || []);
  }

  async function preheat() {
    try {
      const list = await listModels();
      return list.length ? { ok: true } : { ok: false, error: "no account" };
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
  }

  async function close() {}
  async function chatWithKeys(body, keysOverride, opts) {
    const tmp = createGlobalQwenworkProvider({ id, apiKeys: keysOverride, file, fetchImpl, cooldownMs, quotaCooldownMs, connectTimeoutMs });
    return tmp.chat(body, opts);
  }

  return { id, chat, chatWithKeys, listModels, preheat, close, keyRing: ring, baseUrl: "globalqwenwork://native" };
}
