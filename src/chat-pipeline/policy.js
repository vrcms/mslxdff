import { normalizeModel } from "../reasoning.js";
import { isAutoModel } from "../auto.js";
import { parseHops } from "../routes/helpers.js";
import { parseShareKeysHeader, SHARE_KEYS_HEADER } from "../providers/share-keys.js";
import { normalizeFullId, getModelAlias } from "../providers/model-id.js";

/**
 * PolicyStage 纯函数 — 解析 model 别名 / 白名单前置 / header 透传
 * 零网络副作用，输入 headers+body，输出 PolicyResult
 */
export function analyzePolicy({ headers = {}, body = {} } = {}) {
  const hops = parseHops(headers["x-mslxdff-hops"] || headers["X-Mslxdff-Hops"] || "");
  const shareKeys = parseShareKeysHeader(headers[SHARE_KEYS_HEADER] || headers["x-mslxdff-share-keys"] || "");
  const workbuddyUid = (headers["x-mslxdff-workbuddy-uid"] || headers["x-workbuddy-uid"] || "").toString().trim();
  const lockModel = (headers["x-mslxdff-model-lock"] || headers["X-Mslxdff-Model-Lock"] || "").toString();
  const rawModel = body.model || "";

  let normalizedRequested = normalizeModel(lockModel || rawModel || "");
  const aliasResolved = getModelAlias(normalizedRequested);
  if (aliasResolved) {
    normalizedRequested = aliasResolved;
  }
  let requested = normalizedRequested;
  let aliasInfo = null;

  if (requested.startsWith("mslxdff/")) {
    const rawPart = requested.slice("mslxdff/".length);
    aliasInfo = `${requested} -> ${rawPart} (mslxdff provider stripped)`;
    requested = rawPart;
    const alias2 = getModelAlias(requested);
    if (alias2) {
      aliasInfo = `${rawModel} -> ${alias2} (mslxdff + alias)`;
      requested = alias2;
    }
  } else if (aliasResolved) {
    // 非 mslxdff 的 dash 形态已在首轮 aliasResolved 处理
    aliasInfo = aliasResolved !== (lockModel || rawModel) ? `${rawModel} -> ${aliasResolved} (alias)` : null;
    if (!aliasInfo) aliasInfo = null;
  }

  // workbuddy <uid>:model 形式的 uid 钉死在 normalizeFullId 侧处理，这里透传原始 requested 供 planner 二次剥离
  // 若 requested 含 workbuddy/ 前缀且含 :，则尝试提取 uid
  let extractedUid = workbuddyUid;
  if (!extractedUid && requested.startsWith("workbuddy/") && requested.includes(":")) {
    const after = requested.slice("workbuddy/".length);
    const uidPart = after.split(":")[0];
    if (uidPart) extractedUid = uidPart;
  }

  const useAuto = isAutoModel(requested);

  // 对 workbuddy 前缀的 model，做 normalizeFullId 归一（剥 uid 供上游）
  // 但保留 requested 为完整带前缀形态，供 planner 做 ViaRoute 判定
  let normalizedForUpstream = requested;
  try {
    const norm = normalizeFullId(requested);
    if (norm && norm.raw) normalizedForUpstream = norm.raw ? `${norm.provider ? norm.provider + "/" : ""}${norm.raw}` : requested;
  } catch {}

  return {
    rawModel,
    requested,
    normalizedRequested,
    normalizedForUpstream,
    aliasInfo,
    useAuto,
    shareKeys,
    workbuddyUid: extractedUid,
    lockModel,
    hops,
    bodyModel: body.model || null,
  };
}
