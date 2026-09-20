import { startServer, resolvePort } from "../server.js";
import { createRouter } from "../routes.js";
import { createEventBus } from "../events.js";
import { runHook } from "../plugins.js";
import { effectiveHost, maxHopsValue } from "../cli/policy.js";
import { fmtEvent } from "../cli/format.js";
import { writePid } from "../daemon.js";

/**
 * 服务生命周期 — router 装配 → server 创建/ready-EADDRINUSE 自愈 →
 * plugin 事件 → preheat → pid/监听日志 → autostart。返回 { srv, bus, router }。
 */
export async function startServerLifecycle({ VERSION, token, created, upstream, models, auto, peers, groups, bans, loadedPlugins, baseUrl, logs }) {
  const bus = createEventBus();

  try {
    const { loadModelAliases } = await import("../providers/model-id.js");
    loadModelAliases();
  } catch {}

  const router = createRouter({ token, upstream, models, auto, logs, peers, maxHops: maxHopsValue(), groups, bans, bus, plugins: loadedPlugins });
  const listenHost = effectiveHost();
  const isDebug = process.env.MSLXDFF_DEBUG === "1";
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
    const restore2 = async () => {
      console.log("\n[debug] restoring background daemon...");
      try { await srv.close(); } catch {} // 先释放端口，避免恢复的 daemon 抢端口互杀
      if (process.platform === "linux") {
        try {
          const { execFile } = await import("node:child_process");
          const ok = await new Promise((res) => execFile("systemctl", ["--user", "start", "mslxdff"], { windowsHide: true, timeout: 8000 }, (e) => res(!e)));
          if (ok) { console.log("[debug] systemd user service restarted (mslxdff)"); setTimeout(() => process.exit(0), 300); return; }
        } catch {}
      }
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
      console.log(`[lifecycle] EADDRINUSE on port ${resolvePort()} — freeing stale holder and retrying...`);
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
        if (pids.size) console.log(`[lifecycle] killing stale holder(s): ${[...pids].join(",")} (self=${process.pid})`);
        else console.log(`[lifecycle] no holder pid discoverable (ss/fuser unavailable on this platform?) — retry may fail`);
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
    // cline free 目录自检（独立于 opencode 连接预热：dispatcher.preheat 只做默认供应商）
    // 见 .agents/notes/implemented/simplification/2026-09-16-preheat-opencode-only.md
    try {
      const cline = upstream?.byId?.get?.("cline");
      if (cline?.checkFreeUpdates) void cline.checkFreeUpdates().catch(() => {});
    } catch {}
  }, 100).unref?.();

  // responses 模型判定改元数据驱动（models.dev provider.npm）：就绪后注入，每小时重查使新模型自动识别
  void (async () => {
    try {
      const { globalCapabilities } = await import("../model-capabilities/index.js");
      const { setResponsesNpmIndex } = await import("../upstream-responses.js");
      const svc = globalCapabilities();
      const apply = () => setResponsesNpmIndex(svc.npmIndex());
      await svc.ready();
      apply();
      const entry = { ts: Date.now(), type: "responses-npm-index", models: svc.npmIndex().size };
      try { bus.emit(entry); } catch {}
      try { logs.appendEvent(entry); } catch {}
      setInterval(() => { svc.ready().then(apply).catch(() => {}); }, 60 * 60 * 1000).unref?.();
    } catch (e) {
      try { logs.appendEvent({ ts: Date.now(), type: "responses-npm-index-failed", error: String(e?.message || e).slice(0, 200) }); } catch {}
    }
  })();

  models.startAutoRefresh();
  if (process.env.MSLXDFF_DAEMON) {
    writePid(process.pid, VERSION);
  }
  const addr = srv.server.address();
  const host = addr.address === "0.0.0.0" || addr.address === "::" ? "localhost" : addr.address;
  console.log(`mslxdff v${VERSION} listening on http://${host}:${addr.port} (pid ${process.pid})`);
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
            try { logs.appendEvent({ ts: Date.now(), type: "autostart-auto-enabled", method: r.method }); } catch {}
          } else {
            console.log(`autostart auto-enable failed: ${r.error || "unknown"} (run mslxdff -enable-autostart manually)`);
          }
        }
      } catch {}
    }, 2500).unref?.();
  }

  return { srv, bus, router };
}
