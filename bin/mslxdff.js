#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { startServer, resolvePort } from "../src/server.js";
import { DEFAULT_PORT, defaultStateFile } from "../src/state.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createModelsService } from "../src/models.js";
import { loadToken, refreshToken, setPort, getPort, loadGroupsJoined, saveGroupsJoined, loadModelErrors } from "../src/state.js";
import { startDaemon, stopDaemon, writePid, pidFile, logFile, readPid, readPidVersion, isPidAlive } from "../src/daemon.js";
import { createAutoSelector } from "../src/auto.js";
import { createPeersService } from "../src/peers.js";
import { createEventBus } from "../src/events.js";
import { createGroupsService, createBansService, refreshGroupMembers, syncPeersFromMembers } from "../src/groups.js";
import { logDir, recentCalls, lastError, appendCall, appendError, appendEvent, recentEvents, eventsFile, callsFile, errorsFile } from "../src/logs.js";

const logs = { appendCall, appendError, appendEvent };

const args = process.argv.slice(2);
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;
const HEALTH_TIMEOUT_MS = 4000;

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

if (args.includes("-uninstall") || args.includes("--uninstall")) {
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
    } catch {
      // already gone, fine
    }
  }
  if (removed.length) console.log(`removed ${removed.length} file(s):\n  ${removed.join("\n  ")}`);
  else console.log("no state/log files to remove");

  console.log("\npackage still installed — finish with:");
  console.log("  npm uninstall -g mslxdff");
  process.exit(0);
}

if (args.includes("-log") || args.includes("--log") || args.includes("-logs") || args.includes("--logs")) {
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
  // also hint for other logs
  if (count <= 10) {
    console.log(`\nhint: mslxdff -log 100  |  calls: ${callsFile()}  errors: ${errorsFile()}  daemon: ${logFile()}`);
  }
  process.exit(0);
}

if (args.includes("-status") || args.includes("--status") || args.includes("-s")) {
  await printStatus();
  process.exit(0);
}

