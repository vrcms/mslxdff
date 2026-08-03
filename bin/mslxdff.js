#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer, resolvePort } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createModelsService } from "../src/models.js";
import { loadToken, refreshToken, setPort, getPort } from "../src/state.js";
import { startDaemon, stopDaemon, writePid, pidFile, logFile, readPid } from "../src/daemon.js";
import { createAutoSelector } from "../src/auto.js";
import { logDir, recentCalls, lastError, appendCall, appendError } from "../src/logs.js";
const logs = { appendCall, appendError };

const args = process.argv.slice(2);
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

if (args.includes("-help") || args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("-update") || args.includes("--update")) {
  await updateSelf();
  process.exit(0);
}

if (args.includes("-refresh-token") || args.includes("--refresh-token")) {
  const token = await refreshToken();
  console.log(token);
  process.exit(0);
}

if (args.includes("-showtoken") || args.includes("--showtoken")) {
  const { token } = await loadToken();
  console.log(token);
  process.exit(0);
}

if (args.includes("-stop") || args.includes("--stop")) {
  const { stopped, pid, reason } = stopDaemon();
  if (stopped) {
    console.log(`mslxdff daemon stopped (pid ${pid})`);
  } else {
    console.log(`mslxdff daemon not running${reason ? ` (${reason})` : ""}`);
  }
  process.exit(0);
}

if (args.includes("-status") || args.includes("--status") || args.includes("-s")) {
  printStatus();
  process.exit(0);
}

// -port N: persist the port, then restart the daemon on it if one is running.
// Skip when we ARE the daemon child (it already carries the port via args).
const portArg = argValue("-port", "--port");
if (portArg && !process.env.MSLXDFF_DAEMON) {
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

if (args.includes("-d") || args.includes("--daemon")) {
  if (!process.env.MSLXDFF_DAEMON) {
    // foreground: spawn the detached background instance, then wait for health
    const port = effectivePort();
    const spawnedPid = startDaemon(args.filter((a) => a !== "-d" && a !== "--daemon"));
    await waitForHealth(port, 4000);
    console.log(`mslxdff daemon started (pid ${spawnedPid})`);
    console.log(`log: ${logFile()}`);
    console.log(`pid: ${pidFile()}`);
    process.exit(0);
  }
  // we ARE the daemon; stdout/stderr already point at the log file via startDaemon stdio
}

// Bare run: if a daemon is already running, show status instead of starting another.
if (!process.env.MSLXDFF_DAEMON && readPid()) {
  printStatus();
  process.exit(0);
}

const { token, created } = await loadToken();
const upstream = createUpstreamClient({});
const baseUrl = process.env.UPSTREAM_BASE_URL || "https://opencode.ai";
const models = createModelsService({
  baseUrl,
  headers: upstream.headers,
  refreshMs: refreshIntervalMs(),
  cacheFile: join(logDir(), "models.json"),
});
const auto = createAutoSelector({
  cooldownMs: modelCooldownMs(),
  loadCandidates: async () => {
    try {
      return (await models.get()).data.map((m) => m.id);
    } catch {
      return null;
    }
  },
});

const router = createRouter({ token, upstream, models, auto, logs });
const srv = startServer({ router });

await srv.ready();
models.startAutoRefresh();
if (process.env.MSLXDFF_DAEMON) {
  writePid(process.pid);
}
const addr = srv.server.address();
const host = addr.address === "0.0.0.0" || addr.address === "::" ? "localhost" : addr.address;
console.log(`mslxdff v${VERSION} listening on http://${host}:${addr.port}`);
if (created) {
  console.log(`auth token: ${token}`);
}
console.log(`endpoint:   http://${host}:${addr.port}/v1`);

function argValue(...names) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
  }
  return null;
}

function effectivePort() {
  const arg = argValue("-port", "--port");
  if (arg) return Number(arg);
  return resolvePort();
}

