import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, resolvePort } from "../server.js";
import { createRouter } from "../routes.js";
import { createEventBus } from "../events.js";
import { runHook } from "../plugins.js";
import { effectiveHost, maxHopsValue } from "../cli/policy.js";
import { fmtEvent } from "../cli/format.js";
import { writePid } from "../daemon.js";
import { underSystemd } from "./proc-info.js";

/**
 * 由**独立进程**完成 autostart 接管，而不是 daemon 自己。
 * 为什么：`enableAutostart()` 的语义是「停掉裸 daemon，把端口让给 systemd」—— 调用者恰好就是
 * 那个裸 daemon 时，这条语义等于自杀（0.1.236 真机：daemon 启动 4~5 秒后消失、errors.log 记
 * unexplained-kill、daemon.alive 停在 uptimeMs:0、user unit 永远停在 disabled，下次裸跑继续循环）。
 * helper 是普通进程：杀掉 daemon（此时是父进程）不伤自己，`systemctl --user start` 也能跑完。
 */
function spawnAutostartHelper() {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "mslxdff.js");
  const child = spawn(process.execPath, [entry, "-enable-autostart"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, MSLXDFF_DAEMON: "", MSLXDFF_NO_AUTOSTART: "1" },
  });
  child.unref();
  return child;
}

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

  const router = createRouter({ token, upstream, models, auto, logs, peers, maxHops: maxHopsValue(), groups, bans, bus, plugins: loadedPlugins, version: VERSION });
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
      // systemd 托管下不许杀端口占用者：supervisor 保证单实例，去杀「占用者」是越权，且会与
      // systemd 的拉起时序互杀成循环（报告的另一半）。非零退出，让 systemd 按 Restart/RestartSec
      // 退避重试——这才是托管语义下正确的收口。
      if (underSystemd()) {
        console.error(`[lifecycle] EADDRINUSE on port ${resolvePort()} under systemd — exit(1), let systemd backoff-retry（不杀任何进程）`);
        process.exit(1);
      }
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
      else if (Array.isArray(r.results)) {
        const fails = r.results.filter((x) => !x.ok).map((x) => x.id).join(",");
        console.log(`[preheat] custom ${r.okCount}/${r.total} ok${fails ? ` fail:${fails}` : ""}`);
      }
      else if (r.ok) console.log(`[preheat] opencode models ok ${r.status} ${r.ms}ms`);
      else console.log(`[preheat] opencode models failed ${r.error || r.status || ""} ${r.ms || 0}ms`);
    }).catch(() => {});
    // cline 自检已并入 dispatcher.preheat（定制名单含 cline，走 checkFreeUpdates 带快照 diff），此处不再单独调
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
  // **systemd 托管下必须跳过**（2026-10-19 真机无限重启的根因）：
  //  - 托管时 supervisor 已经保证单实例+开机自启，这里再 enable 一次多余；
  //  - 本块查的是 **user** unit（`~/.config/systemd/user/mslxdff.service`），而 systemd **系统**
  //    unit 托管的 daemon 查它必然得 enabled=false ⇒ 走 enableAutostart() ⇒ linuxEnable() ⇒ stopDaemon()。
  //    那条路径里 pid 文件写的就是**本进程**，过去等于每 2.5s 自杀一次（见 daemon.js 的自杀护栏）。
  // systemd 会给被管进程注入 INVOCATION_ID / JOURNAL_STREAM，判据可靠、无需用户配置。
  // **接管动作必须由独立进程做**：enableAutostart() 的语义就是「停掉裸 daemon、把端口让给 systemd」，
  // 由那个裸 daemon 自己调用 = 举手自杀（0.1.236 真机把自己杀掉后 unit 永远 disabled）。
  if (process.platform === "linux" && !process.env.MSLXDFF_NO_AUTOSTART && !underSystemd()) {
    setTimeout(async () => {
      try {
        const { getAutostartStatus } = await import("../autostart.js");
        const st = await getAutostartStatus();
        if (st.enabled) return;
        // 只派生 helper，不在本进程里调 enableAutostart（见 spawnAutostartHelper 注释）
        const helper = spawnAutostartHelper();
        if (!helper.pid) {
          console.log("autostart 未启用且接管进程未启动：请手动运行 mslxdff -enable-autostart");
          return;
        }
        console.log(`autostart 未启用：已派出接管进程 (pid ${helper.pid})，daemon 稍后交给 systemd；不想要就设 MSLXDFF_NO_AUTOSTART=1`);
        try { logs.appendEvent({ ts: Date.now(), type: "autostart-takeover-spawned", pid: helper.pid }); } catch {}
        try { bus?.emit({ ts: Date.now(), type: "autostart-takeover-spawned", pid: helper.pid }); } catch {}
      } catch {}
    }, 2500).unref?.();
  }

  return { srv, bus, router };
}