// -model list | -models : show the free models this proxy serves (cache-first)
// -model refresh : force a fresh fetch from the upstream and update the cache
if (args.includes("-model") || args.includes("-models")) {
  const idx = args.findIndex((x) => x === "-model" || x === "-models");
  const sub = args[idx + 1];
  if (sub === "refresh") {
    const models = createModelsService({
      baseUrl: process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
      headers: createUpstreamClient({}).headers,
      refreshMs: 0,
      cacheFile: join(logDir(), "models.json"),
    });
    try {
      const list = await models.get();
      const ids = (list.data || []).map((m) => m.id).filter(Boolean);
      console.log(`refreshed: ${ids.length} free model(s)`);
      for (const id of ids) console.log(`  ${id}`);
    } catch (err) {
      console.error(`could not refresh models: ${String(err?.message || err)}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (sub === "status") {
    const statuses = loadModelErrors();
    const cacheFile = join(logDir(), "models.json");
    const cached = readModelsCache(cacheFile);
    const ids = new Set([
      ...(cached?.data || []).map((m) => m.id),
      ...Object.keys(statuses),
    ]);
    for (const id of ids) {
      const e = statuses[id];
      const st = typeof e === "number" ? "error" : e?.status || "normal";
      const at = typeof e === "number" ? e : e?.at;
      const when = at
        ? `  (${new Date(at).toISOString().slice(5, 19).replace("T", " ")})`
        : "";
      const extra = e?.code ? `  HTTP ${e.code}` : "";
      console.log(`  ${id}  ${st}${when}${extra}`);
    }
    process.exit(0);
  }
  if (sub !== undefined && sub !== "list") {
    console.error("usage: mslxdff -model list | mslxdff -model status | mslxdff -model refresh");
    process.exit(1);
  }
  const cacheFile = join(logDir(), "models.json");
  try {
    const cached = readModelsCache(cacheFile);
    if (cached) {
      const ids = (cached.data || []).map((m) => m.id).filter(Boolean);
      const at = cached.cachedAt ? ` (cached ${new Date(cached.cachedAt).toISOString().slice(0, 16).replace("T", " ")})` : "";
      console.log(`${ids.length} free model(s)${at}:`);
      for (const id of ids) console.log(`  ${id}`);
    } else {
      const models = createModelsService({
        baseUrl: process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
        headers: createUpstreamClient({}).headers,
        refreshMs: 0,
        cacheFile,
      });
      const list = await models.get();
      const ids = (list.data || []).map((m) => m.id).filter(Boolean);
      console.log(`${ids.length} free model(s):`);
      for (const id of ids) console.log(`  ${id}`);
    }
  } catch (err) {
    console.error(`could not fetch models: ${String(err?.message || err)}`);
    process.exit(1);
  }
  process.exit(0);
}

// -debug: stop the background daemon and run the server in THIS terminal
// (foreground), printing every event to stdout in real time via the in-memory
// event bus — no filesystem polling. Ctrl+C / SIGTERM restarts the daemon in
// the background, then exits. See the daemon body below for the stream wiring.
if (args.includes("-debug") || args.includes("--debug")) {
  const recent = recentEvents(100);
  if (recent.length) {
    console.log(`--- last ${recent.length} event(s) ---`);
    for (const e of recent) console.log(fmtEvent(e));
  }
  console.log("--- live (Ctrl+C: stop debugging and restore background daemon) ---");
  const { stopped, pid } = stopDaemon();
  if (stopped) console.log(`[debug] stopped background daemon (pid ${pid})`);
  process.env.MSLXDFF_DEBUG = "1";
  process.env.MSLXDFF_DAEMON = "1";
  // fall through to the daemon body below — no process.exit() here
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
    const joinedList = loadGroupsJoined();
    if (!joinedList.length) {
      console.log("no groups on this node");
      process.exit(0);
    }
    const { token } = await loadToken();
    const fetchImpl = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(1500) });
    for (const g of joinedList) {
      const isLeader = !g.leaderUrl;
      let members;
      if (isLeader) {
        members = groups.list()[g.name]?.members || {};
      } else {
        try {
          members = await refreshGroupMembers(g.name, {
            leaderUrl: g.leaderUrl,
            memberName: g.memberName,
            url: g.myUrl,
            token,
            fetchImpl,
          });
        } catch (err) {
          console.log(`${g.name}  (members unavailable — leader unreachable: ${errMsg(err)})`);
          continue;
        }
      }
      const entries = Object.entries(members).filter(([id]) => id !== "leader");
      console.log(`${g.name}  (${entries.length} member${entries.length === 1 ? "" : "s"})`);
      // probe every member endpoint concurrently for reachability + latency;
      // display order = state order so the sequence numbers stay stable for -group remove
      // broadband members (relay://) are not probed — they are reachable via leader
      const probes = await Promise.all(
        entries.map(([id, m]) => probeHealth({ id, url: m?.url || id, kind: m?.kind, lastSeen: m?.lastSeen, publicIp: m?.publicIp }))
      );
      const leaderEntry = members.leader ? Object.entries(members).find(([id]) => id === "leader") : null;
      const leaderProbe = leaderEntry ? await probeHealth({ id: "leader", url: leaderEntry[1].url }) : null;
      const display = leaderProbe ? [...probes, leaderProbe] : probes;
      let seq = 0;
      for (const r of display) {
        const m = entries.find(([eid]) => eid === r.id)?.[1] || (r.id === "leader" ? leaderEntry?.[1] : null);
        const isBb = r.kind === "broadband" || String(r.url || "").startsWith("relay://") || m?.kind === "broadband";
        if (isBb) {
          const ago = r.lastSeen ? `${Math.round((Date.now() - r.lastSeen) / 1000)}s ago` : "no heartbeat yet";
          const ip = r.publicIp || m?.publicIp || "?";
          const via = r.stale ? "stale" : `via leader ${ago}`;
          const stateBb = `${via} ip=${ip}`;
          if (r.id === "leader") {
            console.log(`  leader  ${r.url}  ${stateBb}`);
            continue;
          }
          seq += 1;
          const label = r.id && r.id !== r.url ? `  [${r.id}]` : "";
          console.log(`  ${seq}. ${r.url}${label}  [broadband] ${stateBb}`);
          continue;
        }
        const state = r.fail ? `fail  ${r.fail}` : `ok    ${r.ms}ms`;
        if (r.id === "leader") {
          console.log(`  leader  ${r.url}  ${state}`);
          continue;
        }
        seq += 1;
        const label = r.id && r.id !== r.url ? `  [${r.id}]` : "";
        console.log(`  ${seq}. ${r.url}${label}  ${state}`);
      }
    }
    console.log(`\njoined groups (${joinedList.length}):`);
    for (const g of joinedList) console.log(`  ${g.name}  ${g.leaderUrl || "(this node is the leader)"}`);
  } else if (action === "remove" && a) {
    // leader-only: kick a member by its list sequence number (1-based, leader excluded)
    const seq = Number(a);
    if (!Number.isInteger(seq) || seq < 1) {
      console.error(`usage: mslxdff -group remove <seq>`);
      process.exit(1);
    }
    const joined = loadGroupsJoined().find((g) => !g.leaderUrl);
    if (!joined) {
      console.error("group remove requires being the leader — this node leads no group");
      process.exit(1);
    }
    const members = groups.list()[joined.name]?.members || {};
    const entries = Object.entries(members).filter(([id]) => id !== "leader");
    const target = entries[seq - 1];
    if (!target) {
      console.error(`member #${seq} not found — group "${joined.name}" has ${entries.length} member(s)`);
      process.exit(1);
    }
    const [id, m] = target;
    try {
      const removed = groups.removeMember(joined.name, { url: m.url });
      if (removed) console.log(`removed ${m.url} from "${joined.name}"`);
      else console.log(`member ${m.url} already gone from "${joined.name}"`);
    } catch (err) {
      console.error(`remove failed: ${errMsg(err)}`);
      process.exit(1);
    }
  } else {
    console.error("usage: mslxdff -group sync | -group leave <name> | -group list | -group remove <seq> | -creategroup <name>");
  }
  process.exit(0);
}

// -addtogroup <leader-host> <name> [--broadband]
const addToGroupIdx = args.findIndex((x) => x === "-addtogroup" || x === "--addtogroup");
if (addToGroupIdx >= 0) {
  const rawArgs = args.slice(addToGroupIdx + 1);
  const isBroadband = rawArgs.includes("--broadband");
  const filtered = rawArgs.filter((a) => a !== "--broadband");
  const [leaderHost, name] = filtered;
  if (!leaderHost || !name || filtered.length > 2) {
    console.error("usage: mslxdff -addtogroup <leader-host> <name> [--broadband]");
    process.exit(1);
  }
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const myToken = (await loadToken()).token;
  const leaderUrl = leaderHost.includes("://")
    ? leaderHost.replace(/\/+$/, "")
    : `http://${leaderHost}${leaderHost.includes(":") ? "" : ":8989"}`;
  const kind = isBroadband ? "broadband" : "static";
  let joinBody;
  if (isBroadband) {
    const relayId = `relay://${myToken.slice(0, 8)}`;
    joinBody = { name, key: name, leaderUrl, url: relayId, token: myToken, kind: "broadband" };
  } else {
    const myPort = effectivePort();
    joinBody = { name, key: name, leaderUrl, myPort, token: myToken, kind: "static" };
  }
  try {
    const res = await fetch(`${leaderUrl}/v1/groups/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(joinBody),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`join failed (HTTP ${res.status}): ${text}`);
    }
    const data = await res.json();
    const myUrl = data.you?.url || joinBody.url || "";
    const memberName = isBroadband ? myUrl : myUrl;
    markJoined({ name, leaderUrl, myUrl, memberName, kind });
    const synced = await syncAllJoinedGroups({ peers, groups });
    const s = synced.find((x) => x.name === name);
    console.log(`joined group "${name}" at ${leaderUrl}${isBroadband ? " [broadband]" : ""}`);
    if (s?.error) console.log(`  local failover setup failed: ${s.error}`);
    else console.log(`  ${s?.added ?? 0} failover target(s) configured${isBroadband ? " (broadband via leader, local 127.0.0.1)" : ""}`);
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
  if (!entry.kind) entry.kind = "static";
  const list = loadGroupsJoined().filter((g) => g.name !== name);
  saveGroupsJoined([...list, entry]);
}

// -leavegroup | -leave-groups: leave every joined group as a member.
// Leaders cannot "leave" — they must disband with -delgroup <name>.
const leaveAll = args.includes("-leavegroup") || args.includes("--leavegroup") || args.includes("-leave-groups");
if (leaveAll) {
  const peers = createPeersService({});
  const joined = loadGroupsJoined();
  if (!joined.length) {
    console.log("not joined to any group");
    process.exit(0);
  }
  const myToken = (await loadToken()).token;
  const leaders = [];
  for (const g of joined) {
    if (g.leaderUrl) {
      // member: deregister from the leader so we stop showing up in -group list
      const peersRemoved = peers.removeByGroup(g.name);
      try {
        const res = await fetch(`${g.leaderUrl}/v1/groups/leave`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${myToken}`,
          },
          body: JSON.stringify({ name: g.name }),
        });
        if (res.ok) console.log(`${g.name}: left (deregistered from ${g.leaderUrl})`);
        else console.log(`${g.name}: left locally (leader said: ${await res.text().catch(() => `HTTP ${res.status}`)})`);
      } catch (err) {
        console.log(`${g.name}: left locally (leader unreachable: ${errMsg(err)})`);
      }
    } else {
      leaders.push(g.name);
    }
  }
  const left = joined.filter((g) => g.leaderUrl).map((g) => g.name);
  saveGroupsJoined(loadGroupsJoined().filter((g) => !left.includes(g.name)));
  console.log(`left ${left.length} group(s)`);
  if (leaders.length) {
    console.log(`\nskipped ${leaders.length} group(s) where this node is the leader:`);
    for (const n of leaders) console.log(`  ${n}  — leaders can't leave; disband it with: mslxdff -delgroup ${n}`);
  }
  process.exit(0);
}

