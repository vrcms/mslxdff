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
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`,
    "x-opencode-client": "desktop",
    "Accept": "text/event-stream",
  };

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

  return { chat, headers };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}