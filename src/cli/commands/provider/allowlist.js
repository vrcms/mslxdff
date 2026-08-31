export async function handleProviderAllowlist(id, sub, rest) {
  if (sub === "allowAny" || sub === "allow-any" || sub === "allow_any" || sub === "allowany") {
    const { loadProviderAllowAnyModels, saveProviderAllowAnyModels } = await import("../../../state.js");
    const on = rest[1];
    if (!on) {
      const cur = loadProviderAllowAnyModels(id);
      console.log(`allowAnyModels: ${cur ? "ON (allow all when allowlist empty)" : "OFF (empty allowlist = block all)"}`);
      console.log(`  set: mslxdff -provider ${id} allowAny on|off`);
      process.exit(0);
    }
    if (!["on", "off", "1", "0", "true", "false"].includes(String(on).toLowerCase())) {
      console.error(`usage: mslxdff -provider ${id} allowAny on|off`);
      process.exit(1);
    }
    const state = ["on", "1", "true"].includes(String(on).toLowerCase());
    saveProviderAllowAnyModels(id, state);
    console.log(`allowAnyModels: ${state ? "ON (empty allowlist = allow all)" : "OFF (empty allowlist = block all)"} — takes effect immediately (hot-reloaded)`);
    process.exit(0);
  }
  if (sub === "allowlist" || sub === "allow" || sub === "allowed" || sub === "whitelist") {
    const { loadProviderAllowedModels, saveProviderAllowedModels, loadProviderConfig, loadProviderAllowAnyModels } = await import("../../../state.js");
    const action = rest[1];
    const rawTargets = rest.slice(2);
    if (!action || action === "list" || action === "status") {
      const list = loadProviderAllowedModels(id);
      const cfg = loadProviderConfig(id);
      const baseUrl = cfg?.baseUrl || "";
      const allowAny = loadProviderAllowAnyModels(id);
      console.log(`provider: ${id}${baseUrl ? `  baseUrl: ${baseUrl}` : ""}`);
      if (!list.length) {
        if (allowAny) {
          console.log(`  allowedModels: (none — allow all, because allowAny=ON)`);
          console.log(`  to secure: mslxdff -provider ${id} allowAny off  or  mslxdff -provider ${id} allowlist set <model1> <model2> ...`);
        } else {
          console.log(`  allowedModels: (none — BLOCK ALL, provider disabled until allowlist set or allowAny ON)`);
          console.log(`  set via: mslxdff -provider ${id} allowlist set <model1> <model2> ...`);
          console.log(`  or:      mslxdff -provider ${id} allowAny on   (allow all when allowlist empty)`);
        }
      } else {
        console.log(`  allowedModels: ${list.length} model${list.length > 1 ? "s" : ""} (only these can be used)`);
        list.forEach((m, i) => console.log(`  [${i + 1}]  ${m}`));
        console.log(`  manage: mslxdff -provider ${id} allowlist add <model> | remove <model> | set <m1> <m2> ... | clear`);
        console.log(`  allowAny: ${allowAny ? "ON" : "OFF"} (empty list behavior) — mslxdff -provider ${id} allowAny on|off`);
      }
      console.log(`  NOTE: empty allowlist + allowAny OFF = 403 block (hot-reloaded, no restart needed)`);
      process.exit(0);
    }
    if (action === "clear") {
      saveProviderAllowedModels(id, []);
      const allowAny = loadProviderAllowAnyModels(id);
      console.log(`cleared ${id} allowlist (now ${allowAny ? "allow all (allowAny ON)" : "BLOCK ALL (allowAny OFF)"}) — takes effect immediately (hot-reloaded)`);
      process.exit(0);
    }
    if (action === "set") {
      const models = rawTargets.filter((x) => x && !String(x).startsWith("-")).map((m) => String(m).trim()).filter(Boolean);
      const flat = models.flatMap((m) => String(m).split(",")).map((m) => m.trim()).filter(Boolean);
      if (!flat.length) {
        console.error(`usage: mslxdff -provider ${id} allowlist set <model1> <model2> ...`);
        process.exit(1);
      }
      const saved = saveProviderAllowedModels(id, flat);
      console.log(`set ${id} allowlist: ${saved.length} model${saved.length > 1 ? "s" : ""} (${saved.join(", ")}) — takes effect immediately (hot-reloaded)`);
      process.exit(0);
    }
    if (action === "add") {
      const models = rawTargets.filter((x) => x && !String(x).startsWith("-")).map((m) => String(m).trim()).filter(Boolean);
      const flat = models.flatMap((m) => String(m).split(",")).map((m) => m.trim()).filter(Boolean);
      if (!flat.length) {
        console.error(`usage: mslxdff -provider ${id} allowlist add <model> [model2 ...]`);
        process.exit(1);
      }
      const cur = loadProviderAllowedModels(id);
      const next = [...new Set([...cur, ...flat])];
      saveProviderAllowedModels(id, next);
      console.log(`added ${flat.length} model${flat.length > 1 ? "s" : ""} to ${id} allowlist (now ${next.length}: ${next.join(", ")}) — takes effect immediately (hot-reloaded)`);
      process.exit(0);
    }
    if (action === "remove" || action === "rm" || action === "del") {
      const models = rawTargets.filter((x) => x && !String(x).startsWith("-")).map((m) => String(m).trim()).filter(Boolean);
      const flat = models.flatMap((m) => String(m).split(",")).map((m) => m.trim()).filter(Boolean);
      if (!flat.length) {
        console.error(`usage: mslxdff -provider ${id} allowlist remove <model> [model2 ...]`);
        process.exit(1);
      }
      const cur = loadProviderAllowedModels(id);
      const set = new Set(flat);
      const next = cur.filter((m) => !set.has(m));
      saveProviderAllowedModels(id, next);
      const { loadProviderAllowAnyModels: _la } = await import("../../../state.js");
      const _allowAny = _la(id);
      console.log(`removed ${cur.length - next.length} model${cur.length - next.length !== 1 ? "s" : ""} from ${id} allowlist (now ${next.length ? next.join(", ") : (_allowAny ? "(allow all)" : "(BLOCK ALL)")}) — takes effect immediately (hot-reloaded)`);
      process.exit(0);
    }
    console.error(`usage: mslxdff -provider ${id} allowlist [list|set|add|remove|clear] [models...]`);
    console.error(`       mslxdff -provider ${id} allowAny on|off   (empty allowlist = block or allow all)`);
    process.exit(1);
  }
  return false;
}
