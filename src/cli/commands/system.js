import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateFile } from "../../state.js";
import { loadToken, refreshToken } from "../../state.js";
import { stopDaemon, pidFile, logFile } from "../../daemon.js";
import { logDir, eventsFile, callsFile, errorsFile, recentEvents } from "../../logs.js";
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
    stopDaemon();
    startDaemon([]);
    await waitForHealth(resolvePort(), 4000);
    console.log(`restarted (pid ${readPid()})`);
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
  const { stopped, pid } = stopDaemon();
  if (stopped) console.log(`mslxdff daemon stopped (pid ${pid})`);
  else console.log("mslxdff daemon not running");
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
  const { enableAutostart, disableAutostart, getAutostartStatus, autostartHelp } = await import("../../autostart.js");
  if (args.includes("-enable-autostart") || args.includes("--enable-autostart")) {
    const r = await enableAutostart();
    if (r.ok) {
      console.log(`autostart 已启用 · ${r.method || autostartHelp()}`);
      console.log(`验证: mslxdff -autostart status`);
    } else {
      console.error(`启用自启失败: ${r.error || "unknown"}`);
      console.error(`提示: Windows 需允许任务计划，Linux 需 systemd --user`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (args.includes("-disable-autostart") || args.includes("--disable-autostart")) {
    const r = await disableAutostart();
    if (r.ok) console.log(`autostart 已禁用`);
    else { console.error(`禁用失败: ${r.error}`); process.exit(1); }
    process.exit(0);
  }
  const idx = args.findIndex((x) => x === "-autostart" || x === "--autostart");
  const sub = args[idx + 1];
  if (!sub || sub === "status" || sub === "list") {
    const s = await getAutostartStatus();
    console.log(`autostart: ${s.enabled ? "已启用" : "未启用"} · ${s.detail || autostartHelp()}`);
    if (s.taskToRun) console.log(`  task: ${s.taskToRun}`);
    if (s.unit) console.log(`  unit: ${s.unit}`);
    process.exit(0);
  }
  console.error("usage: mslxdff -enable-autostart | mslxdff -disable-autostart | mslxdff -autostart status");
  process.exit(1);
}
