import { timingSafeEqual, createHash } from "node:crypto";
import { loadGroups, saveGroups, loadBans, saveBans } from "./state.js";
import { normalizePeerUrl } from "./peers.js";

export const DEFAULT_GROUP_SYNC_MS = 60_000;
export const DEFAULT_BAN_WINDOW_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_BAN_THRESHOLD = 5;
const SYNC_TIMEOUT_MS = 15_000;

function digestKey(key) {
  return createHash("sha256").update(String(key || "")).digest();
}

export function verifyGroupKey(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  return timingSafeEqual(digestKey(provided), digestKey(expected));
}

// Leader side: create a group. The group name IS the password — anyone who
// knows the name can join, so pick something unguessable.
export function createGroup(name, { file, key = name } = {}) {
  if (!name) throw new Error("group name is required");
  const groups = loadGroups(file ? { file } : {});
  if (groups[name]) return { name, key: groups[name].key, created: false };
  groups[name] = { key, members: {} };
  saveGroups(groups, file ? { file } : {});
  return { name, key, created: true };
}

// Leader side: add a member after verifying the join key.
export function addGroupMember(name, { key, memberName, url, token, file } = {}) {
  const groups = loadGroups(file ? { file } : {});
  const group = groups[name];
  if (!group) throw new Error(`group "${name}" not found on this node`);
  if (!verifyGroupKey(key, group.key)) throw new Error("invalid group key");
  if (!url) throw new Error("member url is required");
  const id = memberName || url;
  group.members[id] = { url, token: token || "" };
  saveGroups(groups, file ? { file } : {});
  return group.members;
}

// Leader side: upsert a member without key verification (used by the sync
// path after the member's bearer token has already been validated).
export function upsertMember(name, { memberName, url, token, file } = {}) {
  const groups = loadGroups(file ? { file } : {});
  const group = groups[name];
  if (!group) return null;
  if (!url) throw new Error("member url is required");
  const id = memberName || url;
  group.members[id] = { url, token: token || "" };
  saveGroups(groups, file ? { file } : {});
  return group.members;
}

// Leader side: confirm a bearer token matches a registered member, then return
// the member list. Used by the sync path (registered members re-registering).
export function membersForToken(name, providedToken, { file } = {}) {
  if (typeof providedToken !== "string" || !providedToken) return null;
  const groups = loadGroups(file ? { file } : {});
  const group = groups[name];
  if (!group) return null;
  const hit = Object.entries(group.members || {}).find(([, m]) =>
    typeof m.token === "string" && m.token.length > 0 &&
    timingSafeEqual(digestKey(m.token), digestKey(providedToken)));
  return hit ? { member: hit[1], members: group.members } : null;
}

// Leader side: list members (requires the join key).
export function listGroupMembers(name, { key, file } = {}) {
  const groups = loadGroups(file ? { file } : {});
  const group = groups[name];
  if (!group) throw new Error(`group "${name}" not found on this node`);
  if (!verifyGroupKey(key, group.key)) throw new Error("invalid group key");
  return group.members;
}

export function listGroups({ file } = {}) {
  return loadGroups(file ? { file } : {});
}

export function createGroupsService({ file } = {}) {
  const opts = (o = {}) => (file ? { ...o, file } : o);
  return {
    create: (name, o = {}) => createGroup(name, opts(o)),
    addMember: (name, o = {}) => addGroupMember(name, opts(o)),
    upsertMember: (name, o = {}) => upsertMember(name, opts(o)),
    listMembers: (name, o = {}) => listGroupMembers(name, opts(o)),
    membersForToken: (name, token) => membersForToken(name, token, opts()),
    list: () => listGroups(opts()),
  };
}

// Re-register with the leader (join is idempotent) and return the fresh member list.
// No key is needed once registered: the leader verifies our bearer token.
export async function refreshGroupMembers(name, { leaderUrl, memberName, url, token, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${leaderUrl}/v1/groups/join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ name, memberName, url, token }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`group sync failed (HTTP ${res.status}): ${text}`);
    }
    const data = await res.json();
    return data.members || {};
  } finally {
    clearTimeout(timer);
  }
}

// Merge a member map into the local peer list, replacing the previous snapshot
// of this group and skipping ourselves. Used by both leaders (local groups) and
// members (leader-pulled members).
export function syncPeersFromMembers({ peers, members, myUrl, group, skipIds = [] }) {
  const self = normalizePeerUrl(myUrl);
  const skip = new Set(skipIds);
  const removed = peers.removeByGroup(group);
  let added = 0;
  for (const [id, m] of Object.entries(members || {})) {
    if (skip.has(id)) continue;
    const url = normalizePeerUrl(m?.url);
    if (!url || url === self) continue;
    if (peers.add({ name: id, url, token: m?.token || "", group })) added++;
  }
  return { removed, added, total: Object.keys(members || {}).length };
}

// ---- join-failure bans (per source IP) ----

export function createBansService({ file, now = () => Date.now(), windowMs = DEFAULT_BAN_WINDOW_MS, threshold = DEFAULT_BAN_THRESHOLD } = {}) {
  let bans = loadBans(file ? { file } : {});

  function prune() {
    let changed = false;
    for (const [ip, b] of Object.entries(bans)) {
      if (b.bannedAt !== undefined && now() - b.bannedAt >= windowMs) {
        delete bans[ip];
        changed = true;
      }
    }
    if (changed) saveBans(bans, file ? { file } : {});
  }

  function isBanned(ip) {
    if (!ip) return false;
    prune();
    const b = bans[ip];
    if (b?.bannedAt === undefined) return false;
    return { bannedAt: b.bannedAt, until: b.bannedAt + windowMs };
  }

  function recordFailure(ip) {
    if (!ip) return null;
    prune();
    const b = (bans[ip] = bans[ip] || { fails: 0 });
    b.fails = (b.fails || 0) + 1;
    if (b.fails >= threshold) {
      b.bannedAt = now();
      b.fails = 0;
    }
    saveBans(bans, file ? { file } : {});
    return b.bannedAt !== undefined ? b : null;
  }

  function clear(ip) {
    if (ip) {
      delete bans[ip];
    } else {
      bans = {};
    }
    saveBans(bans, file ? { file } : {});
  }

  function list() {
    prune();
    return { ...bans };
  }

  return { isBanned, recordFailure, clear, list, windowMs, threshold };
}
