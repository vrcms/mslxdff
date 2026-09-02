import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { defaultStateFile } from "../state/store.js";
import { atomicWriteSync } from "../state/persist.js";

export function defaultViaRoutesFile() {
  if (process.env.MSLXDFF_VIA_ROUTES_FILE) return String(process.env.MSLXDFF_VIA_ROUTES_FILE).trim();
  const sf = defaultStateFile();
  return join(dirname(sf), "via-routes.json");
}

function viaTtlMs() {
  const raw = process.env.MSLXDFF_VIA_ROUTE_TTL_MS;
  if (raw === undefined || raw === null || raw === "") return 0;
  const s = String(raw).trim().toLowerCase();
  if (s === "0" || s === "off" || s === "false" || s === "no" || s === "disable" || s === "disabled") return 0;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 0) return n;
  return 0;
}

export function loadViaRoutes(file) {
  const f = file || defaultViaRoutesFile();
  try {
    if (!existsSync(f)) return { version: 1, at: null, routes: {}, meta: {} };
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (j && typeof j === "object" && j.routes && typeof j.routes === "object") return j;
    if (j && typeof j === "object" && !j.routes) return { version: 1, at: j.at || null, routes: j, meta: {} };
    return { version: 1, at: null, routes: {}, meta: {} };
  } catch {
    return { version: 1, at: null, routes: {}, meta: {} };
  }
}

export function getViaRoute(model, { file, ttlMs } = {}) {
  const id = String(model || "").trim();
  if (!id) return null;
  const f = file || defaultViaRoutesFile();
  const data = loadViaRoutes(f);
  const entry = data.routes?.[id];
  if (!entry) return null;
  const t = ttlMs !== undefined ? ttlMs : viaTtlMs();
  if (t > 0 && entry.at) {
    const atMs = Date.parse(entry.at);
    if (Number.isFinite(atMs) && Date.now() - atMs > t) return null;
  }
  return entry;
}

export function saveViaRoutes(results, { file, meta } = {}) {
  const f = file || defaultViaRoutesFile();
  const now = new Date().toISOString();
  const prev = loadViaRoutes(f);
  const nextRoutes = { ...(prev.routes || {}) };
  for (const r of results || []) {
    const id = String(r.model || r.id || "").trim();
    if (!id) continue;
    const best = String(r.best || "direct").trim() || "direct";
    const direct = r.direct ? { ok: Boolean(r.direct.ok), ttfbMs: r.direct.ttfbMs ?? r.direct.totalMs ?? null, totalMs: r.direct.totalMs ?? null, label: r.direct.label || null, error: r.direct.error ? String(r.direct.error).slice(0, 300) : null } : null;
    const via = {};
    for (const [k, v] of Object.entries(r.via || {})) {
      via[k] = v?.ok ? { ok: true, ttfbMs: v.ttfbMs ?? v.totalMs ?? null, totalMs: v.totalMs ?? null } : { ok: false, ttfbMs: v?.ttfbMs ?? null, totalMs: v?.totalMs ?? null, label: v?.label || v?.error || "offline" };
    }
    nextRoutes[id] = {
      best,
      direct,
      via,
      deltaMs: r.deltaMs ?? null,
      provider: r.provider || id.split("/")[0] || "",
      at: now,
    };
  }
  const out = {
    version: 1,
    at: now,
    routes: nextRoutes,
    meta: meta || prev.meta || {},
  };
  atomicWriteSync(f, out);
  return out;
}

export function clearViaRoutes(file) {
  const f = file || defaultViaRoutesFile();
  atomicWriteSync(f, { version: 1, at: new Date().toISOString(), routes: {}, meta: {} });
}
