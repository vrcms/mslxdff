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

   // 全号聚合：双号分属 cn/global 两区，模型表各不同（cn 14 个/global 15 个）；
   // 只取单号会漏另一区（如轮询到 global 就看不到 cn 独有的 q37fmodel/gm51model）。
   // 按 id 并集去重，只返回 enable=true 的可调用模型（过滤已下沉到 models.js）。
   function eachCred() {
     const out = [];
     const seen = new Set();
     const push = (blob, auth) => {
       if (!blob?.deviceToken || seen.has(blob.deviceToken)) return;
       seen.add(blob.deviceToken);
       out.push({ blob, auth: auth || {} });
     };
     for (const k of keys) {
       const blob = accountFromBlob(k);
       if (!blob?.deviceToken) continue;
       const auth = authList.find((a) => String(a?.refreshToken || "") === String(blob.refreshToken || "")) || authList[0] || {};
       push(blob, auth);
     }
     if (!out.length) {
       // keys 为空但 auth 目录有号（如 state 被外部改写）：从落盘 doc 合成凭据，目录不断即可出列表
       try {
         for (const { uid, doc } of listAccountDocs()) {
           const a = doc?.auth || {};
           if (!a.deviceToken) continue;
           push({ deviceToken: a.deviceToken, refreshToken: a.refreshToken || "" },
             { uid, name: doc?.account?.name || "", region: a.region || "global", refreshToken: a.refreshToken || "" });
         }
       } catch {}
     }
     return out;
   }
 
   async function listModels() {
     const creds = eachCred();
     if (!creds.length) return [];
     const seen = new Set();
     const out = [];
     for (const { blob, auth } of creds) {
       const region = normalizeRegion(region0 || auth.region || "global");
       const sess = buildSessionFor({ ...blob, uid: auth.uid, name: auth.name, region });
       try {
         const list = await modelsSvc.listModels(sess, region);
         for (const m of list) {
           if (!m?.id || seen.has(m.id)) continue;
           seen.add(m.id);
           out.push(m);
         }
       } catch {}
     }
     return out;
   }
 
   async function preheat() {
     try {
       const list = await listModels();
       return list.length ? { ok: true } : { ok: false, error: "no account" };
     } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
   }

  async function close() {}
  async function chatWithKeys(body, keysOverride) {
    const tmp = createQoderProvider({ id, apiKeys: keysOverride, file, fetchImpl, cooldownMs, connectTimeoutMs });
    return tmp.chat(body);
  }

  return { id, chat, chatWithKeys, listModels, preheat, close, keyRing: ring, baseUrl: "qoder://native", region: normalizeRegion(region || authList[0]?.region) };
}