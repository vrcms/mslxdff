// -setto opencode 条目能力注入（ADR-0016 联动）：把 models.dev 能力写进 opencode.json
// 的 per-model 条目（opencode Model 形状，实测 debug config 原样保留并生效），
// 并产出一行人话摘要供 CLI 展示。查不到能力（未收录 provider/模型）时原样返回不硬造。
import { globalCapabilities } from "./index.js";

// "bai/glm-5.3-flash" → { provider: "bai", raw: "glm-5.3-flash" }；裸 id 归 opencode
function splitProvider(modelId) {
  const s = String(modelId || "").trim();
  const i = s.indexOf("/");
  if (i > 0) return { provider: s.slice(0, i).toLowerCase(), raw: s.slice(i + 1) };
  return { provider: "opencode", raw: s };
}

// caps → opencode Model 形状增量（只含能力字段，name 等原有键不动）
function capsToEntryFields(caps) {
  if (!caps) return null;
  const fields = {
    reasoning: Boolean(caps.reasoning),
    tool_call: Boolean(caps.toolCall),
    attachment: Boolean(caps.attachment),
    temperature: Boolean(caps.temperature),
    modalities: { input: caps.inputModalities || ["text"], output: caps.outputModalities || ["text"] },
    limit: { context: Number(caps.context) || 0, output: Number(caps.maxOutput) || 0 },
  };
  if (caps.releaseDate) fields.release_date = caps.releaseDate;
  if (caps.costIn != null || caps.costOut != null) {
    fields.cost = { input: Number(caps.costIn) || 0, output: Number(caps.costOut) || 0 };
  }
  return fields;
}

// entry: 现有条目（含 name 等）；modelId: 内部 canonical id；capsSvc: 可注入（默认全局单例）
// 返回 { entry: 增强后条目, caps: caps|null }；服务异常静默降级（同步命令不能因目录拉取失败而挂）
export async function enrichOpencodeEntry(entry, modelId, capsSvc) {
  const base = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const svc = capsSvc === undefined ? globalCapabilities() : capsSvc;
  if (!svc) return { entry: base, caps: null };
  const { provider, raw } = splitProvider(modelId);
  let caps = null;
  try {
    await svc.ready();
    caps = svc.get(provider, raw) || null;
    // 降级匹配：mslxdff 自建目录的 -free/-search-free/-expert-free 后缀在 models.dev 无后缀
    if (!caps && /-free$/.test(raw)) caps = svc.get(provider, raw.replace(/-free$/, "")) || null;
  } catch {
    caps = null; // 目录不可用：降级为无能力条目（staleness 兜底在服务内已做）
  }
  const fields = capsToEntryFields(caps);
  if (!fields) return { entry: base, caps: null };
  return { entry: { ...base, ...fields }, caps };
}

// caps → 一行人话摘要（无有效信息返回 ""，调用方按空跳过不噪音）
export function capsSummary(caps) {
  if (!caps) return "";
  const parts = [];
  if (caps.effortType === "effort" && Array.isArray(caps.effortValues) && caps.effortValues.length) {
    parts.push(`推理档 ${caps.effortValues.join("/")}`);
  } else if (caps.effortType === "toggle") {
    parts.push("推理 开关型");
  } else if (caps.effortType === "budget_tokens") {
    parts.push("推理 budget_tokens");
  } else if (caps.reasoning) {
    parts.push("推理模型");
  }
  if (caps.imageInput) parts.push("📷读图");
  if (caps.context) parts.push(`上下文 ${caps.context >= 1000 ? `${Math.round(caps.context / 1000)}k` : caps.context}`);
  if (caps.costIn != null || caps.costOut != null) {
    parts.push(`$${caps.costIn ?? 0}/${caps.costOut ?? 0} 每M`);
  }
  return parts.join(" · ");
}
