// 上游只会流式、客户端要非流式时的 SSE 聚合（ADR-0055）。
// 从 `src/routes/messages-route.js` 抽出：该文件贴着 20KB 体积硬门（20306/20480），本单要加的
// usage 兜底接线必须先进一段，故沿用 ADR-0053 把 count_tokens 估算器拆成独立文件的同类先例。
// 共用面：唯一调用方 `src/routes/messages-route.js`（体积门驱动的等价搬移，非新抽象）。
//
// 逐行吃 `data:` 帧聚成 chat.completion JSON（与 qoder/aggregate.js、zcode 非流式聚合同构），
// 出口复用 `chatJsonToAnthropic`；一帧都没有或夹带 in-band 错误帧时返回 null，落回原有 502 + errorText
// 路径 —— 错误绝不聚合成正文。

/**
 * @param text collector 收到的原始响应体（SSE 帧序列）
 * @param model 回显给客户端的模型名
 * @returns chat.completion 形状对象，或 null（无有效帧 / 夹带错误帧）
 */
export function sseToChatJson(text, model) {
  let content = "";
  let finish = "";
  let usage = null;
  let sawChunk = false;
  const toolSlots = new Map();
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue; // 注释帧/keepalive/事件名行全跳过
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
    if (chunk?.error) return null;
    sawChunk = true;
    const choice = chunk.choices?.[0] || {};
    const delta = choice.delta || {};
    if (choice.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
    if (typeof delta.content === "string" && delta.content) content += delta.content;
    for (const tc of delta.tool_calls || []) {
      const slot = Number(tc?.index ?? 0);
      let t = toolSlots.get(slot);
      if (!t) { t = { id: "", name: "", args: "" }; toolSlots.set(slot, t); }
      if (tc?.id) t.id = String(tc.id);
      if (tc?.function?.name) t.name += String(tc.function.name);
      if (tc?.function?.arguments) t.args += String(tc.function.arguments);
    }
  }
  if (!sawChunk) return null;
  const toolCalls = [...toolSlots.values()].map((t, i) => ({ id: t.id || `call_${i}`, type: "function", function: { name: t.name, arguments: t.args || "{}" } }));
  const message = { role: "assistant", content: content || (toolCalls.length ? null : "") };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const out = {
    id: "", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: finish || (toolCalls.length ? "tool_calls" : "stop") }],
  };
  // 上游真报过 usage 才带这个字段：旧版合成 `{prompt_tokens:0,…}` 会把「未报」伪装成「报了 0」，
  // 让翻译层的兜底判据永远看不到真实形状（ADR-0055 决策 3）。
  if (usage) out.usage = usage;
  return out;
}
