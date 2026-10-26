import { existsSync, writeFileSync } from "node:fs";
import { startDaemon, stopDaemon, readPid, readPidVersion, isPidAlive, pidFile, logFile, waitPidGone, reapGhostDaemons } from "../../daemon.js";
import { setPort } from "../../state.js";
import { logDir, eventsFile, callsFile, errorsFile } from "../../logs.js";
import { effectivePort, waitForHealth, stopDaemonIfOutdated, compareSemver, argValue } from "../policy.js";
import { printStatus } from "../status.js";
import { findDaemons, fmtAlive } from "../../runtime/proc-info.js";

/** 停 daemon 并**等它真死**：只发 SIGTERM 就起新的会留下幽灵（隧道子进程把事件循环钉住，见 daemon.js waitPidGone）。 */
async function stopDaemonHard(reason) {
  const pid = readPid();
  const r = stopDaemon({ reason });
  if (pid && r.stopped) {
    const g = await waitPidGone(pid);
    if (!g.died) console.log(`⚠ 旧 daemon (pid ${pid}) 等了 ${Math.round(g.waitedMs / 1000)}s 仍没退（已补 SIGKILL）—— 若仍在世，它会和新的抢端口`);
    else if (g.forced) console.log(`旧 daemon (pid ${pid}) 未响应 SIGTERM，已 SIGKILL（等了 ${Math.round(g.waitedMs / 1000)}s）`);
  }
  return r;
}

export async function handleStop(args) {
  if (!(args.includes("-stop") || args.includes("--stop"))) return false;
  const { stopped, pid, reason } = await stopDaemonHard("stop");
  if (stopped) {
    console.log(`mslxdff daemon stopped (pid ${pid})`);
  } else if (pid) {
    // 「有 pid 但没停成」≠「没在跑」：杀被拒时它还在监听端口，说成 not running 会让人以为可以安全重启。
    console.log(`mslxdff daemon NOT stopped (pid ${pid})${reason ? `: ${reason}` : ""}`);
    process.exit(1);
  } else {
    console.log(`mslxdff daemon not running${reason ? ` (${reason})` : ""}`);
  }
  process.exit(0);
}

export async function handleRestart(args, VERSION) {
  if (!((args.includes("-restart") || args.includes("--restart")) && !process.env.MSLXDFF_DAEMON)) return false;
  const pid = readPid();
  const alive = pid ? isPidAlive(pid) : false;
  if (alive) {
    console.log(`restarting daemon (pid ${pid})...`);
    const r = await stopDaemonHard("restart");
    // 停不掉就别起新的（BUG-29）：旧 daemon 还占着端口 ⇒ 新进程 bind 必 EADDRINUSE 立刻退出，
    // 而 waitForHealth 打的是**旧** daemon 的 /health（照样 200）、Windows 上 findDaemons 读不到 /proc
    // 恒返回空 ⇒ 最后打印「restarted as ... (pid <新的死 pid>)」，把「重启失败且旧版还在跑」谎报成成功。
    if (!r.stopped && r.pid) {
      console.error(`⚠ 旧 daemon (pid ${r.pid}) 没能停掉：${r.reason}`);
      console.error("  继续起新进程只会让它在 EADDRINUSE 上立刻退出，而旧版仍在应答 —— 已中止。");
      console.error("  请用管理员终端重试（mslxdff -stop，或 taskkill /PID " + r.pid + " /F）后再 -restart。");
      process.exit(1);
    }
  } else if (pid) {
    console.log(`daemon pid ${pid} is stale (not running) — starting fresh...`);
    try { stopDaemon({ reason: "restart" }); } catch {}
  } else {
    console.log("daemon not running — starting...");
  }
  // 结构性盲区收口：不在 daemon.pid 里的 daemon 永远杀不到（真机：Oct16 起的旧 daemon 活了一整天，
  // 与新版互抢本机端口；两边日志格式交错才暴露）。起新的之前先清干净。
  const ghosts = await reapGhostDaemons({ log: (m) => console.log(m) });
  if (ghosts.length) console.log(`已清掉 ${ghosts.length} 个不在册的 daemon（pid ${ghosts.map((g) => g.pid).join(", ")}）`);
  const port = effectivePort(args);
  const spawnedPid = startDaemon([]);
  // 只认**刚起的那个 pid**：旧 daemon 若仍占着端口，它的 /health 同样 200（BUG-29 谎报的根源）。
  const health = await waitForHealth(port, 4000, { expectPid: spawnedPid });
  // 诚实报错：/health 可能由**残留的旧 daemon** 应答（它也在监听同一个端口），所以不能只看 health。
  // 新进程已经死了就更不该报成功——Windows 上 EADDRINUSE 秒退时 CLI 什么都收不到。
  const leftover = findDaemons({ self: spawnedPid });
  const leftTxt = leftover.map((g) => `pid ${g.pid}（已运行 ${fmtAlive(g.aliveSec)}）`).join("；");
  if (!isPidAlive(spawnedPid)) {
    console.error(`⚠ 新 daemon (pid ${spawnedPid}) 启动后立即退出 —— 端口 ${port} 大概仍被旧进程占着（EADDRINUSE）。`);
    if (leftover.length) console.error(`  仍在跑的旧 daemon：${leftTxt}`);
    console.error(`  详见 ${logFile()}`);
    process.exit(1);
  }
  if (leftover.length) {
    console.log(`⚠ 仍有 ${leftover.length} 个旧 daemon 在跑：${leftTxt} —— 它们会和新的抢出口池端口，请 kill 掉`);
  } else if (health.ok) console.log(`mslxdff v${VERSION} restarted as a background daemon (pid ${spawnedPid})`);
  else console.log(`mslxdff v${VERSION} restarted (pid ${spawnedPid}) — health check pending (http://127.0.0.1:${port}/health)`);
  console.log(`endpoint:   http://localhost:${port}/v1`);
  console.log(`log:        ${logFile()}`);
  console.log(`pid:        ${pidFile()}`);
  // ADR-0074：restart 本体也要管开机自启 —— 用户点名「每次 restart 都查一遍，不在就重新注入」。
  // 判据与动作都在 `runtime/autostart-repair.js`（daemon 启动 2.5s 后还会查一次，靠在途互斥不重复派）。
  // reportOk=true：连「体检通过」也要打一行，restart 的输出必须看得见自己查过了。
  try {
    const { repairAutostartOnce } = await import("../../runtime/autostart-repair.js");
    const asr = await repairAutostartOnce({ log: (m) => console.log(m), reportOk: true });
    if (asr.action === "skip-env") console.log("autostart: 自愈已按 env 关闭（MSLXDFF_NO_AUTOSTART / MSLXDFF_AUTOSTART_REPAIR=0），本次未体检");
  } catch (e) { console.log(`autostart 体检失败：${e?.message || e}`); }
  process.exit(0);
}

