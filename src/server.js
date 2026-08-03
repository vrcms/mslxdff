import { createServer as httpCreateServer } from "node:http";
import { DEFAULT_PORT, getPort } from "./state.js";

export function startServer({ router }, port = resolvePort()) {
  const server = httpCreateServer((req, res) => {
    router(req, res).catch((err) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    });
  });

  const ready = () =>
    new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, resolve);
    });

  const close = () =>
    new Promise((resolve) => {
      server.close(resolve);
    });

  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  return { server, ready, close };
}

export function resolvePort() {
  const persisted = getPort();
  if (persisted) return persisted;
  const env = Number(process.env.PORT);
  if (Number.isInteger(env) && env > 0) return env;
  return DEFAULT_PORT;
}
