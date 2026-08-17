import { timingSafeEqual, createHash } from "node:crypto";
import { injectReasoningContent, normalizeModel } from "./reasoning.js";
import { isAutoModel } from "./auto.js";
import { DEFAULT_MAX_HOPS } from "./peers.js";

export const errMsg = (err) => String(err?.message || err);

export function createRouter({ token, upstream, models, auto, logs, peers, maxHops = DEFAULT_MAX_HOPS, groups, bans }) {
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

    await route.handler({ req, res, upstream, models, auto, logs, peers, maxHops, groups, bans, token });
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
    handler: async ({ req, res, upstream, auto, logs, peers, maxHops }) => {
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

      let lastErr = null;
      for (const model of order) {
        let upRes = null;
        const forwarded = { ...injectReasoningContent(model, body), model };
        try {
          upRes = await upstream.chat(forwarded);
        } catch (err) {
          if (auto) await auto.recordError(model);
          lastErr = { model, upstream: null, status: 502, message: errMsg(err) };
          logError(model, 502, errMsg(err));
        }
        if (upRes && upRes.status >= 400) {
          if (auto) await auto.recordError(model);
          lastErr = { model, upstream: upRes, status: upRes.status, message: null };
          logError(model, upRes.status, `upstream ${upRes.status}`);
          upRes = null;
        }
        if (upRes) {
          logCall(model, upRes.status);
          return relay(res, upRes, body);
        }

        // local failed for this model: try the same model on peers, round-robin over available ones
        if (canForwardPeers) {
          const count = peers.available().length;
          for (let i = 0; i < count; i++) {
            const peer = peers.next();
            if (!peer) break;
            let peerRes = await forwardToPeer(peer, body, model, hops);
            if (peerRes instanceof Error || peerRes.status >= 400) {
              await peers.recordError(peer.url);
              logError(model, peerRes instanceof Error ? 502 : peerRes.status,
                peerRes instanceof Error ? errMsg(peerRes) : `peer ${peerRes.status}`);
              continue;
            }
            logCall(model, peerRes.status);
            return relay(res, peerRes, body);
          }
        }

        if (canFallback) continue;
        logCall(lastErr?.model ?? model, lastErr?.status ?? 502);
        if (lastErr?.upstream) return relay(res, lastErr.upstream, body);
        return json(res, 502, { error: lastErr?.message || "all auto models failed" });
      }

      logCall(lastErr?.model ?? requested, lastErr?.status ?? 502);
      if (lastErr?.upstream) return relay(res, lastErr.upstream, body);
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
];
