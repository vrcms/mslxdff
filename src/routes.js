import { timingSafeEqual, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { injectReasoningContent, normalizeModel } from "./reasoning.js";
import { isAutoModel } from "./auto.js";
import { DEFAULT_MAX_HOPS } from "./peers.js";
import { loadGroupsJoined } from "./state.js";

export const errMsg = (err) => String(err?.message || err);

// In-memory relay queues for broadband members (polling-based, no WS dependency)
// pendingByTarget: Map<`${group}::${targetUrl}`, Array<{reqId, body, hops, resolve, reject, timer}>>
const relayPending = new Map();
const relayPendingByReqId = new Map();

function enqueueRelay({ group, target, reqId, body, hops }) {
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

function dequeueRelayForPoll({ group, target, limit = 10 }) {
  const key = `${group}::${target}`;
  const list = relayPending.get(key) || [];
  const batch = list.splice(0, limit);
  for (const e of batch) {
    // keep timer, but remove from pending list; result will resolve via relayResult
    // we keep entry in relayPendingByReqId until result arrives
  }
  if (list.length) relayPending.set(key, list);
  else relayPending.delete(key);
  return batch.map((e) => ({ reqId: e.reqId, body: e.body, hops: e.hops }));
}

function resolveRelay(reqId, result) {
  const entry = relayPendingByReqId.get(reqId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  relayPendingByReqId.delete(reqId);
  entry.resolve(result);
  return true;
}

async function tryBroadbandRelay({ groups, token: myToken, model, body, hops, bus, logs, reqId, evt, res, mark, perf0, stages }) {
  try {
    const joined = loadGroupsJoined();
    const broadbandGroups = joined.filter((g) => g.kind === "broadband" || g.myUrl?.startsWith("relay://"));
    // Also consider leader-owned broadband members directly
    const allCandidates = [];
    // 1) If this node is leader, check its own groups for broadband members
    if (groups) {
      const localGroups = groups.list();
      for (const [gName, g] of Object.entries(localGroups)) {
        for (const [id, m] of Object.entries(g.members || {})) {
          if (id === "leader") continue;
          const isBb = m?.kind === "broadband" || String(m?.url || "").startsWith("relay://");
          if (!isBb) continue;
          const staleMs = Number(process.env.MSLXDFF_BROADBAND_STALE_MS) > 0 ? Number(process.env.MSLXDFF_BROADBAND_STALE_MS) : 90_000;
          if (typeof m.lastSeen === "number" && Date.now() - m.lastSeen > staleMs) continue;
          // local leader: enqueue directly
          allCandidates.push({ group: gName, target: m.url, member: m, via: "local-leader", leaderUrl: null });
        }
      }
    }
    // 2) For member nodes, check leader's broadband members (need leaderUrl)
    for (const g of joined) {
      if (!g.leaderUrl) continue; // already handled as leader
      try {
        // fetch fresh members from leader (re-use refreshGroupMembers logic but direct fetch)
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
          if (m.url === g.myUrl) continue; // skip self
          const staleMs = Number(process.env.MSLXDFF_BROADBAND_STALE_MS) > 0 ? Number(process.env.MSLXDFF_BROADBAND_STALE_MS) : 90_000;
          if (typeof m.lastSeen === "number" && Date.now() - m.lastSeen > staleMs) continue;
          allCandidates.push({ group: g.name, target: m.url, member: m, via: "via-leader", leaderUrl: g.leaderUrl });
        }
      } catch {}
    }
    if (!allCandidates.length) return null;
    // Try each candidate via relay forward (sequential, first success wins)
    for (const cand of allCandidates) {
      try {
        evt?.("relay-try", { reqId, model, via: cand.via, target: cand.target, group: cand.group });
        if (!cand.leaderUrl) {
          // local leader: enqueue and wait for broadband poll (same as forward handler's local path)
          const fwdBody = { model, ...body, model };
          const reqIdLocal = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const promise = enqueueRelay({ group: cand.group, target: cand.target, reqId: reqIdLocal, body: fwdBody, hops });
          // also trigger a dummy poll wait: we can't directly wait for poll without D, so timeout quickly
          // For local leader, the D will poll; we wait for result with timeout 30s
          const result = await promise;
          if (result && result.status) {
            return { via: "broadband-local", result, target: cand.target, group: cand.group };
          }
        } else {
          // forward via leader's relay/forward endpoint
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
            evt?.("relay-fail", { reqId, model, via: cand.via, target: cand.target, status: r.status, message: txt.slice(0,200) });
            continue;
          }
          // leader's forward returns the upstream response (maybe SSE)
          // For simplicity, we treat it as direct response to relay back to client
          // We can stream it back: but for now, we just return the Response
          return { via: "broadband-via-leader", result: r, target: cand.target, group: cand.group };
        }
      } catch (err) {
        evt?.("relay-fail", { reqId, model, via: cand.via, target: cand.target, message: String(err?.message || err).slice(0,200) });
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function createRouter({ token, upstream, models, auto, logs, peers, maxHops = DEFAULT_MAX_HOPS, groups, bans, bus }) {
  return async function router(req, res) {
    const method = req.method || "GET";
    const path = (req.url || "").split("?")[0];

    const route = ROUTES.find((r) => r.method === method && r.path === path);

    if (!route) return notFound(res);

    if (route.requiresAuth && !authorized(req, token)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      return json(res, 401, { error: "Unauthorized" });
    }

    await route.handler({ req, res, upstream, models, auto, logs, peers, maxHops, groups, bans, token, bus });
  };
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  const head = typeof fwd === "string" ? fwd.split(",")[0].trim() : "";
  const raw = String(head || req.socket.remoteAddress || "");
  return raw.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1") || null;
}

function authorized(req, token) {
  const header = req.headers["authorization"] || "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const digests = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digests(match[1]), digests(token));
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function notFound(res) {
  return json(res, 404, { error: "Not Found" });
}

// --- fallback 显式提示（巧妙不破兼容）---
// 机器可读：x-mslxdff-* headers；人类可读：mslxdff 字段 + SSE comment
function fallbackReason(lastErr) {
  if (!lastErr) return "cooldown";
  const s = Number(lastErr.status);
  if (s === 429) return "rate_limited";
  if (lastErr.message && /timeout/i.test(String(lastErr.message))) return "timeout";
  if (s === 502 || s === 503 || s === 504) return "upstream_error";
  if (s >= 400) return "upstream_error";
  return "fallback";
}

function buildFallbackInfo({ requested, actual, lastErr, via, useAuto, lockModel }) {
  if (!requested || !actual) return null;
  const alwaysHeaders = {
    requested_model: requested,
    actual_model: actual,
    via: via || "local",
  };
  // auto / lock 仍告知 actual，但不算 fallback
  if (useAuto || lockModel) {
    return { ...alwaysHeaders, fallback: false, reason: null, notice: null };
  }
  const isFallback = requested !== actual;
  if (!isFallback) {
    return { ...alwaysHeaders, fallback: false, reason: null, notice: null };
  }
  const reason = fallbackReason(lastErr);
  const reasonZh = reason === "rate_limited" ? "限流" : reason === "timeout" ? "超时" : reason === "cooldown" ? "冷却中" : "不可用";
  const notice = `${requested} ${reasonZh}，已由 ${actual} 代答`;
  return { ...alwaysHeaders, fallback: true, reason, notice };
}

function applyFallbackHeaders(res, info) {
  if (!info) return;
  // 始终告知实际与请求，客户端对比即知
  if (info.requested_model) res.setHeader("x-mslxdff-requested-model", info.requested_model);
  if (info.actual_model) res.setHeader("x-mslxdff-actual-model", info.actual_model);
  if (info.via) res.setHeader("x-mslxdff-via", info.via);
  if (info.fallback) {
    res.setHeader("x-mslxdff-fallback", "1");
    if (info.reason) res.setHeader("x-mslxdff-fallback-reason", info.reason);
    // 人类 curl 可见
    if (info.notice) res.setHeader("x-mslxdff-notice", encodeURIComponent(info.notice));
  }
}

function enrichNonStreamJson(obj, info) {
  if (!info || typeof obj !== "object" || obj === null) return obj;
  // 仅当 fallback 时才注入顶层 mslxdff，避免噪音；但始终可通过 header 拿到 actual
  if (!info.fallback) return obj;
  if (obj.mslxdff) return obj;
  return {
    ...obj,
    mslxdff: {
      fallback: true,
      requested_model: info.requested_model,
      actual_model: info.actual_model,
      reason: info.reason,
      via: info.via,
      notice: info.notice,
    },
  };
}

function enrichSseChunkText(text, info) {
  if (!info?.fallback) return text;
  // 行级注入：对每行 data: {json} 尝试注入 mslxdff
  const lines = text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^data:\s*(\{.*\})\s*$/.exec(line);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj === "object" && !obj.mslxdff) {
        obj.mslxdff = {
          fallback: true,
          requested_model: info.requested_model,
          actual_model: info.actual_model,
          reason: info.reason,
          via: info.via,
          notice: info.notice,
        };
        lines[i] = `data: ${JSON.stringify(obj)}`;
        changed = true;
        break; // 仅注入首个 JSON 行
      }
    } catch {
      continue;
    }
  }
  return changed ? lines.join("\n") : text;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// Relay an upstream response to the client. Returns { status, ttfMs, aborted, interrupted, detail }
// detail carries byte/chunk/sawDone diagnostics so a truncated deep-think
// stream can be told apart from a clean EOF vs our stall/max vs client abort.
async function relay(res, upRes, body, { onFirstChunk, onDownstreamAbort, streamTimeoutMs = STREAM_TIMEOUT_MS, fallback } = {}) {
  const t0 = performance.now();
  const contentType = upRes.headers.get("content-type") || "";
  const isStream = Boolean(body?.stream) || contentType.includes("text/event-stream");
  res.statusCode = upRes.status;
  if (fallback) applyFallbackHeaders(res, fallback);

  let ttf = null;
  let interrupted = false;
  let finishedNormally = false;
  const detail = {
    receivedChunks: 0,
    receivedBytes: 0,
    wroteChunks: 0,
    wroteBytes: 0,
    sawDone: false,
    sawFinishReason: null,
    lastChunkAtMs: null,
    lastChunkGapMs: null,
    maxGapMs: 0,
    stallHits: 0, // chunks where gap > SCORE_STALL_MS (quality signal, never cuts)
    exitReason: null, // normal | first-timeout | stall | max | upstream-error | downstream-close | empty-body
    upstreamError: null,
    downstreamClosed: false,
  };
  let prevChunkAt = t0;
  const onClose = () => {
    detail.downstreamClosed = true;
    if (!finishedNormally && onDownstreamAbort) onDownstreamAbort();
  };
  res.on("close", onClose);

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // SSE 注释：curl -N 可见，EventSource/SDK 自动忽略，不污染 content
    if (fallback?.fallback) {
      try {
        res.write(`: mslxdff fallback ${fallback.requested_model} -> ${fallback.actual_model} (${fallback.reason})\n`);
        res.write(`: notice ${fallback.notice}\n\n`);
      } catch {}
    }
    if (upRes.body) {
      let first = true;
      let wroteAny = false;
      let timedOut = false;
      let stalled = false;
      let tooLong = false;
      let stallTimer = null;
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = STALL_TIMEOUT_MS
          ? setTimeout(() => {
              stalled = true;
              detail.exitReason = "stall";
              if (typeof upRes.body.cancel === "function") upRes.body.cancel().catch(() => {});
            }, STALL_TIMEOUT_MS)
          : null;
      };
      let firstTimer = setTimeout(() => {
        timedOut = true;
        detail.exitReason = "first-timeout";
        if (typeof upRes.body.cancel === "function") upRes.body.cancel().catch(() => {});
      }, streamTimeoutMs);
      const maxTimer = MAX_STREAM_MS
        ? setTimeout(() => {
            tooLong = true;
            detail.exitReason = "max";
            if (typeof upRes.body.cancel === "function") upRes.body.cancel().catch(() => {});
          }, MAX_STREAM_MS)
        : null;
      try {
        for await (const chunk of upRes.body) {
          const now = performance.now();
          detail.receivedChunks += 1;
          const len = chunk?.length ?? chunk?.byteLength ?? 0;
          detail.receivedBytes += len;
          const gap = Math.round(now - prevChunkAt);
          detail.lastChunkAtMs = Math.round(now - t0);
          detail.lastChunkGapMs = gap;
          if (gap > detail.maxGapMs) detail.maxGapMs = gap;
          if (gap > SCORE_STALL_MS) detail.stallHits += 1;
          prevChunkAt = now;
          // cheap inspection for diagnostics (no full parse)
          try {
            const txt = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : typeof chunk === "string" ? chunk : "";
            if (txt.includes("[DONE]")) detail.sawDone = true;
            const m = txt.match(/"finish_reason"\s*:\s*"([^"]+)"/);
            if (m) detail.sawFinishReason = m[1];
          } catch { /* ignore */ }
          if (timedOut || stalled || tooLong) break;
          if (first) {
            first = false;
            ttf = Math.round(now - t0);
            onFirstChunk?.(ttf);
            if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
          }
          // 首块注入 mslxdff 字段（仅 fallback 时），SDK 解析 JSON 可直接发现
          let outChunk = chunk;
          if (first === false && fallback?.fallback && wroteAny === false) {
            try {
              let txt = "";
              if (Buffer.isBuffer(chunk)) txt = chunk.toString("utf8");
              else if (chunk instanceof Uint8Array) txt = Buffer.from(chunk).toString("utf8");
              else if (typeof chunk === "string") txt = chunk;
              if (txt.includes("data:")) {
                const enriched = enrichSseChunkText(txt, fallback);
                if (enriched !== txt) outChunk = Buffer.from(enriched, "utf8");
              }
            } catch {}
          }
          wroteAny = true;
          detail.wroteChunks += 1;
          detail.wroteBytes += Buffer.isBuffer(outChunk) ? outChunk.length : (outChunk?.length ?? len);
          res.write(outChunk);
          armStall(); // no-op when STALL_TIMEOUT_MS=0; scoring uses SCORE_STALL_MS gap above
        }
        if (!detail.exitReason) detail.exitReason = "normal";
      } catch (err) {
        detail.upstreamError = String(err?.message || err).slice(0, 300);
        detail.exitReason = "upstream-error";
        if (!wroteAny) timedOut = true;
        else stalled = true;
      } finally {
        if (firstTimer) clearTimeout(firstTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (stallTimer) clearTimeout(stallTimer);
      }
      if (timedOut && !wroteAny) {
        res.removeListener("close", onClose);
        return { status: STREAM_TIMEOUT_MS, ttfMs: null, totalMs: Math.round(performance.now() - t0), aborted: true, interrupted: false, detail };
      }
      if ((stalled || tooLong) && wroteAny) {
        interrupted = true;
        detail.exitReason = detail.exitReason || (stalled ? "stall" : "max");
        res.removeListener("close", onClose);
        try { res.end(); } catch { /* ignore */ }
        return { status: 200, ttfMs: ttf, totalMs: Math.round(performance.now() - t0), aborted: false, interrupted, detail };
      }
    } else {
      detail.exitReason = "empty-body";
    }
    const totalMs = Math.round(performance.now() - t0);
    if (!detail.exitReason) detail.exitReason = "normal";
    finishedNormally = true;
    res.removeListener("close", onClose);
    try { res.end(); } catch { /* ignore */ }
    return { status: 200, ttfMs: ttf, totalMs, aborted: false, interrupted: false, detail };
  }

  finishedNormally = true;
  res.removeListener("close", onClose);
  const text = await upRes.text();
  detail.receivedBytes = Buffer.byteLength(text);
  detail.exitReason = "normal-non-stream";
  try {
    const parsed = JSON.parse(text);
    const enriched = enrichNonStreamJson(parsed, fallback);
    json(res, upRes.status, enriched);
  } catch {
    res.statusCode = upRes.status;
    res.setHeader("Content-Type", contentType || "text/plain");
    res.end(text);
  }
  return { status: upRes.status, ttfMs: null, totalMs: Math.round(performance.now() - t0), aborted: false, interrupted: false, detail };
}

const PEER_TIMEOUT_MS = 30_000;
const PEER_STATUS_TIMEOUT_MS = 2_000;

// Ask a peer which of its models are healthy (status normal or never
// failed). Returns model ids ordered as the peer listed them; empty when the
// peer is unreachable, unauthorized, or has no healthy model.
export async function peerHealthyModels(peer, { timeoutMs = PEER_STATUS_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${peer.url}/v1/models/status`, {
      headers: {
        "Authorization": `Bearer ${peer.token || ""}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    return (json.data || [])
      .filter((m) => m && typeof m.id === "string" && m.status === "normal")
      .map((m) => m.id);
  } catch {
    return [];
  }
}

export const PROMPT_MAX_LEN = 160;

// Human-debuggable summary of the request body: the last non-empty message
// text (multi-modal parts joined), whitespace-flattened and truncated.
export function summarizePrompt(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || !msgs.length) return "";
  const msg = msgs[msgs.length - 1];
  const c = msg?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c
      .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : ""))
      .join(" ");
  }
  text = String(text || "").replace(/\s+/g, " ").trim();
  return text.length > PROMPT_MAX_LEN ? text.slice(0, PROMPT_MAX_LEN) + "…" : text;
}