export async function handlePort(args) {
  const portArg = argValue(args, "-port", "--port");
  if (!portArg || process.env.MSLXDFF_DAEMON) return false;
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`invalid port: ${portArg}`);
    process.exit(1);
  }
  setPort(port);
  const daemon = readPid();
  if (daemon) {
    // 同 BUG-29：老 daemon 还在（同一个配置端口）时起新的一定抢不到端口，且 -port 已落盘，
    // 谎报「restarted on port N」会让人以为新端口已生效，实际仍是旧的（甚至旧的监听着旧端口）。
    const r = stopDaemon({ reason: "restart" });
    if (!r.stopped && r.pid) {
      console.error(`⚠ 旧 daemon (pid ${r.pid}) 没能停掉：${r.reason}`);
      console.error(`  端口已保存为 ${port}，但它要等旧进程退出后才生效。已中止，未启动新进程。`);
      process.exit(1);
    }
    const spawned = startDaemon(["-port", String(port)]);
    const health = await waitForHealth(port, 4000, { expectPid: spawned });
    if (!isPidAlive(spawned)) {
      console.error(`⚠ 新 daemon (pid ${spawned}) 启动后立即退出 —— 端口 ${port} 大概仍被占用（EADDRINUSE）。详见 ${logFile()}`);
      process.exit(1);
    }
    console.log(`mslxdff restarted on port ${port} (pid ${spawned})${health.ok ? "" : " — health check pending"}`);
    console.log(`endpoint:   http://localhost:${port}/v1`);
  } else {
    console.log(`port saved: ${port} (daemon not running; takes effect on next start)`);
  }
  process.exit(0);
}

export async function handleDaemonFlag(args, VERSION) {
  if (!(args.includes("-d") || args.includes("--daemon"))) return false;
  if (!process.env.MSLXDFF_DAEMON) {
    const port = effectivePort(args);
    stopDaemonIfOutdated(VERSION);
    const keptPid = readPid();
    if (keptPid && isPidAlive(keptPid)) {
      const rv = readPidVersion();
      if (rv && compareSemver(rv, VERSION) > 0) {
        await printStatus(VERSION);
        console.log(`daemon already running newer v${rv} — not starting v${VERSION}`);
        process.exit(0);
      }
    }
    const spawnedPid = startDaemon(args.filter((a) => a !== "-d" && a !== "--daemon"));
    const health = await waitForHealth(port, 4000, { expectPid: spawnedPid });
    // 起完立刻死了 = 端口被占（旧 daemon 没清掉）。报「started」会让人以为它在服务。
    if (!isPidAlive(spawnedPid)) {
      console.error(`⚠ daemon (pid ${spawnedPid}) 启动后立即退出 —— 端口 ${port} 大概仍被占用（EADDRINUSE）。详见 ${logFile()}`);
      process.exit(1);
    }
    console.log(`mslxdff daemon started (pid ${spawnedPid})${health.ok ? "" : " — health check pending"}`);
    console.log(`log: ${logFile()}`);
    console.log(`pid: ${pidFile()}`);
    process.exit(0);
  }
  return false; // we ARE the daemon — fall through to bootstrap
}

