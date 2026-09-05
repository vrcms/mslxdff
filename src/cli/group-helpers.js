import { loadToken, loadGroupsJoined, saveGroupsJoined } from "../state.js";
import { refreshGroupMembers, syncPeersFromMembers } from "../groups.js";
import { errMsg } from "./util.js";
import { compatFetch, timeoutSignal } from "../compat.js";

const HEALTH_TIMEOUT_MS = 4000;

export function groupIs(action, argv) {
  const idx = argv.indexOf("-group");
  if (idx < 0) return null;
  return argv[idx + 1] === action ? argv[idx + 2] : null;
}

export function markJoined(entry) {
  const { name } = entry;
  if (!entry.kind) entry.kind = "static";
  const list = loadGroupsJoined().filter((g) => g.name !== name);
  saveGroupsJoined([...list, entry]);
}

export async function probeHealth({ id, url, kind, lastSeen, publicIp } = {}) {
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
    const res = await compatFetch(`${base}/health`, { signal: timeoutSignal(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return { id, url: base, fail: `HTTP ${res.status}`, rank: 2 };
    return { id, url: base, ms: Date.now() - startedAt, rank: 0 };
  } catch (err) {
    return { id, url: base, fail: errMsg(err), rank: 2 };
  }
}

export async function syncAllJoinedGroups({ peers, groups }) {
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
