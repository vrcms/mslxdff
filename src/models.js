const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];
const CACHE_TTL_MS = 10 * 60 * 1000;

export function isFreeModel(id) {
  return (typeof id === "string" && id.endsWith("-free")) ||
    KNOWN_FREE_OPENCODE_MODELS.includes(id);
}

export function filterFreeModels(list) {
  const seen = new Set();
  const out = [];
  for (const m of list || []) {
    if (!(m && m.id)) continue;
    if (!isFreeModel(m.id)) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export function createModelsService({ baseUrl, headers, ttlMs = CACHE_TTL_MS } = {}) {
  let cache = null;
  let fetchedAt = 0;
  let inflight = null;

  async function get() {
    const now = Date.now();
    if (cache && now - fetchedAt < ttlMs) return cache;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const data = await fetchUpstreamModels({ baseUrl, headers });
        cache = data;
        fetchedAt = Date.now();
        return data;
      } catch (err) {
        // serve stale on failure if we have it, else rethrow
        if (cache) return cache;
        throw err;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return { get };
}

async function fetchUpstreamModels({ baseUrl, headers, connectTimeoutMs = 30_000 }) {
  const url = `${baseUrl}/zen/v1/models`;
  for (let attempt = 0; ; attempt++) {
    const res = await attemptFetch(url, headers, connectTimeoutMs);
    if (res instanceof Error) {
      if (attempt < NETWORK_RETRIES) continue;
      throw res;
    }
    if (isRetryable(res.status) && attempt < STATUS_RETRIES) {
      await sleep(2000);
      continue;
    }
    if (!res.ok) throw new Error(`models fetch failed: HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    const raw = Array.isArray(json) ? json : json.data ?? json.models ?? [];
    return { object: "list", data: filterFreeModels(raw) };
  }
}

async function attemptFetch(url, headers, connectTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    return err;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const NETWORK_RETRIES = 2;
const STATUS_RETRIES = 2;