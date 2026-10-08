// qoder provider 门面（原生直连，零桥依赖）：
// 多号 = keys[] 里每条 device_token blob（auths/qoder-<uid>.json 落盘由 login 维护）；
// 选号 → 建会话 → COSY 签名直调上游；恒 local-only 不借 key。
// Note: 同请求粘号（一次客户端请求内复用同一个号，仅 401/403/429/5xx 冷却才换）与流式坏号冷却（真实状态码经内部头带出）— 见 .agents/notes/implemented/feature/2026-09-27-qoder-per-request-sticky-account.md
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
import { createStickyPicker } from "./sticky.js";
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
  sharedModelsSvc, // chatWithKeys 等临时门面复用主实例目录快照（评审路1 P1#3：冷缓存否则恒 false）
  cooldownMs = envInt("MSLXDFF_QODER_COOLDOWN_MS", 30_000),
  // 额度耗尽（code 110）按天重置：短冷却等于反复撞死号，故单独配长冷却（默认 1h）
  quotaCooldownMs = envInt("MSLXDFF_QODER_QUOTA_COOLDOWN_MS", 3600_000),
  // 排队（10605/isQueued）单独一档：队列没放行前反复送回就是白烧（实测跨小时不恢复），默认 5min。
  // 上游口播的 retryAfterSeconds=30 只当参考值，不当本档上限——按 30s 回池等于回到旧行为。
  queueCooldownMs = envInt("MSLXDFF_QODER_QUEUE_COOLDOWN_MS", 300_000),
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
  // 额度耗尽号集合（本次进程内）：全号在此集合 → 无可用号时回额度提示而非"无账号"401
  const exhaustedByQuota = new Set();
  if (!fetchImpl) fetchImpl = compatFetch;



  // 选号：同一客户端请求内粘住（重试不换号），只有该号被冷却（401/403/429/5xx）才换下一个；
  // 无 scope（拿不到 reqId，如独立的 models 探活）时退回原 round-robin。
  const pickKey = createStickyPicker({
    pick: () => ring.next() || keys[0] || "",
    isCooling: (k) => ring.isCooling(k),
    ttlMs: envInt("MSLXDFF_QODER_STICKY_MS", 600_000),
  });

  // 凭据 → 会话（会话含 RSA/AES 临时密钥，进程内可复用；此处按请求轻建，成本低）
  function pickSession(scope) {
    let decision = "new";
    const key = pickKey(scope, (d) => { decision = d; });
    // 全部号都在冷却时 pick() 只能兜底取 keys[0]：这是"被迫选择"，必须与正常轮转区分开
    if (ring.available() === 0) decision = "forced";
    const blob = accountFromBlob(key);
    if (!blob?.deviceToken) return null;
    const auth = authList.find((a) => String(a?.refreshToken || "") === String(blob.refreshToken || "")) || authList[0] || {};
    const region = normalizeRegion(region0 || auth.region || "global");
    const sess = buildSessionFor({ ...blob, uid: auth.uid, name: auth.name, region });
    // key/pick 带出：onError(key) 要冷却"刚用过的这个号"；pick 让日志能写"这次为什么是它"
    return { sess, region, key, pick: decision };
  }
  const region0 = region; // 构造参数优先

  const chatSvc = createChatService({
    id,
    fetchImpl,
    // 目录驱动请求（只读 peekModels 缓存，chat 路径恒 0 额外上游调用；preheat 负责灌缓存）
    getModelMeta: (sess2, reg, key) => {
      const list = modelsSvc.peekModels(reg);
      return list ? list.find((m) => m.id === `${id}/${key}` || m.id === key) || null : null;
    },
    timeoutMs: connectTimeoutMs,
  });
  // models 服务按号选区：构造时无固定 region，listModels(sess, region) 动态传
  const modelsSvc = sharedModelsSvc || createModelsService({ id, fetchImpl });

  // 失败冷却：401/403/429/5xx 冷却当前号（cooldownMs，默认 30s），坏号不再参与轮换。
  // 额度耗尽（quota）走长冷却（quotaCooldownMs，默认 1h）——额度按天重置，短冷却等于反复撞死号。
  // 额度错在 provider 内直接换号重发（不依赖外层空转重试链路：那条链路在非流式路径不触发）。
  // 收口只认「每个号都被上游明确判过额度」；排队/限流等非额度冷却不得谎称没额度
  // Note: 判定收紧（全号才报 quota_exhausted，其余如实返回/报冷却中）— 见 .agents/notes/implemented/bug-fix/2026-09-28-qoder-quota-cooldown-switch.md
  async function chat(body, opts) {
    // scope=reqId：同一次客户端请求的多次上游调用（空转重试）粘同一个号
    const scope = opts?.reqId ? `req:${opts.reqId}` : null;
    const stripped = { ...body };
    if (typeof stripped.model === "string" && stripped.model.startsWith("qoder/")) stripped.model = stripped.model.slice(6);
    const badAuth = (n) => n === 401 || n === 403 || n === 429 || n >= 500;
    const total = ring.keys.length;
    // 换号上限：每次 continue 必然冷却掉一个号，故最多 total 轮；超出即退出（收敛保证）
    let lastRes = null;
    for (let hop = 0; hop <= total; hop++) {
      const picked = pickSession(scope);
      if (!picked) break;
      const pickedKey = picked.key || "";
      // 该号额度已耗尽且仍在冷却 → 不再打上游（打也是同一堵墙）。另有可用号时继续换，不轻易断言全灭。
      if (exhaustedByQuota.has(pickedKey)) {
        if (ring.isCooling(pickedKey)) {
          if (ring.available() > 0) continue;
          break;
        }
        exhaustedByQuota.delete(pickedKey);
      }
      let res;
      try {
        res = await chatSvc.runChat(stripped, picked.sess, picked.region, picked.pick);
      } catch (e) {
        try { ring.onError(pickedKey); } catch {}
        throw e;
      }
      const st = res?.status ?? 0;
      // 流式路径把上游非 200 整形成 200 + 流内 error（对外契约），真实状态码只能从回显头取；
      // 否则坏号（401/403/429/5xx）永不冷却，粘号还会把重试继续粘在这个坏号上。
      const ust = Number(res?.headers?.get?.("x-mslxdff-qoder-upstream-status")) || 0;
      const isQuota = res?.headers?.get?.("x-mslxdff-qoder-quota") === "1";
      const isQueued = res?.headers?.get?.("x-mslxdff-qoder-queued") === "1";
      const bad = badAuth(st) ? st : (badAuth(ust) ? ust : 0);
      // 冷却三档：额度（按天重置，最长）> 排队（队列没放行前别再送回，默认 5min）> 其它（普通短冷却）。
      // 排队单独成档的依据：现网 31h 窗口 global 区 176 发被判决 129 发且跨小时不复现恢复，
      // 30s 短冷却等于每 30s 白烧一发；但它不是「今天没了」，到点必须自动回池，故不得并入额度档。
      if (bad) {
        const coolMs = isQuota ? quotaCooldownMs : (isQueued ? queueCooldownMs : cooldownMs);
        try { ring.onError(pickedKey, coolMs); } catch {}
        if (isQuota) exhaustedByQuota.add(pickedKey);
        // 冷却是个决定：钉在响应上，管线写进模型日志（cooled=<status>）
        try { res.headers?.set?.("x-mslxdff-qoder-cooldown", String(bad)); } catch {}
      }
      // 额度耗尽 / 排队：本号这一发已废，只要还有别的号就当场换号重发，别把空流或排队判决递给客户端。
      // （跨请求那侧不用改：长冷却让 sticky 下次因 isCooling 自动 switch。）
      if (isQuota || isQueued) {
        lastRes = res;
        if (ring.available() > 0) continue;
        break;
      }
      return res;
    }
    // 收口按「真实全景」分档，不得把「非额度冷却」误报成没额度：
    // 仅当每一个号都被上游明确判过额度，才是真的全号额度耗尽。
    if (total > 0 && ring.keys.every((k) => exhaustedByQuota.has(k))) return quotaExhaustedResponse();
    if (lastRes) return lastRes;               // 有上游响应 → 如实透出（含上游真错）
    if (!ring.available()) return allCoolingResponse(); // 全在冷却但非额度 → 冷却中提示
    return new Response(JSON.stringify({ error: { message: "qoder: 无可用账号 — 先跑 mslxdff -provider qoder login", type: "auth_error" } }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  // 额度耗尽提示（每一个号都被上游明确判过额度）：继续等只会更糟，让调用方立刻知道要换号/等明天
  function quotaExhaustedResponse() {
    return new Response(JSON.stringify({
      error: { message: "qoder: 所有账号额度已用完（Billing daily count exceeded），请更换账号或明日再试", type: "quota_exhausted" },
    }), { status: 429, headers: { "Content-Type": "application/json", "x-mslxdff-qoder-quota-exhausted": "1" } });
  }

  // 冷却中（非额度原因）：如实说"暂不可用"，不得声称额度耗尽
  function allCoolingResponse() {
    return new Response(JSON.stringify({
      error: { message: "qoder: 账号暂不可用（上游限流/排队冷却中），请稍后重试", type: "all_cooling" },
    }), { status: 429, headers: { "Content-Type": "application/json", "x-mslxdff-qoder-all-cooling": "1" } });
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
  async function chatWithKeys(body, keysOverride, opts) {
    const tmp = createQoderProvider({ id, apiKeys: keysOverride, file, fetchImpl, cooldownMs, queueCooldownMs, connectTimeoutMs, sharedModelsSvc: modelsSvc });
    return tmp.chat(body, opts);
  }

  return { id, chat, chatWithKeys, listModels, preheat, close, keyRing: ring, baseUrl: "qoder://native", region: normalizeRegion(region || authList[0]?.region) };
}