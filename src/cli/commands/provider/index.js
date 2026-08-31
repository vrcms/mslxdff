import { readFileSync } from "node:fs";
import { defaultStateFile } from "../../../state.js";

export async function handleProviders(args) {
  if (!(args.includes("-providers") || args.includes("--providers"))) return false;
  const idx = args.findIndex((x) => x === "-providers" || x === "--providers");
  const sub = args[idx + 1];
  if (!sub || sub === "list" || sub === "status") {
    const { loadProviderConfigs, loadProviderKeys, loadProviderShareKeys, loadProviderBaseUrl, loadProviderAllowedModels } = await import("../../../state.js");
    const configs = loadProviderConfigs();
    const opencodeEnabled = true;
    const opencodeBase = process.env.UPSTREAM_BASE_URL || "https://opencode.ai";
    const orKeys = loadProviderKeys("openrouter");
    const orBase = "https://openrouter.ai/api/v1";
    const orShare = loadProviderShareKeys("openrouter");
    const orAllowed = loadProviderAllowedModels("openrouter");
    const genericIds = new Set(Object.keys(configs).filter((id) => id !== "opencode" && id !== "openrouter"));
    try {
      const raw = JSON.parse(readFileSync(defaultStateFile(), "utf8"));
      const pk = raw.providerKeys || {};
      for (const id of Object.keys(pk)) if (id !== "opencode" && id !== "openrouter") genericIds.add(id);
      const cfgRaw = raw.providerConfigs || {};
      for (const id of Object.keys(cfgRaw)) if (id !== "opencode" && id !== "openrouter") genericIds.add(id);
    } catch {}
    for (const k of Object.keys(process.env)) {
      const m = k.match(/^MSLXDFF_(.+)_KEY$/);
      if (m) {
        const id = m[1].toLowerCase().replace(/__/g, "-");
        if (id !== "openrouter" && id !== "opencode") genericIds.add(id);
      }
    }
    try {
      const raw = JSON.parse(readFileSync(defaultStateFile(), "utf8"));
      const cfgs = raw.providerConfigs || {};
      for (const id of Object.keys(cfgs)) {
        if (id === "opencode" || id === "openrouter") continue;
        const am = cfgs[id]?.allowedModels;
        if (Array.isArray(am) && am.length) genericIds.add(id);
      }
    } catch {}
    const list = [];
    const { loadProviderAllowAnyModels: _la0 } = await import("../../../state.js");
    const opAllowAny = _la0("opencode");
    const orAllowAny = _la0("openrouter");
    const opAllowed = loadProviderAllowedModels("opencode");
    list.push({ id: "opencode", enabled: opencodeEnabled, baseUrl: opencodeBase, keys: [], share: false, allowed: opAllowed, allowAny: opAllowAny, note: "built-in, no key, cannot share" });
    list.push({ id: "openrouter", enabled: orKeys.length > 0, baseUrl: orBase, keys: orKeys, share: orShare, allowed: orAllowed, allowAny: orAllowAny, note: orKeys.length ? "" : "no keys" });
    for (const gid of [...genericIds].sort()) {
      const cfg = configs[gid];
      const keys = loadProviderKeys(gid);
      const baseUrl = loadProviderBaseUrl(gid) || cfg?.baseUrl || "";
      const share = loadProviderShareKeys(gid);
      const allowed = loadProviderAllowedModels(gid);
      const allowAny = _la0(gid);
      const enabled = Boolean(baseUrl && keys.length);
      let note = "";
      if (!baseUrl && !keys.length && !allowed.length && allowAny === false) note = "no baseUrl, no keys, BLOCKED (allowAny OFF)";
      else if (!baseUrl && !keys.length && !allowed.length) note = "no baseUrl, no keys";
      else if (!baseUrl && !allowed.length && !allowAny) note = "missing baseUrl, BLOCKED";
      else if (!keys.length && !allowed.length && !allowAny) note = "no keys, BLOCKED";
      else if (!baseUrl) note = "missing baseUrl";
      else if (!keys.length) note = "no keys";
      list.push({ id: gid, enabled, baseUrl: baseUrl || "(none)", keys, share, allowed, allowAny, note });
    }
    console.log(`providers (${list.length}):`);
    for (const p of list) {
      const state = p.enabled ? "enabled " : "disabled";
      const keysInfo = p.keys.length ? `${p.keys.length} key${p.keys.length > 1 ? "s" : ""} ${p.keys.map((k) => `${k.slice(0, 4)}…${k.slice(-4)}`).join(", ")}` : "0 keys";
      const shareInfo = p.id === "opencode" ? "cannot share" : `share=${p.share ? "ON" : "off"}`;
      const allowInfo = p.allowed.length ? `allow=${p.allowed.length}(${p.allowed.slice(0, 3).join(",")}${p.allowed.length > 3 ? "..." : ""})` : (p.allowAny ? "allow=all" : "allow=none(BLOCKED)");
      const note = p.note ? `  (${p.note})` : "";
      console.log(`  ${p.id.padEnd(12)} ${state}  ${keysInfo.padEnd(28)}  ${allowInfo.padEnd(22)}  baseUrl=${p.baseUrl}  ${shareInfo}${note}`);
    }
    console.log(`\nuse: mslxdff -provider <id> list  to inspect one,  mslxdff -provider <id> allowlist set <model...>  to restrict`);
    console.log(`     mslxdff -provider <id> allowAny on|off  (empty allowlist = block or allow all)`);
    process.exit(0);
  }
  console.error("usage: mslxdff -providers list");
  process.exit(1);
}

