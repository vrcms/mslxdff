function fallbackReason(lastErr) {
  if (!lastErr) return "cooldown";
  const s = Number(lastErr.status);
  if (s === 429) return "rate_limited";
  if (lastErr.message && /timeout/i.test(String(lastErr.message))) return "timeout";
  if (s === 502 || s === 503 || s === 504) return "upstream_error";
  if (s >= 400) return "upstream_error";
  return "fallback";
}

export function buildFallbackInfo({ requested, actual, lastErr, via, useAuto, lockModel }) {
  if (!requested || !actual) return null;
  const alwaysHeaders = {
    requested_model: requested,
    actual_model: actual,
    via: via || "local",
  };
  if (useAuto || lockModel) {
    return { ...alwaysHeaders, fallback: false, reason: null, notice: null };
  }
  const isFallback = requested !== actual;
  if (!isFallback) {
    return { ...alwaysHeaders, fallback: false, reason: null, notice: null };
  }
  const reason = fallbackReason(lastErr);
  const reasonZh = reason === "rate_limited" ? "限流" : reason === "timeout" ? "超时" : reason === "cooldown" ? "冷却中" : "不可用";
  const notice = `${requested} ${reasonZh}，已由 ${actual} 代答`;
  return { ...alwaysHeaders, fallback: true, reason, notice };
}

export function applyFallbackHeaders(res, info) {
  if (!info) return;
  if (info.requested_model) res.setHeader("x-mslxdff-requested-model", info.requested_model);
  if (info.actual_model) res.setHeader("x-mslxdff-actual-model", info.actual_model);
  if (info.via) res.setHeader("x-mslxdff-via", info.via);
  if (info.fallback) {
    res.setHeader("x-mslxdff-fallback", "1");
    if (info.reason) res.setHeader("x-mslxdff-fallback-reason", info.reason);
    if (info.notice) res.setHeader("x-mslxdff-notice", encodeURIComponent(info.notice));
  }
}

export function enrichNonStreamJson(obj, info) {
  if (!info || typeof obj !== "object" || obj === null) return obj;
  if (!info.fallback) return obj;
  if (obj.mslxdff) return obj;
  return {
    ...obj,
    mslxdff: {
      fallback: true,
      requested_model: info.requested_model,
      actual_model: info.actual_model,
      reason: info.reason,
      via: info.via,
      notice: info.notice,
    },
  };
}

export function enrichSseChunkText(text, info) {
  if (!info?.fallback) return text;
  const lines = text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^data:\s*(\{.*\})\s*$/.exec(line);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj === "object" && !obj.mslxdff) {
        obj.mslxdff = {
          fallback: true,
          requested_model: info.requested_model,
          actual_model: info.actual_model,
          reason: info.reason,
          via: info.via,
          notice: info.notice,
        };
        lines[i] = `data: ${JSON.stringify(obj)}`;
        changed = true;
        break;
      }
    } catch {
      continue;
    }
  }
  return changed ? lines.join("\n") : text;
}