// -delgroup <name>: a leader disbands one of its groups (local groups state +
// any member records). Fails if this node is not the leader of that group.
const delGroupName = argValue("-delgroup", "--delgroup");
if (delGroupName) {
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const local = groups.list()[delGroupName];
  if (!local) {
    const joined0 = loadGroupsJoined().find((g) => g.name === delGroupName);
    if (joined0?.leaderUrl) {
      console.log(`"${delGroupName}" is led by ${joined0.leaderUrl} — you are a member, use -leavegroup to leave it`);
    } else if (joined0) {
      console.log(`"${delGroupName}" exists in local state but has no group definition — nothing to delete`);
    } else {
      console.log(`group "${delGroupName}" not found on this node`);
    }
    process.exit(1);
  }
  const disbanded = groups.delete(delGroupName);
  const members = Object.values(disbanded?.members || {});
  peers.removeByGroup(delGroupName);
  saveGroupsJoined(loadGroupsJoined().filter((g) => g.name !== delGroupName));
  console.log(`group "${delGroupName}" disbanded (${members.length} member${members.length === 1 ? "" : "s"} removed)`);
  process.exit(0);
}

function errMsg(err) { return String(err?.message || err); }

// Probe a member's health endpoint concurrently (v1/health preferred,
// falling back to /health). Returns { id, url, ms, rank } or { id, url, fail }.
// broadband relay:// members are not probed — they are reachable via leader relay.
async function probeHealth({ id, url, kind, lastSeen, publicIp } = {}) {
  if (!url) return { id, url, fail: "no url", rank: 3 };
  const isBb = kind === "broadband" || String(url).startsWith("relay://");
  if (isBb) {
    const staleMs = Number(process.env.MSLXDFF_BROADBAND_STALE_MS) > 0 ? Number(process.env.MSLXDFF_BROADBAND_STALE_MS) : 90_000;
    const stale = typeof lastSeen === "number" ? Date.now() - lastSeen > staleMs : true;
    return { id, url, kind: "broadband", lastSeen, publicIp, stale, rank: stale ? 2 : 0 };
  }
  const base = String(url).replace(/\/+$/, "");
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return { id, url: base, fail: `HTTP ${res.status}`, rank: 2 };
    return { id, url: base, ms: Date.now() - startedAt, rank: 0 };
  } catch (err) {
    return { id, url: base, fail: errMsg(err), rank: 2 };
  }
}

