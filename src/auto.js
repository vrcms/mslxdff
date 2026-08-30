import { statSync } from "node:fs";
import { loadModelErrors, saveModelErrors, loadModelLatencies, saveModelLatencies, loadPreferredModel, loadModelPicks, saveModelPicks, defaultStateFile } from "./state.js";

// 出厂默认首选模型（state.json 的 preferredModel / env MSLXDFF_PREFERRED_MODEL 可覆盖）
export const DEFAULT_PREFERRED_MODEL = "big-pickle";
// 兼容旧导出名：语义为"出厂默认"，当前生效值请用 getPreferredModel()
export const PREFERRED_MODEL = DEFAULT_PREFERRED_MODEL;

// 当前生效的首选模型：state.json > env > 出厂默认；mtime 缓存保证 daemon 热生效
const _prefCache = { mtimeMs: -1, file: null, value: null };
export function getPreferredModel({ file = defaultStateFile() } = {}) {
  try {
    const st = statSync(file);
    if (_prefCache.file !== file || st.mtimeMs !== _prefCache.mtimeMs) {
      _prefCache.file = file;
      _prefCache.mtimeMs = st.mtimeMs;
      _prefCache.value = loadPreferredModel({ file });
    }
  } catch {
    _prefCache.file = file;
    _prefCache.mtimeMs = -1;
    _prefCache.value = null;
  }
  const env = (process.env.MSLXDFF_PREFERRED_MODEL || "").trim();
  return _prefCache.value || env || DEFAULT_PREFERRED_MODEL;
}

export const DEFAULT_AUTO_MODELS = [
  PREFERRED_MODEL,
  "mimo-v2.5-free",
  "deepseek-v4-flash-free",
  "ling-3.0-flash-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
].filter((id, i, arr) => id && arr.indexOf(id) === i);

export function isAutoModel(model) {
  return !model || model === "auto";
}

export const MODEL_STATUS = Object.freeze({
  NORMAL: "normal",
  LIMIT: "limit",
  ERROR: "error",
});

// Legacy modelErrors entries are bare timestamps ({id: ts}); newer ones are
// objects ({id: {status, at, code}}). Normalize both to an entry object.
// `slow` flags a model whose last request was slow (over the wall-clock
// threshold) — those get a longer cooldown so they lie low until they recover.
function normEntry(e) {
  if (typeof e === "number") return { status: MODEL_STATUS.ERROR, at: e, code: null, slow: false };
  if (e && typeof e === "object") {
    return {
      status: e.status || MODEL_STATUS.ERROR,
      at: typeof e.at === "number" ? e.at : 0,
      code: e.code ?? null,
      slow: Boolean(e.slow),
    };
  }
  return null;
}

export function classifyErrorEvent(evt = {}) {
  if (evt.slow) return MODEL_STATUS.ERROR;
  const code = Number(evt.status);
  if (code === 429) return MODEL_STATUS.LIMIT;
  const msg = String(evt.message || evt.note || "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("limit exceeded") || msg.includes("429")) {
    return MODEL_STATUS.LIMIT;
  }
  return MODEL_STATUS.ERROR;
}

export const DEFAULT_COOLDOWN_MS = 60_000;
export const DEFAULT_SLOW_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_LATENCY_ALPHA = 0.3;

function effectiveCooldown(entry, slowCooldownMs, cooldownMs) {
  if (entry && entry.slow) return slowCooldownMs || 0;
  return cooldownMs || 0;
}

function inCooldown(id, errors, now, cooldownMs, slowCooldownMs) {
  const e = normEntry(errors[id]);
  if (!e || !(e.at > 0)) return false;
  const cd = effectiveCooldown(e, slowCooldownMs, cooldownMs);
  return cd > 0 && now - e.at < cd;
}

// Latency EMA helpers
function normLatency(e) {
  if (!e || typeof e !== "object") return null;
  const ema = Number(e.emaMs);
  return Number.isFinite(ema) && ema > 0 ? ema : null;
}

