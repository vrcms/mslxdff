import { createGroupsService, createBansService, refreshGroupMembers, syncPeersFromMembers } from "../../groups.js";
import { createPeersService } from "../../peers.js";
import { loadToken, loadGroupsJoined, saveGroupsJoined } from "../../state.js";
import { groupIs, markJoined, probeHealth, syncAllJoinedGroups } from "../group-helpers.js";
import { errMsg } from "../util.js";
import { argValue } from "../policy.js";
import { compatFetch, timeoutSignal } from "../../compat.js";

export async function handleGroupCreate(args) {
  const createGroupArg = argValue(args, "-creategroup", "--creategroup") || groupIs("create", args);
  if (!createGroupArg) return false;
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const name = createGroupArg;
  const { created } = groups.create(name);
  markJoined({ name, leaderUrl: "", myUrl: "", memberName: "leader" });
  const synced = await syncAllJoinedGroups({ peers, groups });
  const s = synced.find((x) => x.name === name);
  console.log(created ? `group created: ${name}` : `group already exists: ${name}`);
  console.log(`members on this node: ${s ? `${s.total} (failover: ${s.added})` : "?"}`);
  console.log(`others join with: mslxdff -addtogroup <this-node-host> ${name}`);
  process.exit(0);
}

export async function handleGroupCommand(args) {
  const groupCmd = argValue(args, "-group", "--group");
  if (!groupCmd || groupCmd === "create") return false;
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
    const fetchImpl = (url, opts) => compatFetch(url, { ...opts, signal: timeoutSignal(1500) });
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

export async function handleAddToGroup(args) {
  const addToGroupIdx = args.findIndex((x) => x === "-addtogroup" || x === "--addtogroup");
  if (addToGroupIdx < 0) return false;
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
    const { effectivePort } = await import("../policy.js");
    const myPort = effectivePort(args);
    joinBody = { name, key: name, leaderUrl, myPort, token: myToken, kind: "static" };
  }
  try {
    const res = await compatFetch(`${leaderUrl}/v1/groups/join`, {
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

export async function handleResetBan(args) {
  const resetBanArg = argValue(args, "-resetban", "--resetban");
  if (resetBanArg === null && !args.includes("-resetban") && !args.includes("--resetban")) return false;
  const bans = createBansService({});
  const ip = resetBanArg || null;
  bans.clear(ip || undefined);
  console.log(ip ? `ban cleared for ${ip}` : "all bans cleared");
  process.exit(0);
}

export async function handleLeaveGroup(args) {
  const leaveAll = args.includes("-leavegroup") || args.includes("--leavegroup") || args.includes("-leave-groups");
  if (!leaveAll) return false;
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
      const peersRemoved = peers.removeByGroup(g.name);
      try {
        const res = await compatFetch(`${g.leaderUrl}/v1/groups/leave`, {
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

export async function handleDelGroup(args) {
  const delGroupName = argValue(args, "-delgroup", "--delgroup");
  if (!delGroupName) return false;
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
