import { splitModelId, DEFAULT_PROVIDER, joinModelId } from "./model-id.js";

// 多供应商 dispatcher：把多个 Provider 聚合成一个 `upstream` 形状（chat/preheat/close），
// 按 body.model 的前缀路由到对应供应商，转发上游前剥掉前缀只发原始 id。
export function createProviderDispatcher(providers = []) {
  const byId = new Map(providers.map((p) => [p.id, p]));

  function resolve(model) {
    const split = splitModelId(model, providers.map((p) => p.id));
    return {
      provider: byId.get(split.provider) ?? byId.get(DEFAULT_PROVIDER) ?? providers[0],
      raw: split.raw,
      prefixed: split.prefixed,
    };
  }

  async function chat(body, opts = {}) {
    const { provider, raw } = resolve(body?.model);
    if (!provider) throw new Error(`no provider for model ${body?.model ?? "(empty)"}`);
    const forwarded = raw === body?.model ? body : { ...body, model: raw };
    // ADR-0008：本请求携带瞬时共享 key（shareKeys 由组员侧按 header 解析后传入）。
    // 命中时用共享 key 覆盖该供应商的 key 集合，组员无需配置自己的 key。
    const sharedKeys = opts?.shareKeys?.[provider.id];
    if (sharedKeys && sharedKeys.length && typeof provider.chatWithKeys === "function") {
      return provider.chatWithKeys(forwarded, sharedKeys);
    }
    return provider.chat(forwarded);
  }

  // 聚合所有供应商的模型列表；默认供应商（opencode）裸 id，其它带前缀
  async function listModels() {
    const out = [];
    const seen = new Set();
    for (const p of providers) {
      let list;
      try {
        list = (await p.listModels?.()) ?? [];
      } catch {
        list = [];
      }
      for (const m of list) {
        if (m && m.id && !seen.has(m.id)) {
          seen.add(m.id);
          out.push(m);
        }
      }
    }
    return out;
  }

  async function preheat() {
    const results = [];
    for (const p of providers) {
      if (typeof p.preheat !== "function") continue;
      try {
        results.push(await p.preheat());
      } catch {
        results.push({ ok: false, error: "preheat failed" });
      }
    }
    return results.length ? results[0] : { ok: false, skipped: true };
  }

  async function close() {
    for (const p of providers) {
      try { await p.close?.(); } catch {}
    }
  }

  return { providers, byId, resolve, listModels, chat, preheat, close, joinModelId };
}