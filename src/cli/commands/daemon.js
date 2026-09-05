import { existsSync, writeFileSync } from "node:fs";
import { startDaemon, stopDaemon, readPid, readPidVersion, isPidAlive, pidFile, logFile } from "../../daemon.js";
import { setPort } from "../../state.js";
import { logDir, eventsFile, callsFile, errorsFile } from "../../logs.js";
import { effectivePort, waitForHealth, stopDaemonIfOutdated, compareSemver, argValue } from "../policy.js";
import { printStatus } from "../status.js";
import { compatFetch, timeoutSignal } from "../../compat.js";

export async function handleStop(args) {
  if (!(args.includes("-stop") || args.includes("--stop"))) return false;
  const { stopped, pid, reason } = stopDaemon();
  if (stopped) {
    console.log(`mslxdff daemon stopped (pid ${pid})`);
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
    stopDaemon();
    await new Promise((r) => setTimeout(r, 300));
  } else if (pid) {
    console.log(`daemon pid ${pid} is stale (not running) — starting fresh...`);
    try { stopDaemon(); } catch {}
  } else {
    console.log(`daemon not running — starting...`);
  }
  const port = effectivePort(args);
  const spawnedPid = startDaemon([]);
  await waitForHealth(port, 4000);
  let ok = false;
  try {
    const r = await compatFetch(`http://127.0.0.1:${port}/health`, { signal: timeoutSignal(1200) });
    ok = r.ok;
  } catch {}
  if (ok) console.log(`mslxdff v${VERSION} restarted as a background daemon (pid ${spawnedPid})`);
  else console.log(`mslxdff v${VERSION} restarted (pid ${spawnedPid}) — health check pending (http://127.0.0.1:${port}/health)`);
  console.log(`endpoint:   http://localhost:${port}/v1`);
  console.log(`log:        ${logFile()}`);
  console.log(`pid:        ${pidFile()}`);
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
    stopDaemon();
    startDaemon(["-port", String(port)]);
    await waitForHealth(port, 4000);
    console.log(`mslxdff restarted on port ${port} (pid ${readPid()})`);
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
    await waitForHealth(port, 4000);
    console.log(`mslxdff daemon started (pid ${spawnedPid})`);
    console.log(`log: ${logFile()}`);
    console.log(`pid: ${pidFile()}`);
    process.exit(0);
  }
  return false; // we ARE the daemon — fall through to bootstrap
}

export async function handleDebug(args) {
  if (!(args.includes("-debug") || args.includes("--debug"))) return false;
  const { stopped, pid } = stopDaemon();
  if (stopped) console.log(`[debug] stopped background daemon (pid ${pid})`);
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
  await waitForHealth(port, 4000);
  console.log(`mslxdff v${VERSION} started as a background daemon (pid ${spawnedPid})`);
  console.log(`endpoint:   http://localhost:${port}/v1`);
  console.log(`log:        ${logFile()}`);
  console.log(`pid:        ${pidFile()}`);
  console.log(`status:     run \`mslxdff\` again (or \`mslxdff -status\`)`);
  process.exit(0);
}
