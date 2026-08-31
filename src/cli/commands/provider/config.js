export async function handleProviderConfig(id, sub, rest) {
  if (sub === "set-models-path" || sub === "setModelsPath" || sub === "models-path") {
    const p = rest[1];
    if (!p) {
      console.error(`usage: mslxdff -provider ${id} set-models-path <path>  (e.g. /v1/models)`);
      process.exit(1);
    }
    if (!String(p).trim().startsWith("/")) {
      console.error(`invalid modelsPath: ${p} (must start with /)`);
      process.exit(1);
    }
    const { loadProviderConfig, saveProviderConfig } = await import("../../../state.js");
    const cur = loadProviderConfig(id) || { baseUrl: "", keys: [] };
    const { normalizeProviderId } = await import("../../../providers/model-id.js");
    const nid = normalizeProviderId(id);
    saveProviderConfig(nid || id, { baseUrl: cur.baseUrl || "", keys: cur.keys || [], modelsPath: String(p).trim() });
    console.log(`set ${nid || id} modelsPath: ${String(p).trim()} — restart daemon to activate`);
    process.exit(0);
  }
  if (sub === "set-chat-path" || sub === "setChatPath" || sub === "chat-path") {
    const p = rest[1];
    if (!p) {
      console.error(`usage: mslxdff -provider ${id} set-chat-path <path>  (e.g. /v1/chat/completions)`);
      process.exit(1);
    }
    if (!String(p).trim().startsWith("/")) {
      console.error(`invalid chatPath: ${p} (must start with /)`);
      process.exit(1);
    }
    const { loadProviderConfig, saveProviderConfig } = await import("../../../state.js");
    const cur = loadProviderConfig(id) || { baseUrl: "", keys: [] };
    const { normalizeProviderId } = await import("../../../providers/model-id.js");
    const nid = normalizeProviderId(id);
    saveProviderConfig(nid || id, { baseUrl: cur.baseUrl || "", keys: cur.keys || [], chatPath: String(p).trim() });
    console.log(`set ${nid || id} chatPath: ${String(p).trim()} — restart daemon to activate`);
    process.exit(0);
  }
  if (sub === "clear") {
    const { loadProviderConfigs, loadProviderConfig, saveProviderConfig, saveProviderKeys } = await import("../../../state.js");
    const configs = loadProviderConfigs();
    if (configs[id]) {
      saveProviderConfig(id, { baseUrl: "", keys: [] });
    } else {
      saveProviderKeys(id, []);
    }
    console.log(`cleared ${id} API keys (provider disabled on next daemon start)`);
    process.exit(0);
  }
  if (sub === "set-url" || sub === "setUrl" || sub === "url") {
    const url = rest[1];
    if (!url) {
      console.error(`usage: mslxdff -provider ${id} set-url <baseUrl>`);
      process.exit(1);
    }
    if (!/^https?:\/\/.+/.test(String(url).trim())) {
      console.error(`invalid baseUrl: ${url} (must start with http:// or https://)`);
      process.exit(1);
    }
    const { loadProviderConfig, saveProviderConfig } = await import("../../../state.js");
    const cur = loadProviderConfig(id) || { baseUrl: "", keys: [] };
    saveProviderConfig(id, { baseUrl: String(url).trim(), keys: cur.keys || [] });
    console.log(`set ${id} baseUrl: ${String(url).trim().replace(/\/+$/, "")} — restart daemon to activate`);
    process.exit(0);
  }
  if (sub === "share") {
    const { loadProviderShareKeys, saveProviderShareKeys } = await import("../../../state.js");
    const on = rest[1];
    if (!on) {
      console.log(`share keys to peers: ${loadProviderShareKeys(id) ? "ON" : "off"}`);
      process.exit(0);
    }
    if (!["on", "off", "1", "0", "true", "false"].includes(String(on).toLowerCase())) {
      console.error("usage: mslxdff -provider openrouter share on|off");
      process.exit(1);
    }
    const state = ["on", "1", "true"].includes(String(on).toLowerCase());
    saveProviderShareKeys(id, state);
    console.log(`share keys to peers: ${state ? "ON" : "off"} — restart daemon to activate`);
    process.exit(0);
  }
  return false;
}
