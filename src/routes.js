import { timingSafeEqual, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { injectReasoningContent, normalizeModel } from "./reasoning.js";
import { isAutoModel } from "./auto.js";
import { DEFAULT_MAX_HOPS } from "./peers.js";

export const errMsg = (err) => String(err?.message || err);

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

// Relay an upstream response to the client. Returns { status, ttfMs, aborted }
// where:
//   - status  200 = fully relayed; STREAM_TIMEOUT = first chunk never arrived
//     within streamTimeoutMs and nothing was written to res yet (safe to
//     failover); 500 = the response body errored mid-stream.
//   - ttfMs   time to first chunk when one arrived.
//   - aborted true when we closed the downstream connection ourselves (only
//     for the STREAM_TIMEOUT case, before anything was written).
async function relay(res, upRes, body, { onFirstChunk, streamTimeoutMs = STREAM_TIMEOUT_MS } = {}) {
  const t0 = performance.now();
  const contentType = upRes.headers.get("content-type") || "";
  const isStream = Boolean(body?.stream) || contentType.includes("text/event-stream");
  res.statusCode = upRes.status;

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    let ttf = null;
    if (upRes.body) {
      let first = true;
      let wroteAny = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // nothing written yet — cancel the upstream body so the loop can exit
        // and we can fail over to the next model cleanly.
        if (typeof upRes.body.cancel === "function") upRes.body.cancel().catch(() => {});
      }, streamTimeoutMs);
      try {
        for await (const chunk of upRes.body) {
          if (timedOut) break;
          if (first) {
            first = false;
            ttf = Math.round(performance.now() - t0);
            onFirstChunk?.(ttf);
          }
          wroteAny = true;
          res.write(chunk);
        }
      } catch (err) {
        timedOut = true;
      } finally {
        clearTimeout(timer);
      }
      if (timedOut && !wroteAny) {
        // nothing written to res yet — safe to drop this model and let the
        // caller fail over to the next one. Do NOT write/end res here.
        return { status: STREAM_TIMEOUT_MS, ttfMs: null, totalMs: Math.round(performance.now() - t0), aborted: true };
      }
      if (timedOut && wroteAny) {
        // we'd already started streaming when it died — can't fail over, just
        // end the response so the client sees a clean EOF.
        try { res.end(); } catch { /* ignore */ }
        return { status: 200, ttfMs: ttf, totalMs: Math.round(performance.now() - t0), aborted: false };
      }
    }
    const totalMs = Math.round(performance.now() - t0);
    try { res.end(); } catch { /* ignore */ }
    return { status: 200, ttfMs: ttf, totalMs, aborted: false };
  }

  const text = await upRes.text();
  try {
    json(res, upRes.status, JSON.parse(text));
  } catch {
    res.statusCode = upRes.status;
    res.setHeader("Content-Type", contentType || "text/plain");
    res.end(text);
  }
  return { status: upRes.status, ttfMs: null, totalMs: Math.round(performance.now() - t0), aborted: false };
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

// Resolve the model a peer should serve for this request: reuse its hot-cache
// model only when it matches the requested one; otherwise probe /v1/models/status
// and prefer the requested model, falling back to the peer's first healthy one.
// Returns { peer, target } or null when the peer is unusable.
async function resolvePeerTarget(ctx, peer) {
  const prevModel = ctx.peers.stat(peer.url)?.model;
  const hot = ctx.peers.isHot(peer.url) && prevModel === ctx.model;
  if (hot) return { peer, target: prevModel };
  const healthy = await peerHealthyModels(peer);
  if (!healthy.length) {
    // peer unreachable or every model unhealthy — mark it and move on
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
  return Number.isInteger(n) && n > 0 ? n : 15_000;
})();

