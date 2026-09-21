// qoder provider 门面（原生直连，零桥依赖）：
// 多号 = keys[] 里每条 device_token blob（auths/qoder-<uid>.json 落盘由 login 维护）；
// 每请求 round-robin 选号 → 建会话 → COSY 签名直调上游；恒 local-only 不借 key。
import { loadProviderKeys, loadProviderConfig } from "../../state.js";
import { listAccountDocs } from "./account-store.js";
import { defaultStateFile } from "../../state/store.js";
import { createKeyRing } from "../keyring.js";
import { envInt } from "../base.js";
import { accountFromBlob } from "./account-store.js";
import { normalizeRegion } from "./constants.js";
import { fingerprintSeed, deriveMachineId, deriveMachineToken, deriveMachineType } from "./fingerprint.js";
import { newSession } from "./session.js";
import { createChatService } from "./chat.js";
import { createModelsService } from "./models.js";
import { compatFetch } from "../../compat.js";

function buildSessionFor(cred) {
  const uid = cred.uid || cred.deviceToken.slice(0, 8);
  const seed = fingerprintSeed(uid, cred.deviceToken);
  const identity = {
    name: cred.name || "", aid: uid, uid, yxUid: "",
    organizationId: cred.organizationId || "", organizationName: cred.organizationName || "",
    userType: cred.userType || "personal_standard",
    securityOauthToken: cred.deviceToken, refreshToken: cred.refreshToken || "",
  };
  return newSession(identity, deriveMachineId(seed), deriveMachineToken(seed), deriveMachineType(seed));
}

export function createQoderProvider({
  id = "qoder",
  apiKeys,
  file,
  region,
  fetchImpl,
  cooldownMs = envInt("MSLXDFF_QODER_COOLDOWN_MS", 30_000),
  connectTimeoutMs = Number(process.env.MSLXDFF_QODER_TIMEOUT_MS) || 120_000,
} = {}) {
  const keys = (() => {
    if (Array.isArray(apiKeys) && apiKeys.length) return [...new Set(apiKeys.map((k) => String(k).trim()).filter(Boolean))];
    try { return loadProviderKeys(id, file ? { file } : {}); } catch { return []; }
  })();
  let authList = [];
  try { authList = loadProviderConfig(id, file ? { file } : {})?.auths || []; } catch {}
  // auths 行的 region 会被 state.normalizeAuths 剥掉：每号真实 region 从 auths/qoder-<uid>.json 读（单一源）
  try {
    const docs = listAccountDocs();
    for (const d of docs) {
      const row = authList.find((a) => String(a?.uid) === String(d.uid));
      if (row) row.region = d.doc?.auth?.region || "global";
      else authList.push({ uid: d.uid, refreshToken: d.doc?.auth?.refreshToken || "", region: d.doc?.auth?.region || "global", name: d.doc?.account?.name || "" });
    }
  } catch {}
  const ring = createKeyRing(keys, { cooldownMs });
  if (!fetchImpl) fetchImpl = compatFetch;



  // 凭据 → 会话（会话含 RSA/AES 临时密钥，进程内可复用；此处按请求轻建，成本低）
  function pickSession() {
    const key = ring.next() || keys[0] || "";
    const blob = accountFromBlob(key);
    if (!blob?.deviceToken) return null;
    const auth = authList.find((a) => String(a?.refreshToken || "") === String(blob.refreshToken || "")) || authList[0] || {};
    const region = normalizeRegion(region0 || auth.region || "global");
    const sess = buildSessionFor({ ...blob, uid: auth.uid, name: auth.name, region });
    return { sess, region };
  }
  const region0 = region; // 构造参数优先

  const chatSvc = createChatService({ id, fetchImpl, timeoutMs: connectTimeoutMs });
  // models 服务按号选区：构造时无固定 region，listModels(sess, region) 动态传
  const modelsSvc = createModelsService({ id, fetchImpl });

  async function chat(body) {
    const picked = pickSession();
    if (!picked) {
      return new Response(JSON.stringify({ error: { message: "qoder: 无可用账号 — 先跑 mslxdff -provider qoder login", type: "auth_error" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const stripped = { ...body };
    if (typeof stripped.model === "string" && stripped.model.startsWith("qoder/")) stripped.model = stripped.model.slice(6);
    return chatSvc.runChat(stripped, picked.sess, picked.region);
  }

  async function listModels() {
    const picked = pickSession();
    if (!picked) return [];
    try { return await modelsSvc.listModels(picked.sess, picked.region); } catch { return []; }
  }

  async function preheat() {
    try {
      const picked = pickSession();
      if (!picked) return { ok: false, error: "no account" };
      await modelsSvc.listModels(picked.sess, picked.region);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
  }

  async function close() {}
  async function chatWithKeys(body, keysOverride) {
    const tmp = createQoderProvider({ id, apiKeys: keysOverride, file, fetchImpl, cooldownMs, connectTimeoutMs });
    return tmp.chat(body);
  }

  return { id, chat, chatWithKeys, listModels, preheat, close, keyRing: ring, baseUrl: "qoder://native", region: normalizeRegion(region || authList[0]?.region) };
}