export async function handleProvider(args) {
  if (!(args.includes("-provider") || args.includes("--provider"))) return false;
  const idx = args.findIndex((x) => x === "-provider" || x === "--provider");
  const id = args[idx + 1];
  const sub = args[idx + 2];
  const rest = args.slice(idx + 2);
  if (!id) {
    console.error("usage: mslxdff -provider <id> [key...|add|remove|list|models|clear|share|set-url|allowlist|allowAny]");
    console.error("       e.g. mslxdff -provider openrouter sk-1 sk-2 sk-3      set multiple keys (replaces all)");
    console.error("            mslxdff -provider openrouter add sk-4             append one key");
    console.error("            mslxdff -provider openrouter remove sk-1          remove a key by value");
    console.error("            mslxdff -provider openrouter list                 list all keys (masked)");
    console.error("            mslxdff -provider openrouter models [--json]      list provider models (allowlist filtered)");
    console.error("            mslxdff -provider openrouter share on|off         share keys with peers on outgoing forward (ADR-0008)");
    console.error("            mslxdff -provider openrouter set-url https://api.example.com/v1");
    console.error("            mslxdff -provider openrouter set-models-path /v1/models");
    console.error("            mslxdff -provider openrouter set-chat-path /v1/chat/completions");
    console.error("            mslxdff -provider openrouter allowlist set gpt-4 gpt-3.5  manage allowed models (empty=block unless allowAny ON)");
    console.error("            mslxdff -provider openrouter allowAny on|off     empty allowlist = allow all or block all (default OFF, secure)");
    console.error("            mslxdff -provider add myapi https://api.example.com/v1 sk-xxx   add generic OpenAI-compatible provider");
    console.error("            mslxdff -provider add myapi https://api.example.com/v1 sk-xxx gpt-4  add with allowlist");
    console.error("            mslxdff -provider add myapi https://api.example.com/v1 sk-xxx --models-path /v1/models --chat-path /v1/chat/completions");
    console.error("            mslxdff -provider openrouter                      interactive hidden input (append)");
    console.error("            mslxdff -provider openrouter clear                remove all keys");
    process.exit(1);
  }
  if (id === "list" || id === "status") {
    const { loadProviderConfigs, loadProviderKeys, loadProviderShareKeys, loadProviderBaseUrl } = await import("../../../state.js");
    const configs = loadProviderConfigs();
    const opencodeBase = process.env.UPSTREAM_BASE_URL || "https://opencode.ai";
    const orKeys = loadProviderKeys("openrouter");
    const orBase = "https://openrouter.ai/api/v1";
    const orShare = loadProviderShareKeys("openrouter");
    const genericIds = new Set(Object.keys(configs).filter((x) => x !== "opencode" && x !== "openrouter"));
    try {
      const raw = JSON.parse(readFileSync(defaultStateFile(), "utf8"));
      const pk = raw.providerKeys || {};
      for (const k of Object.keys(pk)) if (k !== "opencode" && k !== "openrouter") genericIds.add(k);
      const cfgRaw = raw.providerConfigs || {};
      for (const k of Object.keys(cfgRaw)) if (k !== "opencode" && k !== "openrouter") genericIds.add(k);
    } catch {}
    for (const k of Object.keys(process.env)) {
      const m = k.match(/^MSLXDFF_(.+)_KEY$/);
      if (m) {
        const gid = m[1].toLowerCase().replace(/__/g, "-");
        if (gid !== "openrouter" && gid !== "opencode") genericIds.add(gid);
      }
    }
    try {
      const raw = JSON.parse(readFileSync(defaultStateFile(), "utf8"));
      const cfgs = raw.providerConfigs || {};
      for (const gid of Object.keys(cfgs)) {
        if (gid === "opencode" || gid === "openrouter") continue;
        const am = cfgs[gid]?.allowedModels;
        if (Array.isArray(am) && am.length) genericIds.add(gid);
      }
    } catch {}
    const list = [];
    const { loadProviderAllowAnyModels: _la0 } = await import("../../../state.js");
    const { loadProviderAllowedModels } = await import("../../../state.js");
    const opAllowed = loadProviderAllowedModels("opencode");
    const opAllowAny = _la0("opencode");
    const orAllowed = loadProviderAllowedModels("openrouter");
    const orAllowAny = _la0("openrouter");
    list.push({ id: "opencode", enabled: true, baseUrl: opencodeBase, keys: [], share: false, allowed: opAllowed, allowAny: opAllowAny, note: "built-in, no key, cannot share" });
    list.push({ id: "openrouter", enabled: orKeys.length > 0, baseUrl: orBase, keys: orKeys, share: orShare, allowed: orAllowed, allowAny: orAllowAny, note: orKeys.length ? "" : "no keys" });
    for (const gid of [...genericIds].sort()) {
      const cfg = configs[gid];
      const keys = loadProviderKeys(gid);
      const baseUrl = loadProviderBaseUrl(gid) || cfg?.baseUrl || "";
      const share = loadProviderShareKeys(gid);
      const allowed = loadProviderAllowedModels(gid);
      const allowAny = _la0(gid);
      const enabled = Boolean(baseUrl && keys.length);
      let note = "";
      if (!baseUrl && !keys.length) note = "no baseUrl, no keys";
      else if (!baseUrl) note = "missing baseUrl";
      else if (!keys.length) note = "no keys";
      list.push({ id: gid, enabled, baseUrl: baseUrl || "(none)", keys, share, note });
    }
    console.log(`providers (${list.length}):`);
    for (const p of list) {
      const state = p.enabled ? "enabled " : "disabled";
      const keysInfo = p.keys.length ? `${p.keys.length} key${p.keys.length > 1 ? "s" : ""} ${p.keys.map((k) => `${k.slice(0, 4)}…${k.slice(-4)}`).join(", ")}` : "0 keys";
      const shareInfo = p.id === "opencode" ? "cannot share" : `share=${p.share ? "ON" : "off"}`;
      const note = p.note ? `  (${p.note})` : "";
      console.log(`  ${p.id.padEnd(12)} ${state}  ${keysInfo.padEnd(28)}  baseUrl=${p.baseUrl}  ${shareInfo}${note}`);
    }
    console.log(`\nuse: mslxdff -provider <id> list  to inspect one,  mslxdff -provider add <id> <baseUrl> <key>  to add generic`);
    process.exit(0);
  }
  if (id === "add") {
    const { handleProviderAdd } = await import("./add.js");
    await handleProviderAdd(id, sub, rest);
    return true;
  }
  if ((id === "opencode" || id === "oc") && sub !== "allowlist" && sub !== "allow" && sub !== "allowed" && sub !== "whitelist" && sub !== "list" && sub !== "status" && sub !== "allowAny" && sub !== "allow-any" && sub !== "allow_any" && sub !== "allowany") {
    console.log("opencode is the default (bare) provider — it needs no API key and can never be shared with peers");
    console.log("(its IP-based rate limit is spread by peer forwarding itself)");
    console.log(`  allowlist: mslxdff -provider opencode allowlist [list|set|add|remove|clear]  — restrict models (empty=allow all)`);
    process.exit(0);
  }
  const { handleProviderConfig } = await import("./config.js");
  if (await handleProviderConfig(id, sub, rest)) return true;
  const { handleProviderAllowlist } = await import("./allowlist.js");
  if (await handleProviderAllowlist(id, sub, rest)) return true;
  const { handleProviderModels } = await import("./models.js");
  if (await handleProviderModels(id, sub, args, rest)) return true;
  const { handleProviderKeys } = await import("./keys.js");
  await handleProviderKeys(id, sub, rest, args);
  return true;
}
