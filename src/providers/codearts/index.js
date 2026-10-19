// codearts 供应商工厂：注册表入口（registry.js → createCodeartsProvider）。
// key = 凭证 blob（JSON 字符串，一华为账号一条，见 auth-pool.js）；多账号 keyring 自动轮转。
import { createKeyRing } from "../keyring.js";
import { loadProviderKeys, loadProviderBaseUrl, saveProviderConfig } from "../../state.js";
import { getUndici, createAgent, envInt, collectApiKeysGeneric } from "../base.js";
import { compatFetch } from "../../compat.js";
import { logDir, appendEvent } from "../../logs.js";
import { join } from "node:path";
import { SNAP_BASE, MODELS_CACHE_TTL_MS } from "./const.js";
import { createAuthPool } from "./auth-pool.js";
import { createCatalog, discoverAccountModels } from "./models.js";
import { createChatService } from "./chat.js";
import { createGate } from "./concurrency.js";

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
  maxConcurrent = Number.parseInt(process.env.MSLXDFF_CODEARTS_MAX_CONCURRENT ?? "", 10) || 3,
  sessionWindowMs = Number.parseInt(process.env.MSLXDFF_CODEARTS_SESSION_WINDOW_MS ?? "", 10) || 90_000,
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
  // 该上游对并发极敏感（实测 >3 即坏号/限流）；且上游按「最近约 90s 内打开过的会话数」判限，
  // 请求结束**不立即释放**槽（实测 ~80s 才回收）——故闸要同时压「在途」与「窗口内已开会话」。
  // 上限恒为 3：现网实测**两个不同 domainId 的账号也共享同一个 3**（第 4 个必被拒 TM.00001041），
  // 故不能按账号数放大（0.1.218 曾乘账号数=6，反而放行第 4 个，2026-10-19 回归）。
  const gate = createGate({ limit: maxConcurrent, sessionWindowMs });

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

  const onWait = (info) => {
    try { appendEvent({ type: "codearts-queue", ...info }); } catch {}
  };
  // 流式请求必须在**流真正读完/取消后**才释放并发槽——否则 runChat 一返回（body 还没消费）
  // 就 release，上游其实仍占着会话 ⇒ 第 4 路被上游拒（TM.00001041 并发会话数已达上限）。
  // 非流式（JSON）在 runChat 内部已聚合完，可立即释放。返回的 Response 保持原 body 引用，
  // 只包一层 tee 触发 release；出错也保证释放一次（releaseOnce 幂等）。
  function holdUntilBodyDone(res, releaseOnce) {
    const ct = res?.headers?.get?.("content-type") || "";
    if (!ct.includes("text/event-stream") || !res.body) {
      releaseOnce();
      return res;
    }
    let done = false;
    const fin = () => { if (!done) { done = true; releaseOnce(); } };
    const onErr = () => fin();
    try {
      const reader = res.body.getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done: d, value } = await reader.read();
            if (d) { fin(); controller.close(); return; }
            controller.enqueue(value);
          } catch (e) { onErr(); controller.error(e); }
        },
        cancel(reason) { fin(); try { return reader.cancel(reason); } catch { /* ignore */ } },
      });
      return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch {
      fin();
      return res;
    }
  }
  async function chat(body, opts = {}) {
    if (!ring.size) throw new Error("codearts: missing credential — run: mslxdff -provider codearts login");
    const rel = await gate.acquire(onWait);
    let res;
    try {
      res = await chatSvc.runChat(body, ring, opts);
    } catch (err) {
      rel();
      throw err;
    }
    return holdUntilBodyDone(res, rel);
  }
  async function chatWithKeys(body, keys, opts = {}) {
    const blobs = (keys || []).filter((k) => typeof k === "string" && k.trim().startsWith("{"));
    if (!blobs.length) throw new Error("codearts: shared keys are not valid credential blobs");
    const tmpRing = createKeyRing(blobs, { cooldownMs });
    const tmpPool = createAuthPool({ keys: blobs, fetchImpl, stsHost, clock }); // 借用凭据不写回本节点
    const tmpSvc = createChatService({ id, baseUrl: chatSvcBase, chatPath, fetchImpl, dispatcher: null, authPool: tmpPool, catalog, connectTimeoutMs, clock });
    const rel = await gate.acquire(onWait);
    let res;
    try {
      res = await tmpSvc.runChat(body, tmpRing, opts);
    } catch (err) {
      rel();
      throw err;
    }
    return holdUntilBodyDone(res, rel);
  }

  // 三路发现（主账号）；结果写目录（benefit 判定按账号隔离）
  let discovering = null;
  async function discover(force = false) {
    const candidates = pool.aliveAccounts();
    if (!candidates.length) throw new Error("codearts: no alive account — run: mslxdff -provider codearts login");
    if (discovering) return discovering;
    discovering = (async () => {
      let lastErr = null;
      // 逐个账号试（blob 顺序 = 主账号优先）：state 里可能留着已被轮转消费的僵尸凭证（实测 STS5.1806
      // "the refresh token has been used"，login 只追加不清旧，死号会永远排在第一个）。一个死号绝不能
      // 把整个目录变成空表——福利套餐轮换出的新模型全靠这里发现。
      for (const candidate of candidates) {
        if (!force && !catalog.isStale(candidate.userId, clock())) return catalog.accountModels(candidate.userId);
        try {
          const account = await pool.getCredential(candidate.blob);
          const { models, builtinOk, benefitOk } = await discoverAccountModels({ account, snapBase: resolvedBase, benefitHost, autoClaim, fetchImpl });
          catalog.setAccount(account.userId, models, { keepBenefit: builtinOk && !benefitOk, now: clock() });
          return models;
        } catch (err) {
          lastErr = err; // 死号/该号三路全空 → 换下一个号
        }
      }
      throw lastErr || new Error("codearts: no account could list models — run: mslxdff -provider codearts login");
    })().finally(() => { discovering = null; });
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
    _gate: gate,
    _snapshotPath: join(logDir(), "codearts-models.json"),
  };
}
