import { createHash } from "node:crypto";

/**
 * 请求去重（防前端双击/重试风暴）
 * key = ip | requested | stream | bodyHash(messages+model变体)
 * 窗口内重复到达的相同请求直接 429 返回，提示前端去重
 * 默认窗口 1000ms，可用 MSLXDFF_DEDUP_WINDOW_MS 覆盖，0 为关闭
 */
export function dedupWindowMs() {
  const raw = process.env.MSLXDFF_DEDUP_WINDOW_MS;
  if (raw != null && String(raw).trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 1000;
}

function hashBody(body) {
  try {
    const m = body?.messages;
    const s = JSON.stringify({
      model: body?.model || "",
      stream: Boolean(body?.stream),
      max_tokens: body?.max_tokens ?? body?.maxTokens ?? null,
      messages: Array.isArray(m) ? m.map((x) => ({ role: x.role, content: typeof x.content === "string" ? x.content.slice(0, 4000) : JSON.stringify(x.content).slice(0, 4000) })) : [],
      // 工具调用等也纳入，避免误判
      tools: body?.tools ? JSON.stringify(body.tools).slice(0, 1000) : "",
    });
    return createHash("sha1").update(s).digest("hex").slice(0, 16);
  } catch {
    return String(body?.model || "").slice(0, 32);
  }
}

let _global = null;
export function globalDedup() {
  if (!_global) _global = createDedup({ windowMs: dedupWindowMs() });
  // 若环境变量在运行时被改，同步窗口
  const want = dedupWindowMs();
  if (_global.windowMs !== want) {
    _global.windowMs = want;
  }
  return _global;
}
export function _resetGlobalDedup() { _global = null; }

export function createDedup({ windowMs = dedupWindowMs(), now = Date.now } = {}) {
  const map = new Map(); // key -> at
  let sweepAt = 0;

  function sweep() {
    const t = now();
    if (t - sweepAt < windowMs) return;
    sweepAt = t;
    for (const [k, at] of map) {
      if (t - at > windowMs) map.delete(k);
    }
  }

  function keyFor({ ip, requested, body }) {
    const h = hashBody(body);
    const stream = body?.stream ? "1" : "0";
    return `${ip || "-"}|${requested || "-"}|${stream}|${h}`;
  }

  function check({ ip, requested, body }) {
    if (!windowMs) return { dup: false, key: null };
    sweep();
    const key = keyFor({ ip, requested, body });
    const at = map.get(key);
    const t = now();
    if (at != null && t - at < windowMs) {
      return { dup: true, key, ageMs: t - at };
    }
    map.set(key, t);
    return { dup: false, key };
  }

  function _size() { return map.size; }
  function _clear() { map.clear(); }

  return { check, keyFor, _size, _clear, windowMs };
}
