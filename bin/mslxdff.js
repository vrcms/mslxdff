#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer, resolvePort } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createModelsService } from "../src/models.js";
import { loadToken, refreshToken, setPort, getPort, loadGroupsJoined, saveGroupsJoined } from "../src/state.js";
import { startDaemon, stopDaemon, writePid, pidFile, logFile, readPid } from "../src/daemon.js";
import { createAutoSelector } from "../src/auto.js";
import { createPeersService } from "../src/peers.js";
import { createGroupsService, createBansService, refreshGroupMembers, syncPeersFromMembers } from "../src/groups.js";
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
  await printStatus();
  process.exit(0);
}

// -creategroup <name> | -group create <name> | -group sync | -group leave <name> | -group list |
// -addtogroup <leader-host> <name> | -resetban [ip]
const createGroupArg = argValue("-creategroup", "--creategroup") || groupIs("create", args);
if (createGroupArg) {
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const name = createGroupArg;
  const { created } = groups.create(name); // the group name is the password
  markJoined({ name, leaderUrl: "", myUrl: "", memberName: "leader" });
  const synced = await syncAllJoinedGroups({ peers, groups });
  const s = synced.find((x) => x.name === name);
  console.log(created ? `group created: ${name}` : `group already exists: ${name}`);
  console.log(`members on this node: ${s ? `${s.total} (failover: ${s.added})` : "?"}`);
  console.log(`others join with: mslxdff -addtogroup <this-node-host> ${name}`);
  process.exit(0);
}

function groupIs(action, argv) {
  const idx = argv.indexOf("-group");
  if (idx < 0) return null;
  return argv[idx + 1] === action ? argv[idx + 2] : null;
}

const groupCmd = argValue("-group", "--group");
if (groupCmd && groupCmd !== "create") {
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const rest = args.slice(args.indexOf("-group") + 1);
  const [action, a] = rest;
  if (action === "sync") {
    const synced = await syncAllJoinedGroups({ peers, groups });
    if (!synced.length) {
      console.log("not joined to any group (use -addtogroup or -creategroup)");
    } else {
      for (const s of synced) {
        if (s.error) console.log(`${s.name}: sync failed — ${s.error}`);
        else console.log(`${s.name}: ${s.total} member(s), ${s.added} failover target(s) configured`);
      }
    }
  } else if (action === "leave" && a) {
    const before = loadGroupsJoined().filter((g) => g.name === a).length;
    saveGroupsJoined(loadGroupsJoined().filter((g) => g.name !== a));
    const removed = peers.removeByGroup(a);
    console.log(before ? `left group "${a}" (${removed} member(s) removed)` : `not a member of group "${a}"`);
  } else if (action === "list") {
    const all = groups.list();
    const names = Object.keys(all);
    if (names.length) {
      for (const n of names) {
        console.log(`${n}  (${Object.keys(all[n].members || {}).length} members)`);
      }
    } else {
      console.log("no groups on this node");
    }
    const joined = loadGroupsJoined();
    if (joined.length) {
      console.log(`\njoined groups (${joined.length}):`);
      for (const g of joined) console.log(`  ${g.name}  ${g.leaderUrl || "(this node is the leader)"}`);
    }
  } else {
    console.error("usage: mslxdff -creategroup <name> | -group sync | -group leave <name> | -group list");
  }
  process.exit(0);
}

