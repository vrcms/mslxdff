import { createServer as httpCreateServer } from "node:http";

export function startServer({ router }, port = Number(process.env.PORT) || 8080) {
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

  const shutdown = () => close();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, ready, close };
}