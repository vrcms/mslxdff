import { readFileSync } from "node:fs";
import { defaultStateFile } from "../../../state.js";

export async function handleProviders(args) {
  if (!(args.includes("-providers") || args.includes("--providers"))) return false;
  const idx = args.findIndex((x) => x === "-providers" || x === "--providers");
  const sub = args[idx + 1];
  if (!sub || sub === "list" || sub === "status") {
    const { buildProviderRows, formatProviderSection } = await import("../../provider-row.js");
    const rows = buildProviderRows({});
    const enabled = rows.filter((r) => r.enabled).length;
    console.log(`providers  ${rows.length} 个 · ${enabled} 已启用  —  mslxdff -provider <id> list 查看详情`);
    console.log(formatProviderSection(rows));
    console.log(`\n提示: mslxdff -provider <id> list 单看一个 · allowlist set <model...> 限制模型 · allowAny on|off 空名单放行/阻断`);
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
    const { buildProviderRows, formatProviderSection } = await import("../../provider-row.js");
    const rows = buildProviderRows({});
    const enabled = rows.filter((r) => r.enabled).length;
    console.log(`providers  ${rows.length} 个 · ${enabled} 已启用  —  mslxdff -provider <id> list 单看一个`);
    console.log(formatProviderSection(rows));
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
  const { handleClineLogin } = await import("./cline-login.js");
  if (await handleClineLogin(id, sub)) return true;
  const { handleWorkbuddyLogin } = await import("./workbuddy-login.js");
  if (await handleWorkbuddyLogin(id, sub, rest)) return true;
  const { handleProviderConfig } = await import("./config.js");
  if (await handleProviderConfig(id, sub, rest)) return true;
  const { handleProviderAllowlist } = await import("./allowlist.js");
  if (await handleProviderAllowlist(id, sub, rest)) return true;
  const { handleProviderModels } = await import("./models.js");
  if (await handleProviderModels(id, sub, args, rest)) return true;
  const { handleProviderBench } = await import("./bench.js");
  if (await handleProviderBench(id, sub, rest, args)) return true;
  const { handleProviderKeys } = await import("./keys.js");
  await handleProviderKeys(id, sub, rest, args);
  return true;
}
