import { getUndici } from "../compat.js";

const UndiciAgent = getUndici().Agent;

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

export function createPool({
  keepAlive = true,
  keepAliveTimeout,
  keepAliveMaxTimeout,
  connections,
} = {}) {
  const keepAliveTimeoutMs = keepAliveTimeout ?? envInt("MSLXDFF_UPSTREAM_KEEPALIVE_TIMEOUT", 30_000);
  const keepAliveMaxTimeoutMs = keepAliveMaxTimeout ?? envInt("MSLXDFF_UPSTREAM_KEEPALIVE_MAX_TIMEOUT", 60_000);
  const keepAliveConnections = connections ?? envInt("MSLXDFF_UPSTREAM_KEEPALIVE_CONNECTIONS", 20);

  let agent = null;
  let dispatcher = null;
  let closed = false;

  if (keepAlive && UndiciAgent) {
    try {
      agent = new UndiciAgent({
        keepAliveTimeout: keepAliveTimeoutMs,
        keepAliveMaxTimeout: keepAliveMaxTimeoutMs,
        connections: keepAliveConnections,
        pipelining: 1,
      });
      dispatcher = agent;
    } catch {
      agent = null;
      dispatcher = null;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (agent && typeof agent.close === "function") {
      try { await agent.close(); } catch {}
    } else if (dispatcher && typeof dispatcher.close === "function" && dispatcher !== agent) {
      try { await dispatcher.close(); } catch {}
    }
  }

  return {
    get dispatcher() { return dispatcher; },
    get agent() { return agent; },
    get closed() { return closed; },
    close,
    [Symbol.asyncDispose]: close,
  };
}
