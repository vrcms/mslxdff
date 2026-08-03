#!/usr/bin/env node
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createModelsService } from "../src/models.js";
import { loadToken, refreshToken } from "../src/state.js";
import { startDaemon, stopDaemon, writePid, pidFile, logFile } from "../src/daemon.js";

const args = process.argv.slice(2);

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
    console.log(`mslxdfree daemon stopped (pid ${pid})`);
  } else {
    console.log(`mslxdfree daemon not running${reason ? ` (${reason})` : ""}`);
  }
  process.exit(0);
}

if (args.includes("-d") || args.includes("--daemon")) {
  if (!process.env.MSLXDFREE_DAEMON) {
    // foreground: spawn the detached background instance, then wait for health
    const spawnedPid = startDaemon(args.filter((a) => a !== "-d" && a !== "--daemon"));
    await waitForHealth(4000);
    console.log(`mslxdfree daemon started (pid ${spawnedPid})`);
    console.log(`log: ${logFile()}`);
    console.log(`pid: ${pidFile()}`);
    process.exit(0);
  }
  // we ARE the daemon; stdout/stderr already point at the log file via startDaemon stdio
}

const { token, created } = await loadToken();
const upstream = createUpstreamClient({});
const baseUrl = process.env.UPSTREAM_BASE_URL || "https://opencode.ai";
const models = createModelsService({ baseUrl, headers: upstream.headers });

const router = createRouter({ token, upstream, models });
const srv = startServer({ router });

await srv.ready();
if (process.env.MSLXDFREE_DAEMON) {
  writePid(process.pid);
}
const addr = srv.server.address();
const host = addr.address === "0.0.0.0" || addr.address === "::" ? "localhost" : addr.address;
console.log(`mslxdfree listening on http://${host}:${addr.port}`);
if (created) {
  console.log(`auth token: ${token}`);
}
console.log(`endpoint:   http://${host}:${addr.port}/v1`);

async function waitForHealth(timeoutMs) {
  const start = Date.now();
  const port = Number(process.env.PORT) || 8080;
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