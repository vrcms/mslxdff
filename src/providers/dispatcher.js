import { splitModelId, DEFAULT_PROVIDER, joinModelId } from "./model-id.js";
import { isModelAllowed, loadProviderAllowedModels } from "../state.js";

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
    if (!isModelAllowed(provider.id, raw)) {
      const allowed = loadProviderAllowedModels(provider.id);
      const msg = `model not allowed for provider "${provider.id}": "${raw}" — allowed: ${allowed.join(", ") || "(none)"} (use: mslxdff -provider ${provider.id} allowlist add <model>)`;
      return new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json", "x-mslxdff-allowlist": "1" } });
    }
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
  // 若某供应商设置了 allowlist（非空），则仅暴露白名单内的模型（按 raw id 匹配）
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
      const allowed = loadProviderAllowedModels(p.id);
      const allowedSet = allowed.length ? new Set(allowed) : null;
      for (const m of list) {
        if (!m || !m.id) continue;
        if (seen.has(m.id)) continue;
        if (allowedSet) {
          // m.id 已是带前缀的对外 id，需剥回 raw 再比对
          const { raw } = splitModelId(m.id, providers.map((x) => x.id));
          const rawNorm = String(raw || "").trim();
          if (!allowedSet.has(rawNorm)) continue;
          // 对于 opencode 裸 id，rawNorm 即 m.id 本身
        }
        seen.add(m.id);
        out.push(m);
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