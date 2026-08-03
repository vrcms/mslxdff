import { timingSafeEqual } from "node:crypto";
import { injectReasoningContent, normalizeModel } from "./reasoning.js";

export function createRouter({ token, upstream, models }) {
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

    await route.handler({ req, res, upstream, models });
  };
}

function authorized(req, token) {
  const header = req.headers["authorization"] || "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const provided = match[1];
  if (provided.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
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
    handler: async ({ req, res, upstream }) => {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "Invalid JSON body" });
      }

      const model = normalizeModel(body.model || "");
      const forwarded = { ...injectReasoningContent(model, body), model };
      let upRes;
      try {
        upRes = await upstream.chat(forwarded);
      } catch (err) {
        return json(res, 502, { error: String(err?.message || err) });
      }

      const contentType = upRes.headers.get("content-type") || "";
      const isStream = Boolean(body.stream) || contentType.includes("text/event-stream");
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
        json(res, 502, { error: String(err?.message || err) });
      }
    },
  },
];