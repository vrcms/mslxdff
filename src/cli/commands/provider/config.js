export async function handleProviderConfig(id, sub, rest) {
  if (sub === "del" || sub === "delete" || sub === "rm" || sub === "remove-provider" || sub === "del-provider") {
    const nid = String(id || "").trim().toLowerCase();
    if (nid === "opencode" || nid === "oc") {
      console.error("opencode 是内置供应商，不能删除");
      process.exit(1);
    }
    const { loadProviderConfigs, saveProviderConfig, saveProviderShareKeys } = await import("../../../state.js");
    const { isPidAlive, readPid } = await import("../../../daemon.js");
    const configs = loadProviderConfigs();
    if (!configs[id] && !configs[nid]) {
      // 也查旧的 providerKeys
      const { readState } = await import("../../../state/store.js");
      const { defaultStateFile } = await import("../../../state/store.js");
      const raw = readState(defaultStateFile());
      const hasLegacy = raw.providerKeys && raw.providerKeys[id];
      if (!hasLegacy) {
        console.error(`provider not found: ${id}`);
        process.exit(1);
      }
    }
    // 真删：空对象会触发 saveProviderConfig 的 delete 分支
    saveProviderConfig(id, { baseUrl: "", keys: [], auths: [], allowedModels: [], modelsPath: "", chatPath: "" });
    // 兼容旧路径的残留
    try {
      const { readState, writeStateImmediate, defaultStateFile } = await import("../../../state/store.js");
      const file = defaultStateFile();
      const raw = readState(file);
      let changed = false;
      if (raw.providerKeys && raw.providerKeys[id] !== undefined) {
        const nk = { ...raw.providerKeys };
        delete nk[id];
        writeStateImmediate(file, { providerKeys: nk });
        changed = true;
      }
      if (raw.providerShareKeys && raw.providerShareKeys[id] !== undefined) {
        const ns = { ...raw.providerShareKeys };
        delete ns[id];
        writeStateImmediate(file, { providerShareKeys: ns });
        changed = true;
      }
      // 清理模型错误/延迟中该供应商前缀的条目（可选，不阻塞）
      void changed;
    } catch {}
    try { saveProviderShareKeys(id, false); } catch {}
    console.log(`已删除供应商: ${id} — 配置已清空`);
    // 需要重启才生效，自动重启
    const pid = readPid();
    if (pid && isPidAlive(pid)) {
      console.log("检测到 daemon 运行中，自动重启以生效…");
      const { spawnSync } = await import("node:child_process");
      const { fileURLToPath } = await import("node:url");
      const bin = fileURLToPath(new URL("../../../../bin/mslxdff.js", import.meta.url));
      const r = spawnSync(process.execPath, [bin, "-restart"], { stdio: "inherit" });
      if (r.status !== 0) console.log("自动重启失败，请手动执行: mslxdff -restart");
      else console.log("已自动重启完成");
    } else {
      console.log("daemon 未运行，下次启动时生效");
    }
    process.exit(0);
  }
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
