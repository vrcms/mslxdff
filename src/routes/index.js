import { timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_MAX_HOPS } from "../peers.js";
import { json, notFound, authorized } from "./helpers.js";
import { chatHandler } from "./chat.js";
import { joinHandler, leaveHandler } from "./groups.js";
import { heartbeatHandler, pollHandler, resultHandler, forwardHandler, streamHandler } from "./groups-relay.js";
import { modelsHandler, modelsStatusHandler, providerModelsHandler, capabilitiesHandler } from "./models-route.js";
import { relayHandler } from "./relay.js";
import { responsesHandler } from "./responses-route.js";
import { messagesHandler, countTokensHandler } from "./messages-route.js";

export function createRouter({ token, upstream, models, auto, logs, peers, maxHops = DEFAULT_MAX_HOPS, groups, bans, bus, plugins, version = null }) {
  // /health 要报版本：调用方（waitForHealth）拿它判断「应答的是不是刚起的那个」。
  // 未显式传入时读 package.json 兜底 —— 测试直接 createRouter() 也能拿到真版本，不必逐个补参数。
  const healthVersion = (() => {
    if (version) return version;
    try { return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? null; } catch { return null; }
  })();
  return async function router(req, res) {
    const method = req.method || "GET";
    const path = (req.url || "").split("?")[0];
    // pid/version 不是装饰：调用方（`-restart`/`-port`/`-update` 的 waitForHealth）需要它判断
    // 「应答的到底是不是我刚起的那个」。只回 {status:"ok"} 时，旧 daemon 占着端口也能让健康检查通过，
    // 于是「新进程 EADDRINUSE 秒退、旧版仍在服务」会被谎报成重启成功（BUG-29）。
    if (method === "GET" && path === "/health") {
      return json(res, 200, { status: "ok", pid: process.pid, version: healthVersion });
    }
    // dynamic provider models route: GET /v1/providers/:id/models
    if (method === "GET" && /^\/v1\/providers\/[^/]+\/models\/?$/.test(path)) {
      if (!authorized(req, token)) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", "Bearer");
        return json(res, 401, { error: "Unauthorized" });
      }
      return providerModelsHandler({ req, res, models, upstream });
    }
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
    method: "POST",
    path: "/v1/chat/completions",
    requiresAuth: true,
    handler: chatHandler,
  },
  {
    method: "POST",
    path: "/v1/responses",
    requiresAuth: true,
    handler: responsesHandler,
  },
  {
    method: "POST",
    path: "/v1/messages",
    requiresAuth: true,
    handler: messagesHandler,
  },
  {
    method: "POST",
    path: "/v1/messages/count_tokens",
    requiresAuth: true,
    handler: countTokensHandler,
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
    method: "GET",
    path: "/v1/groups/relay/stream",
    requiresAuth: false,
    handler: streamHandler,
  },
  {
    method: "POST",
    path: "/v1/groups/relay/forward",
    // 鉴权下沉到 forwardHandler：接受**组长 token 或本组成员 token**（成员经组长转发的正是成员 token）。
    // 路由层 authorized(req, token) 只认组长自己那一个 token ⇒ 用 requiresAuth:true 会把成员中继一律 401
    // （现网 2026-10-19 实证：deepseek-v4.1-flash-free.log 里所有 relay-fail 都是 status=401，组员接力从未通过）。
    // 同族 heartbeat/poll/result 同理走 requiresAuth:false + membersForToken 自校验。
    requiresAuth: false,
    handler: forwardHandler,
  },
  {
    method: "POST",
    path: "/v1/relay",
    requiresAuth: true,
    handler: relayHandler,
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
  {
    method: "GET",
    path: "/v1/models/capabilities",
    requiresAuth: true,
    handler: capabilitiesHandler,
  },
];

// re-export for facade & tests
export { errMsg, PROMPT_MAX_LEN, summarizePrompt, clientIp, authorized, json, notFound, readBody, parseHops } from "./helpers.js";
export { buildFallbackInfo, applyFallbackHeaders, enrichNonStreamJson, enrichSseChunkText } from "./fallback.js";
export { relay, SLOW_TOTAL_MS, STREAM_TIMEOUT_MS, STALL_TIMEOUT_MS, SCORE_STALL_MS, MAX_STREAM_MS } from "./stream.js";
export { peerHealthyModels, racePeerCandidates, PEER_RACE_LIMIT } from "./peers.js";
export { enqueueRelay, dequeueRelayForPoll, resolveRelay, tryBroadbandRelay } from "./relay-queue.js";
