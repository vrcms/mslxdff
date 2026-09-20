// ADR-0019：借道 = 用你的 key —— 转发时自动借出，无开关、无白名单（组内互信是前提）。
// header: `x-mslxdff-share-keys: <providerId>=<key1>,<key2>;<providerId2>=<key3>`
import { splitModelId, DEFAULT_PROVIDER } from "./model-id.js";
import { classifyProvider } from "./classify.js";
import { loadProviderKeys, listProviderIdsWithKeys } from "../state.js";
import { isRefreshToken } from "./cline/headers.js";

export const SHARE_KEYS_HEADER = "x-mslxdff-share-keys";

// 硬排除：refresh-token 型凭据（对端刷新会轮换 token，与本机互相踢下线）——正确性问题。
// 二层保护：① 按 id 硬排除（cline 恒 local-only）；② 按凭据形状兜底（见 shareableProviderIds）。
const NEVER_SHARE_IDS = new Set(["cline", "codearts"]);

// 本节点应 cast key 到出站转发的供应商 id 集合 = 所有「本机有 key」的供应商，
// 减去：opencode（无 key 且恒排除）、local-only（workbuddy/cline系，本就不走组员）、刷新型凭据。
export function shareableProviderIds({ file } = {}) {
  const ids = [];
  for (const id of listProviderIdsWithKeys({ file })) {
    if (id === DEFAULT_PROVIDER) continue;
    if (NEVER_SHARE_IDS.has(id)) continue;
    try { if (classifyProvider(id) === "local-only") continue; } catch {}
    // 形状兜底：id 白名单可能有残留（迁移未跑/回滚/手改 config），只要该供应商现有 key 里
    // 有一个是 refreshToken 形态，就一律不外借——refreshToken 借出去会被对端刷新轮换，双向踢下线。
    try { if (loadProviderKeys(id, { file }).some((k) => isRefreshToken(k, id))) continue; } catch {}
    ids.push(id);
  }
  return ids;
}

// 组装 share header 值（只含 shareable 且当前请求命中前缀的供应商）。
// splitModelId 用 shareableProviderIds() 作为已知集合：命中 → 该供应商在此节点 shareable；
// 未命中或裸 id（默认供应商 opencode）→ 不附带。返回 null 表示本请求不需要附带。
export function buildShareKeysHeader(model, { file } = {}) {
  const split = splitModelId(model, shareableProviderIds({ file }));
  if (!split.provider || split.provider === DEFAULT_PROVIDER) return null;
  const keys = loadProviderKeys(split.provider, { file });
  if (!keys.length) return null;
  return `${split.provider}=${keys.join(",")}`;
}

// 组员侧：解析 share header 为 { providerId -> keys[] }
// 防御：默认供应商（opencode）即使出现在 header 一律忽略——它不该有共享 key。
export function parseShareKeysHeader(value) {
  const out = {};
  if (!value) return out;
  for (const seg of String(value).split(";")) {
    const [provider, keysPart] = seg.split("=");
    const id = String(provider || "").trim();
    if (!id || id === DEFAULT_PROVIDER || !keysPart) continue;
    const keys = String(keysPart).split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.length) out[id] = keys;
  }
  return out;
}