function refreshIntervalMs() {
  const n = Number(process.env.MODELS_REFRESH_MS);
  return Number.isInteger(n) && n > 0 ? n : 2 * 60 * 60 * 1000;
}

function modelCooldownMs() {
  const n = Number(process.env.MSLXDFF_MODEL_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}

async function waitForHealth(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function printHelp() {
  console.log(`mslxdff v${VERSION} — OpenCode Free OpenAI-compatible proxy

Usage:
  mslxdff                          start the server (if none running); shows status when a daemon is already up
  mslxdff -d                       start as a background daemon
  mslxdff -status                  show current status (daemon, models, recent calls, last error)
  mslxdff -stop                    stop the running daemon
  mslxdff -port N                  persist the listen port (restarts the daemon on it if running)
  mslxdff -update                  update mslxdff to the latest published version
  mslxdff -showtoken               print the current auth token
  mslxdff -refresh-token           rotate the auth token (prints the new one)
  mslxdff -help                    show this help

Environment:
  PORT                    listen port (default 8989)
  MSLXDFF_STATE_FILE      token/port state file
  MSLXDFF_DAEMON_DIR      daemon pid/log/models dir
  UPSTREAM_BASE_URL       upstream base (default https://opencode.ai)
  UPSTREAM_AUTH_TOKEN     upstream bearer value (default "public")
  UPSTREAM_CONNECT_TIMEOUT_MS  upstream connect timeout (default 30000)
  MODELS_REFRESH_MS       model-list background refresh interval (default 7200000)
  MSLXDFF_MODEL_COOLDOWN_MS  fallback cooldown after a model error (default 60000)
`);
}

function printStatus() {
  const daemon = readPid();
  const port = getPort() || resolvePort();
  console.log(`mslxdff v${VERSION}`);
  console.log(`daemon:    ${daemon ? `running (pid ${daemon})` : "not running"}`);
  console.log(`endpoint:  http://localhost:${port}/v1`);
  console.log(`log dir:   ${logDir()}`);

  const modelsFile = join(logDir(), "models.json");
  if (existsSync(modelsFile)) {
    try {
      const cached = JSON.parse(readFileSync(modelsFile, "utf8"));
      const ids = (cached.data || []).map((m) => m.id).filter(Boolean);
      console.log(`\nmodels (${ids.length} free):`);
      for (const id of ids) console.log(`  ${id}`);
    } catch {
      console.log("\nmodels: cache unreadable");
    }
  } else {
    console.log("\nmodels: not cached yet (runs once the server has fetched the upstream list)");
  }

  console.log("\nrecent calls:");
  const calls = recentCalls(5);
  if (calls.length) {
    for (const c of calls) {
      console.log(`  ${fmtTs(c.ts)}  ${c.model || "-"}  ${c.status}  ${c.durationMs ?? "?"}ms${c.auto ? "  auto" : ""}`);
    }
  } else {
    console.log("  (none yet)");
  }

  console.log("\nlast error:");
  const err = lastError();
  if (err) {
    console.log(`  ${fmtTs(err.ts)}  ${err.model || "-"}  ${err.status}  ${err.message || ""}`);
  } else {
    console.log("  (none)");
  }

  if (daemon) console.log(`\nauth token: use \`mslxdff -showtoken\``);
  else console.log(`\nnot running — start with: mslxdff -d`);
}

function fmtTs(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(5, 19);
  } catch {
    return "-";
  }
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120_000, ...opts }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function updateSelf() {
  console.log(`mslxdff v${VERSION} — checking for updates…`);
  const info = await run(npmCmd(), ["view", "mslxdff", "version", "dist-tags.latest"]);
  if (info.err) {
    console.error(`could not query npm: ${info.err.message}`);
    process.exit(1);
  }
  const [version, latest] = (info.stdout || "").trim().split(/\s+/);
  console.log(`  installed: ${version}`);
  console.log(`  latest:    ${latest}`);
  if (version === latest) {
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
}
