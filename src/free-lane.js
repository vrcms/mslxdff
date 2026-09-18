// zen 免费层"agent 形状"门禁（2026-09-18 上线，bisect 实测）：
//   403 FreeTierError ≤ 请求必须同时满足：① stream:true ② tools 含 bash/edit/glob/grep/read 五个核心名。
//   另 UA 版本需 ≥ opencode/1.18.0（低版本返回 426 UpgradeRequired，见 opencode-identity.js）。
// 官方客户端自带这五个工具天然通过；-chat 直连（非流式、工具名不同）与裸 API 客户端需补形状。
// 逃生阀：MSLXDFF_FREE_LANE=0 关闭（注入与强制流式都跳过），上游若撤门禁可回退。

export const CORE_AGENT_TOOL_NAMES = ["bash", "edit", "glob", "grep", "read"];

function laneDisabled(env = process.env) {
  const raw = env.MSLXDFF_FREE_LANE;
  if (raw === undefined || raw === null || raw === "") return false;
  const s = String(raw).trim().toLowerCase();
  return s === "0" || s === "false" || s === "off" || s === "no";
}

const chatTool = (name) => ({
  type: "function",
  function: { name, description: `The ${name} tool.`, parameters: { type: "object", properties: {} } },
});

const responsesTool = (name) => ({
  type: "function",
  name,
  description: `The ${name} tool.`,
  parameters: { type: "object", properties: {} },
});

function toolName(tool, responses) {
  return responses ? tool?.name : tool?.function?.name;
}

/**
 * 给免费层请求补 agent 形状（幂等，原地改 body）。
 * @returns {{injected: string[], forcedStream: boolean, disabled: boolean}}
 */
export function ensureFreeLaneShape(body, { responses = false, env = process.env } = {}) {
  if (!body || typeof body !== "object") return { injected: [], forcedStream: false, disabled: true };
  if (laneDisabled(env)) return { injected: [], forcedStream: false, disabled: true };
  const forcedStream = body.stream !== true;
  body.stream = true;
  const mk = responses ? responsesTool : chatTool;
  const list = Array.isArray(body.tools) ? body.tools : [];
  const have = new Set(list.map((t) => toolName(t, responses)).filter(Boolean));
  const injected = CORE_AGENT_TOOL_NAMES.filter((n) => !have.has(n));
  if (injected.length) body.tools = [...list, ...injected.map(mk)];
  return { injected, forcedStream, disabled: false };
}

function mergeToolCall(target, idx, delta) {
  const cur = target[idx] || (target[idx] = { index: idx, id: undefined, type: "function", function: { name: undefined, arguments: "" } });
  if (delta?.id) cur.id = delta.id;
  if (delta?.type) cur.type = delta.type;
  if (delta?.function?.name) cur.function.name = delta.function.name;
  if (delta?.function?.arguments) cur.function.arguments += delta.function.arguments;
}

function finishSseJson(acc) {
  const message = { role: "assistant", content: acc.content };
  if (acc.reasoning) message.reasoning_content = acc.reasoning;
  if (acc.toolCalls.length) {
    message.tool_calls = acc.toolCalls
      .filter(Boolean)
      .map((c, i) => ({ ...c, index: undefined, id: c.id || `call_${i}`, function: { name: c.function.name || "", arguments: c.function.arguments || "{}" } }));
    if (!message.content) message.content = "";
  }
  const json = {
    id: acc.id || "chatcmpl-aggregated",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: acc.model,
    choices: [{ index: 0, message, finish_reason: acc.finishReason || (acc.toolCalls.length ? "tool_calls" : "stop"), logprobs: null }],
  };
  if (acc.usage) json.usage = acc.usage;
  return json;
}

/**
 * 把上游 SSE 流聚合回非流式 chat completion JSON。
 * 仅消费 body，不改状态；解析失败时抛错（调用方自行回退）。
 */
export async function aggregateChatSse(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return res;
  const acc = { id: null, model: null, content: "", reasoning: "", toolCalls: [], finishReason: null, usage: null, error: null };
  const decoder = new TextDecoder();
  let buf = "";
  const eat = (frame) => {
    for (const line of frame.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j?.error) { acc.error = acc.error || j.error; continue; }
      if (j?.id) acc.id = j.id;
      if (j?.model) acc.model = j.model;
      if (j?.usage) acc.usage = j.usage;
      const ch = j?.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (typeof d.content === "string") acc.content += d.content;
      if (typeof d.reasoning_content === "string") acc.reasoning += d.reasoning_content;
      else if (typeof d.reasoning === "string") acc.reasoning += d.reasoning;
      if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) mergeToolCall(acc.toolCalls, tc.index ?? 0, tc);
      if (ch.finish_reason) acc.finishReason = ch.finish_reason;
      if (ch.message && typeof ch.message.content === "string" && !acc.content) {
        acc.content = ch.message.content;
        if (Array.isArray(ch.message.tool_calls)) for (const tc of ch.message.tool_calls) mergeToolCall(acc.toolCalls, tc.index ?? 0, tc);
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() || "";
      for (const f of frames) eat(f);
    }
    if (buf.trim()) eat(buf);
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  if (acc.error && !acc.content && !acc.toolCalls.length) {
    const body = JSON.stringify({ error: acc.error });
    return new Response(body, { status: 502, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify(finishSseJson(acc)), { status: res.status, headers: { "content-type": "application/json" } });
}
