import { appendEvent } from "../logs.js";
import { splitModelId, DEFAULT_PROVIDER, joinModelId } from "./model-id.js";
import { isModelAllowed as stateIsAllowed, loadProviderAllowedModels as stateLoadAllowed, loadProviderAllowAnyModels as stateLoadAllowAny } from "../state.js";

// 多供应商 dispatcher：把多个 Provider 聚合成一个 `upstream` 形状（chat/preheat/close），
// 按 body.model 的前缀路由到对应供应商，转发上游前剥掉前缀只发原始 id。
// 纯化：第二参可注入纯函数 isAllowed/getAllowed/getAllowAny，便于单测不读盘
export function createProviderDispatcher(providers = [], opts = {}) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  // 纯化注入：第二参可为 {isAllowed, getAllowedModels, getAllowAny} 或直接函数 isAllowed
  let isAllowedFn, getAllowedFn, getAllowAnyFn;
  if (typeof opts === "function") {
    isAllowedFn = opts;
    getAllowedFn = stateLoadAllowed;
    getAllowAnyFn = stateLoadAllowAny;
  } else {
    isAllowedFn = opts.isAllowed || stateIsAllowed;
    getAllowedFn = opts.getAllowedModels || stateLoadAllowed;
    getAllowAnyFn = opts.getAllowAny || stateLoadAllowAny;
  }

  function resolve(model) {
    const split = splitModelId(model, providers.map((p) => p.id));
    return {
      provider: byId.get(split.provider) ?? byId.get(DEFAULT_PROVIDER) ?? providers[0],
      raw: split.raw,
      prefixed: split.prefixed,
    };
  }

  async function chat(body, opts = {}) {
    let { provider, raw } = resolve(body?.model);
    if (!provider) throw new Error(`no provider for model ${body?.model ?? "(empty)"}`);
    let workbuddyUid = opts?.workbuddyUid ? String(opts.workbuddyUid).trim() : "";
    // model 前缀钉死：workbuddy/<uid>:<rawId>  -> 剥 uid，rawId 为真实模型
    if (provider.id === "workbuddy" && typeof raw === "string" && raw.includes(":")) {
      const idx = raw.indexOf(":");
      const uidPart = raw.slice(0, idx).trim();
      const modelPart = raw.slice(idx + 1).trim();
      if (uidPart && modelPart) {
        if (!workbuddyUid) workbuddyUid = uidPart;
        raw = modelPart;
      }
    }
    if (!isAllowedFn(provider.id, raw)) {
      const allowed = getAllowedFn(provider.id) || [];
      const msg = `model not allowed for provider "${provider.id}": "${raw}" — allowed: ${allowed.join(", ") || "(none)"} (use: mslxdff -provider ${provider.id} allowlist add <model>)`;
      appendEvent({ type: "provider-model-state", provider: provider.id, model: body?.model, rawModel: raw, state: "blocked", reason: "allowlist", status: 403 });
      return new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json", "x-mslxdff-allowlist": "1" } });
    }
    const forwarded = raw === body?.model ? body : { ...body, model: raw };
    // ADR-0008：本请求携带瞬时共享 key（shareKeys 由组员侧按 header 解析后传入）。
    const sharedKeys = opts?.shareKeys?.[provider.id];
    const startedAt = Date.now();
    let res;
    try {
      if (sharedKeys && sharedKeys.length && typeof provider.chatWithKeys === "function") {
        res = await provider.chatWithKeys(forwarded, sharedKeys, opts);
      } else if (provider.id === "workbuddy" && workbuddyUid) {
        res = await provider.chat(forwarded, { ...opts, workbuddyUid });
      } else {
        res = await provider.chat(forwarded, opts);
      }
    } catch (err) {
      appendEvent({ type: "provider-model-state", provider: provider.id, model: body?.model, rawModel: raw, state: "upstream-error", error: String(err?.message || err), durationMs: Date.now() - startedAt });
      throw err;
    }
    appendEvent({
      type: "provider-model-state",
      provider: provider.id,
      model: body?.model,
      rawModel: raw,
      status: res?.status,
      state: res?.status === 429 ? "limited" : res?.ok ? "ok" : "upstream-error",
      durationMs: Date.now() - startedAt,
    });
    return res;
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
      const allowed = getAllowedFn(p.id) || [];
      const allowAny = getAllowAnyFn(p.id);
      const allowedSet = allowed.length ? new Set(allowed) : null;
      // 空名单且不允许任意模型 => 该供应商不暴露任何模型（安全默认）
      if (!allowedSet && !allowAny) continue;
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

  // 只预热默认供应商（opencode）：连接池与模型缓存预热是其主链路收益；
  // 其他供应商按需在首次请求时自拉（10min 缓存）。不再逐家预热，避免 daemon 每次启动
  // 对所有上游各发一次 GET；MSLXDFF_PREHEAT=0 的关闭由唯一被调的 opencode preheat 自行尊重。
  // 见 .agents/notes/implemented/simplification/2026-09-16-preheat-opencode-only.md
  async function preheat() {
    const p = byId.get(DEFAULT_PROVIDER);
    if (!p || typeof p.preheat !== "function") return { ok: false, skipped: true };
    try {
      return await p.preheat();
    } catch {
      return { ok: false, error: "preheat failed" };
    }
  }

  async function close() {
    for (const p of providers) {
      try { await p.close?.(); } catch {}
    }
  }

  return { providers, byId, resolve, listModels, chat, preheat, close, joinModelId };
}