function readModelsCache(cacheFile) {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    return null;
  }
}

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
          kind: g.kind,
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

// Upgrade-aware handling of a running daemon: keep it when it already runs
// our version, otherwise stop it so the spawn below takes over. Cleans up
// stale pid files (daemon died without -stop).
function stopDaemonIfOutdated() {
  const pid = readPid();
  if (!pid) return;
  if (!isPidAlive(pid)) {
    console.log(`daemon pid ${pid} is stale (not running) — starting fresh`);
    return;
  }
  const runningVersion = readPidVersion();
  if (runningVersion === VERSION) return;
  console.log(
    runningVersion
      ? `daemon running v${runningVersion} — upgrading to v${VERSION}, restarting...`
      : `daemon version unknown — restarting with v${VERSION}...`
  );
  stopDaemon();
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
    stopDaemonIfOutdated();
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
  const pid = readPid();
  if (pid && isPidAlive(pid) && readPidVersion() === VERSION) {
    await printStatus();
    printHelp();
    process.exit(0);
  }
  const port = effectivePort();
  stopDaemonIfOutdated();
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
  slowCooldownMs: slowCooldownMs(),
  loadCandidates: async () => {
    try {
      return (await models.get()).data.map((m) => m.id);
    } catch {
      return null;
    }
  },
});
const peers = createPeersService({ cooldownMs: peerCooldownMs(), heatMs: peerHeatMs() });
const groups = createGroupsService({});
const bans = createBansService({ windowMs: banWindowMs(), threshold: banThreshold() });

