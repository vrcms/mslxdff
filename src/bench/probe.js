import { joinUrl } from "../providers/base.js";
import { getCustomNormalizer } from "../providers/registry.js";
import { createTransport } from "../transport/index.js";
import { compatFetch } from "../compat.js";

function normalizeModelsPayload(json, baseUrl = "") {
  if (!json) return [];
  try {
    const custom = getCustomNormalizer(baseUrl);
    if (custom) {
      const v = custom(json);
      if (Array.isArray(v)) return v;
    }
  } catch {}
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.models)) return json.models;
  if (json.data && typeof json.data === "object" && Array.isArray(json.data.data)) return json.data.data;
  return [];
}

function toModelId(m) {
  if (!m) return "";
  if (typeof m === "string") return m;
  if (typeof m.id === "string") return m.id;
  if (typeof m.model === "string") return m.model;
  if (typeof m.name === "string") return m.name;
  return "";
}

export async function probeModels({
  baseUrl,
  modelsPath,
  chatPath,
  headers = {},
  fetchImpl = compatFetch,
  timeoutMs = 8000,
} = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "missing baseUrl", tried: [], data: [] };
  const candidates = [];
  const seen = new Set();
  const push = (p) => {
    const s = String(p || "").trim();
    if (!s) return;
    const norm = s.startsWith("/") ? s : `/${s}`;
    if (!seen.has(norm)) { seen.add(norm); candidates.push(norm); }
  };
  if (modelsPath) push(modelsPath);
  push("/v1/models");
  push("/models");
  const tr = createTransport({ fetchImpl, keepAlive: false, retry: {}, timeoutMs });
  const tried = [];
  let lastError = "";
  for (const p of candidates) {
    const url = joinUrl(base, p);
    tried.push(url);
    try {
      const res = await tr.request({ url, method: "GET", headers, stream: false });
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
      let json = {};
      try { json = await res.json(); } catch { json = {}; }
      const raw = normalizeModelsPayload(json, baseUrl);
      const data = raw.map((m) => ({ id: toModelId(m), raw: m })).filter((x) => x.id).map((x) => ({ id: x.id, ...x.raw }));
      return { ok: true, data, tried, url, rawCount: raw.length };
    } catch (e) {
      lastError = e?.message || String(e);
    }
  }
  return { ok: false, error: lastError || "all probes failed", tried, data: [] };
}
