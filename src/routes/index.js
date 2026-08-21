import { timingSafeEqual, createHash } from "node:crypto";
import { DEFAULT_MAX_HOPS } from "../peers.js";
import { json, notFound, authorized } from "./helpers.js";
import { chatHandler } from "./chat.js";
import { joinHandler, leaveHandler } from "./groups.js";
import { heartbeatHandler, pollHandler, resultHandler, forwardHandler } from "./groups-relay.js";
import { modelsHandler, modelsStatusHandler } from "./models-route.js";

export function createRouter({ token, upstream, models, auto, logs, peers, maxHops = DEFAULT_MAX_HOPS, groups, bans, bus, plugins }) {
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
    await route.handler({ req, res, upstream, models, auto, logs, peers, maxHops, groups, bans, token, bus, plugins });
  };
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
    handler: chatHandler,
  },
  {
    method: "POST",
    path: "/v1/groups/join",
    requiresAuth: false,
    handler: joinHandler,
  },
  {
    method: "POST",
    path: "/v1/groups/leave",
    requiresAuth: false,
    handler: leaveHandler,
  },
  {
    method: "POST",
    path: "/v1/groups/relay/heartbeat",
    requiresAuth: false,
    handler: heartbeatHandler,
  },
  {
    method: "POST",
    path: "/v1/groups/relay/poll",
    requiresAuth: false,
    handler: pollHandler,
  },
  {
    method: "POST",
    path: "/v1/groups/relay/result",
    requiresAuth: false,
    handler: resultHandler,
  },
  {
    method: "POST",
    path: "/v1/groups/relay/forward",
    requiresAuth: true,
    handler: forwardHandler,
  },
  {
    method: "GET",
    path: "/v1/models",
    requiresAuth: true,
    handler: modelsHandler,
  },
  {
    method: "GET",
    path: "/v1/models/status",
    requiresAuth: true,
    handler: modelsStatusHandler,
  },
];

// re-export for facade & tests
export { errMsg, PROMPT_MAX_LEN, summarizePrompt, clientIp, authorized, json, notFound, readBody, parseHops } from "./helpers.js";
export { buildFallbackInfo, applyFallbackHeaders, enrichNonStreamJson, enrichSseChunkText } from "./fallback.js";
export { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS, MAX_STREAM_MS } from "./stream.js";
export { peerHealthyModels, racePeerCandidates, PEER_RACE_LIMIT } from "./peers.js";
export { enqueueRelay, dequeueRelayForPoll, resolveRelay, tryBroadbandRelay } from "./relay-queue.js";
