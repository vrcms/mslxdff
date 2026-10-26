import { repairAutostartOnce } from "./autostart-repair.js";
import { startServer, resolvePort } from "../server.js";
import { createRouter } from "../routes.js";
import { createEventBus } from "../events.js";
import { runHook } from "../plugins.js";
import { effectiveHost, maxHopsValue } from "../cli/policy.js";
import { fmtEvent } from "../cli/format.js";
import { writePid } from "../daemon.js";
import { underSystemd } from "./proc-info.js";

// autostart 的接管动作与判据都在 `./autostart-repair.js`（`repairAutostartOnce`），本文件只在
// 启动 2.5s 后叫它一次。**为什么必须由独立进程做**（原有约束不变）：`enableAutostart()` 在 Linux
// 的语义是「停掉裸 daemon、把端口让给 systemd」，由那个裸 daemon 自己调用 = 举手自杀
// （0.1.236 真机，ADR-0069）。CLI `-restart` 也调同一个函数 ⇒ 判据只有一套（ADR-0074）。

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

  // ---------- 开机自启自愈（Windows + Linux 同一条路，ADR-0074）----------
  // 判据+动作在 `repairAutostartOnce()`（与 CLI `-restart` 共用，杜绝两套真相）：env/平台门 →
  // supervisor 托管则跳过 → 意愿位 → **内容健康**体检（未注册/任务禁用/注册里 node·脚本路径已不存在）
  // → 在途互斥 → 重注入预算 → 才派 detached helper。延迟 2.5s：让 listen/健康先落地再动注册。
  setTimeout(async () => {
    try {
      const r = await repairAutostartOnce({
        log: (m) => console.log(m),
        onEvent: (e) => {
          try { logs.appendEvent(e); } catch {}
          try { bus?.emit(e); } catch {}
        },
      });
      if (r.action === "error") console.log(`autostart 体检失败：${r.reason}`);
    } catch {}
  }, 2500).unref?.();

  return { srv, bus, router };
}
