/**
 * 冷却深模块：对 state 的 10min 冷却 + EMA 延迟做唯一封装
 * 注入化便于单测（内存 Map + now）
 */

export function createCooling({
  loadModelErrors,
  saveModelErrors,
  loadModelLatencies,
  saveModelLatencies,
  flush,
  now = () => Date.now(),
  cooldownMs = 10 * 60 * 1000,
  slowCooldownMs = 10 * 60 * 1000,
} = {}) {
  const _loadErrors = loadModelErrors || (() => ({}));
  const _saveErrors = saveModelErrors || (() => {});
  const _loadLats = loadModelLatencies || (() => ({}));
  const _saveLats = saveModelLatencies || (() => {});
  const _flush = flush || (() => {});

  async function isCooling(id) {
    try {
      const errors = _loadErrors() || {};
      const e = errors[id];
      if (!e || typeof e !== "object") return false;
      const at = Number(e.at || 0);
      if (!at) return false;
      const isSlow = !!e.slow;
      const cd = isSlow ? slowCooldownMs : cooldownMs;
      return now() - at < cd && (e.status === "limit" || e.status === "error");
    } catch {
      return false;
    }
  }

  async function recordError(id, status, { slow = false, latencyMs = 0 } = {}) {
    try {
      const errors = _loadErrors() || {};
      const isLimit = Number(status) === 429 || String(status).includes("429");
      const entryStatus = isLimit ? "limit" : "error";
      errors[id] = { status: entryStatus, at: now(), code: Number.isInteger(Number(status)) ? Number(status) : null, slow: !!slow };
      _saveErrors(errors);
      try { _flush(); } catch {}
      if (slow && Number.isFinite(latencyMs) && latencyMs > 0) {
        try {
          const lat = _loadLats() || {};
          const prev = lat[id]?.emaMs;
          const ema = prev ? Math.round(prev * 0.7 + latencyMs * 0.3) : Math.round(latencyMs);
          lat[id] = { emaMs: ema, lastMs: Math.round(latencyMs), at: now(), count: (lat[id]?.count ?? 0) + 1 };
          _saveLats(lat);
          try { _flush(); } catch {}
        } catch {}
      }
    } catch {}
  }

  async function recordOk(id, latencyMs) {
    try {
      const errors = _loadErrors() || {};
      errors[id] = { status: "normal", at: now(), code: 200, slow: false };
      _saveErrors(errors);
      try { _flush(); } catch {}
      if (Number.isFinite(latencyMs) && latencyMs > 0) {
        const lat = _loadLats() || {};
        const prev = lat[id]?.emaMs;
        const ema = prev ? Math.round(prev * 0.7 + latencyMs * 0.3) : Math.round(latencyMs);
        lat[id] = { emaMs: ema, lastMs: Math.round(latencyMs), at: now(), count: (lat[id]?.count ?? 0) + 1 };
        _saveLats(lat);
        try { _flush(); } catch {}
      }
    } catch {}
  }

  // 兼容旧命名
  const recordChatError = recordError;
  const recordChatOk = recordOk;
  const isCoolingAsync = isCooling;

  return { isCooling, isCoolingAsync, recordError, recordChatError, recordOk, recordChatOk };
}

// 默认实例（对接真实 state.js）
let _default = null;
export function getDefaultCooling() {
  if (_default) return _default;
  // 懒加载 state，避免循环
  _default = createCooling({
    loadModelErrors: () => {
      try { const s = require("../state.js"); return s.loadModelErrors(); } catch { return {}; }
    },
    saveModelErrors: (o) => { try { const s = require("../state.js"); s.saveModelErrors(o); } catch {} },
    loadModelLatencies: () => { try { const s = require("../state.js"); return s.loadModelLatencies(); } catch { return {}; } },
    saveModelLatencies: (o) => { try { const s = require("../state.js"); s.saveModelLatencies(o); } catch {} },
    flush: () => { try { const s = require("../state.js"); s.flushStateSync(); } catch {} },
    now: () => Date.now(),
  });
  return _default;
}