const isDebug = process.env.MSLXDFF_DEBUG === "1";
const bus = createEventBus();
const router = createRouter({ token, upstream, models, auto, logs, peers, maxHops: maxHopsValue(), groups, bans, bus });
const listenHost = effectiveHost();
const srv = startServer({ router, signals: !isDebug, host: listenHost });

// -debug: push every event straight to this terminal.
if (isDebug) {
  bus.subscribe((e) => {
    try {
      console.log(fmtEvent(e));
    } catch {
      // malformed event — skip
    }
  });
  // Ctrl+C / SIGTERM: restore the background daemon, then exit.
  const restore = () => {
    console.log("\n[debug] restoring background daemon...");
    try {
      const restoredPid = startDaemon([]);
      console.log(`[debug] daemon restored (pid ${restoredPid})`);
    } catch (err) {
      console.error(`[debug] could not restore daemon: ${err.message}`);
    }
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
}

await srv.ready();
models.startAutoRefresh();
if (process.env.MSLXDFF_DAEMON) {
  writePid(process.pid, VERSION);
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

// Broadband heartbeat + relay poll (only for broadband members)
const broadbandGroups = () => loadGroupsJoined().filter((g) => g.kind === "broadband" && g.leaderUrl);
if (broadbandGroups().length) {
  const doHeartbeat = async () => {
    for (const g of broadbandGroups()) {
      try {
        const res = await fetch(`${g.leaderUrl}/v1/groups/relay/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ name: g.name, group: g.name }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          console.log(`broadband heartbeat ${g.name}: ${res.status} ${txt.slice(0, 100)}`);
        }
      } catch (err) {
        console.log(`broadband heartbeat ${g.name}: failed — ${errMsg(err)}`);
      }
    }
  };
  const doPoll = async () => {
    for (const g of broadbandGroups()) {
      try {
        const pollRes = await fetch(`${g.leaderUrl}/v1/groups/relay/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ name: g.name, group: g.name }),
          signal: AbortSignal.timeout(8000),
        });
        if (!pollRes.ok) continue;
        const data = await pollRes.json().catch(() => ({}));
        const items = data.data || [];
        for (const item of items) {
          const { reqId, body } = item;
          let result;
          try {
            const upRes = await upstream.chat(body);
            const ct = upRes.headers.get("content-type") || "";
            const isStream = Boolean(body?.stream) || ct.includes("text/event-stream");
            if (isStream && upRes.body) {
              // collect stream chunks for relay (simplified: buffer then forward as SSE)
              let collected = "";
              for await (const chunk of upRes.body) {
                collected += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
              }
              result = { status: upRes.status, headers: { "Content-Type": "text/event-stream" }, body: collected };
            } else {
              const txt = await upRes.text();
              let parsed;
              try { parsed = JSON.parse(txt); } catch { parsed = txt; }
              result = { status: upRes.status, headers: { "Content-Type": upRes.headers.get("content-type") || "application/json" }, body: typeof parsed === "string" ? parsed : JSON.stringify(parsed) };
            }
          } catch (err) {
            result = { status: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: errMsg(err) }) };
          }
          try {
            await fetch(`${g.leaderUrl}/v1/groups/relay/result`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
              body: JSON.stringify({ name: g.name, group: g.name, reqId, result }),
              signal: AbortSignal.timeout(5000),
            });
          } catch {}
        }
      } catch {}
    }
  };
  // initial heartbeat
  doHeartbeat().catch(() => {});
  const hbTimer = setInterval(doHeartbeat, 30_000);
  hbTimer.unref();
  const pollTimer = setInterval(doPoll, 1000);
  pollTimer.unref();
  console.log(`broadband relay: heartbeat 30s + poll 1s for ${broadbandGroups().length} group(s)`);
}

