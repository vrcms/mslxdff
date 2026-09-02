import { readFileSync, existsSync } from "node:fs";
import { loadProviderKeys, loadProviderAuths, loadProviderConfigs, loadProviderAllowedModels, loadProviderAllowAnyModels, loadProviderShareKeys, loadProviderBaseUrl } from "../state.js";

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
  const opAllowAny = (() => { try { return loadProviderAllowAnyModels("opencode", stateFile ? { file: stateFile } : undefined); } catch { return true; } })();
  rows.push({ id: "opencode", enabled: true, baseUrl: upstreamBase, keys: [], allowed: opAllowed, allowAny: opAllowAny !== false, share: false, note: "built-in, no key, cannot share", authCount: 0 });

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

  // 保证 openrouter 始终可见（即使 0 keys，供用户发现）
  genericIds.add("openrouter");
  for (const gid of [...genericIds].sort()) {
    const cfg = configs[gid];
    let keys = [];
    let baseUrl = "";
    let share = false;
    let allowed = [];
    let allowAny = false;
    try { keys = loadProviderKeys(gid, stateFile ? { file: stateFile } : undefined); } catch {}
    try { baseUrl = loadProviderBaseUrl(gid, stateFile ? { file: stateFile } : undefined) || cfg?.baseUrl || (gid === "openrouter" ? "https://openrouter.ai/api/v1" : gid === "workbuddy" ? "https://copilot.tencent.com" : ""); } catch { baseUrl = cfg?.baseUrl || ""; }
    try { share = loadProviderShareKeys(gid, stateFile ? { file: stateFile } : undefined); } catch {}
    try { allowed = loadProviderAllowedModels(gid, stateFile ? { file: stateFile } : undefined); } catch {}
    try { allowAny = loadProviderAllowAnyModels(gid, stateFile ? { file: stateFile } : undefined); } catch {}
    // openrouter 特殊：opencode 例外默认 allowAny true，其余默认 false
    if (gid === "opencode") allowAny = true;
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
    rows.push({ id: gid, enabled, baseUrl: baseUrl || "(none)", keys, allowed, allowAny, share, note, authCount: auths.length });
  }
  return rows;
}

function maskKey(k) {
  const s = String(k || "").trim();
  if (s.length <= 8) return `${s.slice(0, 3)}…${s.slice(-2)}`;
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

export function formatProviderRow(p) {
  const isBlocked = !p.allowed.length && !p.allowAny && p.id !== "opencode";
  const dot = !p.enabled ? "○" : isBlocked ? "◐" : "●";
  const state = !p.enabled ? "未启用" : isBlocked ? "已启用·阻断" : "已启用";
  // keys
  let keysInfo;
  if (p.id === "opencode") keysInfo = "无需 key";
  else if (!p.keys.length) keysInfo = "0 keys";
  else if (p.keys.length === 1) keysInfo = `1 key ${maskKey(p.keys[0])}`;
  else keysInfo = `${p.keys.length} keys ${p.keys.slice(0, 2).map(maskKey).join(", ")}${p.keys.length > 2 ? ` +${p.keys.length - 2}` : ""}`;
  if (p.authCount) keysInfo += ` · ${p.authCount} acc`;
  // allow — 空名单 + allowAny OFF = 阻断（安全默认）
  let allowInfo;
  if (!p.allowed.length) {
    if (p.id === "opencode") allowInfo = "allow all";
    else if (p.allowAny) allowInfo = "allow all";
    else allowInfo = "allow none (BLOCKED)";
  } else {
    const head = p.allowed.slice(0, 2).join(", ");
    const more = p.allowed.length > 2 ? ` …+${p.allowed.length - 2}` : "";
    allowInfo = `allow ${p.allowed.length} → ${head}${more}`;
  }
  // share
  const shareInfo = p.id === "opencode" ? "无法共享" : `共享 ${p.share ? "开" : "关"}`;
  // base
  const base = p.baseUrl && p.baseUrl !== "(none)" ? p.baseUrl : "(none)";
  const baseLine = `    └ ${base}${p.note ? `  · ${p.note}` : ""}`;
  // 主行：id 固定 12，状态 6，keys 22，allow 自适应，share 固定
  const main = `  ${dot} ${p.id.padEnd(12)}  ${state}  ${keysInfo.padEnd(22)}  ${allowInfo.padEnd(28)}  ${shareInfo}`;
  return `${main}\n${baseLine}`;
}

export function formatProviderSection(rows) {
  if (!rows.length) {
    return [
      "  (空) 暂无供应商 — 加一个试试：",
      "    mslxdff -provider add myapi https://api.example.com/v1 sk-xxx",
      "    或  node workbuddy-token-auto.js  (WorkBuddy 一键接入)",
    ].join("\n");
  }
  const enabled = rows.filter((r) => r.enabled);
  const disabled = rows.filter((r) => !r.enabled);
  const out = [];
  if (enabled.length) {
    out.push(`  已启用 (${enabled.length})`);
    for (const p of enabled) out.push(formatProviderRow(p));
  }
  if (disabled.length) {
    if (enabled.length) out.push("");
    out.push(`  未启用 / 需配置 (${disabled.length})`);
    for (const p of disabled) out.push(formatProviderRow(p));
  }
  return out.join("\n");
}
