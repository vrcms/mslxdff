import { compatFetch } from "./compat.js";
const V2EX_LATEST = "https://www.v2ex.com/api/topics/latest.json";
const V2EX_HOT = "https://www.v2ex.com/api/topics/hot.json";

const INCLUDE_RE = /(白嫖|限免|免费额度|注册送|注册即送|羊毛|薅羊毛|免费\s*API|free\s*tier)/i;
const EXCLUDE_RE = /(代充|代购|倍率|0\.16|0\.1|0\.2|闲鱼|手续费|求职|物业|期望薪资)/i;

function isHit(title) {
  const t = String(title || "");
  if (!INCLUDE_RE.test(t)) return false;
  if (EXCLUDE_RE.test(t)) return false;
  return true;
}

async function fetchJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await compatFetch(url, {
      headers: { "User-Agent": "mslxdff/free-watcher", Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchV2exFree({ timeoutMs = 6000 } = {}) {
  const [latest, hot] = await Promise.all([
    fetchJson(V2EX_LATEST, timeoutMs).catch(() => []),
    fetchJson(V2EX_HOT, timeoutMs).catch(() => []),
  ]);
  const all = [...(Array.isArray(latest) ? latest : []), ...(Array.isArray(hot) ? hot : [])];
  const seen = new Set();
  const hits = [];
  for (const item of all) {
    const id = item?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = item?.title || "";
    if (!isHit(title)) continue;
    hits.push({
      id,
      title,
      url: `https://www.v2ex.com/t/${id}`,
      node: item?.node?.title || item?.node?.name || "",
      replies: item?.replies ?? 0,
      created: item?.created || 0,
      member: item?.member?.username || "",
    });
  }
  hits.sort((a, b) => (b.created || 0) - (a.created || 0));
  return hits;
}

export function formatHits(hits) {
  if (!hits.length) return "暂无命中（关键词：白嫖|限免|免费额度|注册送|羊毛）";
  return hits.map((h) => `- ${h.title} | ${h.url} | ${h.node} ${h.replies}回复`).join("\n");
}

export { INCLUDE_RE, EXCLUDE_RE, isHit };
