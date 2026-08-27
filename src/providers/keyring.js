// 多 key 轮转器：round-robin 取键 + 出错冷却隔离。
// 语义：某个 key 出错后 cooldownMs 内不再使用；全部 key 都在冷却 → next() 返回 null
// （调用方应视为该供应商暂时失效，直接报错而非降级为单 key）。
export const DEFAULT_COOLDOWN_MS = 30_000;

export function createKeyRing(keys = [], { cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now } = {}) {
  const list = [...new Set(keys.filter((k) => typeof k === "string" && k.trim().length))];
  const errAt = new Map();
  let cursor = 0;

  function isCooling(key) {
    const t = errAt.get(key);
    return t != null && now() - t < cooldownMs;
  }

  function next() {
    if (!list.length) return null;
    for (let i = 0; i < list.length; i++) {
      const idx = (cursor + i) % list.length;
      const key = list[idx];
      if (!isCooling(key)) {
        cursor = (idx + 1) % list.length;
        return key;
      }
    }
    return null;
  }

  function onError(key) {
    if (list.includes(key)) errAt.set(key, now());
  }

  function available() {
    return list.filter((k) => !isCooling(k)).length;
  }

  return { next, onError, available, size: list.length, cooldownMs, keys: [...list] };
}