function parseHops(header) {
  const n = Number(header);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

async function forwardToPeer(peer, body, model, hops) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);
  try {
    return await fetch(`${peer.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${peer.token}`,
        "x-mslxdff-hops": String(hops + 1),
        "x-mslxdff-model-lock": model,
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal,
    });
  } catch (err) {
    return err;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the model a peer should serve for this request.
// 原设计严格语义：显式指定模型时，永远用该模型去试 peer，不因 peer 的本地 healthy 状态而偷换成 hy3。
// 只有 auto 模式才走 healthy 探测与择优。
// Returns { peer, target } or null when the peer is unusable.
async function resolvePeerTarget(ctx, peer) {
  const prevModel = ctx.peers.stat(peer.url)?.model;
  const hot = ctx.peers.isHot(peer.url) && prevModel === ctx.model;
  if (hot) return { peer, target: prevModel };
  // 显式模型：严格用请求模型，不做 healthy 偷换（B/D 必须以 deepseek 去试，失败才算该模型在该 peer 不可用）
  const isExplicit = !!ctx.model && !isAutoModel(ctx.model);
  if (isExplicit) {
    // 仅做可达性探测：轻量 ping /v1/models/status 判断 peer 是否活着，不因模型状态过滤
    const healthy = await peerHealthyModels(peer);
    if (!healthy.length) {
      // 无法探活也仍尝试：让 forward 去试，失败会由 race 逻辑记错；但为保持原有“全不健康则跳过”行为，仍标记
      // 这里改为：即使 healthy 为空，也返回 target=ctx.model，让上游去判 429，而不是直接丢弃 peer
      // 只有当 fetch 本身异常（healthy=[] 来自网络错）才视为 peer 不可用，需区分
      // peerHealthyModels 在网络错时返回 []，此时应视为 peer 不可用
      // 我们通过再次轻量探测区分：若 peer 完全不可达，healthy=[] 且 peer 曾无成功记录，则跳过
      // 简化：若 healthy 为空，直接尝试目标模型，失败再记错（更符合“严格”）
      ctx.evt("peer-health", { peer: peer.url, healthy: [], count: 0, strict: true });
      return { peer, target: ctx.model };
    }
    ctx.evt("peer-health", { peer: peer.url, healthy, count: healthy.length, strict: true });
    return { peer, target: ctx.model };
  }
  // auto 模式：走原有择优逻辑
  const healthy = await peerHealthyModels(peer);
  if (!healthy.length) {
    await ctx.peers.recordError(peer.url);
    ctx.logError(ctx.model, 0, `peer ${peer.url} has no healthy models`);
    ctx.evt("peer-health", { peer: peer.url, healthy: [], count: 0 });
    return null;
  }
  ctx.evt("peer-health", { peer: peer.url, healthy, count: healthy.length });
  return { peer, target: healthy.includes(ctx.model) ? ctx.model : healthy[0] };
}

// Race a batch of candidates: up to PEER_RACE_LIMIT at a time, first success
// wins. Uses ctx.model/body/hops/peers to resolve targets and forward. Retries
// remaining candidates in subsequent batches. Returns the winning
// { peer, target, res, latencyMs } or null when everyone failed.
export const PEER_RACE_LIMIT = Number(process.env.MSLXDFF_PEER_RACE_LIMIT) > 0
  ? Number(process.env.MSLXDFF_PEER_RACE_LIMIT)
  : 3;

// A model whose whole request takes longer than this wall-clock duration is
// remembered as slow and demoted, so a fast model is preferred next request.
// Set MSLXDFF_SLOW_TOTAL_MS=0 to disable.
export const SLOW_TOTAL_MS = (() => {
  const n = Number(process.env.MSLXDFF_SLOW_TOTAL_MS);
  return Number.isInteger(n) && n > 0 ? n : 20_000;
})();

// How long to wait for the first chunk of a streamed response before giving up
// on that model (nothing has been written yet, so we can fail over cleanly).
// Set MSLXDFF_STREAM_TIMEOUT_MS=0 to disable the circuit breaker.
export const STREAM_TIMEOUT_MS = (() => {
  const n = Number(process.env.MSLXDFF_STREAM_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 25_000;
})();

// Stall / max ceilings — disabled by default for relays (we never cut a
// stream that has already started; different models have different verbosity,
// that's normal). Stall is kept only as a *quality* signal for ranking.
// Set MSLXDFF_STALL_TIMEOUT_MS=15000 to re-enable cutting (not recommended),
// or tune MSLXDFF_SCORE_STALL_MS for scoring.
export const STALL_TIMEOUT_MS = (() => {
  const n = Number(process.env.MSLXDFF_STALL_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 0;
})();

export const SCORE_STALL_MS = (() => {
  const raw = process.env.MSLXDFF_SCORE_STALL_MS ?? process.env.MSLXDFF_STALL_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 15_000;
})();

export const MAX_STREAM_MS = (() => {
  const n = Number(process.env.MSLXDFF_MAX_STREAM_MS);
  return Number.isInteger(n) && n > 0 ? n : 0;
})();

async function racePeerCandidates(candidates, ctx) {
  for (let i = 0; i < candidates.length; i += PEER_RACE_LIMIT) {
    const batch = candidates.slice(i, i + PEER_RACE_LIMIT);
    // resolve targets for this batch first (may probe), then fire them together
    const prepared = (await Promise.all(batch.map((peer) => resolvePeerTarget(ctx, peer)))).filter(Boolean);
    if (!prepared.length) continue;
    // fire every peer in the batch concurrently and record completion order —
    // the first one to succeed wins the race
    const completed = await new Promise((resolve) => {
      const order = [];
      const total = prepared.length;
      for (const { peer, target } of prepared) {
        ctx.evt("peer-request", { peer: peer.url, model: target, hops: ctx.hops + 1 });
        const t0 = performance.now();
        forwardToPeer(peer, ctx.body, target, ctx.hops).then((res) => {
          const latencyMs = Math.round(performance.now() - t0);
          const failed = res instanceof Error || res.status >= 400;
          ctx.evt("peer-forward", { peer: peer.url, model: target, hops: ctx.hops + 1, latencyMs, ok: !failed });
          if (failed) {
            const status = res instanceof Error ? 502 : res.status;
            ctx.logError(ctx.model,
              status,
              res instanceof Error ? errMsg(res) : `peer ${status}`);
            ctx.evt("peer-error", {
              peer: peer.url,
              model: target,
              status,
              message: res instanceof Error ? errMsg(res) : null,
            });
            order.push({ ok: false, peer, target, res, status });
          } else {
            order.push({ ok: true, peer, target, res, latencyMs });
          }
          if (order.length === total) resolve(order);
        });
      }
    });
    const winner = completed.find((o) => o.ok);
    if (winner) {
      // every other responder also gets its memory cleared and its stats warmed
      // so it becomes a candidate next time too
      for (const o of completed) {
        if (o === winner) continue;
        if (!o.ok) {
          await ctx.peers.recordError(o.peer.url);
          await ctx.peers.recordResult(o.peer.url, { ok: false });
        } else {
          await ctx.peers.recordResult(o.peer.url, { ok: true, latencyMs: o.latencyMs, model: o.target });
        }
      }
      return { peer: winner.peer, target: winner.target, res: winner.res, latencyMs: winner.latencyMs };
    }
    for (const o of completed) {
      await ctx.peers.recordError(o.peer.url);
      await ctx.peers.recordResult(o.peer.url, { ok: false });
    }
  }
  return null;
}

const ROUTES = [
  {
    method: "GET",
    path: "/health",
    handler: ({ res }) => json(res, 200, { status: "ok" }),
  },
  {
    method: "POST",
    path: "/v1/chat/completions",
    requiresAuth: true,
    handler: async ({ req, res, upstream, auto, logs, peers, maxHops, groups, bus }) => {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "Invalid JSON body" });
      }

      const startedAt = Date.now();
      const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const perf0 = performance.now();
      const stages = [];
      const mark = (name) => stages.push([name, Math.round(performance.now() - perf0)]);
      const hops = parseHops(req.headers["x-mslxdff-hops"]);
      const lockModel = req.headers["x-mslxdff-model-lock"] || "";
      const rawModel = body.model || "";
      const requested = normalizeModel(lockModel || rawModel || "");
      const useAuto = isAutoModel(requested);
      mark("parsed");

      let order;
      if (lockModel) {
        order = [requested];
      } else if (useAuto) {
        order = auto ? await auto.candidates() : [""];
      } else {
        order = auto ? await auto.candidatesFor(requested) : [requested];
      }
      if (!order.length) order = [""];
      const canFallback = order.length > 1;
      const canForwardPeers = Boolean(peers) && hops < maxHops;
      mark("ordered");

      const logCall = (model, status) =>
        logs?.appendCall({ reqId, model, auto: useAuto, status, durationMs: Date.now() - startedAt, stream: Boolean(body.stream), stages });
      const logError = (model, status, message) =>
        logs?.appendError({ reqId, model, auto: useAuto, status, message, stages });
      const evt = (type, data) => {
        const entry = { ts: Date.now(), reqId, type, ...data, model: data.model ?? requested, auto: useAuto, durationMs: Date.now() - startedAt, stages: [...stages] };
        if (bus) bus.emit(entry);
        logs?.appendEvent?.(entry);
      };
      evt("request", { reqId, hops, ip: clientIp(req), stream: Boolean(body.stream), prompt: summarizePrompt(body), rawModel, requested, lockModel: lockModel || null });
      evt("ordered", { reqId, order, canFallback, canForwardPeers, useAuto, statuses: auto?.statuses?.() ?? null });

      // Shared context for the peer race helpers below (each model iteration
      // reuses it; `model` is bound per iteration call).
      const handlerCtx = {
        model: null,
        body,
        hops,
        peers,
        evt,
        logError,
        logCall,
      };

      let lastErr = null;
      for (let idx = 0; idx < order.length; idx++) {
        const model = order[idx];
        handlerCtx.model = model;
        evt("model-try", { reqId, model, idx, remaining: order.length - idx });
        let upRes = null;
        const forwarded = { ...injectReasoningContent(model, body), model };
        const tUp = performance.now();
        evt("upstream-try", { reqId, model, attempt: idx + 1 });
        try {
          upRes = await upstream.chat(forwarded);
          evt("upstream-done", { reqId, model, ok: !(upRes instanceof Error) && upRes.status < 400, status: upRes instanceof Error ? null : upRes.status, timing: upRes._t ?? null, error: null });
        } catch (err) {
          if (auto) await auto.recordError(model, { message: errMsg(err) });
          lastErr = { model, upstream: null, status: 502, message: errMsg(err) };
          logError(model, 502, errMsg(err));
          evt("upstream-error", { reqId, model, status: 502, message: errMsg(err), timing: err._t ?? { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - tUp) } });
        }
        mark(`up-${model}`);
        if (upRes && upRes.status >= 400) {
          if (auto) await auto.recordError(model, { status: upRes.status });
          lastErr = { model, upstream: upRes, status: upRes.status, message: null };
          logError(model, upRes.status, `upstream ${upRes.status}`);
          evt("upstream-error", { reqId, model, status: upRes.status, message: null, timing: upRes._t ?? null });
          upRes = null;
        }
        if (upRes) {
          logCall(model, upRes.status);
          const fallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "local", useAuto, lockModel });
          if (fallback?.fallback) evt("fallback-notice", { reqId, requested, actual: model, reason: fallback.reason, notice: fallback.notice, via: "local" });
          evt("relay-start", { reqId, model, via: "local", isStream: Boolean(body.stream), fallback });
          const out = await relay(res, upRes, body, {
            fallback,
            onFirstChunk: (delta) => {
              mark(`ttf-${model}`);
              evt("relay-first-chunk", { reqId, model, ttfMs: delta });
            },
            onDownstreamAbort: () => {
              evt("client-abort", { reqId, model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] });
            },
          });
          evt("relay-done", { reqId, model, via: "local", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
          if (out.status === STREAM_TIMEOUT_MS) {
            if (auto) await auto.recordError(model, { status: 502, slow: true, note: `stream timeout ${STREAM_TIMEOUT_MS}ms` });
            lastErr = { model, upstream: null, status: 502, message: `stream timed out after ${STREAM_TIMEOUT_MS}ms` };
            logError(model, 502, `stream timeout ${STREAM_TIMEOUT_MS}ms`);
            evt("upstream-error", { reqId, model, status: 502, message: "stream timeout", timing: null });
            evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: "stream timeout" });
            upRes = null;
            continue;
          }
          if (out.interrupted) {
            if (auto) {
              await auto.recordError(model, { status: 200, slow: true, note: `stall ${STALL_TIMEOUT_MS}ms` });
              await auto.recordLatency(model, out.totalMs ?? (Date.now() - startedAt));
            }
            evt("slow-model", { model, elapsedMs: out.totalMs ?? (Date.now() - startedAt), threshold: STALL_TIMEOUT_MS, interrupted: true, detail: out.detail ?? null });
            logCall(model, 200);
            evt("result", { model, status: out.status, via: "local", timing: upRes._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, interrupted: true, detail: out.detail ?? null, fallback, requested, actual: model });
            evt("client-response", { requested, actual: model, via: "local", fallback, status: out.status, interrupted: true, reqId });
            return;
          }
          const elapsed = Date.now() - startedAt;
          const latencyMs = out.totalMs ?? elapsed;
          let scoredSlow = false;
          if (SLOW_TOTAL_MS && auto && elapsed > SLOW_TOTAL_MS && out.status === 200) {
            void auto.recordError(model, { status: 200, slow: true, note: `slow ${elapsed}ms` });
            void auto.recordLatency(model, latencyMs);
            evt("slow-model", { model, elapsedMs: elapsed, threshold: SLOW_TOTAL_MS, reason: "total", detail: out.detail ?? null });
            scoredSlow = true;
          }
          if (out.detail?.stallHits > 0 && auto && out.status === 200) {
            void auto.recordError(model, { status: 200, slow: true, note: `stall ${out.detail.stallHits}x gap>${SCORE_STALL_MS}ms maxGap ${out.detail.maxGapMs}ms` });
            void auto.recordLatency(model, latencyMs);
            evt("slow-model", { model, elapsedMs: elapsed, threshold: SCORE_STALL_MS, reason: "stall", stallHits: out.detail.stallHits, maxGapMs: out.detail.maxGapMs, detail: out.detail ?? null });
            scoredSlow = true;
          }
          if (!scoredSlow && auto && out.status === 200) {
            await auto.recordOk(model, { latencyMs });
          } else if (!scoredSlow && auto) {
            // still update latency for non-200? keep for completeness
            await auto.recordLatency(model, latencyMs);
          } else if (scoredSlow && out.detail) {
            // already recorded slow+latency above, still ensure latency EMA is updated for slow case (done)
          }
          evt("result", { model, status: out.status, via: "local", timing: upRes._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback, requested, actual: model });
          evt("client-response", { requested, actual: model, via: "local", fallback, status: out.status, reqId });
          return;
        }

        // local failed for this model: race the peers — send the request to
        // up to N of them in parallel, first success wins (the winner's model
        // is remembered for the next call). If every candidate fails, retry
        // once ordered by recovery time (earliest failure first), which
        // favours the peer that has had the longest to come back.
        if (canForwardPeers) {
          evt("peer-race-start", { reqId, model, peers: peers.ordered().length });
          const win =
            (await racePeerCandidates(peers.ordered(), handlerCtx)) ||
            (await racePeerCandidates(peers.orderedByLastError(), handlerCtx));
          if (win) {
            evt("peer-race-win", { reqId, model, winPeer: win.peer.url, winTarget: win.target, latencyMs: win.latencyMs });
            await peers.recordResult(win.peer.url, { ok: true, latencyMs: win.latencyMs, model: win.target });
            logCall(win.target, win.res.status);
            const peerFallback = buildFallbackInfo({ requested, actual: win.target, lastErr, via: "peer", useAuto, lockModel });
            if (peerFallback?.fallback) evt("fallback-notice", { reqId, requested, actual: win.target, reason: peerFallback.reason, notice: peerFallback.notice, via: "peer" });
            evt("relay-start", { reqId, model: win.target, via: "peer", isStream: Boolean(body.stream), fallback: peerFallback });
            const out = await relay(res, win.res, body, {
              fallback: peerFallback,
              onFirstChunk: (d) => mark(`ttf-peer-${win.target}`),
              onDownstreamAbort: () => evt("client-abort", { reqId, model: win.target, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
            });
            evt("relay-done", { reqId, model: win.target, via: "peer", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
            if (auto && out.status === 200) {
              const latencyMs = out.totalMs ?? win.latencyMs;
              if (out.detail?.stallHits > 0 || (latencyMs && latencyMs > SLOW_TOTAL_MS)) {
                void auto.recordError(win.target, { status: 200, slow: true, note: `peer slow ${latencyMs}ms` });
                void auto.recordLatency(win.target, latencyMs);
              } else {
                await auto.recordOk(win.target, { latencyMs });
              }
            }
            evt("result", { model: win.target, status: out.status, via: "peer", timing: win.res._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: peerFallback, requested, actual: win.target });
            evt("client-response", { requested, actual: win.target, via: "peer", fallback: peerFallback, status: out.status, reqId });
            return;
          }
          evt("peer-race-lose", { reqId, model });
        }

        // Broadband relay: try to forward via leader to a broadband member's quota
        if (groups) {
          const bb = await tryBroadbandRelay({ groups, token, model, body, hops, bus, logs, reqId, evt, res, mark, perf0, stages });
          if (bb) {
            const isResponse = bb.result && typeof bb.result.status === "number" && typeof bb.result.headers?.get === "function";
            if (isResponse) {
              // streaming response from leader's forward (which waited for broadband)
              const bbFallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "broadband", useAuto, lockModel });
              if (bbFallback?.fallback) evt("fallback-notice", { reqId, requested, actual: model, reason: bbFallback.reason, notice: bbFallback.notice, via: "broadband" });
              evt("relay-start", { reqId, model, via: "broadband", target: bb.target, group: bb.group, fallback: bbFallback });
              const out = await relay(res, bb.result, body, {
                fallback: bbFallback,
                onFirstChunk: (d) => mark(`ttf-bb-${model}`),
                onDownstreamAbort: () => evt("client-abort", { reqId, model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
              });
              evt("relay-done", { reqId, model, via: "broadband", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
              if (auto && out.status === 200) {
                const latencyMs = out.totalMs ?? 0;
                if (out.detail?.stallHits > 0 || (latencyMs && latencyMs > SLOW_TOTAL_MS)) {
                  void auto.recordError(model, { status: 200, slow: true, note: `broadband slow ${latencyMs}ms` });
                  void auto.recordLatency(model, latencyMs);
                } else {
                  await auto.recordOk(model, { latencyMs });
                }
              }
              evt("result", { model, status: out.status, via: "broadband", timing: bb.result._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: bbFallback, requested, actual: model });
              evt("client-response", { requested, actual: model, via: "broadband", fallback: bbFallback, status: out.status, reqId });
              return;
            } else if (bb.result && typeof bb.result.status === "number") {
              // buffered result from local leader enqueue
              const fakeRes = {
                status: bb.result.status,
                headers: { get: (k) => bb.result.headers?.[k] || bb.result.headers?.[k.toLowerCase()] || null },
                text: async () => typeof bb.result.body === "string" ? bb.result.body : JSON.stringify(bb.result.body),
                body: (() => {
                  const b = bb.result.body || "";
                  const str = typeof b === "string" ? b : JSON.stringify(b);
                  const isSSE = bb.result.headers?.["Content-Type"]?.includes("text/event-stream");
                  if (isSSE) {
                    return (async function* () { yield Buffer.from(str); })();
                  }
                  return null;
                })(),
              };
              const bbLocalFallback = buildFallbackInfo({ requested, actual: model, lastErr, via: "broadband", useAuto, lockModel });
              if (bbLocalFallback?.fallback) evt("fallback-notice", { reqId, requested, actual: model, reason: bbLocalFallback.reason, notice: bbLocalFallback.notice, via: "broadband" });
              evt("relay-start", { reqId, model, via: "broadband-local", target: bb.target, group: bb.group, fallback: bbLocalFallback });
              const out = await relay(res, fakeRes, body, {
                fallback: bbLocalFallback,
                onFirstChunk: (d) => mark(`ttf-bb-${model}`),
                onDownstreamAbort: () => evt("client-abort", { reqId, model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
              });
              evt("relay-done", { reqId, model, via: "broadband-local", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
              evt("result", { model, status: out.status, via: "broadband", timing: null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null, fallback: bbLocalFallback, requested, actual: model });
              evt("client-response", { requested, actual: model, via: "broadband", fallback: bbLocalFallback, status: out.status, reqId });
              return;
            }
          }
          evt("relay-miss", { reqId, model });
        }

        if (canFallback) {
          evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: lastErr?.message || `upstream ${lastErr?.status ?? 502}` });
          continue;
        }
        evt("exhausted-local", { reqId, lastModel: lastErr?.model ?? model, lastStatus: lastErr?.status ?? 502, order });
        logCall(lastErr?.model ?? model, lastErr?.status ?? 502);
        if (lastErr?.upstream) {
          evt("relay-start", { reqId, model: lastErr.model, via: "local-exhausted", isStream: Boolean(body.stream) });
          const out = await relay(res, lastErr.upstream, body, {
            onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
            onDownstreamAbort: () => evt("client-abort", { reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
          });
          evt("relay-done", { reqId, model: lastErr.model, via: "local-exhausted", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
          evt("result", { reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
          return;
        }
        evt("result", { reqId, model, status: lastErr?.status ?? 502, via: "none", timing: null });
        return json(res, 502, { error: lastErr?.message || "all auto models failed" });
      }

      evt("exhausted-all", { reqId, lastModel: lastErr?.model ?? requested, lastStatus: lastErr?.status ?? 502, order });
      logCall(lastErr?.model ?? requested, lastErr?.status ?? 502);
      if (lastErr?.upstream) {
        evt("relay-start", { reqId, model: lastErr.model, via: "local-final", isStream: Boolean(body.stream) });
        const out = await relay(res, lastErr.upstream, body, {
          onFirstChunk: (d) => mark(`ttf-${lastErr.model}`),
          onDownstreamAbort: () => evt("client-abort", { reqId, model: lastErr.model, totalMs: Math.round(performance.now() - perf0), stages: [...stages] }),
        });
        evt("relay-done", { reqId, model: lastErr.model, via: "local-final", status: out.status, ttfMs: out.ttfMs, totalMs: out.totalMs, aborted: out.aborted, interrupted: out.interrupted ?? false, detail: out.detail ?? null });
        evt("result", { reqId, model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs, detail: out.detail ?? null });
        return;
      }
      evt("result", { reqId, model: lastErr?.model ?? requested, status: lastErr?.status ?? 502, via: "none", timing: null });
      return json(res, 502, { error: lastErr?.message || "all auto models failed" });
    },
  },
  {
    method: "POST",
    path: "/v1/groups/join",
    requiresAuth: false,
    handler: async ({ req, res, groups, token, bans }) => {
      if (!groups) return json(res, 501, { error: "Groups service not configured" });
      const ip = clientIp(req);
      const banned = bans?.isBanned(ip);
      if (banned) {
        return json(res, 403, { error: `banned until ${new Date(banned.until).toISOString()}` });
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "Invalid JSON body" });
      }
      if (!body?.name) return json(res, 400, { error: "group name is required" });

      const fail = (msg) => {
        try {
          if (bans) {
            const b = bans.recordFailure(ip);
            if (b) console.error(`${ip} banned (${bans.threshold} failed joins)`);
          }
        } catch {
          // ban bookkeeping must never break the join endpoint
        }
        return json(res, 403, { error: msg });
      };

      // Already-registered members re-register (sync) using their bearer token;
      // new members must present the group name (which IS the password).
      if (!body.key) {
        const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
        const hit = auth && groups.membersForToken(body.name, auth[1]);
        if (!hit) return fail("invalid member token");
        try {
          const isBroadbandRe = String(body.url || hit.member?.url || "").startsWith("relay://") || body.kind === "broadband" || hit.member?.kind === "broadband";
          const extra = {};
          if (isBroadbandRe) {
            extra.kind = "broadband";
            extra.publicIp = ip;
            extra.lastSeen = Date.now();
            if (body.url) extra.url = String(body.url);
          }
          const refreshed = groups.upsertMember(body.name, {
            memberName: body.memberName,
            url: body.url || hit.member.url,
            token: body.token || hit.member.token,
            kind: extra.kind,
            publicIp: extra.publicIp,
            lastSeen: extra.lastSeen,
          });
          // also ensure broadband's publicIp/lastSeen updated even if url same
          if (isBroadbandRe && refreshed) {
            const targetId = Object.keys(refreshed).find((k) => refreshed[k].url === (body.url || hit.member.url));
            if (targetId) {
              refreshed[targetId].publicIp = ip;
              refreshed[targetId].lastSeen = Date.now();
              refreshed[targetId].kind = "broadband";
            }
          }
          return json(res, 200, { object: "group", name: body.name, members: refreshed });
        } catch (err) {
          return json(res, 400, { error: errMsg(err) });
        }
      }

      try {
        const youPort = Number(body.myPort);
        const youUrl = Number.isInteger(youPort) && youPort > 0 ? `http://${ip}:${youPort}` : "";
        let memberUrl = String(body.url || youUrl);
        if (!memberUrl) throw new Error("member url is required");
        const isBroadband = String(memberUrl).startsWith("relay://") || body.kind === "broadband";
        if (isBroadband) {
          // broadband: keep relay:// url, record publicIp from source ip
          memberUrl = String(body.url || memberUrl);
        }
        const members = groups.addMember(body.name, {
          key: body.key,
          memberName: body.memberName,
          url: memberUrl,
          token: body.token,
          kind: isBroadband ? "broadband" : "static",
          publicIp: isBroadband ? ip : undefined,
          lastSeen: isBroadband ? Date.now() : undefined,
        });
        // 5 wrong passwords bans the source IP (48h) — see createBansService.
        if (bans) bans.clear(ip);
        // First join seeds the leader's own entry using the addr the joiner saw,
        // so -creategroup needs no address argument.
        if (!members.leader) {
          const leaderUrl = String(body.leaderUrl || "").replace(/\/+$/, "");
          if (leaderUrl) {
            groups.upsertMember(body.name, { memberName: "leader", url: leaderUrl, token });
            Object.assign(members, { leader: { url: leaderUrl, token } });
          }
        }
        // Tell the joiner the url we registered them under (source IP + their port),
        // so they can exclude themselves from their own peer list.
        json(res, 200, { object: "group", name: body.name, members, you: { url: memberUrl } });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  },
  {
    method: "POST",
    path: "/v1/groups/leave",
    requiresAuth: false,
    handler: async ({ req, res, groups }) => {
      if (!groups) return json(res, 501, { error: "Groups service not configured" });
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "Invalid JSON body" });
      }
      if (!body?.name) return json(res, 400, { error: "group name is required" });
      const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
      if (!auth) return json(res, 401, { error: "bearer token required" });
      const group = groups.list()[body.name];
      if (!group) return json(res, 404, { error: `group "${body.name}" not found` });
      const hit = groups.membersForToken(body.name, auth[1]);
      if (!hit) return json(res, 403, { error: "invalid member token" });
      try {
        const removed = groups.removeMember(body.name, { url: hit.member.url });
        return json(res, 200, {
          object: "group",
          name: body.name,
          removed: removed?.removed ?? null,
          members: groups.list()[body.name]?.members ?? {},
        });
      } catch (err) {
        return json(res, 400, { error: errMsg(err) });
      }
    },
  },
  {
    method: "POST",
    path: "/v1/groups/relay/heartbeat",
    requiresAuth: false,
    handler: async ({ req, res, groups, bus, logs }) => {
      const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
      if (!auth) return json(res, 401, { error: "bearer token required" });
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
      const groupName = body?.name || body?.group;
      if (!groupName) return json(res, 400, { error: "group name is required" });
      const hit = groups?.membersForToken(groupName, auth[1]);
      if (!hit) return json(res, 403, { error: "invalid member token" });
      const ip = clientIp(req);
      try {
        const memberUrl = hit.member?.url;
        const members = groups.list()[groupName]?.members || {};
        const targetId = Object.keys(members).find((k) => members[k].url === memberUrl) || hit.member?.url;
        // update lastSeen/publicIp for broadband
        if (hit.member?.kind === "broadband" || String(memberUrl).startsWith("relay://")) {
          const m = members[targetId] || hit.member;
          if (m) {
            m.publicIp = ip;
            m.lastSeen = Date.now();
            // persist via groups service (upsert)
            try { groups.upsertMember(groupName, { memberName: targetId, url: m.url, token: m.token, kind: "broadband", publicIp: ip, lastSeen: m.lastSeen }); } catch {}
          }
          const evtData = { ts: Date.now(), type: "relay-heartbeat", member: targetId, ip, lastSeen: m?.lastSeen, group: groupName };
          if (bus) bus.emit(evtData);
          logs?.appendEvent?.(evtData);
        }
        return json(res, 200, { object: "heartbeat", ok: true, ip, lastSeen: Date.now() });
      } catch (err) {
        return json(res, 400, { error: errMsg(err) });
      }
    },
  },
  {
    method: "POST",
    path: "/v1/groups/relay/poll",
    requiresAuth: false,
    handler: async ({ req, res, groups }) => {
      const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
      if (!auth) return json(res, 401, { error: "bearer token required" });
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
      const groupName = body?.name || body?.group;
      if (!groupName) return json(res, 400, { error: "group name is required" });
      const hit = groups?.membersForToken(groupName, auth[1]);
      if (!hit) return json(res, 403, { error: "invalid member token" });
      const targetUrl = hit.member?.url;
      if (!targetUrl) return json(res, 400, { error: "member url not found" });
      const batch = dequeueRelayForPoll({ group: groupName, target: targetUrl, limit: 10 });
      return json(res, 200, { object: "poll", data: batch });
    },
  },
  {
    method: "POST",
    path: "/v1/groups/relay/result",
    requiresAuth: false,
    handler: async ({ req, res, groups }) => {
      const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
      if (!auth) return json(res, 401, { error: "bearer token required" });
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
      const groupName = body?.name || body?.group;
      const reqId = body?.reqId;
      if (!groupName || !reqId) return json(res, 400, { error: "group and reqId required" });
      const hit = groups?.membersForToken(groupName, auth[1]);
      if (!hit) return json(res, 403, { error: "invalid member token" });
      const ok = resolveRelay(reqId, body.result || body);
      if (!ok) return json(res, 404, { error: "pending request not found or timed out" });
      return json(res, 200, { object: "result", ok: true });
    },
  },
  {
    method: "POST",
    path: "/v1/groups/relay/forward",
    requiresAuth: true,
    handler: async ({ req, res, groups, bus, logs }) => {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
      const groupName = body?.group || body?.name;
      const target = body?.target || body?.url;
      const hops = parseHops(req.headers["x-mslxdff-hops"] || body?.hops);
      if (!groupName || !target) return json(res, 400, { error: "group and target required" });
      if (hops >= DEFAULT_MAX_HOPS) return json(res, 429, { error: "max hops exceeded" });
      const members = groups?.list()[groupName]?.members || {};
      const targetMember = Object.values(members).find((m) => m.url === target) || Object.entries(members).find(([id]) => id === target)?.[1];
      if (!targetMember) return json(res, 404, { error: `target ${target} not found in group ${groupName}` });
      const isBb = targetMember.kind === "broadband" || String(targetMember.url).startsWith("relay://");
      if (!isBb) {
        // static: direct fetch (should have been handled by peer race, but support via relay as well)
        try {
          const fwdBody = body.body || body;
          const r = await fetch(`${targetMember.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${targetMember.token || ""}`, "x-mslxdff-hops": String(hops + 1), "x-mslxdff-model-lock": fwdBody.model || "", "Accept": "text/event-stream" },
            body: JSON.stringify(fwdBody),
          });
          const evtData = { ts: Date.now(), type: "relay-forward", target, via: "direct", group: groupName, hops };
          if (bus) bus.emit(evtData);
          logs?.appendEvent?.(evtData);
          res.statusCode = r.status;
          if (r.headers.get("content-type")?.includes("text/event-stream")) {
            res.setHeader("Content-Type", "text/event-stream");
            if (r.body) for await (const c of r.body) res.write(c);
            res.end();
          } else {
            const txt = await r.text();
            res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
            res.end(txt);
          }
          return;
        } catch (err) {
          return json(res, 502, { error: errMsg(err) });
        }
      }
      // broadband: enqueue and wait for poll/result
      const reqId = body.reqId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const fwdBody = body.body || { model: body.model, messages: body.messages, stream: body.stream };
      const evtData = { ts: Date.now(), type: "relay-forward", target, via: "leader", group: groupName, hops, reqId, model: fwdBody.model };
      if (bus) bus.emit(evtData);
      logs?.appendEvent?.(evtData);
      // check stale
      const staleMs = Number(process.env.MSLXDFF_BROADBAND_STALE_MS) > 0 ? Number(process.env.MSLXDFF_BROADBAND_STALE_MS) : 90_000;
      if (typeof targetMember.lastSeen === "number" && Date.now() - targetMember.lastSeen > staleMs) {
        return json(res, 502, { error: "broadband member stale (no heartbeat)" });
      }
      try {
        const resultPromise = enqueueRelay({ group: groupName, target: targetMember.url, reqId, body: fwdBody, hops });
        // race with timeout already in enqueueRelay (30s)
        const result = await resultPromise;
        // result is expected to be { status, headers, body } from broadband
        if (result && typeof result.status === "number") {
          res.statusCode = result.status;
          if (result.headers) for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
          if (result.body) {
            if (typeof result.body === "string") res.end(result.body);
            else res.end(JSON.stringify(result.body));
          } else res.end();
          return;
        }
        // if result is raw upstream response body
        return json(res, 200, result);
      } catch (err) {
        return json(res, 504, { error: errMsg(err) || "relay timeout" });
      }
    },
  },
  {
    method: "GET",
    path: "/v1/models",
    requiresAuth: true,
    handler: async ({ res, models }) => {
      if (!models) return json(res, 501, { error: "Models service not configured" });
      try {
        const data = await models.get();
        json(res, 200, data);
      } catch (err) {
        json(res, 502, { error: errMsg(err) });
      }
    },
  },
  {
    method: "GET",
    path: "/v1/models/status",
    requiresAuth: true,
    handler: async ({ res, models, auto }) => {
      const statuses = auto?.statuses?.() || {};
      let ids = [];
      try {
        ids = (await models?.get?.())?.data?.map((m) => m.id) || [];
      } catch {
        // models list unavailable; fall back to status records only
      }
      const seen = new Set();
      const data = [];
      for (const id of [...ids, ...Object.keys(statuses)]) {
        if (seen.has(id)) continue;
        seen.add(id);
        const e = statuses[id];
        const entry = typeof e === "number"
          ? { id, status: "error", at: e }
          : { id, status: e?.status || "normal", at: e?.at ?? null, code: e?.code ?? null };
        data.push(entry);
      }
      json(res, 200, { object: "list", data });
    },
  },
];
