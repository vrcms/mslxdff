import { normalizeFullId, toFullId } from "./providers/model-id.js";

export { normalizeFullId, toFullId };

// 从上游 usage 或文本兜底算 tps / charsPerSec
export function computeMetrics({ ttfbMs, totalMs, promptTokens, completionTokens, chars }) {
  const ttfb = Number(ttfbMs);
  const total = Number(totalMs);
  const hasTtfb = Number.isFinite(ttfb) && ttfb >= 0;
  const hasTotal = Number.isFinite(total) && total >= 0;
  const completionMs = hasTtfb && hasTotal ? Math.max(0, total - ttfb) : hasTotal ? total : null;
  const comp = Number(completionTokens);
  const hasComp = Number.isFinite(comp) && comp > 0 && Number.isFinite(completionMs) && completionMs > 0;
  const tps = hasComp ? Number((comp / (completionMs / 1000)).toFixed(1)) : null;
  const c = Number(chars);
  const hasChars = Number.isFinite(c) && c > 0 && Number.isFinite(completionMs) && completionMs > 0;
  const charsPerSec = !hasComp && hasChars ? Math.round(c / (completionMs / 1000)) : null;
  return { completionMs, tps, charsPerSec };
}

// 从 Response 文本或 SSE 末帧提取 usage
export function extractUsageFromJson(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const u = parsed.usage;
  if (!u || typeof u !== "object") return null;
  const prompt = Number(u.prompt_tokens ?? u.promptTokens ?? u.input_tokens);
  const comp = Number(u.completion_tokens ?? u.completionTokens ?? u.output_tokens);
  const total = Number(u.total_tokens ?? u.totalTokens);
  const out = {};
  if (Number.isFinite(prompt)) out.prompt_tokens = prompt;
  if (Number.isFinite(comp)) out.completion_tokens = comp;
  if (Number.isFinite(total)) out.total_tokens = total;
  // reasoning_tokens 透传
  const rt = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens;
  if (Number.isFinite(Number(rt))) out.reasoning_tokens = Number(rt);
  return Object.keys(out).length ? out : null;
}

export function extractUsageFromSseText(sseText) {
  if (!sseText) return null;
  const lines = String(sseText).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      if (j.usage) return extractUsageFromJson(j);
      if (j.choices?.[0]?.finish_reason && j.usage) return extractUsageFromJson(j);
    } catch {}
  }
  return null;
}

// 归一模型全称：provider + raw -> opencode/xxx
export function resolveFullId(rawModel, providerHint) {
  const raw = String(rawModel || "").trim();
  if (!raw) return "";
  if (raw.includes("/")) return normalizeFullId(raw);
  const prov = String(providerHint || "opencode").trim() || "opencode";
  return toFullId(prov, raw);
}
