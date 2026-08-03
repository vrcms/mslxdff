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

export const DEFAULT_COOLDOWN_MS = 60_000;

function inCooldown(id, errors, now, cooldownMs) {
  if (!cooldownMs) return false;
  const err = errors[id];
  return typeof err === "number" && now - err < cooldownMs;
}

export function rankModels(ids, errors = {}, { now = Date.now(), cooldownMs = 0 } = {}) {
  return [...new Set(ids)]
    .filter(Boolean)
    .map((id) => ({
      id,
      err: typeof errors[id] === "number" ? errors[id] : 0,
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

  async function recordError(id) {
    if (!id) return;
    lastErrorAt[id] = now();
    await persist({ ...lastErrorAt });
  }

  return {
    candidates,
    candidatesFor,
    recordError,
    errors: () => ({ ...lastErrorAt }),
  };
}
