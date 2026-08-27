// 模型 ID 前缀解析：`<provider>/<rawId>`。默认供应商（opencode）保持裸 id（向后兼容），
// 其它供应商必须带前缀，请求按前缀路由到对应上游通道。

export const DEFAULT_PROVIDER = "opencode";

const ALIASES = { oc: "opencode", opencode: "opencode" };

export function normalizeProviderId(p) {
  const id = String(p || "").trim();
  return ALIASES[id] || id;
}

// 把（可能带前缀的）模型 id 拆成 { provider, raw, prefixed }
// - 无前缀（含默认供应商裸 id）→ provider = DEFAULT_PROVIDER
// - 前缀是已知供应商 → 对应路由；开头的 `oc/` 视为 opencode 别名
export function splitModelId(id, knownProviders = []) {
  const s = String(id || "");
  if (!s) return { provider: DEFAULT_PROVIDER, raw: s, prefixed: false };
  const idx = s.indexOf("/");
  if (idx > 0) {
    const head = normalizeProviderId(s.slice(0, idx));
    const known = new Set([DEFAULT_PROVIDER, ...knownProviders]);
    if (known.has(head)) {
      return { provider: head, raw: s.slice(idx + 1), prefixed: true };
    }
  }
  return { provider: DEFAULT_PROVIDER, raw: s, prefixed: false };
}

// 生成对外暴露的模型 id：默认供应商裸 id（向后兼容），其它供应商带前缀
export function joinModelId(provider, raw, { force = false } = {}) {
  provider = normalizeProviderId(provider || "");
  raw = String(raw || "");
  if (provider === DEFAULT_PROVIDER && !force) return raw;
  return `${provider}/${raw}`;
}