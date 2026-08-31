import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.js";
import { defaultStateFile } from "../state.js";
import { createRouter } from "../routes.js";
import { createUpstreamClient } from "../upstream.js";
import { createModelsService } from "../models.js";
import { loadToken } from "../state.js";
import { createAutoSelector } from "../auto.js";
import { createPeersService } from "../peers.js";
import { createEventBus } from "../events.js";
import { createGroupsService, createBansService, refreshGroupMembers, syncPeersFromMembers } from "../groups.js";
import { logDir, appendCall, appendError, appendEvent } from "../logs.js";
import { loadPlugins, runHook, resolvePluginDirs } from "../plugins.js";
import { createOpenCodeProvider } from "../providers/opencode.js";
import { loadProviderKeys, loadProviderAuths, loadProviderConfigs } from "../state.js";
import { effectiveHost, refreshIntervalMs, modelCooldownMs, slowCooldownMs, peerCooldownMs, peerHeatMs, maxHopsValue, groupSyncIntervalMs, autoUpdateIntervalMs, banWindowMs, banThreshold } from "../cli/policy.js";
import { fmtEvent } from "../cli/format.js";
import { errMsg, npmCmd, run } from "../cli/util.js";
import { loadGroupsJoined } from "../state.js";
import { writePid } from "../daemon.js";
import { resolvePort } from "../server.js";

const logs = { appendCall, appendError, appendEvent };