// Auto-update: periodically check npm for a newer mslxdff and restart.
// Enable with MSLXDFF_AUTO_UPDATE=1 (hourly) or MSLXDFF_AUTO_UPDATE_MS=<ms>.
// Uses the same npm view/install path as `mslxdff -update`, but runs inside
// the daemon so no manual intervention is needed.
const autoUpdateMs = autoUpdateIntervalMs();
if (autoUpdateMs) {
  console.log(`auto-update enabled: checking every ${Math.round(autoUpdateMs / 60000)}m`);
  const autoUpdateTimer = setInterval(() => {
    checkAndAutoUpdate().catch((err) => console.log(`auto-update check failed: ${errMsg(err)}`));
  }, autoUpdateMs);
  autoUpdateTimer.unref();
}

async function checkAndAutoUpdate() {
  const info = await run(npmCmd(), ["view", "mslxdff", "version", "dist-tags.latest"]);
  if (info.err) throw new Error(info.err.message);
  const parts = (info.stdout || "").trim().split(/\s+/).filter(Boolean);
  const latest = parts[parts.length - 1];
  if (!latest || latest === VERSION) return;
  // simple semver compare: skip if latest is not newer
  if (compareSemver(latest, VERSION) <= 0) return;
  console.log(`auto-update: v${VERSION} -> v${latest}, installing...`);
  const up = await run(npmCmd(), ["install", "-g", `mslxdff@${latest}`]);
  if (up.err) throw new Error(up.err.message);
  console.log(`auto-update: installed v${latest}, restarting daemon...`);
  try { stopDaemon(); } catch {}
  // startDaemon re-reads VERSION from the newly installed package on next boot;
  // for the current process we just respawn with the new code.
  const newPid = startDaemon([]);
  await waitForHealth(resolvePort(), 8000);
  console.log(`auto-update: restarted as v${latest} (pid ${newPid})`);
}

