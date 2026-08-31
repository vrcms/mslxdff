/**
 * 可扩展供应商注册表：新增特殊供应商时，仅在此文件注册 + 新增对应 provider 文件即可
 * 每个条目：{ id, match(id, baseUrl) => bool, load() => Promise<factory> }
 * 匹配优先级：按数组顺序，首个命中即用；未命中走通用 generic
 */

export const customProviders = [
  {
    id: "workbuddy",
    match: (id, baseUrl) => id === "workbuddy" || String(baseUrl).includes("copilot.tencent"),
    load: () => import("./workbuddy.js").then((m) => m.createWorkbuddyProvider),
  },
  {
    id: "cline",
    match: (id, baseUrl) => id === "cline" || id === "clinebot" || String(baseUrl).includes("cline.bot"),
    load: () => import("./cline.js").then((m) => m.createClineProvider),
  },
];

// 供 bench/probe 等需要定制化解析模型列表的场景
export const customNormalizers = [
  {
    id: "cline",
    match: (baseUrl) => String(baseUrl).includes("cline.bot"),
    normalize: (json) => Array.isArray(json?.free) ? json.free : null,
  },
];

export async function getCustomProviderFactory(id, baseUrl) {
  for (const entry of customProviders) {
    try { if (entry.match(id, baseUrl)) return await entry.load(); } catch {}
  }
  return null;
}

export function getCustomNormalizer(baseUrl) {
  for (const entry of customNormalizers) {
    try { if (entry.match(baseUrl)) return entry.normalize; } catch {}
  }
  return null;
}
