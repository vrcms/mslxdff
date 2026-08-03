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

async function fetchUpstreamModels({ baseUrl, headers }) {
  const res = await fetch(`${baseUrl}/zen/v1/models`, { headers });
  if (!res.ok) throw new Error(`models fetch failed: HTTP ${res.status}`);
  const json = await res.json().catch(() => ({}));
  const raw = Array.isArray(json) ? json : json.data ?? json.models ?? [];
  const free = filterFreeModels(raw);
  return {
    object: "list",
    data: free,
  };
}