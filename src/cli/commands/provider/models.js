import { join } from "node:path";
import { defaultStateFile } from "../../../state.js";
import { logDir } from "../../../logs.js";

export async function handleProviderModels(id, sub, args, rest) {
  if (!(sub === "models" || sub === "show-models" || sub === "list-models" || sub === "ls")) return false;
  const { loadProviderConfig, loadProviderKeys, isModelAllowed } = await import("../../../state.js");
  const wantsJson = args.includes("--json") || args.includes("-json");
  const cfg = loadProviderConfig(id);
  if (id === "opencode" || id === "oc") {
    try {
      const cacheFile = join(logDir(), "models.json");
      const { readFileSync } = await import("node:fs");
      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      const ids = (raw.data || []).map((m) => m.id).filter((x) => !String(x).includes("/"));
      if (wantsJson) {
        console.log(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }, null, 2));
      } else {
        console.log(`opencode models (${ids.length}):`);
        for (const mid of ids) console.log(`  ${mid}`);
      }
    } catch (e) {
      console.error(`could not read models cache: ${String(e?.message || e)}`);
      process.exit(1);
    }
    process.exit(0);
  }
  try {
    const { createGenericProvider } = await import("../../../providers/generic.js");
    const { createWorkbuddyProvider } = await import("../../../providers/workbuddy.js");
    const baseUrl = cfg?.baseUrl || (id === "workbuddy" ? "https://copilot.tencent.com" : "");
    const keys = loadProviderKeys(id);
    const auths = cfg?.auths || [];
    let provider;
    if (id === "workbuddy") {
      provider = createWorkbuddyProvider({ baseUrl, apiKeys: keys, auths, file: defaultStateFile() });
    } else {
      if (!baseUrl) {
        console.error(`provider ${id}: missing baseUrl — set via: mslxdff -provider ${id} set-url <baseUrl>`);
        process.exit(1);
      }
      provider = createGenericProvider({ id, baseUrl, apiKeys: keys, file: defaultStateFile() });
    }
    const all = await provider.listModels();
    const markAllowed = (mid) => {
      const raw = String(mid || "").includes("/") ? String(mid).split("/").slice(1).join("/") : String(mid);
      const checkRaw = mid.startsWith(`${id}/`) ? mid.slice(id.length + 1) : raw;
      return isModelAllowed(id, checkRaw);
    };
    if (wantsJson) {
      const filtered = all.filter((m) => markAllowed(m.id));
      console.log(JSON.stringify({ object: "list", data: filtered }, null, 2));
    } else {
      const allowedCount = all.filter((m) => markAllowed(m.id)).length;
      console.log(`${id} models (${all.length} total, ${allowedCount} ✓ allowed${allowedCount !== all.length ? `, ${all.length - allowedCount} x blocked by allowlist` : ""}):`);
      const fmtPrice = (m) => {
        const c = String(m.credits || "").trim();
        if (c) {
          const m0 = c.match(/x\s*([\d.]+)/i);
          if (m0) return `x${m0[1]}`;
          return c.replace(/\s*credits\s*/gi, "").trim().replace(/\s+/g, " ");
        }
        if (m.pricing && typeof m.pricing === "object") {
          const p = m.pricing.prompt ?? m.pricing.input ?? m.pricing.completion ?? "";
          if (p) return String(p);
        }
        if (m.price != null && String(m.price).trim()) return String(m.price).trim();
        if (String(m.id).endsWith("/auto")) return "浮动";
        return "—";
      };
      const fmtBadge = (m) => {
        const tags = Array.isArray(m.tags) ? m.tags : [];
        const b = tags.find((t) => String(t).includes("限时免费") || String(t).toLowerCase().includes("free"));
        if (!b) return "";
        const part = String(b).split(":")[1];
        return part ? ` [${part}]` : ` [${b}]`;
      };
      const idW = Math.max(22, ...all.map((m) => String(m.id).length)) + 2;
      const priceW = Math.max(6, ...all.map((m) => fmtPrice(m).length)) + 2;
      for (const m of all) {
        const ok = markAllowed(m.id);
        const price = fmtPrice(m);
        const badge = fmtBadge(m);
        const name = m.name ? ` ${m.name}` : "";
        const blocked = ok ? "" : "  [blocked — allowlist]";
        const line = `  ${ok ? "✓" : "x"} ${String(m.id).padEnd(idW)}${String(price).padEnd(priceW)}${name}${badge}${blocked}`;
        console.log(line);
      }
      if (!all.length) console.log(`  (no models — check baseUrl/keys or try: curl ${baseUrl}/models)`);
      else if (allowedCount === 0) console.log(`  tip: all blocked — mslxdff -provider ${id} allowAny on  或  allowlist set <model...>`);
      else if (allowedCount !== all.length) console.log(`  tip: blocked 仅影响 /v1/chat 调用，展示已全量列出`);
    }
    try { await provider.close?.(); } catch {}
  } catch (e) {
    console.error(`could not list ${id} models: ${String(e?.message || e)}`);
    process.exit(1);
  }
  process.exit(0);
}