function compareSemver(a, b) {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

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

function effectiveHost() {
  const envHost = process.env.MSLXDFF_HOST || process.env.MSLXDFF_BIND_HOST;
  if (typeof envHost === "string" && envHost.trim()) return envHost.trim();
  try {
    const joined = loadGroupsJoined();
    if (joined.some((g) => g.kind === "broadband")) return "127.0.0.1";
  } catch {}
  return "0.0.0.0";
}

function refreshIntervalMs() {
  const n = Number(process.env.MODELS_REFRESH_MS);
  return Number.isInteger(n) && n > 0 ? n : 2 * 60 * 60 * 1000;
}

function modelCooldownMs() {
  const n = Number(process.env.MSLXDFF_MODEL_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}

function slowCooldownMs() {
  const n = Number(process.env.MSLXDFF_SLOW_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 5 * 60_000;
}

function peerCooldownMs() {
  const n = Number(process.env.MSLXDFF_PEER_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 30_000;
}

function peerHeatMs() {
  const n = Number(process.env.MSLXDFF_PEER_HEAT_MS);
  return Number.isInteger(n) && n > 0 ? n : 5 * 60_000;
}

function maxHopsValue() {
  const n = Number(process.env.MSLXDFF_MAX_HOPS);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

function groupSyncIntervalMs() {
  const n = Number(process.env.MSLXDFF_GROUP_SYNC_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}

function autoUpdateIntervalMs() {
  const raw = process.env.MSLXDFF_AUTO_UPDATE_MS ?? process.env.MSLXDFF_AUTO_UPDATE;
  if (raw === undefined || raw === null || raw === "") return 0;
  if (raw === "1" || String(raw).toLowerCase() === "true") return 60 * 60 * 1000;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
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
  mslxdff -log [N]                 show last N events (default 10, e.g. -log 100)
  mslxdff -model list              list the free models this proxy serves (cached)
  mslxdff -model status            show per-model health status (normal/limit/error)
  mslxdff -model refresh           force-refresh the model cache from the upstream
  mslxdff -debug                   live-follow the daemon event stream (requests, errors, peer forwards)
  mslxdff -stop                    stop the running daemon
  mslxdff -uninstall               stop the daemon and delete all state/log files
  mslxdff -port N                  persist the listen port (restarts the daemon on it if running)
  mslxdff -update                  update mslxdff to the latest published version
  mslxdff -showtoken               print the current auth token
  mslxdff -refresh-token           rotate the auth token (prints the new one)
  mslxdff -creategroup <name>      create a group on this node (the group name is the password)
  mslxdff -addtogroup <leader-host> <name> [--broadband]  join a group via its leader host (default port 8989) — broadband: 宽带动态IP成员（经Leader中继，无需公网入站，默认127.0.0.1）
  mslxdff -group sync              pull the freshest member list for all joined groups
  mslxdff -group leave <name>      leave a group (removes its members from this node)
  mslxdff -group list              list groups on this node (numbered members)
  mslxdff -group remove <seq>      leader only: kick a member by its list sequence number
  mslxdff -leavegroup              leave every joined group as a member (leaders: use -delgroup)
  mslxdff -delgroup <name>         disband a group this node leads (deletes it and its members)
  mslxdff -resetban [ip]           clear join-failure bans (all, or one ip)
  mslxdff -help                    show this help

Environment:
  MSLXDFF_PORT          listen port (default 8989; use mslxdff -port N to persist)
  MSLXDFF_STATE_FILE      token/port state file
  MSLXDFF_DAEMON_DIR      daemon pid/log/models dir
  UPSTREAM_BASE_URL       upstream base (default https://opencode.ai)
  UPSTREAM_AUTH_TOKEN     upstream bearer value (default "public")
  UPSTREAM_CONNECT_TIMEOUT_MS  upstream connect timeout (default 30000)
  MODELS_REFRESH_MS       model-list background refresh interval (default 7200000)
  MSLXDFF_MODEL_COOLDOWN_MS  fallback cooldown after a model error (default 60000)
  MSLXDFF_PEER_COOLDOWN_MS   peer failover cooldown (default 30000)
  MSLXDFF_PEER_HEAT_MS       how long a peer success stays hot for fast reuse (default 300000)
  MSLXDFF_GROUP_SYNC_MS   group membership sync interval (default 60000)
  MSLXDFF_MAX_HOPS           max peer-forwarding depth (default 3)
  MSLXDFF_BAN_THRESHOLD   failed joins before an ip is banned (default 5)
  MSLXDFF_BAN_WINDOW_MS   ban duration after too many failures (default 48h)
  MSLXDFF_AUTO_UPDATE   auto-update: 1/true=hourly, or ms interval (0=off)
  MSLXDFF_AUTO_UPDATE_MS  same as above, explicit ms (overrides AUTO_UPDATE)
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
            if (m?.kind === "broadband") tags.push("broadband");
            if (m?.kind === "broadband" && m?.publicIp) tags.push(`ip=${m.publicIp}`);
            if (m?.kind === "broadband" && m?.lastSeen) {
              const ago = Math.round((Date.now() - m.lastSeen) / 1000);
              tags.push(ago < 90 ? `via leader ${ago}s ago` : "stale");
            }
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
      const tags = [];
      if (peers.isCooling(p.url)) tags.push("cooling");
      if (peers.isHot(p.url)) tags.push("hot");
      const s = peers.stat(p.url);
      if (s?.latencyMs != null) tags.push(`${s.latencyMs}ms`);
      if (s?.fails) tags.push(`${s.fails} fail(s)`);
      const tag = tags.length ? `  [${tags.join(", ")}]` : "";
      console.log(`  ${p.name || p.url}  ${p.url}${tag}`);
    }
  }

  const groupNames = Object.keys(groups.list());
  if (groupNames.length) {
    console.log(`\ngroups on this node (${groupNames.length}):`);
    for (const n of groupNames) console.log(`  ${n}`);
  }

  const modelsFile = join(logDir(), "models.json");
  const statuses = loadModelErrors();
  if (existsSync(modelsFile)) {
    try {
      const cached = JSON.parse(readFileSync(modelsFile, "utf8"));
      const ids = (cached.data || []).map((m) => m.id).filter(Boolean);
      console.log(`\nmodels (${ids.length} free):`);
      for (const id of ids) {
        const st = fmtStatus(id, statuses);
        console.log(`  ${id}${st ? `  [${st}]` : ""}`);
      }
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

function fmtStatus(id, statuses) {
  const e = statuses[id];
  if (typeof e === "number") return `error ${fmtTs(new Date(e).toISOString())}`;
  if (!e?.status || e.status === "normal") return "";
  const when = e.at ? ` ${fmtTs(new Date(e.at).toISOString())}` : "";
  const code = e.code ? ` HTTP ${e.code}` : "";
  return `${e.status}${when}${code}`;
}

function fmtDur(ms) {
  if (!Number.isFinite(ms)) return "?";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtEvent(e) {
  const t = e?.ts ? new Date(e.ts).toISOString().slice(11, 19) : "--:--:--";
  const head = `[${t}]`;
  const m = (x) => x || "-";
  switch (e?.type) {
    case "request":
      return `${head} request       ${m(e.model)}${e.auto ? " (auto)" : ""} hops=${e.hops} from ${e.ip || "?"}${e.stream ? " stream" : ""}${e.prompt ? ` content="${e.prompt}"` : ""}`;
    case "upstream-error":
      return `${head} upstream err  ${m(e.model)} ${e.status ? `HTTP ${e.status}` : "network"}: ${m(e.message)}`;
    case "peer-health":
      return `${head} peer check    ${e.peer} -> ${e.count ? e.healthy.join(", ") : "no healthy models"}`;
    case "peer-forward":
      return `${head} forward ->    ${e.peer} model=${m(e.model)} hops=${e.hops}${e.retry ? " (retry)" : ""}`;
    case "peer-error":
      return `${head} peer err      ${e.peer} ${e.status ? `HTTP ${e.status}` : "network"}: ${m(e.message)}`;
    case "relay-ip-change":
      return `${head} relay ip      ${e.member || e.id || "?"} ${e.oldIp || "?"} -> ${e.newIp || e.publicIp || "?"} via leader`;
    case "relay-forward":
      return `${head} relay fwd     ${e.target || e.peer || "?"} via leader model=${m(e.model)} hops=${e.hops || 0}`;
    case "relay-heartbeat":
      return `${head} relay hb      ${e.member || "?"} ip=${e.ip || "?"} lastSeen=${e.lastSeen ? new Date(e.lastSeen).toISOString().slice(11,19) : "?"}`;
    case "client-abort":
      return `${head} client abort  ${m(e.model)} total=${fmtDur(e.totalMs)}`;
    case "result":
      return `${head} result        ${e.status} ${m(e.model)} via=${e.via} 响应耗时 ${fmtDur(e.durationMs)}`;
    default:
      return `${head} ${e?.type || "?"} ${JSON.stringify(e || {})}`;
  }
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
