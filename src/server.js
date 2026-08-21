import { createServer as httpCreateServer } from "node:http";
import { DEFAULT_PORT, getPort } from "./state.js";

export function startServer({ router, signals = true, host, onBeforeClose }, port = resolvePort()) {
  const listenHost = host ?? resolveHost();
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
      if (listenHost) server.listen(port, listenHost, resolve);
      else server.listen(port, resolve);
    });

  const close = async () => {
    // 插件 hook：server:stop — 关闭前触发（fire-and-forget，不阻塞关停）
    try { await onBeforeClose?.(); } catch {}
    await new Promise((resolve) => {
      server.close(resolve);
      // SSE debug streams keep connections open — force-close so shutdown
      // never waits on them.
      server.closeAllConnections?.();
    });
  };

  if (signals) {
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  }

  return { server, ready, close };
}

export function resolveHost() {
  const envHost = process.env.MSLXDFF_HOST || process.env.MSLXDFF_BIND_HOST;
  if (typeof envHost === "string" && envHost.trim()) return envHost.trim();
  return "0.0.0.0";
}

export function resolvePort() {
  // 8989 is the hard default. Port only changes via an explicit, mslxdff-owned
  // override: the persisted `-port N` setting, or the MSLXDFF_PORT env var.
  // Bare `PORT` is deliberately NOT read — an ssh session / wrapper script
  // commonly injects it and would silently override the default.
  const persisted = getPort();
  if (persisted) return persisted;
  const env = Number(process.env.MSLXDFF_PORT);
  // 0 = OS-assigned ephemeral port (valid; used by tests/containers)
  if (Number.isInteger(env) && env >= 0) return env;
  return DEFAULT_PORT;
}
