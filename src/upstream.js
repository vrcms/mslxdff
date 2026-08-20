import crypto from "node:crypto";

function genId(prefix) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}

export function createUpstreamClient({
  baseUrl = process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
  authToken = process.env.UPSTREAM_AUTH_TOKEN || "public",
  connectTimeoutMs = Number(process.env.UPSTREAM_CONNECT_TIMEOUT_MS) || 30_000,
  retry = {
    network: { attempts: 2, delayMs: 1000 },
    429: { attempts: 1, delayMs: 500 },
    502: { attempts: 1, delayMs: 500 },
    503: { attempts: 1, delayMs: 500 },
    504: { attempts: 1, delayMs: 500 },
  },
  fetchImpl = fetch,
} = {}) {
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
      const headers = buildHeaders(body);
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return res;
    } catch (err) {
      return err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 兼容旧调用：headers 为动态生成，暴露 getter 快照（用于测试/展示）
  const headers = buildHeaders({});
  return { chat, headers, buildHeaders };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}