import { createRelayPipeline } from "./relay-pipeline.js";
import { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS } from "../stream.js";
import { buildFallbackInfo } from "../fallback.js";
import { getViaRoute } from "../../bench/via-routes.js";
import { loadProviderKeys } from "../../state.js";
import { SHARE_KEYS_HEADER } from "../../providers/share-keys.js";
import { errMsg } from "../helpers.js";
import { compatFetch } from "../../compat.js";

function shortLabel(p) {
  const raw = String(p?.name || p?.id || p?.url || "").trim();
  if (!raw) return "";
  if (raw.includes("://")) {
    try { const u = new URL(raw); return `${u.hostname}${u.port ? `:${u.port}` : ""}`; } catch { return raw.slice(-16); }
  }
  return raw;
}

export async function handleViaRoute({
  model,
  body,
  peers,
  handlerCtx,
  evt,
  logCall,
  logError,
  mark,
  perf0,
  stages,
  startedAt,
  plugins,
  res,
  requested,
  useAuto,
  lockModel,
  auto,
}) {
  const route = getViaRoute(model);
  if (!route || !route.best || route.best === "direct" || !String(route.best).startsWith("via:")) return { handled: false };
  const peerLabel = String(route.best).slice(4).trim();
  if (!peerLabel) return { handled: false };
  // 找到对应该 label 的 peer（仅走 best 单路径，不并发）
  const ordered = (() => { try { return peers.ordered(); } catch { return []; } })();
  const byErr = (() => { try { return peers.orderedByLastError(); } catch { return []; } })();
  const all = [...ordered, ...byErr];
  const uniq = [];
  const seen = new Set();
  for (const p of all) { const k = p.url; if (!seen.has(k)) { seen.add(k); uniq.push(p); } }
  let peer = uniq.find((p) => shortLabel(p) === peerLabel || String(p.url || "").includes(peerLabel) || String(p.id || "") === peerLabel || String(p.name || "") === peerLabel);
  if (!peer) {
    try {
      const { loadPeers } = await import("../../state.js");
      const disk = loadPeers() || [];
      peer = disk.find((p) => shortLabel(p) === peerLabel || String(p.url || "").includes(peerLabel));
    } catch {}
  }
  if (!peer) {
    evt("via-route-miss", { reqId: handlerCtx.reqId, model, peerLabel, reason: "peer not found" });
    return { handled: false };
  }
  evt("via-route-hit", { reqId: handlerCtx.reqId, model, peer: peer.url, peerLabel, routeBest: route.best, at: route.at });
  // 单路径转发，不并发：直接打 best peer
  const hops = handlerCtx.hops || 0;
  const providerId = String(model).split("/")[0] || "";
  let shareHeader = null;
  try {
    const keys = loadProviderKeys(providerId) || [];
    if (keys.length) shareHeader = `${providerId}=${keys.join(",")}`;
  } catch {}
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("via-route timeout 30000ms")), 30000);
  let upRes;
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer.token || ""}`,
      "x-mslxdff-hops": String(hops + 1),
      "x-mslxdff-model-lock": model,
      "Accept": "text/event-stream",
    };
    if (shareHeader) headers[SHARE_KEYS_HEADER] = shareHeader;
    // workbuddyUid 透传
    if (handlerCtx.workbuddyUid) headers["x-mslxdff-workbuddy-uid"] = handlerCtx.workbuddyUid;
    evt("via-route-request", { reqId: handlerCtx.reqId, peer: peer.url, model, hops: hops + 1, hasShare: Boolean(shareHeader) });
    upRes = await compatFetch(`${String(peer.url).replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = errMsg(e);
    evt("via-route-error", { reqId: handlerCtx.reqId, peer: peer.url, model, error: msg });
    try { await peers.recordError(peer.url); } catch {}
    try { await peers.recordResult(peer.url, { ok: false }); } catch {}
    return { handled: false, lastErr: { model, status: 502, message: msg } };
  }
  clearTimeout(timer);
  const failed = upRes instanceof Error || upRes.status >= 400;
  if (failed) {
    const status = upRes instanceof Error ? 502 : upRes.status;
    let bodyText = "";
    try { bodyText = await upRes.clone().text(); } catch {}
    const msg = bodyText.slice(0, 300) || errMsg(upRes) || `peer ${status}`;
    evt("via-route-peer-error", { reqId: handlerCtx.reqId, peer: peer.url, model, status, message: msg.slice(0, 200) });
    try { await peers.recordError(peer.url); } catch {}
    try { await peers.recordResult(peer.url, { ok: false }); } catch {}
    // 502/429 等可 fallback 到 direct
    return { handled: false, lastErr: { model, upstream: upRes, status, message: msg } };
  }
  // 成功：记录并走 pipeline 中继（复用 peer 的 streaming 逻辑）
  try { await peers.recordResult(peer.url, { ok: true, latencyMs: 0, model }); } catch {}
  evt("via-route-win", { reqId: handlerCtx.reqId, peer: peer.url, model });
  const pipeline = createRelayPipeline({
    relay,
    buildFallbackInfo,
    auto,
    plugins,
    evt,
    mark,
    logCall,
    logError: logError || (() => {}),
    constants: { STREAM_TIMEOUT_MS, SLOW_TOTAL_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS },
    startedAt,
    stages,
  });
  await pipeline.execute({
    res,
    upRes,
    body,
    requested: requested ?? model,
    actual: model,
    lastErr: null,
    via: "peer",
    lockModel: lockModel || model,
    useAuto: Boolean(useAuto),
    handlerCtx: { ...handlerCtx, model },
    mark,
    perf0,
    stages,
    startedAt,
  });
  return { handled: true };
}