export async function startDaemonMain(VERSION) {
  const { token, created } = await loadToken();
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  // src/cli/bootstrap.js -> 2 levels up to src, then 1 to root
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
      if (gid === "workbuddy") {
        const base = String(cfg?.baseUrl || "").trim() || "https://copilot.tencent.com";
        const keys = Array.isArray(cfg?.keys) ? cfg.keys.filter((k) => typeof k === "string" && k.trim()) : [];
        const auths = Array.isArray(cfg?.auths) ? cfg.auths : [];
        if (!keys.length) continue;
        try {
          const { createWorkbuddyProvider } = await import("../providers/workbuddy.js");
          providers.push(createWorkbuddyProvider({ baseUrl: base, apiKeys: keys, auths }));
          console.log(`provider enabled: workbuddy (${keys.length} key${keys.length > 1 ? "s" : ""}) baseUrl=${base}`);
          appendEvent({ ts: Date.now(), type: "provider-enabled", provider: gid, keys: keys.length, baseUrl: base });
        } catch (err) {
          console.log(`provider ${gid} failed: ${err?.message || err}`);
          appendEvent({ ts: Date.now(), type: "provider-error", provider: gid, error: String(err?.message || err) });
        }
        continue;
      }
      const base = String(cfg?.baseUrl || "").trim();
      const keys = Array.isArray(cfg?.keys) ? cfg.keys.filter((k) => typeof k === "string" && k.trim()) : [];
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

  const isDebug = process.env.MSLXDFF_DEBUG === "1";
  const bus = createEventBus();

  try {
    const { loadModelAliases } = await import("../providers/model-id.js");
    loadModelAliases();
  } catch {}

  const router = createRouter({ token, upstream, models, auto, logs, peers, maxHops: maxHopsValue(), groups, bans, bus, plugins: loadedPlugins });
  const listenHost = effectiveHost();
  const srv = startServer({
    router,
    signals: !isDebug,
    host: listenHost,
    onBeforeClose: loadedPlugins.length
      ? () => runHook(loadedPlugins, "server:stop", { version: VERSION }).then(() => {})
      : undefined,
  });

  if (isDebug) {
    bus.subscribe((e) => {
      try {
        console.log(fmtEvent(e));
      } catch {}
    });
    const { startDaemon: sd } = await import("../daemon.js");
    const restore2 = () => {
      console.log("\n[debug] restoring background daemon...");
      try {
        const restoredPid = sd([]);
        console.log(`[debug] daemon restored (pid ${restoredPid})`);
      } catch (err) {
        console.error(`[debug] could not restore daemon: ${err.message}`);
      }
      setTimeout(() => process.exit(0), 300);
    };
    process.on("SIGINT", restore2);
    process.on("SIGTERM", restore2);
  }

  await srv.ready();

  if (loadedPlugins.length) {
    runHook(loadedPlugins, "server:start", { port: srv.server.address()?.port, host: listenHost, version: VERSION }).catch(() => {});
    const eventPlugins = loadedPlugins.filter((p) => typeof p.onEvent === "function");
    if (eventPlugins.length) {
      bus.subscribe((e) => {
        for (const p of eventPlugins) {
          try { p.onEvent(e); } catch {}
        }
      });
    }
  }

  setTimeout(() => {
    upstream.preheat().then((r) => {
      const entry = { ts: Date.now(), type: "upstream-preheat", ...r, baseUrl };
      try { bus.emit(entry); } catch {}
      try { logs.appendEvent(entry); } catch {}
      if (r.skipped) console.log(`[preheat] skipped (MSLXDFF_PREHEAT disabled)`);
      else if (r.ok) console.log(`[preheat] opencode models ok ${r.status} ${r.ms}ms`);
      else console.log(`[preheat] opencode models failed ${r.error || r.status || ""} ${r.ms || 0}ms`);
    }).catch(() => {});
  }, 100).unref?.();

  models.startAutoRefresh();
  if (process.env.MSLXDFF_DAEMON) {
    writePid(process.pid, VERSION);
  }
  const addr = srv.server.address();
  const host = addr.address === "0.0.0.0" || addr.address === "::" ? "localhost" : addr.address;
  console.log(`mslxdff v${VERSION} listening on http://${host}:${addr.port}`);
  if (created) {
    console.log(`auth token: ${token}`);
  }
  console.log(`endpoint:   http://${host}:${addr.port}/v1`);
  try {
    const { hedgeDelayMs } = await import("../routes/hedge.js");
    const hd = hedgeDelayMs();
    console.log(`hedge:      ${hd ? `${hd}ms` : "off"} (MSLXDFF_HEDGE_DELAY_MS)`);
  } catch {}

  // group sync
  const { syncAllJoinedGroups } = await import("../cli/group-helpers.js");
  syncAllJoinedGroups({ peers, groups })
    .then((results) => {
      for (const r of results) {
        if (r.error) console.log(`group sync ${r.name}: failed — ${r.error}`);
        else console.log(`group sync ${r.name}: ${r.total} member(s), ${r.added} peer(s)`);
      }
    })
    .catch((err) => console.log(`group sync: ${errMsg(err)}`));
  const groupSyncTimer = setInterval(() => {
    syncAllJoinedGroups({ peers, groups })
      .then((results) => {
        for (const r of results) {
          if (r.error) console.log(`group sync ${r.name}: failed — ${r.error}`);
          else if (r.added) console.log(`group sync ${r.name}: ${r.total} member(s), ${r.added} peer(s)`);
        }
      })
      .catch((err) => console.log(`group sync: ${errMsg(err)}`));
  }, groupSyncIntervalMs());
  groupSyncTimer.unref();

  const broadbandGroups = () => loadGroupsJoined().filter((g) => g.kind === "broadband" && g.leaderUrl);
  if (broadbandGroups().length) {
    const doHeartbeat = async () => {
      for (const g of broadbandGroups()) {
        try {
          const res = await fetch(`${g.leaderUrl}/v1/groups/relay/heartbeat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ name: g.name, group: g.name }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            console.log(`broadband heartbeat ${g.name}: ${res.status} ${txt.slice(0, 100)}`);
          }
        } catch (err) {
          console.log(`broadband heartbeat ${g.name}: failed — ${errMsg(err)}`);
        }
      }
    };
    const doPoll = async () => {
      for (const g of broadbandGroups()) {
        try {
          const pollRes = await fetch(`${g.leaderUrl}/v1/groups/relay/poll`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ name: g.name, group: g.name }),
            signal: AbortSignal.timeout(8000),
          });
          if (!pollRes.ok) continue;
          const data = await pollRes.json().catch(() => ({}));
          const items = data.data || [];
          for (const item of items) {
            const { reqId, body } = item;
            let result;
            try {
              const upRes = await upstream.chat(body);
              const ct = upRes.headers.get("content-type") || "";
              const isStream = Boolean(body?.stream) || ct.includes("text/event-stream");
              if (isStream && upRes.body) {
                let collected = "";
                for await (const chunk of upRes.body) {
                  collected += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
                }
                result = { status: upRes.status, headers: { "Content-Type": "text/event-stream" }, body: collected };
              } else {
                const txt = await upRes.text();
                let parsed;
                try { parsed = JSON.parse(txt); } catch { parsed = txt; }
                result = { status: upRes.status, headers: { "Content-Type": upRes.headers.get("content-type") || "application/json" }, body: typeof parsed === "string" ? parsed : JSON.stringify(parsed) };
              }
            } catch (err) {
              result = { status: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: errMsg(err) }) };
            }
            try {
              await fetch(`${g.leaderUrl}/v1/groups/relay/result`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                body: JSON.stringify({ name: g.name, group: g.name, reqId, result }),
                signal: AbortSignal.timeout(5000),
              });
            } catch {}
          }
        } catch {}
      }
    };
    doHeartbeat().catch(() => {});
    const hbTimer = setInterval(doHeartbeat, 30_000);
    hbTimer.unref();
    const pollTimer = setInterval(doPoll, 1000);
    pollTimer.unref();
    console.log(`broadband relay: heartbeat 30s + poll 1s for ${broadbandGroups().length} group(s)`);
  }

  const autoUpdateMs = autoUpdateIntervalMs();
  function emitAutoUpdate(type, data = {}) {
    const entry = { ts: Date.now(), type, ...data };
    try { bus?.emit(entry); } catch {}
    try { logs?.appendEvent?.(entry); } catch {}
    const line = `[auto-update] ${type} ${JSON.stringify(data)}`;
    console.log(line);
  }
  if (autoUpdateMs) {
    console.log(`auto-update enabled: checking every ${Math.round(autoUpdateMs / 60000)}m`);
    emitAutoUpdate("auto-update-enabled", { intervalMs: autoUpdateMs, current: VERSION });
    setTimeout(() => {
      emitAutoUpdate("auto-update-check", { current: VERSION });
      checkAndAutoUpdate().catch((err) => {
        console.log(`auto-update check failed: ${errMsg(err)}`);
        emitAutoUpdate("auto-update-failed", { error: errMsg(err) });
      });
    }, 30_000).unref?.();
    const autoUpdateTimer = setInterval(() => {
      emitAutoUpdate("auto-update-check", { current: VERSION });
      checkAndAutoUpdate().catch((err) => {
        console.log(`auto-update check failed: ${errMsg(err)}`);
        emitAutoUpdate("auto-update-failed", { error: errMsg(err) });
      });
    }, autoUpdateMs);
    autoUpdateTimer.unref();
  } else {
    console.log(`auto-update disabled (set MSLXDFF_AUTO_UPDATE=1 to enable hourly)`);
    emitAutoUpdate("auto-update-disabled", { current: VERSION });
  }

  async function checkAndAutoUpdate() {
    emitAutoUpdate("auto-update-query", { current: VERSION });
    const info = await run(npmCmd(), ["view", "mslxdff", "dist-tags.latest", "--json"]);
    if (info.err) {
      emitAutoUpdate("auto-update-query-failed", { error: info.err.message || String(info.stderr || "").slice(0, 500) });
      throw new Error(info.err.message || String(info.stderr || "").slice(0, 500));
    }
    let latest = "";
    try {
      latest = JSON.parse(String(info.stdout || "").trim());
      if (Array.isArray(latest)) latest = latest[latest.length - 1];
      latest = String(latest || "").replace(/^v/, "").trim();
    } catch {
      const raw = String(info.stdout || "").trim();
      const m = raw.match(/(\d+\.\d+\.\d+[^\s'"]*)/);
      latest = m ? m[1] : raw.split(/\s+/).pop()?.replace(/['"]/g, "") || "";
    }
    latest = latest.replace(/['"]/g, "").trim();
    emitAutoUpdate("auto-update-queried", { current: VERSION, latest, stdout: String(info.stdout || "").trim().slice(0, 200) });
    if (!latest || latest === VERSION) {
      emitAutoUpdate("auto-update-noop", { current: VERSION, latest });
      return;
    }
    const { compareSemver } = await import("../cli/policy.js");
    if (compareSemver(latest, VERSION) <= 0) {
      emitAutoUpdate("auto-update-noop", { current: VERSION, latest, reason: "not newer" });
      return;
    }
    emitAutoUpdate("auto-update-found", { current: VERSION, latest });
    console.log(`auto-update: v${VERSION} -> v${latest}, installing...`);
    emitAutoUpdate("auto-update-installing", { current: VERSION, latest });
    const up = await run(npmCmd(), ["install", "-g", `mslxdff@${latest}`]);
    if (up.err) {
      emitAutoUpdate("auto-update-install-failed", { current: VERSION, latest, error: up.err.message || String(up.stderr || "").slice(0, 500) });
      throw new Error(up.err.message || String(up.stderr || "").slice(0, 500));
    }
    emitAutoUpdate("auto-update-installed", { current: VERSION, latest, stdout: String(up.stdout || "").slice(0, 500) });
    console.log(`auto-update: installed v${latest}, restarting daemon...`);
    emitAutoUpdate("auto-update-restarting", { current: VERSION, latest });
    const { stopDaemon, startDaemon } = await import("../daemon.js");
    try { stopDaemon(); } catch (e) { emitAutoUpdate("auto-update-stop-failed", { error: errMsg(e) }); }
    const { waitForHealth } = await import("../cli/policy.js");
    const newPid = startDaemon([]);
    await waitForHealth(resolvePort(), 8000);
    console.log(`auto-update: restarted as v${latest} (pid ${newPid})`);
    emitAutoUpdate("auto-update-restarted", { current: VERSION, latest, newPid });
  }
}