// How long to wait for the first chunk of a streamed response before giving up
// on that model (nothing has been written yet, so we can fail over cleanly).
// Set MSLXDFF_STREAM_TIMEOUT_MS=0 to disable the circuit breaker.
export const STREAM_TIMEOUT_MS = (() => {
  const n = Number(process.env.MSLXDFF_STREAM_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 25_000;
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
        const t0 = performance.now();
        forwardToPeer(peer, ctx.body, target, ctx.hops).then((res) => {
          const latencyMs = Math.round(performance.now() - t0);
          const failed = res instanceof Error || res.status >= 400;
          ctx.evt("peer-forward", { peer: peer.url, model: target, hops: ctx.hops + 1 });
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
    handler: async ({ req, res, upstream, auto, logs, peers, maxHops, bus }) => {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "Invalid JSON body" });
      }

      const startedAt = Date.now();
      const perf0 = performance.now();
      const stages = [];
      const mark = (name) => stages.push([name, Math.round(performance.now() - perf0)]);
      const hops = parseHops(req.headers["x-mslxdff-hops"]);
      const lockModel = req.headers["x-mslxdff-model-lock"] || "";
      const requested = normalizeModel(lockModel || body.model || "");
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
        logs?.appendCall({ model, auto: useAuto, status, durationMs: Date.now() - startedAt, stream: Boolean(body.stream), stages });
      const logError = (model, status, message) =>
        logs?.appendError({ model, auto: useAuto, status, message, stages });
      const evt = (type, data) => {
        const entry = { ts: Date.now(), type, ...data, model: data.model ?? requested, auto: useAuto, durationMs: Date.now() - startedAt, stages: [...stages] };
        if (bus) bus.emit(entry);
        logs?.appendEvent?.(entry);
      };
      evt("request", { hops, ip: clientIp(req), stream: Boolean(body.stream), prompt: summarizePrompt(body) });

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
      for (const model of order) {
        handlerCtx.model = model;
        let upRes = null;
        const forwarded = { ...injectReasoningContent(model, body), model };
        const tUp = performance.now();
        try {
          upRes = await upstream.chat(forwarded);
        } catch (err) {
          if (auto) await auto.recordError(model, { message: errMsg(err) });
          lastErr = { model, upstream: null, status: 502, message: errMsg(err) };
          logError(model, 502, errMsg(err));
          evt("upstream-error", { model, status: 502, message: errMsg(err), timing: err._t ?? { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - tUp) } });
        }
        mark(`up-${model}`);
        if (upRes && upRes.status >= 400) {
          if (auto) await auto.recordError(model, { status: upRes.status });
          lastErr = { model, upstream: upRes, status: upRes.status, message: null };
          logError(model, upRes.status, `upstream ${upRes.status}`);
          evt("upstream-error", { model, status: upRes.status, message: null, timing: upRes._t ?? null });
          upRes = null;
        }
        if (upRes) {
          if (auto) await auto.recordOk(model);
          logCall(model, upRes.status);
          const out = await relay(res, upRes, body, { onFirstChunk: (delta) => mark(`ttf-${model}`) });
          if (out.status === STREAM_TIMEOUT_MS) {
            // nothing was written — treat this model as failed and keep walking
            // the failover chain instead of waiting out the slow stream.
            if (auto) await auto.recordError(model, { status: 502, slow: true, note: `stream timeout ${STREAM_TIMEOUT_MS}ms` });
            lastErr = { model, upstream: null, status: 502, message: `stream timed out after ${STREAM_TIMEOUT_MS}ms` };
            logError(model, 502, `stream timeout ${STREAM_TIMEOUT_MS}ms`);
            evt("upstream-error", { model, status: 502, message: "stream timeout", timing: null });
            upRes = null;
            continue;
          }
          // A model that took a long wall-clock time (TTFB + generation + relay)
          // gets remembered as slow so the next request prefers a faster one.
          const elapsed = Date.now() - startedAt;
          if (SLOW_TOTAL_MS && auto && elapsed > SLOW_TOTAL_MS && out.status === 200) {
            void auto.recordError(model, { status: 200, slow: true, note: `slow ${elapsed}ms` });
            evt("slow-model", { model, elapsedMs: elapsed, threshold: SLOW_TOTAL_MS });
          }
          evt("result", { model, status: out.status, via: "local", timing: upRes._t ?? null, ttfMs: out.ttfMs, totalMs: out.totalMs });
          return;
        }

        // local failed for this model: race the peers — send the request to
        // up to N of them in parallel, first success wins (the winner's model
        // is remembered for the next call). If every candidate fails, retry
        // once ordered by recovery time (earliest failure first), which
        // favours the peer that has had the longest to come back.
        if (canForwardPeers) {
          const win =
            (await racePeerCandidates(peers.ordered(), handlerCtx)) ||
            (await racePeerCandidates(peers.orderedByLastError(), handlerCtx));
          if (win) {
            await peers.recordResult(win.peer.url, { ok: true, latencyMs: win.latencyMs, model: win.target });
            logCall(win.target, win.res.status);
            const out = await relay(res, win.res, body, { onFirstChunk: (d) => mark(`ttf-peer-${win.target}`) });
            evt("result", { model: win.target, status: out.status, via: "peer", timing: win.res._t ?? null, ttfMs: out.ttfMs });
            return;
          }
        }

        if (canFallback) continue;
        logCall(lastErr?.model ?? model, lastErr?.status ?? 502);
        if (lastErr?.upstream) {
          const out = await relay(res, lastErr.upstream, body, { onFirstChunk: (d) => mark(`ttf-${lastErr.model}`) });
          evt("result", { model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs });
          return;
        }
        evt("result", { model, status: lastErr?.status ?? 502, via: "none", timing: null });
        return json(res, 502, { error: lastErr?.message || "all auto models failed" });
      }

      logCall(lastErr?.model ?? requested, lastErr?.status ?? 502);
      if (lastErr?.upstream) {
        const out = await relay(res, lastErr.upstream, body, { onFirstChunk: (d) => mark(`ttf-${lastErr.model}`) });
        evt("result", { model: lastErr.model, status: out.status, via: "local", timing: lastErr.upstream._t ?? null, ttfMs: out.ttfMs });
        return;
      }
      evt("result", { model: lastErr?.model ?? requested, status: lastErr?.status ?? 502, via: "none", timing: null });
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
          const refreshed = groups.upsertMember(body.name, {
            memberName: body.memberName,
            url: body.url,
            token: body.token,
          });
          return json(res, 200, { object: "group", name: body.name, members: refreshed });
        } catch (err) {
          return json(res, 400, { error: errMsg(err) });
        }
      }

      try {
        const youPort = Number(body.myPort);
        const youUrl = Number.isInteger(youPort) && youPort > 0 ? `http://${ip}:${youPort}` : "";
        const memberUrl = String(body.url || youUrl);
        if (!memberUrl) throw new Error("member url is required");
        const members = groups.addMember(body.name, {
          key: body.key,
          memberName: body.memberName,
          url: memberUrl,
          token: body.token,
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
