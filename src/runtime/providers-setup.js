import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateFile, loadToken } from "../state.js";
import { createUpstreamClient } from "../upstream.js";
import { createModelsService } from "../models.js";
import { createAutoSelector } from "../auto.js";
import { createPeersService } from "../peers.js";
import { createGroupsService, createBansService } from "../groups.js";
import { logDir, appendEvent } from "../logs.js";
import { loadPlugins, runHook, resolvePluginDirs } from "../plugins.js";
import { createOpenCodeProvider } from "../providers/opencode.js";
import { loadProviderKeys, loadProviderAuths, loadProviderConfigs } from "../state.js";
import { refreshIntervalMs, modelCooldownMs, slowCooldownMs, peerCooldownMs, peerHeatMs, banWindowMs, banThreshold } from "../cli/policy.js";
import { errMsg } from "../cli/util.js";

/**
 * 世界组装 — 插件加载 → providers → models/auto/peers/groups/bans。
 * 无参（读 env/state 自身），返回 ctx 由门面接力 server-lifecycle。
 */
export async function setupProviders() {
  const { token, created } = await loadToken();
  const pkgRoot2 = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pluginDirs = resolvePluginDirs({ pkgRoot: pkgRoot2 });
  const { plugins: loadedPlugins, errors: pluginErrors } = await loadPlugins({ dirs: pluginDirs });
  for (const e of pluginErrors) {
    console.log(`plugin load failed: ${e.file} — ${e.error}`);
    appendEvent({ ts: Date.now(), type: "plugin-load-error", file: e.file, error: e.error });
  }
  if (loadedPlugins.length) {
    console.log(`plugins loaded (${loadedPlugins.length}): ${loadedPlugins.map((p) => `${p.name}${p.version ? `@${p.version}` : ""}`).join(", ")}`);
    appendEvent({ ts: Date.now(), type: "plugins-loaded", plugins: loadedPlugins.map((p) => ({ name: p.name, version: p.version })) });
  }
  const upstreamHooks = loadedPlugins.length
    ? (name, ctx) => runHook(loadedPlugins, name, ctx)
    : null;
  const providerPlugin = loadedPlugins.find((p) => typeof p.createUpstream === "function");
  let upstream;
  const baseUrl = process.env.UPSTREAM_BASE_URL || "https://opencode.ai";
  let providers = [];
  if (providerPlugin) {
    if (!upstream) {
      try {
        upstream = await providerPlugin.createUpstream({ baseUrl, authToken: process.env.UPSTREAM_AUTH_TOKEN || "public", env: process.env });
        console.log(`upstream provider replaced by plugin: ${providerPlugin.name}`);
        appendEvent({ ts: Date.now(), type: "plugin-upstream-active", plugin: providerPlugin.name });
      } catch (err) {
        console.log(`plugin upstream (${providerPlugin.name}) failed: ${errMsg(err)} — falling back to default`);
        appendEvent({ ts: Date.now(), type: "plugin-upstream-error", plugin: providerPlugin.name, error: errMsg(err) });
      }
    }
    if (!upstream) upstream = createUpstreamClient({ hooks: upstreamHooks });
  } else {
    const opencodeClient = createUpstreamClient({ hooks: upstreamHooks });
    const opencodeModels = createModelsService({
      baseUrl,
      headers: opencodeClient.headers,
      refreshMs: refreshIntervalMs(),
      cacheFile: join(logDir(), "models.json"),
    });
    providers.push(createOpenCodeProvider({ upstream: opencodeClient, modelsService: opencodeModels }));
    const orKeys = loadProviderKeys("openrouter");
    if (orKeys.length) {
      const { createOpenRouterProvider } = await import("../providers/openrouter.js");
      providers.push(createOpenRouterProvider({ apiKeys: orKeys }));
      console.log(`provider enabled: openrouter (${orKeys.length} key${orKeys.length > 1 ? "s" : ""})`);
      appendEvent({ ts: Date.now(), type: "provider-enabled", provider: "openrouter", keys: orKeys.length });
    }
    const genericConfigs = loadProviderConfigs();
    for (const [gid, cfg] of Object.entries(genericConfigs)) {
      if (gid === "opencode" || gid === "openrouter") continue;
      const base = String(cfg?.baseUrl || "").trim();
      const keys = Array.isArray(cfg?.keys) ? cfg.keys.filter((k) => typeof k === "string" && k.trim()) : [];
      const auths = Array.isArray(cfg?.auths) ? cfg.auths : [];
      // 可扩展：优先走注册表定制 provider（如 workbuddy、cline），新增供应商仅需在 registry.js 注册
      const { getCustomProviderFactory } = await import("../providers/registry.js");
      const customFactory = await getCustomProviderFactory(gid, base);
      if (customFactory) {
        if (gid === "workbuddy" && !keys.length) continue;
        if (gid !== "workbuddy" && (!base || !keys.length)) continue;
        try {
          const provider = gid === "workbuddy"
            ? await customFactory({ baseUrl: base || "https://copilot.tencent.com", apiKeys: keys, auths })
            : await customFactory({ id: gid, baseUrl: base, apiKeys: keys });
          providers.push(provider);
          console.log(`provider enabled: ${gid} (${keys.length} key${keys.length > 1 ? "s" : ""}) baseUrl=${base || provider.baseUrl} [custom]`);
          appendEvent({ ts: Date.now(), type: "provider-enabled", provider: gid, keys: keys.length, baseUrl: base || provider.baseUrl });
        } catch (err) {
          console.log(`provider ${gid} failed: ${err?.message || err}`);
          appendEvent({ ts: Date.now(), type: "provider-error", provider: gid, error: String(err?.message || err) });
        }
        continue;
      }
      if (!base || !keys.length) continue;
      try {
        const { createGenericProvider } = await import("../providers/generic.js");
        providers.push(createGenericProvider({ id: gid, baseUrl: base, apiKeys: keys }));
        console.log(`provider enabled: ${gid} (${keys.length} key${keys.length > 1 ? "s" : ""}) baseUrl=${base}`);
        appendEvent({ ts: Date.now(), type: "provider-enabled", provider: gid, keys: keys.length, baseUrl: base });
      } catch (err) {
        console.log(`provider ${gid} failed: ${err?.message || err}`);
        appendEvent({ ts: Date.now(), type: "provider-error", provider: gid, error: String(err?.message || err) });
      }
    }
    if (!genericConfigs["workbuddy"]) {
      const wbKeys = loadProviderKeys("workbuddy");
      if (wbKeys.length) {
        try {
          const { createWorkbuddyProvider } = await import("../providers/workbuddy.js");
          const wbAuths = loadProviderAuths("workbuddy");
          providers.push(createWorkbuddyProvider({ apiKeys: wbKeys, auths: wbAuths }));
          console.log(`provider enabled: workbuddy (${wbKeys.length} key${wbKeys.length > 1 ? "s" : ""}) baseUrl=https://copilot.tencent.com (env)`);
          appendEvent({ ts: Date.now(), type: "provider-enabled", provider: "workbuddy", keys: wbKeys.length, baseUrl: "https://copilot.tencent.com" });
        } catch (err) {
          console.log(`provider workbuddy failed: ${err?.message || err}`);
        }
      }
    }
    const { createProviderDispatcher } = await import("../providers/dispatcher.js");
    upstream = createProviderDispatcher(providers);
    appendEvent({ ts: Date.now(), type: "providers", providers: providers.map((p) => p.id) });
  }
  const opencodeProvider = providers.find((p) => p.id === "opencode");
  const models = createModelsService({
    providers: providers.length > 1 ? providers : undefined,
    baseUrl,
    headers: upstream.headers || opencodeProvider?.upstream?.headers,
    refreshMs: refreshIntervalMs(),
    cacheFile: join(logDir(), "models.json"),
  });
  const auto = createAutoSelector({
    cooldownMs: modelCooldownMs(),
    slowCooldownMs: slowCooldownMs(),
    file: defaultStateFile(),
    loadCandidates: async () => {
      try {
        return (await models.get()).data.map((m) => m.id);
      } catch {
        return null;
      }
    },
  });
  const peers = createPeersService({ cooldownMs: peerCooldownMs(), heatMs: peerHeatMs() });
  const groups = createGroupsService({});
  const bans = createBansService({ windowMs: banWindowMs(), threshold: banThreshold() });

  return { token, created, loadedPlugins, upstreamHooks, providerPlugin, upstream, providers, baseUrl, opencodeProvider, models, auto, peers, groups, bans };
}
