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

    if (bus && path === "/v1/_debug/stream") {
      // live debug stream (SSE): auth REQUIRED, then replay backlog + push
      if (!authorized(req, token)) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", "Bearer");
        return json(res, 401, { error: "Unauthorized" });
      }
      return streamEvents(req, res, bus);
    }

    if (!route) return notFound(res);

    if (route.requiresAuth && !authorized(req, token)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      return json(res, 401, { error: "Unauthorized" });
    }

    await route.handler({ req, res, upstream, models, auto, logs, peers, maxHops, groups, bans, token, bus });
  };
}

// SSE endpoint consumed by `mslxdff -debug`: replays the buffered backlog,
// then pushes each new event as it happens. One second heartbeat keeps
// proxies/NAT from closing the connection.
function streamEvents(req, res, bus) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  for (const e of bus.replayAll()) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  const unsubscribe = bus.subscribe((e) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
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

async function relay(res, upRes, body) {
  const contentType = upRes.headers.get("content-type") || "";
  const isStream = Boolean(body?.stream) || contentType.includes("text/event-stream");
  res.statusCode = upRes.status;

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (upRes.body) {
      for await (const chunk of upRes.body) {
        res.write(chunk);
      }
    }
    res.end();
    return;
  }

  const text = await upRes.text();
  try {
    json(res, upRes.status, JSON.parse(text));
  } catch {
    res.statusCode = upRes.status;
    res.setHeader("Content-Type", contentType || "text/plain");
    res.end(text);
  }
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
      const hops = parseHops(req.headers["x-mslxdff-hops"]);
      const lockModel = req.headers["x-mslxdff-model-lock"] || "";
      const requested = normalizeModel(lockModel || body.model || "");
      const useAuto = isAutoModel(requested);

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

      const logCall = (model, status) =>
        logs?.appendCall({ model, auto: useAuto, status, durationMs: Date.now() - startedAt, stream: Boolean(body.stream) });
      const logError = (model, status, message) =>
        logs?.appendError({ model, auto: useAuto, status, message });
      const evt = (type, data) => {
        const entry = { ts: Date.now(), type, ...data, model: data.model ?? requested, auto: useAuto, durationMs: Date.now() - startedAt };
        if (bus) bus.emit(entry);
        logs?.appendEvent?.(entry);
      };
      evt("request", { hops, ip: clientIp(req), stream: Boolean(body.stream), prompt: summarizePrompt(body) });

      let lastErr = null;
      for (const model of order) {
        let upRes = null;
        const forwarded = { ...injectReasoningContent(model, body), model };
        try {
          upRes = await upstream.chat(forwarded);
        } catch (err) {
          if (auto) await auto.recordError(model, { message: errMsg(err) });
          lastErr = { model, upstream: null, status: 502, message: errMsg(err) };
          logError(model, 502, errMsg(err));
          evt("upstream-error", { model, status: 502, message: errMsg(err) });
        }
        if (upRes && upRes.status >= 400) {
          if (auto) await auto.recordError(model, { status: upRes.status });
          lastErr = { model, upstream: upRes, status: upRes.status, message: null };
          logError(model, upRes.status, `upstream ${upRes.status}`);
          evt("upstream-error", { model, status: upRes.status, message: null });
          upRes = null;
        }
        if (upRes) {
          if (auto) await auto.recordOk(model);
          logCall(model, upRes.status);
          evt("result", { model, status: upRes.status, via: "local" });
          return relay(res, upRes, body);
        }

        // local failed for this model: try peers ordered hot-first (reuse
        // their last successful model without probing), cold peers get a
        // health probe before the forward
        if (canForwardPeers) {
          for (const peer of peers.ordered()) {
            let target = null;
            const hot = peers.isHot(peer.url);
            if (hot && peers.stat(peer.url)?.model) {
              target = peers.stat(peer.url).model;
            } else {
              const healthy = await peerHealthyModels(peer);
              if (!healthy.length) {
                // peer unreachable or every model unhealthy — mark it and move on
                await peers.recordError(peer.url);
                logError(model, 0, `peer ${peer.url} has no healthy models`);
                evt("peer-health", { peer: peer.url, healthy: [], count: 0 });
                continue;
              }
              evt("peer-health", { peer: peer.url, healthy, count: healthy.length });
              target = healthy[0];
            }

            const t0 = performance.now();
            let peerRes = await forwardToPeer(peer, body, target, hops);
            let latencyMs = Math.round(performance.now() - t0);
            evt("peer-forward", { peer: peer.url, model: target, hops: hops + 1 });
            if (peerRes instanceof Error || peerRes.status >= 400) {
              // hot-cache miss: probe this peer once for a healthy model
              if (hot) {
                const healthy = await peerHealthyModels(peer);
                if (healthy.length) {
                  target = healthy[0];
                  const t1 = performance.now();
                  peerRes = await forwardToPeer(peer, body, target, hops);
                  latencyMs = Math.round(performance.now() - t1);
                  evt("peer-forward", { peer: peer.url, model: target, hops: hops + 1, retry: true });
                }
              }
            }
            if (peerRes instanceof Error || peerRes.status >= 400) {
              await peers.recordError(peer.url);
              await peers.recordResult(peer.url, { ok: false });
              logError(model, peerRes instanceof Error ? 502 : peerRes.status,
                peerRes instanceof Error ? errMsg(peerRes) : `peer ${peerRes.status}`);
              evt("peer-error", {
                peer: peer.url,
                model: target,
                status: peerRes instanceof Error ? 502 : peerRes.status,
                message: peerRes instanceof Error ? errMsg(peerRes) : null,
              });
              continue;
            }
            await peers.recordResult(peer.url, { ok: true, latencyMs, model: target });
            logCall(target, peerRes.status);
            evt("result", { model: target, status: peerRes.status, via: "peer" });
            return relay(res, peerRes, body);
          }
        }

        if (canFallback) continue;
        logCall(lastErr?.model ?? model, lastErr?.status ?? 502);
        if (lastErr?.upstream) {
          evt("result", { model: lastErr.model, status: lastErr.status, via: "local" });
          return relay(res, lastErr.upstream, body);
        }
        evt("result", { model, status: lastErr?.status ?? 502, via: "none" });
        return json(res, 502, { error: lastErr?.message || "all auto models failed" });
      }

      logCall(lastErr?.model ?? requested, lastErr?.status ?? 502);
      if (lastErr?.upstream) {
        evt("result", { model: lastErr.model, status: lastErr.status, via: "local" });
        return relay(res, lastErr.upstream, body);
      }
      evt("result", { model: lastErr?.model ?? requested, status: lastErr?.status ?? 502, via: "none" });
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
