// traework provider 门面：薄聚合（读 state keys/auths，无则扫 auth 目录）。
import { createKeyRing } from "../keyring.js";
import { loadProviderKeys, loadProviderAuths, loadProviderBaseUrl } from "../../state.js";
import { compatFetch, getUndici } from "../../compat.js";
import { envInt, createAgent } from "../base.js";
import { AGENT_HOST } from "./constants.js";
import { listAccountDocs } from "./account-store.js";
import { createChatService } from "./chat.js";
import { createModelsService } from "./models.js";

const { UndiciFetch } = getUndici();

function resolveBaseUrl(baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  try {
    const env = loadProviderBaseUrl("traework");
    if (env) return env;
  } catch {}
  return AGENT_HOST;
}

export function createTraeworkProvider({
  id = "traework",
  baseUrl,
  apiKeys,
  apiKey,
  auths,
  connectTimeoutMs = Number(process.env.MSLXDFF_TRAEWORK_TIMEOUT_MS) || 30_000,
  cooldownMs = envInt("MSLXDFF_TRAEWORK_COOLDOWN_MS", 30_000),
  fetchImpl,
  file,
  clock = Date.now,
} = {}) {
  if (id !== "traework") throw new Error(`traework provider id mismatch: ${id}`);
  const resolvedBase = resolveBaseUrl(baseUrl);
  if (!fetchImpl) fetchImpl = UndiciFetch || compatFetch;

  const keysFromState = (() => { try { return loadProviderKeys(id, file ? { file } : {}); } catch { return []; } })();
  const authsFromState = (() => { try { return loadProviderAuths(id, file ? { file } : {}); } catch { return []; } })();
  const keys = (() => {
    const list = [
      ...(Array.isArray(apiKeys) ? apiKeys : [apiKeys].filter(Boolean)),
      apiKey,
      ...(apiKeys === undefined && apiKey === undefined ? keysFromState : []),
    ].filter((k) => typeof k === "string" && k.trim().length);
    return [...new Set(list.map((k) => k.trim()))];
  })();
  let authList = Array.isArray(auths) && auths.length ? [...auths] : [...authsFromState];

  if (!authList.length && !keys.length) {
    try {
      for (const { uid, doc } of listAccountDocs()) {
        const at = doc?.auth?.accessToken || doc?.accessToken;
        if (at && !keys.includes(at)) keys.push(at);
        authList.push({
          uid,
          domain: doc?.auth?.domain || "trae.cn",
          apiHost: doc?.auth?.apiHost || "",
          machineId: doc?.auth?.machineId || "",
          deviceId: doc?.auth?.deviceId || "",
          enterpriseId: doc?.account?.enterpriseId || "",
          refreshToken: doc?.auth?.refreshToken || "",
          expiresAt: doc?.auth?.expiresAt || 0,
          nickname: doc?.account?.nickname || "",
        });
      }
    } catch {}
  }
  // auths 行自带 refreshToken 但无 accessToken（login 后 keys 与 auths 平行）；
  // keys 与 authList 不配对（如 state 被外部改写）→ 从 auth 目录按 uid 补齐 accessToken，防 ring 空
  if (authList.length && keys.length !== authList.length) {
    try {
      const docs = new Map(listAccountDocs().map((d) => [String(d.uid), d.doc]));
      authList.forEach((a, i) => {
        const at = docs.get(String(a.uid))?.auth?.accessToken;
        if (at && !keys.includes(at)) keys[i] = at;
      });
    } catch {}
  }

  const ring = createKeyRing(keys, { cooldownMs, now: clock });
  let agent = null; let dispatcher = null;
  try {
    const a = createAgent({
      keepAliveTimeout: envInt("MSLXDFF_TRAEWORK_KEEPALIVE_TIMEOUT", 30_000),
      keepAliveMaxTimeout: envInt("MSLXDFF_TRAEWORK_KEEPALIVE_MAX_TIMEOUT", 60_000),
      connections: envInt("MSLXDFF_TRAEWORK_KEEPALIVE_CONNECTIONS", 20),
    });
    agent = a.agent; dispatcher = a.dispatcher;
  } catch {}

  function getKey() { return ring.next() || keys[0] || ""; }
  function getAuth(k) {
    const idx = keys.indexOf(k);
    if (idx >= 0 && authList[idx]) return authList[idx];
    if (authList.length) return authList[0];
    return { uid: "", accessToken: k || "", refreshToken: "", expiresAt: 0, domain: "trae.cn", apiHost: "", machineId: "", deviceId: "" };
  }

  const chatSvc = createChatService({ id, baseUrl: resolvedBase, keys, authList, ring, fetchImpl, dispatcher, connectTimeoutMs, file, clock, cooldownMs });
  const modelsSvc = createModelsService({ id, baseUrl: resolvedBase, fetchImpl, getKey, getAuth, clock });

  async function chat(body, opts = {}) { return chatSvc.runChat(body, ring, opts); }

  async function chatWithKeys(body, keysOverride) {
    const tmpKeys = [...keysOverride].filter((k) => typeof k === "string" && k.trim().length).map((k) => k.trim());
    const tmpAuth = authList[0] || getAuth("");
    const tmpAuthList = tmpKeys.map(() => tmpAuth);
    const tmpRing = createKeyRing(tmpKeys, { cooldownMs, now: clock });
    const tmpSvc = createChatService({ id, baseUrl: resolvedBase, keys: tmpKeys, authList: tmpAuthList, ring: tmpRing, fetchImpl, dispatcher: null, connectTimeoutMs, file, clock, cooldownMs });
    return tmpSvc.runChat(body, tmpRing);
  }

  async function close() { if (agent && typeof agent.close === "function") { try { await agent.close(); } catch {} } }

  return { id, chat, chatWithKeys, listModels: modelsSvc.listModels, preheat: modelsSvc.preheat, close, agent, keyRing: ring, baseUrl: resolvedBase };
}

export { mapModel, normalizeModelName, staticModels } from "./models.js";
export { soloHeaders, ugHeaders, oauthHeaders } from "./headers.js";
export { prepareBody } from "./payload.js";
export { classify, ErrKind } from "./errors.js";
