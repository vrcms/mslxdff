import { viaProbe } from "./via-probe.js";

export async function resolveIncludeOpencode({ includeOpencode, isTTY, confirmFn, log = () => {} } = {}) {
  if (!includeOpencode) return false;
  if (!isTTY) {
    try { log("via 已跳过 opencode（非 TTY，省额度；需对比请在 TTY 加 --include-opencode 并确认）"); } catch {}
    return false;
  }
  if (typeof confirmFn === "function") {
    try {
      const ok = await confirmFn();
      // confirmFn returns true for y, false otherwise
      if (ok) return true;
      try { log("已回落：via 跳过 opencode"); } catch {}
      return false;
    } catch { return false; }
  }
  return false;
}

export async function getOnlinePeers({ loadGroupsJoined, loadPeers, probeHealth } = {}) {
  let candidates = [];
  if (typeof loadPeers === "function") {
    try { candidates = loadPeers() || []; } catch { candidates = []; }
  } else {
    try {
      const m = await import("../state.js");
      if (m.loadPeers) candidates = m.loadPeers() || [];
    } catch {}
  }
  // also consider groupsJoined for validation - if no groups joined, via is meaningless, but we still allow static peers?
  // For bench-via, if no groupsJoined at all, treat as no via capability -> return [] without probing?
  // However static peers may exist without group; we probe them anyway.
  // To satisfy "empty group -> skip probing" test, check loadGroupsJoined.
  let joined = [];
  if (typeof loadGroupsJoined === "function") {
    try { joined = loadGroupsJoined() || []; } catch { joined = []; }
  } else {
    try {
      const m = await import("../state.js");
      if (m.loadGroupsJoined) joined = m.loadGroupsJoined() || [];
    } catch {}
  }
  if (!joined.length) return [];
  if (!candidates.length) return [];

  // If probeHealth not provided, try import
  let probe = probeHealth;
  if (!probe) {
    try {
      const m = await import("../cli/group-helpers.js");
      probe = m.probeHealth;
    } catch { return candidates; }
  }
  if (!candidates.length) return [];
  const online = [];
  for (const p of candidates) {
    try {
      const r = await probe(p);
      if (r && r.rank === 0 && !r.fail && !r.stale) online.push(p);
    } catch {}
  }
  return online;
}

export async function orchestrateVia({
  models = [],
  peers = [],
  directRunner = null,
  viaProbeFn = viaProbe,
  includeOpencode = false,
  token,
  timeoutMs = 30000,
  clock = Date.now,
} = {}) {
  const filtered = includeOpencode ? models : models.filter((m) => {
    const s = typeof m === "string" ? m : (m.id || m.model || m.provider || "");
    const first = String(s).split("/")[0].toLowerCase();
    const prov = String(m?.provider || m?.providerId || first).toLowerCase();
    return prov !== "opencode" && first !== "opencode";
  });
  // normalize model entries
  const normModels = filtered.map((m) => {
    if (typeof m === "string") return { provider: m.split("/")[0], model: m, id: m };
    const id = m.id || m.model || "";
    const provider = m.provider || m.providerId || (id.includes("/") ? id.split("/")[0] : "");
    return { provider, model: id, id };
  });
  const results = [];
  for (const entry of normModels) {
    const provider = entry.provider;
    const model = entry.model;
    // direct
    let direct = null;
    if (directRunner) {
      try { direct = await directRunner({ provider, model, timeoutMs, clock }); } catch (e) { direct = { ok: false, label: "网络错误", error: String(e), ttfbMs: null, totalMs: 0 }; }
    } else {
      direct = { ok: false, label: "未配置 directRunner", error: "missing directRunner", ttfbMs: null, totalMs: 0 };
    }
    const via = {};
    for (const peer of peers) {
      const raw = String(peer.name || peer.id || peer.url || "peer");
      let peerId = raw;
      // 组员 name 可能存为完整 url（如 http://172.93...），统一短化为 host:port，防止 report 端 peerIds 与 via keys 不一致导致表格空白
      if (raw.includes("://")) {
        try { const u = new URL(raw); const host = u.hostname; const port = u.port ? `:${u.port}` : ""; if (host) peerId = `${host}${port}`; else peerId = raw.slice(-16); } catch { peerId = raw.slice(-16); }
      }
      const peerToken = peer.token || token || "";
      try {
        const r = await viaProbeFn({ peerUrl: peer.url, token: peerToken, providerId: provider, model, prompt: "hi", maxTokens: 5, timeoutMs, clock });
        via[peerId] = r;
      } catch (e) {
        via[peerId] = { ok: false, label: "网络错误", error: String(e?.message || e), ttfbMs: null, totalMs: 0 };
      }
    }
    // best
    let best = "direct";
    let bestTtfb = direct?.ok ? (direct.ttfbMs ?? direct.totalMs) : Infinity;
    let deltaMs = null;
    for (const [pid, rv] of Object.entries(via)) {
      if (!rv.ok) continue;
      const t = rv.ttfbMs ?? rv.totalMs;
      if (t < bestTtfb) { bestTtfb = t; best = `via:${pid}`; }
    }
    if (best.startsWith("via:")) {
      const d = direct?.ttfbMs ?? direct?.totalMs ?? 0;
      deltaMs = bestTtfb - d;
    }
    results.push({ provider, model, direct, via, best, deltaMs, opencodeSkipped: !includeOpencode });
  }
  return results;
}
