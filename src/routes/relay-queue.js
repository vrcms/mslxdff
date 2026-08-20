import { loadGroupsJoined } from "../state.js";

const relayPending = new Map();
const relayPendingByReqId = new Map();

export function enqueueRelay({ group, target, reqId, body, hops }) {
  const key = `${group}::${target}`;
  const list = relayPending.get(key) || [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = list.findIndex((e) => e.reqId === reqId);
      if (idx >= 0) list.splice(idx, 1);
      relayPendingByReqId.delete(reqId);
      reject(new Error("relay timeout"));
    }, 30_000);
    timer.unref?.();
    const entry = { reqId, body, hops, resolve, reject, timer };
    list.push(entry);
    relayPending.set(key, list);
    relayPendingByReqId.set(reqId, entry);
  });
}

export function dequeueRelayForPoll({ group, target, limit = 10 }) {
  const key = `${group}::${target}`;
  const list = relayPending.get(key) || [];
  const batch = list.splice(0, limit);
  if (list.length) relayPending.set(key, list);
  else relayPending.delete(key);
  return batch.map((e) => ({ reqId: e.reqId, body: e.body, hops: e.hops }));
}

export function resolveRelay(reqId, result) {
  const entry = relayPendingByReqId.get(reqId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  relayPendingByReqId.delete(reqId);
  entry.resolve(result);
  return true;
}

export function getRelayPending() { return relayPending; }
export function getRelayPendingByReqId() { return relayPendingByReqId; }

export async function tryBroadbandRelay({ groups, token: myToken, model, body, hops, bus, logs, reqId, evt, res, mark, perf0, stages }) {
  try {
    const joined = loadGroupsJoined();
    const broadbandGroups = joined.filter((g) => g.kind === "broadband" || g.myUrl?.startsWith("relay://"));
    const allCandidates = [];
    if (groups) {
      const localGroups = groups.list();
      for (const [gName, g] of Object.entries(localGroups)) {
        for (const [id, m] of Object.entries(g.members || {})) {
          if (id === "leader") continue;
          const isBb = m?.kind === "broadband" || String(m?.url || "").startsWith("relay://");
          if (!isBb) continue;
          const staleMs = Number(process.env.MSLXDFF_BROADBAND_STALE_MS) > 0 ? Number(process.env.MSLXDFF_BROADBAND_STALE_MS) : 90_000;
          if (typeof m.lastSeen === "number" && Date.now() - m.lastSeen > staleMs) continue;
          allCandidates.push({ group: gName, target: m.url, member: m, via: "local-leader", leaderUrl: null });
        }
      }
    }
    for (const g of joined) {
      if (!g.leaderUrl) continue;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(`${g.leaderUrl}/v1/groups/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${myToken}` },
          body: JSON.stringify({ name: g.name, memberName: g.memberName, url: g.myUrl, token: myToken }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!r.ok) continue;
        const data = await r.json().catch(() => ({}));
        const members = data.members || {};
        for (const [id, m] of Object.entries(members)) {
          if (id === "leader") continue;
          const isBb = m?.kind === "broadband" || String(m?.url || "").startsWith("relay://");
          if (!isBb) continue;
          if (m.url === g.myUrl) continue;
          const staleMs = Number(process.env.MSLXDFF_BROADBAND_STALE_MS) > 0 ? Number(process.env.MSLXDFF_BROADBAND_STALE_MS) : 90_000;
          if (typeof m.lastSeen === "number" && Date.now() - m.lastSeen > staleMs) continue;
          allCandidates.push({ group: g.name, target: m.url, member: m, via: "via-leader", leaderUrl: g.leaderUrl });
        }
      } catch {}
    }
    if (!allCandidates.length) return null;
    for (const cand of allCandidates) {
      try {
        evt?.("relay-try", { reqId, model, via: cand.via, target: cand.target, group: cand.group });
        if (!cand.leaderUrl) {
          const fwdBody = { model, ...body, model };
          const reqIdLocal = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const promise = enqueueRelay({ group: cand.group, target: cand.target, reqId: reqIdLocal, body: fwdBody, hops });
          const result = await promise;
          if (result && result.status) {
            return { via: "broadband-local", result, target: cand.target, group: cand.group };
          }
        } else {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 35_000);
          const r = await fetch(`${cand.leaderUrl}/v1/groups/relay/forward`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${myToken}`, "x-mslxdff-hops": String(hops + 1) },
            body: JSON.stringify({ group: cand.group, target: cand.target, body: { ...body, model }, hops: hops + 1, reqId }),
            signal: ctrl.signal,
          });
          clearTimeout(t);
          if (!r.ok) {
            const txt = await r.text().catch(() => "");
            evt?.("relay-fail", { reqId, model, via: cand.via, target: cand.target, status: r.status, message: txt.slice(0, 200) });
            continue;
          }
          return { via: "broadband-via-leader", result: r, target: cand.target, group: cand.group };
        }
      } catch (err) {
        evt?.("relay-fail", { reqId, model, via: cand.via, target: cand.target, message: String(err?.message || err).slice(0, 200) });
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}