export function rankModels(ids, errors = {}, { now = Date.now(), cooldownMs = 0, slowCooldownMs = 0, latencies = {}, preferred } = {}) {
  const pref = preferred ?? getPreferredModel();
  return [...new Set(ids)]
    .filter(Boolean)
    .map((id) => ({
      id,
      e: normEntry(errors[id]),
      err: normEntry(errors[id])?.at ?? 0,
      isPreferred: id === pref,
      cooling: inCooldown(id, errors, now, cooldownMs, slowCooldownMs),
      latency: normLatency(latencies[id]) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort(
      (a, b) =>
        (a.cooling ? 1 : 0) - (b.cooling ? 1 : 0) ||
        (b.isPreferred ? 1 : 0) - (a.isPreferred ? 1 : 0) ||
        a.latency - b.latency ||
        a.err - b.err
    )
    .map((x) => x.id);
}

export function createAutoSelector({
  loadCandidates,
  file,
  now = () => Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  slowCooldownMs = DEFAULT_SLOW_COOLDOWN_MS,
  latencyAlpha = DEFAULT_LATENCY_ALPHA,
  errors: seedErrors,
  latencies: seedLatencies,
  persist = (errors, f = file) => saveModelErrors(errors, f ? { file: f } : {}),
  persistLatencies = (latencies, f = file) => saveModelLatencies(latencies, f ? { file: f } : {}),
  loadPicks = () => (file ? loadModelPicks({ file }) : []),
  persistPicks = (picks) => (file ? saveModelPicks(picks, { file }) : picks),
} = {}) {
  const lastErrorAt = { ...(seedErrors ?? loadModelErrors(file ? { file } : {})) };
  const latencies = { ...(seedLatencies ?? loadModelLatencies(file ? { file } : {})) };

  async function loadList() {
    let list;
    try {
      const loaded = await loadCandidates?.();
      list = Array.isArray(loaded) && loaded.length ? loaded : DEFAULT_AUTO_MODELS;
    } catch {
      list = DEFAULT_AUTO_MODELS;
    }
    return [...new Set(list)].filter(Boolean);
  }

  // 勾选集 = auto 候选池白名单：只在勾选的模型里择优；空勾选或勾选中无可用模型时回退全量
  async function pickedPool(list) {
    const picks = loadPicks();
    if (!picks.length) return list;
    const pickedSet = new Set(picks);
    const filtered = list.filter((id) => pickedSet.has(id));
    return filtered.length ? filtered : list;
  }

  async function candidates() {
    const list = await loadList();
    const pool = await pickedPool(list);
    return rankModels(pool, lastErrorAt, { now: now(), cooldownMs, slowCooldownMs, latencies, preferred: getPreferredModel({ file: file ?? undefined }) });
  }

  async function candidatesFor(requested) {
    if (!requested) return candidates();
    const list = await loadList();
    // 显式指定某模型 = 认可它，自动加入勾选集（仅当它是真实上游 free 模型时，避免垃圾 id 污染）
    const picks = loadPicks();
    if (list.includes(requested) && !picks.includes(requested) && persistPicks) {
      await persistPicks([...picks, requested]);
    }
    const all = list.includes(requested) ? list : [requested, ...list];
    const others = rankModels(all.filter((id) => id !== requested), lastErrorAt, {
      now: now(),
      cooldownMs,
      slowCooldownMs,
      latencies,
      preferred: getPreferredModel({ file: file ?? undefined }),
    });
    // 显式指定模型：严格优先，永不因冷却被挤到最后（原设计：A deepseek 失败 → B/D deepseek 并发 → 都失败才 fallback）
    // 冷却仅影响 auto 的择优，不影响指定模型的“很难被更改”语义
    return [requested, ...others];
  }

  function isCooling(id) {
    return inCooldown(id, lastErrorAt, now(), cooldownMs, slowCooldownMs);
  }

  async function recordError(id, evt = {}) {
    if (!id) return;
    lastErrorAt[id] = {
      status: classifyErrorEvent(evt),
      at: now(),
      code: Number.isInteger(Number(evt.status)) ? Number(evt.status) : null,
      slow: Boolean(evt.slow),
    };
    await persist({ ...lastErrorAt });
  }

  async function recordOk(id, evt = {}) {
    if (!id) return;
    lastErrorAt[id] = { status: MODEL_STATUS.NORMAL, at: now(), code: 200, slow: false };
    await persist({ ...lastErrorAt });
    const ms = Number(evt.latencyMs ?? evt.totalMs ?? evt.elapsedMs);
    if (Number.isFinite(ms) && ms > 0) {
      const prev = latencies[id]?.emaMs;
      const ema = prev ? Math.round(prev * (1 - latencyAlpha) + ms * latencyAlpha) : Math.round(ms);
      latencies[id] = { emaMs: ema, lastMs: Math.round(ms), at: now(), count: (latencies[id]?.count ?? 0) + 1 };
      await persistLatencies({ ...latencies });
    }
  }

  async function recordLatency(id, ms) {
    if (!id || !Number.isFinite(ms) || ms <= 0) return;
    const prev = latencies[id]?.emaMs;
    const ema = prev ? Math.round(prev * (1 - latencyAlpha) + ms * latencyAlpha) : Math.round(ms);
    latencies[id] = { emaMs: ema, lastMs: Math.round(ms), at: now(), count: (latencies[id]?.count ?? 0) + 1 };
    await persistLatencies({ ...latencies });
  }

  function statuses() {
    return { ...lastErrorAt };
  }

  function latencyStatuses() {
    return { ...latencies };
  }

  return {
    candidates,
    candidatesFor,
    recordError,
    recordOk,
    recordLatency,
    statuses,
    latencyStatuses,
    isCooling,
    errors: () => ({ ...lastErrorAt }),
    latencies: () => ({ ...latencies }),
  };
}
