import { timingSafeEqual, createHash } from "node:crypto";
import { injectReasoningContent, normalizeModel } from "./reasoning.js";
import { isAutoModel } from "./auto.js";

export const errMsg = (err) => String(err?.message || err);

export function createRouter({ token, upstream, models, auto, logs }) {
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

    await route.handler({ req, res, upstream, models, auto, logs });
  };
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
    handler: async ({ req, res, upstream, auto, logs }) => {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "Invalid JSON body" });
      }

      const startedAt = Date.now();
      const requested = normalizeModel(body.model || "");
      const useAuto = isAutoModel(requested);

      let order;
      if (useAuto) {
        order = auto ? await auto.candidates() : [""];
      } else {
        order = auto ? await auto.candidatesFor(requested) : [requested];
      }
      if (!order.length) order = [""];
      const canFallback = order.length > 1;

      const logCall = (model, status) =>
        logs?.appendCall({ model, auto: useAuto, status, durationMs: Date.now() - startedAt, stream: Boolean(body.stream) });
      const logError = (model, status, message) =>
        logs?.appendError({ model, auto: useAuto, status, message });

      let lastErr = null;
      for (const model of order) {
        const forwarded = { ...injectReasoningContent(model, body), model };
        let upRes;
        try {
          upRes = await upstream.chat(forwarded);
        } catch (err) {
          if (auto) await auto.recordError(model);
          lastErr = { model, upstream: null, status: 502, message: errMsg(err) };
          logError(model, 502, errMsg(err));
          if (canFallback) continue;
          logCall(model, 502);
          return json(res, 502, { error: errMsg(err) });
        }
        if (upRes.status >= 400) {
          if (auto) await auto.recordError(model);
          lastErr = { model, upstream: upRes, status: upRes.status, message: null };
          logError(model, upRes.status, `upstream ${upRes.status}`);
          if (canFallback) continue;
          logCall(model, upRes.status);
          return relay(res, upRes, body);
        }
        logCall(model, upRes.status);
        return relay(res, upRes, body);
      }

      logCall(lastErr?.model ?? requested, lastErr?.status ?? 502);
      if (lastErr?.upstream) return relay(res, lastErr.upstream, body);
      return json(res, 502, { error: lastErr?.message || "all auto models failed" });
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
