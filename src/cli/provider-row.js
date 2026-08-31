import { readFileSync, existsSync } from "node:fs";
import { loadProviderKeys, loadProviderAuths, loadProviderConfigs, loadProviderAllowedModels, loadProviderShareKeys, loadProviderBaseUrl } from "../state.js";

/**
 * 聚合 genericIds：来自 providerConfigs + providerKeys + env MSLXDFF_*_KEY
 * 纯逻辑抽取，便于单测；默认读真实 stateFile 与 env，测试可注入 stateFile
 */
export function buildProviderRows({ stateFile, env = process.env } = {}) {
  // 复用 status 的聚合逻辑，但抽为纯函数
  let configs = {};
  try { configs = loadProviderConfigs(stateFile ? { file: stateFile } : undefined); } catch {}
  const upstreamBase = env.UPSTREAM_BASE_URL || "https://opencode.ai";
  const rows = [];
  const opAllowed = (() => { try { return loadProviderAllowedModels("opencode", stateFile ? { file: stateFile } : undefined); } catch { return []; } })();
  rows.push({ id: "opencode", enabled: true, baseUrl: upstreamBase, keys: [], allowed: opAllowed, share: false, note: "built-in, no key, cannot share", authCount: 0 });

  const genericIds = new Set(Object.keys(configs).filter((id) => id !== "opencode"));
  try {
    const raw = JSON.parse(readFileSync(stateFile || "", "utf8"));
    const pk = raw.providerKeys || {};
    for (const id of Object.keys(pk)) if (id !== "opencode") genericIds.add(id);
    const cfgRaw = raw.providerConfigs || {};
    for (const id of Object.keys(cfgRaw)) if (id !== "opencode") genericIds.add(id);
  } catch {}
  for (const k of Object.keys(env)) {
    const m = k.match(/^MSLXDFF_(.+)_KEY$/);
    if (m) {
      const id = m[1].toLowerCase().replace(/__/g, "-");
      if (id !== "opencode") genericIds.add(id);
    }
  }

  for (const gid of [...genericIds].sort()) {
    const cfg = configs[gid];
    let keys = [];
    let baseUrl = "";
    let share = false;
    let allowed = [];
    try { keys = loadProviderKeys(gid, stateFile ? { file: stateFile } : undefined); } catch {}
    try { baseUrl = loadProviderBaseUrl(gid, stateFile ? { file: stateFile } : undefined) || cfg?.baseUrl || (gid === "openrouter" ? "https://openrouter.ai/api/v1" : gid === "workbuddy" ? "https://copilot.tencent.com" : ""); } catch { baseUrl = cfg?.baseUrl || ""; }
    try { share = loadProviderShareKeys(gid, stateFile ? { file: stateFile } : undefined); } catch {}
    try { allowed = loadProviderAllowedModels(gid, stateFile ? { file: stateFile } : undefined); } catch {}
    let enabled = Boolean(baseUrl && keys.length) || (gid === "openrouter" && keys.length > 0);
    const auths = gid === "workbuddy" ? (() => { try { return loadProviderAuths(gid, stateFile ? { file: stateFile } : undefined) || []; } catch { return []; } })() : [];
    let note = "";
    const isWorkbuddyStub = gid === "workbuddy" && (keys.includes("k-new") || String(baseUrl).includes("127.0.0.1") || (keys.length === 1 && keys[0].length < 20));
    if (isWorkbuddyStub) {
      enabled = false;
      note = "测试桩 (key=k-new, baseUrl=127.0.0.1) — 请重跑 node workbuddy-token-auto.js 写入真实 JWT";
    } else if (!enabled) {
      if (!baseUrl && !keys.length) note = "no baseUrl, no keys";
      else if (!baseUrl) note = "missing baseUrl";
      else if (!keys.length) note = "no keys";
    } else if (gid === "workbuddy" && auths.length && auths.length !== keys.length) {
      note = `${auths.length} auth(s) / ${keys.length} key(s) — 数量不一致请重跑 workbuddy-token-auto.js`;
    }
    rows.push({ id: gid, enabled, baseUrl: baseUrl || "(none)", keys, allowed, share, note, authCount: auths.length });
  }
  return rows;
}

export function formatProviderRow(p) {
  const dot = p.enabled ? "●" : "○";
  const state = p.enabled ? "enabled " : "disabled";
  let keysInfo;
  if (p.id === "opencode") keysInfo = "无需 key (内置)";
  else keysInfo = p.keys.length ? `${p.keys.length} key${p.keys.length > 1 ? "s" : ""} ${p.keys.map((k) => `${k.slice(0, 3)}…${k.slice(-3)}`).join(", ")}` : "0 keys";
  const authInfo = p.authCount ? ` ${p.authCount} acc` : "";
  const allowInfo = p.allowed.length ? `allow=${p.allowed.length}(${p.allowed.slice(0, 2).join(",")}${p.allowed.length > 2 ? "…" : ""})` : "allow=all";
  const shareInfo = p.id === "opencode" ? "cannot share" : `share=${p.share ? "ON" : "off"}`;
  const note = p.note ? `  (${p.note})` : "";
  return `  ${dot} ${p.id.padEnd(12)} ${state}  ${keysInfo}${authInfo}  ${allowInfo.padEnd(18)}  baseUrl=${p.baseUrl}  ${shareInfo}${note}`;
}