export async function handleDebug(args) {
  if (!(args.includes("-debug") || args.includes("--debug"))) return false;
  // systemd 自启协同：若后台 daemon 由 user service（Restart=always, RestartSec=3）托管，
  // 仅 stopDaemon() 会让 systemd 3 秒后拉起新实例 → 抢 8989 → EADDRINUSE 自愈反杀本 debug 前台。
  // 必须先 systemctl stop（主动停止不会被 Restart 拉起）。
  if (process.platform === "linux") {
    try {
      const { execFile } = await import("node:child_process");
      const active = await new Promise((res) => execFile("systemctl", ["--user", "is-active", "mslxdff"], { windowsHide: true, timeout: 4000 }, (e, so) => res(String(so || "").trim())));
      if (active === "active") {
        await new Promise((res) => execFile("systemctl", ["--user", "stop", "mslxdff"], { windowsHide: true, timeout: 6000 }, () => res()));
        console.log("[debug] stopped systemd user service (mslxdff) — it will be restarted on exit");
      }
    } catch {}
  }
  const { stopped, pid } = stopDaemon({ reason: "debug-takeover" });
  if (stopped) console.log(`[debug] stopped background daemon (pid ${pid})`);
  // 等旧 daemon 真正退出再抢端口（Windows 端口释放有延迟，否则 EADDRINUSE 会让 debug 立即崩）
  if (stopped && pid) {
    const t0 = Date.now();
    while (isPidAlive(pid) && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    const dir = logDir();
    const toClear = [eventsFile(), callsFile(), errorsFile(), logFile()];
    let cleared = 0;
    for (const f of toClear) {
      try {
        if (existsSync(f)) {
          writeFileSync(f, "");
          cleared++;
        }
      } catch {}
    }
    console.log(`[debug] 已清理旧日志 ${cleared} 个文件 (${dir})，本次会话干净输出`);
  } catch {}
  console.log("--- live (Ctrl+C: stop debugging and restore background daemon) ---");
  process.env.MSLXDFF_DEBUG = "1";
  process.env.MSLXDFF_DAEMON = "1";
  return false; // fall through to daemon body
}

export async function handleBareRun(args, VERSION) {
  if (process.env.MSLXDFF_DAEMON) return false;
  const pid = readPid();
  if (pid && isPidAlive(pid)) {
    const rv = readPidVersion();
    if (rv && compareSemver(rv, VERSION) >= 0) {
      await printStatus(VERSION);
      const { printHelp } = await import("../help.js");
      printHelp(VERSION);
      process.exit(0);
    }
  }
  const port = effectivePort(args);
  stopDaemonIfOutdated(VERSION);
  const pid2 = readPid();
  if (pid2 && isPidAlive(pid2)) {
    const rv2 = readPidVersion();
    if (rv2 && compareSemver(rv2, VERSION) >= 0) {
      await printStatus(VERSION);
      const { printHelp } = await import("../help.js");
      printHelp(VERSION);
      process.exit(0);
    }
  }
  const spawnedPid = startDaemon([]);
  const health = await waitForHealth(port, 4000, { expectPid: spawnedPid });
  // 裸跑是用户最常敲的命令，更不能谎报：旧 daemon 若仍占端口，新进程 EADDRINUSE 秒退，
  // 而 waitForHealth 打的是旧 daemon 的 /health（照样 200）——见 BUG-29/30。
  if (!isPidAlive(spawnedPid)) {
    console.error(`⚠ daemon (pid ${spawnedPid}) 启动后立即退出 —— 端口 ${port} 大概仍被占用（EADDRINUSE）。详见 ${logFile()}`);
    process.exit(1);
  }
  console.log(`mslxdff v${VERSION} started as a background daemon (pid ${spawnedPid})${health.ok ? "" : " — health check pending"}`);
  console.log(`endpoint:   http://localhost:${port}/v1`);
  console.log(`log:        ${logFile()}`);
  console.log(`pid:        ${pidFile()}`);
  console.log(`status:     run \`mslxdff\` again (or \`mslxdff -status\`)`);
  process.exit(0);
}
