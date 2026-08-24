import crypto from "node:crypto";

let UndiciAgent = null;
let UndiciFetch = null;
try {
  const mod = await import("undici");
  UndiciAgent = mod.Agent;
  UndiciFetch = mod.fetch;
} catch {
  // undici not installed — fallback to no dispatcher (still works, just no keep-alive tuning)
}

function genId(prefix) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

function isPreheatDisabled() {
  const raw = process.env.MSLXDFF_PREHEAT;
  if (raw === undefined || raw === null || raw === "") return false;
  const s = String(raw).trim().toLowerCase();
  return s === "0" || s === "off" || s === "false" || s === "no" || s === "disable" || s === "disabled";
}

export function createUpstreamClient({
  baseUrl = process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
  authToken = process.env.UPSTREAM_AUTH_TOKEN || "public",
  connectTimeoutMs = Number(process.env.UPSTREAM_CONNECT_TIMEOUT_MS) || 30_000,
  retry = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  },
  fetchImpl,
  hooks,
} = {}) {
  // 使用 undici 的 fetch 与 Agent 配对，避免 global fetch 与 npm undici Agent 不兼容
  if (!fetchImpl) fetchImpl = UndiciFetch || fetch;
  // hooks: async (name, ctx) => ({ value, changed }) | null — 由 bin 用 runHook 绑定；错误已在上层隔离
  const applyHook = async (name, ctx) => {
    if (!hooks) return null;
    try {
      return await hooks(name, ctx);
    } catch {
      return null;
    }
  };
  const baseHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`,
    "x-opencode-client": "desktop",
  };

  function buildHeaders(body) {
    const isStream = body?.stream !== false;
    return {
      ...baseHeaders,
      "Accept": isStream ? "text/event-stream" : "*/*",
      "User-Agent": "opencode",
      "x-opencode-session": genId("ses_"),
      "x-opencode-request": genId("msg_"),
      "x-opencode-project": "global",
    };
  }

  // Keep-Alive Agent（显式复用 TCP+TLS）
  const keepAliveTimeout = envInt("MSLXDFF_UPSTREAM_KEEPALIVE_TIMEOUT", 30_000);
  const keepAliveMaxTimeout = envInt("MSLXDFF_UPSTREAM_KEEPALIVE_MAX_TIMEOUT", 60_000);
  const keepAliveConnections = envInt("MSLXDFF_UPSTREAM_KEEPALIVE_CONNECTIONS", 20);
  let dispatcher = null;
  let agent = null;
  if (UndiciAgent) {
    try {
      agent = new UndiciAgent({
        keepAliveTimeout,
        keepAliveMaxTimeout,
        connections: keepAliveConnections,
        pipelining: 1,
      });
      dispatcher = agent;
    } catch {
      agent = null;
      dispatcher = null;
    }
  }

  async function chat(body) {
    const url = `${baseUrl}/zen/v1/chat/completions`;
    const t0 = performance.now();
    const attempts = [];
    let waitMs = 0;
    for (let attempt = 0; ; attempt++) {
      const t = performance.now();
      const result = await attemptOnce(url, body);
      attempts.push({
        attempt,
        type: result instanceof Error ? "network" : `http${result.status}`,
        ms: Math.round(performance.now() - t),
      });
      if (result instanceof Error) {
        const entry = retry?.network;
        if (entry && attempt < entry.attempts) {
          await sleep(entry.delayMs);
          waitMs += entry.delayMs;
          continue;
        }
        result._t = {
          attempts,
          waitMs,
          totalMs: Math.round(performance.now() - t0),
        };
        throw result;
      }
      const entry = retry?.[result.status];
      if (entry && attempt < entry.attempts) {
        await sleep(entry.delayMs);
        waitMs += entry.delayMs;
        continue;
      }
      result._t = {
        attempts,
        waitMs,
        totalMs: Math.round(performance.now() - t0),
      };
      return result;
    }
  }

  async function attemptOnce(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() =>
      controller.abort(new Error(`upstream timed out after ${connectTimeoutMs}ms`)),
      connectTimeoutMs
    );
    try {
      let reqUrl = url;
      let headers = buildHeaders(body);
      // 插件 hook：upstream:headers — 返回 { headers } 可替换请求头
      const hh = await applyHook("upstream:headers", { url, body, headers });
      if (hh?.changed && hh.value?.headers) headers = hh.value.headers;
      // 插件 hook：upstream:before-request — 返回 { url, headers } 可改目标地址/头（上游不限于 opencode）
      const br = await applyHook("upstream:before-request", { url, method: "POST", body, headers });
      if (br?.changed && br.value) {
        if (typeof br.value.url === "string" && br.value.url) reqUrl = br.value.url;
        if (br.value.headers && typeof br.value.headers === "object") headers = br.value.headers;
      }
      const opts = {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(reqUrl, opts);
      return res;
    } catch (err) {
      return err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function preheat() {
    if (isPreheatDisabled()) return { ok: false, skipped: true, reason: "disabled" };
    const url = `${baseUrl}/zen/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("preheat timed out after 3000ms")), 3000);
    const t0 = performance.now();
    try {
      const headers = buildHeaders({ stream: false });
      const opts = {
        method: "GET",
        headers,
        signal: controller.signal,
      };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetchImpl(url, opts);
      const ms = Math.round(performance.now() - t0);
      // 消耗 body 以释放连接回池（即使不需要内容）
      try { if (res.body) await res.text().catch(() => {}); } catch {}
      return { ok: res.ok, status: res.status, ms };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), ms: Math.round(performance.now() - t0) };
    } finally {
      clearTimeout(timer);
    }
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (agent && typeof agent.close === "function") {
      try { await agent.close(); } catch {}
    } else if (dispatcher && typeof dispatcher.close === "function" && dispatcher !== agent) {
      try { await dispatcher.close(); } catch {}
    }
  }

  // 兼容旧调用：headers 为动态生成，暴露 getter 快照（用于测试/展示）
  const headers = buildHeaders({});
  return { chat, preheat, close, headers, buildHeaders, dispatcher, agent, [Symbol.asyncDispose]: close };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}