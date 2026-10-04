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
    id: "traework",
    match: (id, baseUrl) => id === "traework" || String(baseUrl).includes("trae"),
    load: () => import("./traework.js").then((m) => m.createTraeworkProvider),
  },
  {
    id: "cline",
    match: (id, baseUrl) => id === "cline" || String(baseUrl).includes("cline.bot"),
    load: () => import("./cline.js").then((m) => m.createClineProvider),
  },
  {
    id: "codearts",
    match: (id, baseUrl) => id === "codearts" || String(baseUrl).includes("myhuaweicloud.com"),
    load: () => import("./codearts.js").then((m) => m.createCodeartsProvider),
  },
  {
    id: "qoder",
    match: (id, baseUrl) => id === "qoder" || String(baseUrl).includes("qoder"),
    load: () => import("./qoder/index.js").then((m) => m.createQoderProvider),
  },
  {
    // ⚠ 必须排在 qwenwork 之前：qwenwork 的 match 用 `includes("qwenwork")`，
    // 而 "globalqwenwork" 与 "gateway.qwenwork.ai"/"globalqwenwork://native" 都含该子串，
    // 若后置会被 cn 条目抢先命中（first-match-wins），把国际站 token 打到 cn 网关。
    id: "globalqwenwork",
    match: (id, baseUrl) => id === "globalqwenwork" || String(baseUrl).includes("qwenwork.ai"),
    load: () => import("./globalqwenwork/index.js").then((m) => m.createGlobalQwenworkProvider),
  },
  {
    id: "qwenwork",
    match: (id, baseUrl) => id === "qwenwork" || String(baseUrl).includes("qwenwork"),
    load: () => import("./qwenwork/index.js").then((m) => m.createQwenworkProvider),
  },
  {
    id: "zcode",
    match: (id, baseUrl) => id === "zcode" || String(baseUrl).includes("zcode.z.ai"),
    load: () => import("./zcode/index.js").then((m) => m.createZcodeProvider),
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
