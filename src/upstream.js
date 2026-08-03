export function createUpstreamClient({
  baseUrl = process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
  authToken = process.env.UPSTREAM_AUTH_TOKEN || "public",
  connectTimeoutMs = Number(process.env.UPSTREAM_CONNECT_TIMEOUT_MS) || 30_000,
  retry = {
    429: { attempts: 2, delayMs: 2000 },
    502: { attempts: 2, delayMs: 2000 },
    503: { attempts: 2, delayMs: 2000 },
    504: { attempts: 2, delayMs: 3000 },
  },
  fetchImpl = fetch,
  log = null,
} = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`,
    "x-opencode-client": "desktop",
    "Accept": "text/event-stream",
  };

  async function chat(body) {
    const url = `${baseUrl}/zen/v1/chat/completions`;
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`upstream timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const entry = retry?.["network"];
        if (entry && attempt < entry.attempts) {
          attempt++;
          await delay(entry.delayMs);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      const entry = retry?.[response.status];
      if (entry && attempt < entry.attempts) {
        attempt++;
        await delay(entry.delayMs);
        continue;
      }
      return response;
    }
  }

  return { chat, headers };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}