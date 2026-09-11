// models.dev 能力目录 → mslxdff 能力形状的纯函数解析层（无 IO，测试接缝 S1）
// 源数据形态（实测 models.opencode.ai/api.json 2026-09-11）：
//   reasoning_options: [{type:"effort",values:["low","medium","high","max"]} | {type:"toggle"} | {type:"budget_tokens",min}]
//   modalities.input 含 "image" 即可读图；limit.context/output；cost.input/output 为 $/M tokens
export function normalizeModelCaps(_id, m) {
  const opts = Array.isArray(m?.reasoning_options) ? m.reasoning_options : [];
  const effort = opts.find((o) => o?.type === "effort");
  const toggle = opts.some((o) => o?.type === "toggle");
  const budget = opts.find((o) => o?.type === "budget_tokens");
  const input = Array.isArray(m?.modalities?.input) ? m.modalities.input : [];
  return {
    reasoning: Boolean(m?.reasoning),
    effortType: effort ? "effort" : toggle ? "toggle" : budget ? "budget_tokens" : null,
    effortValues: effort && Array.isArray(effort.values) ? effort.values.map(String) : null,
    imageInput: input.includes("image"),
    toolCall: Boolean(m?.tool_call),
    context: Number(m?.limit?.context) || null,
    maxOutput: Number(m?.limit?.output) || null,
    costIn: Number(m?.cost?.input) || null,
    costOut: Number(m?.cost?.output) || null,
    // opencode Model 形状补充字段（-setto opencode 条目注入用）
    attachment: Boolean(m?.attachment),
    temperature: Boolean(m?.temperature),
    releaseDate: typeof m?.release_date === "string" && m.release_date ? m.release_date : null,
    inputModalities: input.length ? input : ["text"],
    outputModalities: Array.isArray(m?.modalities?.output) && m.modalities.output.length ? m.modalities.output : ["text"],
  };
}

// provider.models 对象（{ [modelId]: rawModel }）→ { [modelId]: caps }
export function normalizeProviderModels(modelsObj) {
  const out = {};
  if (!modelsObj || typeof modelsObj !== "object") return out;
  for (const [id, m] of Object.entries(modelsObj)) {
    if (!m || typeof m !== "object") continue;
    out[id] = normalizeModelCaps(id, m);
  }
  return out;
}
