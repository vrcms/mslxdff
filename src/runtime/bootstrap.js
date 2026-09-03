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

  // Robust ready: if EADDRINUSE (bare daemon still holds port), kill holders and retry once
  try {
    await srv.ready();
  } catch (err) {
    const msg = String(err?.message || err);
    const code = err?.code || "";
    if (code === "EADDRINUSE" || msg.includes("EADDRINUSE")) {
      console.log(`port ${resolvePort()} in use — freeing stale holder and retrying...`);
      try {
        const { execFile } = await import("node:child_process");
        const execAsync2 = (f, a) => new Promise((res) => execFile(f, a, { windowsHide: true, timeout: 4000 }, (e, so, se) => res({ e, so: String(so||""), se: String(se||"") })));
        const port = resolvePort();
        // kill via ss parse (same as autostart)
        const ss1 = await execAsync2("ss", ["-lptn", `sport = :${port}`]);
        const out = ss1.so || "";
        const pids = new Set();
        let m;
        const re = /pid=(\d+)/g;
        while ((m = re.exec(out))) pids.add(Number(m[1]));
        if (!pids.size) {
          const ss2 = await execAsync2("ss", ["-lptn"]);
          for (const line of (ss2.so||"").split("\n")) {
            if (!line.includes(`:${port}`)) continue;
            let m2; const re2 = /pid=(\d+)/g;
            while ((m2 = re2.exec(line))) pids.add(Number(m2[1]));
          }
        }
        for (const p of pids) { if (p !== process.pid) try { process.kill(p, "SIGTERM"); } catch {} }
        if (pids.size) await new Promise((r2) => setTimeout(r2, 600));
        for (const p of pids) try { const { isPidAlive } = await import("../daemon.js"); if (isPidAlive(p)) process.kill(p, "SIGKILL"); } catch {}
        try { await execAsync2("fuser", ["-k", `${port}/tcp`]); } catch {}
        for (let i=0;i<10;i++) {
          const chk = await execAsync2("ss", ["-ltn"]);
          if (!chk.so.includes(`:${port}`)) break;
          await new Promise((r2)=>setTimeout(r2,200));
        }
      } catch {}
      await srv.ready();
    } else throw err;
  }

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

  // best-effort: ensure autostart on Linux (so daemon survives reboot/SSH disconnect without manual cmd)
  if (process.platform === "linux" && !process.env.MSLXDFF_NO_AUTOSTART) {
    setTimeout(async () => {
      try {
        const { getAutostartStatus, enableAutostart } = await import("../autostart.js");
        const st = await getAutostartStatus();
        if (!st.enabled) {
          const r = await enableAutostart();
          if (r.ok) {
            console.log(`autostart auto-enabled: ${r.method}${r.linger ? ` linger=${r.linger}` : ""}`);
            try { bus?.emit({ ts: Date.now(), type: "autostart-auto-enabled", method: r.method }); } catch {}
            try { appendEvent({ ts: Date.now(), type: "autostart-auto-enabled", method: r.method }); } catch {}
          } else {
            console.log(`autostart auto-enable failed: ${r.error || "unknown"} (run mslxdff -enable-autostart manually)`);
          }
        }
      } catch {}
    }, 2500).unref?.();
  }

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
    const streamEnabled = (() => {
      const v = process.env.MSLXDFF_BROADBAND_STREAM;
      if (v === "0" || v === "false" || v === "off") return false;
      return true;
    })();
    const execAndPost = async (g, reqId, body) => {
          let result;
      try {
        const upRes = await upstream.chat(body);
        const ct = upRes.headers.get("content-type") || "";
        const isStream = Boolean(body?.stream) || ct.includes("text/event-stream");
        if (isStream && upRes.body) {
          let collected = "";
          for await (const chunk of upRes.body) {
            if (typeof chunk === "string") collected += chunk;
            else if (Buffer.isBuffer(chunk)) collected += chunk.toString("utf8");
            else if (chunk instanceof Uint8Array) collected += Buffer.from(chunk).toString("utf8");
            else collected += String(chunk);
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
    };
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
            await execAndPost(g, reqId, body);
          }
        } catch {}
      }
    };
    if (!streamEnabled) {
      doHeartbeat().catch(() => {});
      const hbTimer = setInterval(doHeartbeat, 30_000);
      hbTimer.unref();
      const pollTimer = setInterval(doPoll, 1000);
      pollTimer.unref();
      console.log(`broadband relay: heartbeat 30s + poll 1s for ${broadbandGroups().length} group(s) [poll mode]`);
    } else {
      const streamManagers = new Map();
      const startStreamForGroup = (g) => {
        if (streamManagers.has(g.name)) return;
        let attempts = 0;
        let abort = null;
        let stopped = false;
        const connect = async () => {
          if (stopped) return;
          const url = `${g.leaderUrl}/v1/groups/relay/stream?name=${encodeURIComponent(g.name)}`;
          const controller = new AbortController();
          abort = controller;
          try {
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
              signal: controller.signal,
            });
            if (!res.ok) throw new Error(`stream ${res.status}`);
            if (!res.body) throw new Error("no body");
            attempts = 0;
            let buf = "";
            const decodeChunk = (c) => {
              if (typeof c === "string") return c;
              if (Buffer.isBuffer(c)) return c.toString("utf8");
              if (c instanceof Uint8Array) return Buffer.from(c).toString("utf8");
              return String(c);
            };
            for await (const chunk of res.body) {
              buf += decodeChunk(chunk);
              let idx;
              while ((idx = buf.indexOf("\n\n")) >= 0) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (!raw || raw.startsWith(":")) continue;
                let event = "message";
                let data = "";
                for (const line of raw.split("\n")) {
                  if (line.startsWith("event:")) event = line.slice(6).trim();
                  else if (line.startsWith("data:")) data += line.slice(5).trim();
                }
                if (event === "relay" && data) {
                  try {
                    const parsed = JSON.parse(data);
                    const { reqId, body } = parsed;
                    if (reqId && body) execAndPost(g, reqId, body).catch(() => {});
                  } catch {}
                }
              }
            }
            throw new Error("stream ended");
          } catch (err) {
            if (stopped) return;
            const msg = errMsg(err);
            if (!String(msg).includes("abort") && !String(msg).includes("Abort")) console.log(`broadband stream ${g.name}: ${msg} — reconnecting`);
            attempts++;
            const delay = Math.min(30_000, 1000 * Math.pow(2, attempts - 1) + Math.random() * 500);
            await new Promise((r) => setTimeout(r, delay));
            connect();
          }
        };
        streamManagers.set(g.name, { stop: () => { stopped = true; abort?.abort(); } });
        connect();
      };
      for (const g of broadbandGroups()) startStreamForGroup(g);
      const ensureTimer = setInterval(() => {
        for (const g of broadbandGroups()) if (!streamManagers.has(g.name)) startStreamForGroup(g);
      }, 10_000);
      ensureTimer.unref();
      console.log(`broadband relay: stream (SSE) + ping 25s for ${broadbandGroups().length} group(s)`);
    }
  }

  const { setupAutoUpdate } = await import("./auto-update.js");
  setupAutoUpdate({ VERSION, bus, logs });
}


