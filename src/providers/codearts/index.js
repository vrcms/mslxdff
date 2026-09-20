// codearts 供应商工厂：注册表入口（registry.js → createCodeartsProvider）。
// key = 凭证 blob（JSON 字符串，一华为账号一条，见 auth-pool.js）；多账号 keyring 自动轮转。
import { createKeyRing } from "../keyring.js";
import { loadProviderKeys, loadProviderBaseUrl, saveProviderConfig } from "../../state.js";
import { getUndici, createAgent, envInt, collectApiKeysGeneric } from "../base.js";
import { compatFetch } from "../../compat.js";
import { logDir } from "../../logs.js";
import { join } from "node:path";
import { SNAP_BASE, MODELS_CACHE_TTL_MS } from "./const.js";
import { createAuthPool } from "./auth-pool.js";
import { createCatalog, discoverAccountModels } from "./models.js";
import { createChatService } from "./chat.js";

const { UndiciFetch } = getUndici();

function resolveBaseUrl(baseUrl) {
  if (baseUrl) return String(baseUrl).trim().replace(/\/+$/, "");
  const env = loadProviderBaseUrl("codearts");
  return env || SNAP_BASE;
}

export function createCodeartsProvider({
  id = "codearts",
  baseUrl,
  apiKeys,
  apiKey,
  chatPath,
  stsHost,
  benefitHost,
  snapBase,
  connectTimeoutMs = envInt("MSLXDFF_CODEARTS_TIMEOUT_MS", 30_000),
  cooldownMs = envInt("MSLXDFF_CODEARTS_COOLDOWN_MS", 30_000),
  autoClaim = process.env.MSLXDFF_CODEARTS_AUTO_CLAIM !== "0",
  fetchImpl,
  file,
  clock = Date.now,
} = {}) {
  if (id !== "codearts") throw new Error(`codearts provider id mismatch: ${id}`);
  const resolvedBase = snapBase || resolveBaseUrl(baseUrl);
  if (!fetchImpl) fetchImpl = UndiciFetch || compatFetch;
  const chatSvcBase = resolvedBase;

  const rawKeys = collectApiKeysGeneric(id, apiKeys, apiKey, (pid) => loadProviderKeys(pid, file ? { file } : {}));
  const allKeys = [...new Set(rawKeys.map((k) => String(k).trim()).filter(Boolean))];
  const ring = createKeyRing(allKeys, { cooldownMs });

  // 刷新轮转写回：原位替换 providerConfigs.codearts.keys 里的旧 blob + ring/pool 重排
  const saveFn = async ({ oldBlob, newBlob }) => {
    try {
      const cur = loadProviderKeys(id, file ? { file } : {});
      const idx = cur.indexOf(oldBlob);
      if (idx < 0) return;
      const next = [...cur];
      next[idx] = newBlob;
      saveProviderConfig(id, { baseUrl: loadProviderBaseUrl(id, file ? { file } : {}) || resolvedBase, keys: next }, file ? { file } : {});
      ring.replace(oldBlob, newBlob);
      pool.replace(oldBlob, newBlob);
    } catch {}
  };
  const pool = createAuthPool({ keys: allKeys, fetchImpl, stsHost, clock, saveFn });
  const catalog = createCatalog();

  let agent = null; let dispatcher = null;
  try {
    const a = createAgent({
      keepAliveTimeout: envInt("MSLXDFF_CODEARTS_KEEPALIVE_TIMEOUT", 30_000),
      keepAliveMaxTimeout: envInt("MSLXDFF_CODEARTS_KEEPALIVE_MAX_TIMEOUT", 60_000),
      connections: envInt("MSLXDFF_CODEARTS_KEEPALIVE_CONNECTIONS", 20),
    });
    agent = a.agent;
    dispatcher = a.dispatcher;
  } catch {}

  const chatSvc = createChatService({
    id, baseUrl: chatSvcBase, chatPath, fetchImpl, dispatcher, authPool: pool, catalog, connectTimeoutMs, clock,
  });

  async function chat(body, opts = {}) {
    if (!ring.size) throw new Error("codearts: missing credential — run: mslxdff -provider codearts login");
    return chatSvc.runChat(body, ring, opts);
  }
  async function chatWithKeys(body, keys, opts = {}) {
    const blobs = (keys || []).filter((k) => typeof k === "string" && k.trim().startsWith("{"));
    if (!blobs.length) throw new Error("codearts: shared keys are not valid credential blobs");
    const tmpRing = createKeyRing(blobs, { cooldownMs });
    const tmpPool = createAuthPool({ keys: blobs, fetchImpl, stsHost, clock }); // 借用凭据不写回本节点
    const tmpSvc = createChatService({ id, baseUrl: chatSvcBase, chatPath, fetchImpl, dispatcher: null, authPool: tmpPool, catalog, connectTimeoutMs, clock });
    return tmpSvc.runChat(body, tmpRing, opts);
  }

  // 三路发现（主账号）；结果写目录（benefit 判定按账号隔离）
  let discovering = null;
  async function discover(force = false) {
    const primary = pool.pickPrimary();
    if (!primary) throw new Error("codearts: no alive account — run: mslxdff -provider codearts login");
    if (!force && !catalog.isStale(primary.userId, clock())) return catalog.accountModels(primary.userId);
    if (discovering) return discovering;
    discovering = (async () => {
      try {
        const account = await pool.getCredential(primary.blob);
        const { models, builtinOk, benefitOk } = await discoverAccountModels({ account, snapBase: resolvedBase, benefitHost, autoClaim, fetchImpl });
        catalog.setAccount(account.userId, models, { keepBenefit: builtinOk && !benefitOk, now: clock() });
        return models;
      } finally {
        discovering = null;
      }
    })();
    return discovering;
  }

  let modelsCache = { at: 0, list: [] };
  async function listModels() {
    if (clock() - modelsCache.at < MODELS_CACHE_TTL_MS && modelsCache.list.length) return modelsCache.list;
    let models;
    try {
      models = await discover();
    } catch {
      models = catalog.accountModels(pool.pickPrimary()?.userId || "");
    }
    if (!models.length) return [];
    const list = models.map((m) => ({
      id: `codearts/${m.id}`,
      object: "model",
      name: m.name || m.id,
      ...(m.contextWindow ? { maxInputTokens: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxOutputTokens: m.maxTokens } : {}),
      ...(m.benefit ? { tags: ["free:benefit"] } : {}),
    }));
    modelsCache = { at: clock(), list };
    return list;
  }

  async function preheat() {
    if (!ring.size) return { ok: false, skipped: true };
    try {
      await discover();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 120) };
    }
  }

  async function close() { if (agent?.close) try { await agent.close(); } catch {} }


  return {
    id,
    chat,
    chatWithKeys,
    listModels,
    preheat,
    close,
    agent,
    keyRing: ring,
    baseUrl: resolvedBase,
    _pool: pool,
    _catalog: catalog,
    _snapshotPath: join(logDir(), "codearts-models.json"),
  };
}
