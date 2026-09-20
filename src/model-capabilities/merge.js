// /v1/models 能力富化（ADR-0022）：把 models.dev 目录（+ workbuddy 原生字段兜底）
// 的能力合并进 /v1/models 每条 data 条目的 `capabilities` 子对象，客户端与 CLI 一眼可读。
// 逃生门：GET /v1/models?raw=1 保持 ADR-0016 的原始透传形状；codex 调用者恒原始 + 空 models:[]。
// 全程 best-effort：目录不可用 → 原样返回，绝不让 /models 因富化失败挂掉。
import { globalCapabilities } from "./index.js";

// "cline/deepseek/deepseek-v4-flash" → { provider: "cline", raw: "deepseek/deepseek-v4-flash" }；裸 id 归 opencode
export function splitModelId(id) {
  const s = String(id || "").trim();
  const i = s.indexOf("/");
  if (i > 0) return { provider: s.slice(0, i).toLowerCase(), raw: s.slice(i + 1) };
  return { provider: "opencode", raw: s };
}

function stripFreeSuffix(raw) {
  return raw.replace(/-free$/i, "");
}

// 上游原生 wire API：muse-spark* 只认 /responses（zen /chat 500 实测）；
// models.dev 标 npm @ai-sdk/openai 的模型上游走 responses；其余 chat。
export function upstreamApiFor(caps, raw) {
  const bare = stripFreeSuffix(String(raw || ""));
  if (/^muse-spark/i.test(bare)) return "responses";
  if (caps?.npm === "@ai-sdk/openai") return "responses";
  return "chat";
}

// caps → 对外 capabilities 子对象（只填有值的键，未收录字段不硬造）
export function capsPayloadFor(caps, raw) {
  if (!caps) return null;
  const payload = {
    reasoning: Boolean(caps.reasoning),
    ...(caps.effortType ? { effortType: caps.effortType } : {}),
    ...(Array.isArray(caps.effortValues) && caps.effortValues.length
      ? { effortValues: caps.effortValues.map(String) }
      : {}),
    ...(caps.defaultEffort ? { defaultEffort: String(caps.defaultEffort) } : {}),
    imageInput: Boolean(caps.imageInput),
    inputModalities: Array.isArray(caps.inputModalities) && caps.inputModalities.length
      ? caps.inputModalities
      : ["text"],
    outputModalities: Array.isArray(caps.outputModalities) && caps.outputModalities.length
      ? caps.outputModalities
      : ["text"],
    toolCall: Boolean(caps.toolCall),
    ...(Number(caps.context) > 0 ? { context: Number(caps.context) } : {}),
    ...(Number(caps.maxOutput) > 0 ? { maxOutput: Number(caps.maxOutput) } : {}),
    ...((caps.costIn != null || caps.costOut != null)
      ? { costIn: Number(caps.costIn) || 0, costOut: Number(caps.costOut) || 0 }
      : {}),
    // 网关两侧端点都收：/v1/responses 复用 ChatPipeline 翻译层；upstreamApi 记上游原生协议
    endpoints: ["chat", "responses"],
    upstreamApi: upstreamApiFor(caps, raw),
  };
  return payload;
}

// 单条 id 的目录匹配：精确裸 id → 剥 -free 后缀 → 二级厂商前缀（cline/deepseek/x → deepseek/x）
function lookupCaps(svc, provider, raw) {
  return (
    svc.get(provider, raw) ||
    svc.get(provider, stripFreeSuffix(raw)) ||
    null
  );
}

function lookupCapsDeep(svc, provider, raw) {
  const direct = lookupCaps(svc, provider, raw);
  if (direct) return direct;
  const parts = raw.split("/");
  if (parts.length >= 2) {
    const head = parts[0];
    const rest = parts.slice(1).join("/");
    return svc.get(head, rest) || svc.get(head, stripFreeSuffix(rest)) || null;
  }
  return null;
}

/**
 * 把能力合并进 { object:"list", data:[...] } 的每条条目。
 * capsSvc/wbSource 为测试接缝；生产用全局单例（models.dev 24h 缓存）+ workbuddy 动态源。
 * wbSource 显式 null 禁用 workbuddy 兜底（测试用）。
 */
export async function mergeModelsList(data, { capsSvc, wbSource } = {}) {
  const svc = capsSvc === undefined ? globalCapabilities() : capsSvc;
  const entries = Array.isArray(data?.data) ? data.data : [];
  if (!svc || !entries.length) return data;
  // 只用内存/磁盘缓存热身；冷缓存绝不阻塞请求（后台拉新，下次请求即富化）
  try {
    const warmed = svc.readyWarm ? await svc.readyWarm() : await svc.ready();
    if (!warmed) return data;
  } catch {
    return data;
  }
  // 第一遍：目录直查；workbuddy 未命中记下，第二遍走上游原生字段
  const resolved = new Map(); // index -> caps
  const needWb = []; // [index, raw]
  entries.forEach((entry, i) => {
    const id = String(entry?.id || "");
    if (!id) return;
    const { provider, raw } = splitModelId(id);
    const caps = lookupCapsDeep(svc, provider, raw);
    if (caps) resolved.set(i, caps);
    else if (provider === "workbuddy" && wbSource !== null) needWb.push([i, raw]);
  });
  if (needWb.length) {
    try {
      const { workbuddyCapsFromModels, workbuddyAllModels } = await import("./index.js");
      const wbMap = await workbuddyCapsFromModels(wbSource || workbuddyAllModels)();
      for (const [i, raw] of needWb) {
        const caps = wbMap?.[raw] || null;
        if (caps) resolved.set(i, caps);
      }
    } catch {
      // workbuddy 源不可用：这些条目保持无能力，不拖垮整个列表
    }
  }
  if (!resolved.size) return data;
  const next = entries.map((entry, i) => {
    const caps = resolved.get(i);
    if (!caps) return entry;
    const { raw } = splitModelId(String(entry?.id || ""));
    const payload = capsPayloadFor(caps, raw);
    return payload ? { ...entry, capabilities: payload } : entry;
  });
  return { ...data, data: next };
}
