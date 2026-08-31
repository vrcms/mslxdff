import { defaultStateFile, readState, writeStateImmediate, writeStateDeferred } from "../store.js";

export function loadModelErrors({ file = defaultStateFile() } = {}) {
  const errors = readState(file).modelErrors;
  return errors && typeof errors === "object" && !Array.isArray(errors) ? errors : {};
}

export function saveModelErrors(errors, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { modelErrors: errors });
  return errors;
}

export function loadModelLatencies({ file = defaultStateFile() } = {}) {
  const lat = readState(file).modelLatencies;
  return lat && typeof lat === "object" && !Array.isArray(lat) ? lat : {};
}

export function saveModelLatencies(latencies, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { modelLatencies: latencies });
  return latencies;
}

export function loadModelStats({ file = defaultStateFile() } = {}) {
  const s = readState(file).modelStats;
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

export function saveModelStats(stats, { file = defaultStateFile() } = {}) {
  writeStateDeferred(file, { modelStats: stats });
  return stats;
}

export function loadPreferredModel({ file = defaultStateFile() } = {}) {
  const v = readState(file).preferredModel;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function loadModelPicks({ file = defaultStateFile() } = {}) {
  const picks = readState(file).modelPicks;
  if (!Array.isArray(picks)) return [];
  return [...new Set(picks.filter((x) => typeof x === "string" && x.trim().length))];
}

export function saveModelPicks(picks, { file = defaultStateFile() } = {}) {
  const list = [...new Set((Array.isArray(picks) ? picks : []).filter((x) => typeof x === "string" && x.trim().length))];
  writeStateImmediate(file, { modelPicks: list });
  return list;
}

export function savePreferredModel(id, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { preferredModel: String(id || "").trim() });
  return String(id || "").trim();
}
