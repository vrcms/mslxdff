import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateFile } from "../../state.js";
import { loadToken, refreshToken } from "../../state.js";
import { stopDaemon, pidFile, logFile, isPidAlive } from "../../daemon.js";
import { logDir, eventsFile, callsFile, errorsFile, recentEvents, timelineFile, recentTimeline } from "../../logs.js";
import { fmtEvent } from "../format.js";
import { fmtShanghaiYMDHMS, fmtShanghaiHMS } from "../../time.js";
import { printHelp } from "../help.js";
import { printStatus } from "../status.js";
import { loadPlugins, resolvePluginDirs } from "../../plugins.js";

export async function handleHelp(args, VERSION) {
  if (!(args.includes("-help") || args.includes("--help") || args.includes("-h"))) return false;
  printHelp(VERSION);
  process.exit(0);
}

export async function handleUpdate(args, VERSION) {
  if (!(args.includes("-update") || args.includes("--update"))) return false;
  const { npmCmd, run } = await import("../util.js");
  const { compareSemver } = await import("../policy.js");
  const { resolvePort } = await import("../../server.js");
  const { readPid } = await import("../../daemon.js");
  const { startDaemon, stopDaemon } = await import("../../daemon.js");
  const { waitForHealth } = await import("../policy.js");
  console.log(`mslxdff v${VERSION} — checking for updates…`);
  const info = await run(npmCmd(), ["view", "mslxdff", "dist-tags.latest", "--json"]);
  if (info.err) {
    console.error(`could not query npm: ${info.err.message || String(info.stderr || "").slice(0, 500)}`);
    process.exit(1);
  }
  let latest = "";
  try {
    latest = JSON.parse(String(info.stdout || "").trim());
    if (Array.isArray(latest)) latest = latest[latest.length - 1];
    latest = String(latest || "").trim();
  } catch {
    const m = String(info.stdout || "").trim().match(/(\d+\.\d+\.\d+[^\s'"]*)/);
    latest = m ? m[1] : "";
  }
  latest = String(latest || "").replace(/['"]/g, "").trim();
  const version = VERSION;
  console.log(`  installed: ${version}`);
  console.log(`  latest:    ${latest || "unknown"}`);
  if (!latest || version === latest || compareSemver(latest, version) <= 0) {
    console.log("already up to date");
    process.exit(0);
  }
  console.log(`updating to ${latest}…`);
  const up = await run(npmCmd(), ["install", "-g", `mslxdff@${latest}`], { stdio: "inherit" });
  if (up.err) {
    console.error(`update failed: ${up.err.message}`);
    process.exit(1);
  }
  console.log(`updated to ${latest}`);
  const daemon = readPid();
  if (daemon) {
    console.log("restarting daemon on the new version…");
    const r = stopDaemon({ reason: "restart" });
    // 同 BUG-29：停不掉就绝不能报 restarted —— 旧版还占着端口，新进程 EADDRINUSE 秒退，
    // 而 waitForHealth 打的是旧 daemon 的 /health，照样 200，读 pid 读到的也是旧值。
    if (!r.stopped && r.pid) {
      console.error(`⚠ 旧 daemon (pid ${r.pid}) 没能停掉：${r.reason}`);
      console.error(`  新版本已装好，但旧版仍在运行（未生效）。请用管理员终端停掉它后重新 -restart。`);
      process.exit(1);
    }
    const spawned = startDaemon([]);
    const health = await waitForHealth(resolvePort(), 4000, { expectPid: spawned });
    if (!isPidAlive(spawned)) {
      console.error(`⚠ 新 daemon (pid ${spawned}) 启动后立即退出 —— 端口大概仍被旧进程占着（EADDRINUSE）。旧版仍在运行，升级未生效。`);
      process.exit(1);
    }
    console.log(`restarted (pid ${spawned})${health.ok ? "" : " — health check pending"}`);
  }
  process.exit(0);
}

export async function handleRefreshToken(args) {
  if (!(args.includes("-refresh-token") || args.includes("--refresh-token"))) return false;
  const token = await refreshToken();
  console.log(token);
  process.exit(0);
}

export async function handleShowToken(args) {
  if (!(args.includes("-showtoken") || args.includes("--showtoken"))) return false;
  const { token } = await loadToken();
  console.log(token);
  process.exit(0);
}

export async function handleUninstall(args) {
  if (!(args.includes("-uninstall") || args.includes("--uninstall"))) return false;
  const { stopped, pid, reason } = stopDaemon({ reason: "uninstall" });
  if (stopped) console.log(`mslxdff daemon stopped (pid ${pid})`);
  else if (pid) {
    // 杀被拒 ≠ 没在跑：它还活着并持有 state/logs，继续删文件会让在跑的 daemon 半瘫（写不进也不重来）。
    console.error(`mslxdff daemon still running (pid ${pid}) — uninstall aborted: ${reason}`);
    console.error("先停掉它（管理员终端执行 mslxdff -stop，或 taskkill /PID " + pid + " /F），再重新 -uninstall");
    process.exit(1);
  } else console.log("mslxdff daemon not running");
  const stateFile = defaultStateFile();
  const dir = dirname(stateFile);
  const removed = [];
  for (const f of [
    stateFile,
    pidFile(),
    logFile(),
    join(dir, "calls.log"),
    join(dir, "errors.log"),
    join(dir, "events.log"),
    join(dir, "timeline.log"),
  ]) {
    try {
      rmSync(f, { force: true });
      removed.push(f);
    } catch {}
  }
  if (removed.length) console.log(`removed ${removed.length} file(s):\n  ${removed.join("\n  ")}`);
  else console.log("no state/log files to remove");
  console.log("\npackage still installed — finish with:");
  console.log("  npm uninstall -g mslxdff");
  process.exit(0);
}

export async function handleLog(args) {
  if (!(args.includes("-log") || args.includes("--log") || args.includes("-logs") || args.includes("--logs"))) return false;
  const idx = args.findIndex((x) => x === "-log" || x === "--log" || x === "-logs" || x === "--logs");
  const raw = args[idx + 1];
  const n = Number(raw);
  const count = Number.isInteger(n) && n > 0 ? n : 10;
  const file = eventsFile();
  const dir = logDir();
  console.log(`log dir: ${dir}`);
  console.log(`events:  ${file}`);
  const evts = recentEvents(count);
  if (!evts.length) {
    console.log(`(no events yet — file empty or not found)`);
  } else {
    console.log(`--- last ${evts.length} event(s) ---`);
    for (const e of evts) console.log(fmtEvent(e));
  }
  if (count <= 10) {
    console.log(`\nhint: mslxdff -log 100  |  calls: ${callsFile()}  errors: ${errorsFile()}  daemon: ${logFile()}`);
  }
  const timeline = recentTimeline(count);
  if (timeline.length) {
    console.log(`--- last ${timeline.length} timeline line(s) ---`);
    for (const line of timeline) console.log(line);
  }
  console.log(`timeline: ${timelineFile()}`);
  console.log(`model logs: ${dir}\\<provider>-<model>.log`);
  process.exit(0);
}

export async function handlePlugins(args) {
  if (!(args.includes("-plugins") || args.includes("--plugins"))) return false;
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const dirs = resolvePluginDirs({ pkgRoot: dirname(pkgRoot) });
  // Actually pkgRoot is src/cli -> need to go to root: bin/mslxdff.js used dirname(dirname(...)). For src/cli/commands/system.js, need 3 levels.
  // Simpler: compute from import.meta.url
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const dirs2 = resolvePluginDirs({ pkgRoot: root });
  const labels = ["official (bundled)", "user"];
  if (dirs2.length === 1) labels[0] = "dir";
  console.log(`plugin dirs:`);
  dirs2.forEach((d, i) => console.log(`  [${labels[i] || `dir${i + 1}`}] ${d}${existsSync(d) ? "" : "  (not created yet)"}`));
  const { plugins, errors } = await loadPlugins({ dirs: dirs2 });
  if (!plugins.length && !errors.length) {
    console.log("(no plugins — drop *.mjs files into a dir above, see docs/plugins.md)");
  }
  for (const p of plugins) {
    const hooks = Object.keys(p.hooks || {});
    const src = p.file.startsWith(root) ? "official" : "user";
    console.log(`  ${p.name}${p.version ? `@${p.version}` : ""}  [${hooks.join(", ") || "no hooks"}]  (${src})`);
    if (p.description) console.log(`    ${p.description}`);
  }
  for (const e of errors) console.log(`  load error: ${e.file} — ${e.error}`);
  process.exit(0);
}

export async function handleChat(args) {
  if (!(args.includes("-chat") || args.includes("--chat"))) return false;
  const idx = args.findIndex((x) => x === "-chat" || x === "--chat");
  const rest = args.slice(idx + 1);
  const singleShot = rest.length ? rest.join(" ").trim() : null;
  const { startChat } = await import("../../chat/index.js");
  await startChat({ singleShot: singleShot || undefined });
  process.exit(0);
}

export async function handleStatus(args, VERSION) {
  if (!(args.includes("-status") || args.includes("--status") || args.includes("-s"))) return false;
  await printStatus(VERSION);
  process.exit(0);
}

export async function handleFree(args) {
  if (!(args.includes("-free") || args.includes("--free") || args.includes("-free-check") || args.includes("--free-check") || args.includes("-free-watch") || args.includes("--free-watch"))) return false;
  const isWatch = args.includes("-free-watch") || args.includes("--free-watch");
  const { fetchV2exFree } = await import("../../free-watcher.js");
  const show = async () => {
    const hits = await fetchV2exFree({ timeoutMs: 6000 });
    const ts = fmtShanghaiYMDHMS(new Date());
    console.log(`[V2EX] free check @ ${ts} — ${hits.length} hit(s)`);
    if (!hits.length) {
      console.log("(暂无命中 — 关键词：白嫖|限免|免费额度|注册送|羊毛，来源：/api/topics/latest.json + hot.json)");
    } else {
      for (const h of hits) console.log(`  ${h.title} | ${h.url} | ${h.node} ${h.replies}回复`);
    }
  };
  if (!isWatch) {
    try { await show(); } catch (err) { console.error(`V2EX 拉取失败: ${err?.message || err}`); process.exit(1); }
    process.exit(0);
  }
  console.log("V2EX 白嫖雷达 watch 模式 — 每 5 分钟拉一次 Ctrl+C 退出");
  const run = async () => {
    try { await show(); } catch (err) { console.error(`[${fmtShanghaiHMS(new Date())}] 拉取失败: ${err?.message || err}`); }
    console.log("---");
  };
  await run();
  const timer = setInterval(run, 5 * 60 * 1000);
  timer.unref?.();
  await new Promise(() => {});
}

export async function handleAutostart(args) {
  if (!(args.includes("-enable-autostart") || args.includes("--enable-autostart") || args.includes("-disable-autostart") || args.includes("--disable-autostart") || args.includes("-autostart") || args.includes("--autostart"))) return false;
  const { enableAutostart, disableAutostart, getAutostartStatus, autostartHelp, checkAutostartHealth } = await import("../../autostart.js");
  const { saveAutostartWanted, recordAutostartRepair, AUTOSTART_REPAIR_MAX_FAILS } = await import("../../state.js");
  if (args.includes("-enable-autostart") || args.includes("--enable-autostart")) {
    const r = await enableAutostart();
    if (r.ok) {
      // 意愿位 + 台账：enable 成功即表态「要自启」并清零失败计数 —— daemon 每次启动的自愈据此保持注册
      saveAutostartWanted(true);
      recordAutostartRepair({ ok: true });
      console.log(`autostart 已启用 · ${r.method || autostartHelp()}`);
      console.log(`验证: mslxdff -autostart status ；此后注册被清理软件抹掉或注册里的路径搬家失效，daemon 启动时会自动重注入`);
    } else {
      const rep = recordAutostartRepair({ ok: false, reason: r.error || "unknown" });
      console.error(`启用自启失败: ${r.error || "unknown"}`);
      console.error(`提示: Windows 需允许任务计划，Linux 需 systemd --user`);
      if (rep.fails >= AUTOSTART_REPAIR_MAX_FAILS) console.error(`已连续失败 ${rep.fails} 次：daemon 启动时的自动重注入停手只告警（整块开关 MSLXDFF_AUTOSTART_REPAIR=0）`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (args.includes("-disable-autostart") || args.includes("--disable-autostart")) {
    const r = await disableAutostart();
    if (r.ok) {
      saveAutostartWanted(false);
      recordAutostartRepair({ ok: true });
      console.log(`autostart 已禁用 — 意愿已记进 state，daemon 重启不会再自动补注册；要恢复：mslxdff -enable-autostart`);
    }
    else { console.error(`禁用失败: ${r.error}`); process.exit(1); }
    process.exit(0);
  }
  const idx = args.findIndex((x) => x === "-autostart" || x === "--autostart");
  const sub = args[idx + 1];
  if (!sub || sub === "status" || sub === "list") {
    // 与 daemon 启动自愈共用 checkAutostartHealth()：面板与自愈必须同一判据，不许两套真相
    const h = await checkAutostartHealth();
    const s = h.status || await getAutostartStatus();
    const verdict = !h.wanted ? "按意愿关闭（不会自动补注册）" : (h.ok ? "已启用 · 体检通过" : `失效 → ${h.reason}`);
    console.log(`autostart: ${verdict}`);
    console.log(`  ${s.detail || autostartHelp()}`);
    if (s.taskToRun) console.log(`  task: ${s.taskToRun}`);
    if (s.execStart) console.log(`  exec: ${s.execStart}`);
    if (s.unit) console.log(`  unit: ${s.unit}`);
    if (h.repair.fails) console.log(`  重注入台账: 连续失败 ${h.repair.fails} 次（剩 ${h.budget} 次）· 上次原因 ${h.repair.reason || "-"}`);
    process.exit(0);
  }
  console.error("usage: mslxdff -enable-autostart | mslxdff -disable-autostart | mslxdff -autostart status");
  process.exit(1);
}