// -addtogroup <leader-host> <name>
const addToGroupIdx = args.findIndex((x) => x === "-addtogroup" || x === "--addtogroup");
if (addToGroupIdx >= 0) {
  const [leaderHost, name] = args.slice(addToGroupIdx + 1);
  if (!leaderHost || !name) {
    console.error("usage: mslxdff -addtogroup <leader-host> <name>");
    process.exit(1);
  }
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const myToken = (await loadToken()).token;
  const leaderUrl = leaderHost.includes("://")
    ? leaderHost.replace(/\/+$/, "")
    : `http://${leaderHost}${leaderHost.includes(":") ? "" : ":8989"}`;
  const myPort = effectivePort();
  try {
    const res = await fetch(`${leaderUrl}/v1/groups/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, key: name, leaderUrl, myPort, token: myToken }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`join failed (HTTP ${res.status}): ${text}`);
    }
    const data = await res.json();
    const myUrl = data.you?.url || "";
    markJoined({ name, leaderUrl, myUrl, memberName: myUrl });
    const synced = await syncAllJoinedGroups({ peers, groups });
    const s = synced.find((x) => x.name === name);
    console.log(`joined group "${name}" at ${leaderUrl}`);
    if (s?.error) console.log(`  local failover setup failed: ${s.error}`);
    else console.log(`  ${s?.added ?? 0} failover target(s) configured`);
  } catch (err) {
    console.error(`join failed: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// -resetban [ip]
const resetBanArg = argValue("-resetban", "--resetban");
if (resetBanArg !== null || args.includes("-resetban") || args.includes("--resetban")) {
  const bans = createBansService({});
  const ip = resetBanArg || null;
  bans.clear(ip || undefined);
  console.log(ip ? `ban cleared for ${ip}` : "all bans cleared");
  process.exit(0);
}

function markJoined(entry) {
  const { name } = entry;
  const list = loadGroupsJoined().filter((g) => g.name !== name);
  saveGroupsJoined([...list, entry]);
}

const errMsg = (err) => String(err?.message || err);

// Sync every joined group into the local peer list. Leaders read their local
// groups state; members re-register with the leader (idempotent) to get the
// freshest member list. Returns per-group results.
async function syncAllJoinedGroups({ peers, groups }) {
  const joined = loadGroupsJoined();
  const myToken = (await loadToken()).token;
  const results = [];
  for (const g of joined) {
    try {
      if (g.leaderUrl) {
        const members = await refreshGroupMembers(g.name, {
          leaderUrl: g.leaderUrl,
          memberName: g.memberName,
          url: g.myUrl,
          token: myToken,
        });
        results.push({
          name: g.name,
          ...syncPeersFromMembers({ peers, members, myUrl: g.myUrl, group: g.name }),
        });
      } else {
        // this node is the leader: […] own entry is always skipped
        const members = groups.list()[g.name]?.members ?? {};
        results.push({
          name: g.name,
          ...syncPeersFromMembers({ peers, members, myUrl: g.myUrl, group: g.name, skipIds: ["leader"] }),
        });
      }
    } catch (err) {
      results.push({ name: g.name, error: errMsg(err) });
    }
  }
  return results;
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

// Bare run: show status + help when the daemon is already up; otherwise spawn it
// as a background daemon and exit — never holds the terminal (npx-friendly).
if (!process.env.MSLXDFF_DAEMON) {
  if (readPid()) {
    await printStatus();
    printHelp();
    process.exit(0);
  }
  const port = effectivePort();
  const spawnedPid = startDaemon([]);
  await waitForHealth(port, 4000);
  console.log(`mslxdff v${VERSION} started as a background daemon (pid ${spawnedPid})`);
  console.log(`endpoint:   http://localhost:${port}/v1`);
  console.log(`log:        ${logFile()}`);
  console.log(`pid:        ${pidFile()}`);
  console.log(`status:     run \`mslxdff\` again (or \`mslxdff -status\`)`);
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
const peers = createPeersService({ cooldownMs: peerCooldownMs() });
const groups = createGroupsService({});
const bans = createBansService({ windowMs: banWindowMs(), threshold: banThreshold() });

const router = createRouter({ token, upstream, models, auto, logs, peers, maxHops: maxHopsValue(), groups, bans });
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

// Periodically pull the freshest member lists for every joined group so a
// new member becomes a failover peer on all nodes without manual re-joining.
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

function peerCooldownMs() {
  const n = Number(process.env.MSLXDFF_PEER_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 30_000;
}

function maxHopsValue() {
  const n = Number(process.env.MSLXDFF_MAX_HOPS);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

function groupSyncIntervalMs() {
  const n = Number(process.env.MSLXDFF_GROUP_SYNC_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}

function banWindowMs() {
  const n = Number(process.env.MSLXDFF_BAN_WINDOW_MS);
  return Number.isInteger(n) && n > 0 ? n : 48 * 60 * 60 * 1000;
}

function banThreshold() {
  const n = Number(process.env.MSLXDFF_BAN_THRESHOLD);
  return Number.isInteger(n) && n > 0 ? n : 5;
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
  mslxdff                          start as a background daemon and exit (status + help if one is already running)
  mslxdff -d                       start as a background daemon
  mslxdff -status                  show current status (daemon, models, recent calls, last error)
  mslxdff -stop                    stop the running daemon
  mslxdff -port N                  persist the listen port (restarts the daemon on it if running)
  mslxdff -update                  update mslxdff to the latest published version
  mslxdff -showtoken               print the current auth token
  mslxdff -refresh-token           rotate the auth token (prints the new one)
  mslxdff -creategroup <name>      create a group on this node (the group name is the password)
  mslxdff -addtogroup <leader-host> <name>  join a group via its leader host (default port 8989)
  mslxdff -group sync              pull the freshest member list for all joined groups
  mslxdff -group leave <name>      leave a group (removes its members from this node)
  mslxdff -group list              list groups on this node
  mslxdff -resetban [ip]           clear join-failure bans (all, or one ip)
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
  MSLXDFF_PEER_COOLDOWN_MS   peer failover cooldown (default 30000)
  MSLXDFF_GROUP_SYNC_MS   group membership sync interval (default 60000)
  MSLXDFF_MAX_HOPS           max peer-forwarding depth (default 3)
  MSLXDFF_BAN_THRESHOLD   failed joins before an ip is banned (default 5)
  MSLXDFF_BAN_WINDOW_MS   ban duration after too many failures (default 48h)
`);
}

async function printStatus() {
  const daemon = readPid();
  const port = getPort() || resolvePort();
  console.log(`mslxdff v${VERSION}`);
  console.log(`daemon:    ${daemon ? `running (pid ${daemon})` : "not running"}`);
  console.log(`endpoint:  http://localhost:${port}/v1`);
  console.log(`log dir:   ${logDir()}`);

  const groups = createGroupsService({});
  const joined = loadGroupsJoined();
  if (joined.length) {
    console.log(`\njoined groups (${joined.length}):`);
    const { token } = await loadToken();
    for (const g of joined) {
      const isLeader = !g.leaderUrl;
      console.log(`  ${g.name}  ${isLeader ? "(this node is the leader)" : `leader ${g.leaderUrl}`}`);
      let members = null;
      if (isLeader) {
        members = groups.list()[g.name]?.members ?? {};
      } else {
        // registered members can pull the member map back from the leader
        const fetchImpl = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(1500) });
        try {
          members = await refreshGroupMembers(g.name, {
            leaderUrl: g.leaderUrl,
            memberName: g.memberName,
            url: g.myUrl,
            token,
            fetchImpl,
          });
        } catch {
          members = null;
        }
      }
      if (members === null) {
        console.log("    members: (unavailable — leader unreachable)");
      } else {
        const ids = Object.keys(members);
        if (!ids.length) {
          console.log("    members: (none yet)");
        } else {
          console.log(`    members (${ids.length}):`);
          for (const id of ids) {
            const m = members[id];
            const tags = [];
            if (id === "leader" && isLeader) tags.push("leader");
            if (m?.url && m.url === g.myUrl) tags.push("this node");
            const tag = tags.length ? `  [${tags.join(", ")}]` : "";
            console.log(`      ${m?.url || id}${tag}`);
          }
        }
      }
    }
  } else {
    console.log("\njoined groups: (none — use -creategroup or -addtogroup)");
  }

  const peers = createPeersService({});
  const allPeers = peers.all();
  if (allPeers.length) {
    console.log(`\nfailover targets (${allPeers.length}):`);
    for (const p of allPeers) {
      const cooling = peers.isCooling(p.url) ? "  [cooling]" : "";
      console.log(`  ${p.name || p.url}  ${p.url}${cooling}`);
    }
  }

  const groupNames = Object.keys(groups.list());
  if (groupNames.length) {
    console.log(`\ngroups on this node (${groupNames.length}):`);
    for (const n of groupNames) console.log(`  ${n}`);
  }

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
