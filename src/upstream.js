export function createUpstreamClient({
  baseUrl = process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
  authToken = process.env.UPSTREAM_AUTH_TOKEN || "public",
  connectTimeoutMs = Number(process.env.UPSTREAM_CONNECT_TIMEOUT_MS) || 30_000,
  retry = {
    network: { attempts: 2, delayMs: 1000 },
    429: { attempts: 2, delayMs: 2000 },
    502: { attempts: 2, delayMs: 2000 },
    503: { attempts: 2, delayMs: 2000 },
    504: { attempts: 2, delayMs: 3000 },
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
    for (let attempt = 0; ; attempt++) {
      const result = await attemptOnce(url, body);
      if (result instanceof Error) {
        const entry = retry?.network;
        if (entry && attempt < entry.attempts) {
          await sleep(entry.delayMs);
          continue;
        }
        throw result;
      }
      const entry = retry?.[result.status];
      if (entry && attempt < entry.attempts) {
        await sleep(entry.delayMs);
        continue;
      }
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