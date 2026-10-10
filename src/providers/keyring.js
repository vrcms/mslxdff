// 多 key 轮转器：round-robin 取键 + 出错冷却隔离。
// 语义：某个 key 出错后 cooldownMs 内不再使用；全部 key 都在冷却 → next() 返回 null
// （调用方应视为该供应商暂时失效，直接报错而非降级为单 key）。
export const DEFAULT_COOLDOWN_MS = 30_000;

export function createKeyRing(keys = [], { cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now } = {}) {
  const list = [...new Set(keys.filter((k) => typeof k === "string" && k.trim().length))];
  const errAt = new Map();
  let cursor = 0;

  // errAt 存「冷却到期时间戳」：onError(key, durationMs?) 可自定义时长（额度错长冷却用），
  // 缺省用构造时的 cooldownMs —— 旧的 onError(key) 调用方行为不变。
  function isCooling(key) {
    const e = errAt.get(key);
    return e != null && now() < e;
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

  function onError(key, durationMs) {
    if (!list.includes(key)) return;
    const dur = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : cooldownMs;
    errAt.set(key, now() + dur);
  }

  function replace(oldKey, newKey) {
    const idx = list.indexOf(oldKey);
    if (idx < 0) {
      if (newKey && !list.includes(newKey)) list.push(newKey);
      return false;
    }
    if (newKey && oldKey !== newKey) {
      list[idx] = newKey;
      // 迁移冷却状态：旧 key 的冷却移到新 key，避免新 token 立即被误判可用
      if (errAt.has(oldKey)) {
        const t = errAt.get(oldKey);
        errAt.delete(oldKey);
        // 新 token 刚刷新，不应继承旧冷却，直接清掉
      }
    }
    return true;
  }

  function available() {
    return list.filter((k) => !isCooling(k)).length;
  }

  // isCooling 对外暴露：粘号选择器要判断"上次这个号还在冷却吗"（决定是否必须换号）
  return { next, onError, replace, available, isCooling, cooldownMs, get size() { return list.length; }, get keys() { return [...list]; } }; // ⚠ size/keys 必须是 getter：replace() 换号后构造期快照会停在已废弃的旧 token
}