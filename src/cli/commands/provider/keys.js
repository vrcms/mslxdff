export async function handleProviderKeys(id, sub, rest, args) {
  if (sub === "list" || sub === "status") {
    const { loadProviderKeys, loadProviderConfig, loadProviderAllowedModels, loadProviderAllowAnyModels } = await import("../../../state.js");
    const keys = loadProviderKeys(id);
    const cfg = loadProviderConfig(id);
    const allowed = loadProviderAllowedModels(id);
    const allowAny = loadProviderAllowAnyModels(id);
    const baseUrl = cfg?.baseUrl || "";
    if (baseUrl) console.log(`provider: ${id}  baseUrl: ${baseUrl}`);
    else console.log(`provider: ${id}${id === "openrouter" ? " (built-in baseUrl: https://openrouter.ai/api/v1)" : ""}`);
    if (keys.length) {
      console.log(`  keys: ${keys.length} key${keys.length > 1 ? "s" : ""}`);
      if (id === "codearts") {
        const { accountFromBlob } = await import("../../../providers/codearts/auth-pool.js");
        for (const [i, k] of keys.entries()) {
          const a = accountFromBlob(k);
          if (a) console.log(`  [${i + 1}]  user=${a.userName || "(未识别)"} uid=${a.userId ? `${a.userId.slice(0, 8)}…` : "(空，请删了重登回填)"} domain=${a.domainId ? a.domainId.slice(0, 8) + "…" : "(空)"} (${k.length} chars)`);
          else console.log(`  [${i + 1}]  ${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`);
        }
      } else if (id === "cline") {
        const { loadProviderAuths } = await import("../../../state.js");
        const auths = loadProviderAuths(id) || [];
        const byRt = new Map(auths.map((a) => [String(a?.refreshToken || ""), String(a?.uid || "")]));
        keys.forEach((k, i) => {
          const em = byRt.get(String(k || "")) || "";
          console.log(`  [${i + 1}]  ${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)${em ? `  ${em}` : "  (邮箱未映射，重登一次回填)"}`);
        });
      } else keys.forEach((k, i) => console.log(`  [${i + 1}]  ${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`));
      console.log(`  remove by: mslxdff -provider ${id} remove <seq> [seq...] | <key-value>`);
    } else {
      console.log(`  keys: (no keys configured)`);
    }
    try {
      const { shareableProviderIds } = await import("../../../providers/share-keys.js");
      const shared = shareableProviderIds().includes(id);
      console.log(`  share keys to peers:   ${shared ? "借出（随转发自动附带，ADR-0019）" : "不借出（local-only / 硬排除，codearts/cline 恒不借，ADR-0019/0015）"}`);
    } catch { console.log(`  share keys to peers:   借出（默认，key 随转发自动附带，ADR-0019）`); }
    console.log(`  allowAnyModels: ${allowAny ? "ON (empty allowlist = allow all)" : "OFF (empty allowlist = BLOCK ALL)"}  (mslxdff -provider ${id} allowAny on|off)`);
    if (allowed.length) console.log(`  allowedModels: ${allowed.length} (${allowed.join(", ")})  — only these can be used`);
    else console.log(`  allowedModels: (none — ${allowAny ? "allow all" : "BLOCK ALL"})  (mslxdff -provider ${id} allowlist set <model...>  or  allowAny on)`);
    if (baseUrl) console.log(`  set url: mslxdff -provider ${id} set-url <baseUrl>`);
    console.log(`  NOTE: opencode is the default provider and can never be shared`);
    process.exit(0);
  }
  if (sub === "add") {
    const key = rest[1];
    if (!key) {
      console.error("usage: mslxdff -provider openrouter add <key>");
      process.exit(1);
    }
    const trimmed = String(key).trim();
    const { loadProviderKeys, loadProviderConfig, saveProviderConfig, addProviderKey, loadProviderConfigs } = await import("../../../state.js");
    const curKeys = loadProviderKeys(id);
    if (curKeys.some((k) => String(k).trim() === trimmed)) {
      console.log(`key already exists for ${id} (${trimmed.slice(0, 4)}…${trimmed.slice(-4)}), skipped — still ${curKeys.length} key(s)`);
      console.log(`  use: mslxdff -provider ${id} list  to see keys`);
      process.exit(0);
    }
    const configs = loadProviderConfigs();
    if (configs[id]) {
      const cur = loadProviderConfig(id) || { baseUrl: "", keys: [] };
      const keys = [...new Set([...(cur.keys || []), trimmed].filter(Boolean))];
      saveProviderConfig(id, { baseUrl: cur.baseUrl || "", keys });
      console.log(`added ${id} API key (now ${keys.length} total) — restart daemon to activate`);
    } else {
      const added = addProviderKey(id, key);
      console.log(`added ${id} API key (now ${added.length} total) — restart daemon to activate`);
    }
    process.exit(0);
  }
  if (sub === "remove") {
    const { loadProviderKeys, loadProviderConfig, saveProviderConfig, removeProviderKeys, loadProviderConfigs } = await import("../../../state.js");
    const targets = rest.slice(1).filter((k) => !k.startsWith("-"));
    if (!targets.length) {
      console.error("usage: mslxdff -provider openrouter remove <seq|key> [seq|key ...]   (seq = index shown by 'list')");
      process.exit(1);
    }
    const current = loadProviderKeys(id);
    const toRemove = [];
    for (const raw of targets.flatMap((t) => String(t).split(","))) {
      const t = raw.trim();
      if (!t) continue;
      if (/^\d+$/.test(t)) {
        const seq = Number(t);
        const idx2 = seq - 1;
        if (Number.isInteger(seq) && idx2 >= 0 && idx2 < current.length) toRemove.push(current[idx2]);
        else console.log(`  ! no key at sequence ${seq} (provider has ${current.length}) — skipped`);
      } else {
        toRemove.push(t);
      }
    }
    if (!toRemove.length) {
      console.log("nothing to remove");
      process.exit(0);
    }
    const configs = loadProviderConfigs();
    let remaining;
    if (configs[id]) {
      const cur = loadProviderConfig(id) || { baseUrl: "", keys: [] };
      const set = new Set([...new Set(toRemove)].map((k) => String(k).trim()));
      const keys = (cur.keys || []).filter((k) => !set.has(k));
      saveProviderConfig(id, { baseUrl: cur.baseUrl || "", keys });
      remaining = keys;
    } else {
      remaining = removeProviderKeys(id, [...new Set(toRemove)]);
    }
    console.log(`removed ${current.length - remaining.length} ${id} API key(s) (now ${remaining.length} total) — restart daemon to activate`);
    process.exit(0);
  }
  if (sub && !sub.startsWith("-")) {
    const { loadProviderKeys, loadProviderConfig, saveProviderConfig, saveProviderKeys, loadProviderConfigs } = await import("../../../state.js");
    const keys = rest.filter((k) => !k.startsWith("-"));
    if (!keys.length) {
      console.error("no key given");
      process.exit(1);
    }
    const configs = loadProviderConfigs();
    if (configs[id]) {
      const cur = loadProviderConfig(id) || { baseUrl: "", keys: [] };
      const clean = [...new Set(keys.map((k) => String(k).trim()).filter(Boolean))];
      saveProviderConfig(id, { baseUrl: cur.baseUrl || "", keys: clean });
      console.log(`set ${id} API keys (${clean.length}: ${clean.map((k) => `${k.slice(0, 4)}…${k.slice(-4)}`).join(", ")}) — restart daemon to activate`);
    } else {
      saveProviderKeys(id, keys);
      console.log(`set ${id} API keys (${keys.length}: ${keys.map((k) => `${k.slice(0, 4)}…${k.slice(-4)}`).join(", ")}) — restart daemon to activate`);
    }
    process.exit(0);
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { loadProviderKeys, addProviderKey } = await import("../../../state.js");
    const { createInterface } = await import("../../../readline-compat.js");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    console.log(`Enter ${id} API keys, one per line (input hidden). Blank line to finish:`);
    const existing = loadProviderKeys(id);
    const collected = [];
    for (;;) {
      const key = await rl.question(existing.length || collected.length ? "" : "");
      const clean = String(key || "").trim();
      if (!clean) break;
      collected.push(clean);
    }
    rl.close();
    if (!collected.length) {
      console.log("empty input — nothing changed");
      process.exit(0);
    }
    for (const k of collected) addProviderKey(id, k);
    const total = (await import("../../../state.js")).loadProviderKeys(id).length;
    console.log(`added ${collected.length} ${id} API key(s) (now ${total} total) — restart daemon to activate`);
    process.exit(0);
  }
  console.error("provide keys inline (non-TTY): mslxdff -provider openrouter <key1> [key2 ...]");
  process.exit(1);
}
