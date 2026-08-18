import { loadModelErrors, saveModelErrors } from "./state.js";

export const DEFAULT_AUTO_MODELS = [
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "ling-3.0-flash-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
  "big-pickle",
];

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
function normEntry(e) {
  if (typeof e === "number") return { status: MODEL_STATUS.ERROR, at: e, code: null };
  if (e && typeof e === "object") {
    return {
      status: e.status || MODEL_STATUS.ERROR,
      at: typeof e.at === "number" ? e.at : 0,
      code: e.code ?? null,
    };
  }
  return null;
}

export function classifyErrorEvent(evt = {}) {
  const code = Number(evt.status);
  if (code === 429) return MODEL_STATUS.LIMIT;
  const msg = String(evt.message || evt.note || "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("limit exceeded") || msg.includes("429")) {
    return MODEL_STATUS.LIMIT;
  }
  return MODEL_STATUS.ERROR;
}

export const DEFAULT_COOLDOWN_MS = 60_000;

function inCooldown(id, errors, now, cooldownMs) {
  if (!cooldownMs) return false;
  const at = normEntry(errors[id])?.at ?? 0;
  return at > 0 && now - at < cooldownMs;
}

export function rankModels(ids, errors = {}, { now = Date.now(), cooldownMs = 0 } = {}) {
  return [...new Set(ids)]
    .filter(Boolean)
    .map((id) => ({
      id,
      err: normEntry(errors[id])?.at ?? 0,
      isDeepseek: /deepseek/i.test(id),
      cooling: inCooldown(id, errors, now, cooldownMs),
    }))
    .sort(
      (a, b) =>
        (a.cooling ? 1 : 0) - (b.cooling ? 1 : 0) ||
        a.err - b.err ||
        (b.isDeepseek ? 1 : 0) - (a.isDeepseek ? 1 : 0)
    )
    .map((x) => x.id);
}

export function createAutoSelector({
  loadCandidates,
  file,
  now = () => Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  errors: seedErrors,
  persist = (errors, f = file) => saveModelErrors(errors, f ? { file: f } : {}),
} = {}) {
  const lastErrorAt = { ...(seedErrors ?? loadModelErrors(file ? { file } : {})) };

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

  async function candidates() {
    return rankModels(await loadList(), lastErrorAt, { now: now(), cooldownMs });
  }

  async function candidatesFor(requested) {
    if (!requested) return candidates();
    const list = await loadList();
    const all = list.includes(requested) ? list : [requested, ...list];
    const others = rankModels(all.filter((id) => id !== requested), lastErrorAt, {
      now: now(),
      cooldownMs,
    });
    if (inCooldown(requested, lastErrorAt, now(), cooldownMs)) {
      return [...others, requested];
    }
    return [requested, ...others];
  }

  function isCooling(id) {
    return inCooldown(id, lastErrorAt, now(), cooldownMs);
  }

  async function recordError(id, evt = {}) {
    if (!id) return;
    lastErrorAt[id] = {
      status: classifyErrorEvent(evt),
      at: now(),
      code: Number.isInteger(Number(evt.status)) ? Number(evt.status) : null,
    };
    await persist({ ...lastErrorAt });
  }

  async function recordOk(id) {
    if (!id) return;
    lastErrorAt[id] = { status: MODEL_STATUS.NORMAL, at: now(), code: 200 };
    await persist({ ...lastErrorAt });
  }

  function statuses() {
    return { ...lastErrorAt };
  }

  return {
    candidates,
    candidatesFor,
    recordError,
    recordOk,
    statuses,
    isCooling,
    errors: () => ({ ...lastErrorAt }),
  };
}
