// ADR-0008：供应商 key 瞬时共享 —— 转发时附带、组员一次性借用，用完即弃。
// header: `x-mslxdff-share-keys: <providerId>=<key1>,<key2>;<providerId2>=<key3>`
import { splitModelId, DEFAULT_PROVIDER } from "./model-id.js";
import { loadProviderKeys, loadProviderShareKeys } from "../state.js";

export const SHARE_KEYS_HEADER = "x-mslxdff-share-keys";

// 本节点应 cast key 到出站转发的供应商 id 集合（开启 share 且配了 key 的）。
// share 只在"有 key 且开关为 true"时发生；否则不附带，避免空头泄露配置意图。
// 默认供应商（opencode）恒排除：它无 key 可共享（public 即可），限流以 IP 为主，
// 分散 IP 由 peer 转发天然实现，不需要也不应走 key 共享。
export function shareableProviderIds({ file } = {}) {
  const ids = new Set();
  const raw = process.env.MSLXDFF_SHARE_PROVIDERS || ""; // 高级：显式白名单，逗号分隔
  const explicit = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (explicit.length) {
    for (const id of explicit) {
      if (id === DEFAULT_PROVIDER) continue; // opencode 永远不可 share
      ids.add(id);
    }
    return [...ids];
  }
  for (const id of ["openrouter"]) {
    if (id !== DEFAULT_PROVIDER && loadProviderKeys(id, { file }).length && loadProviderShareKeys(id, { file })) ids.add(id);
  }
  return [...ids];
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