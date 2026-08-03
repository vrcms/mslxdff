const PLACEHOLDER = " ";

const MODEL_RULES = [
  { match: (m) => /^kimi-/i.test(m || ""), scope: "toolCalls" },
  { match: (m) => /deepseek/i.test(m || ""), scope: "all" },
];

export function normalizeModel(model) {
  return model.startsWith("oc/") ? model.slice(3) : model;
}

function shouldInject(message, scope) {
  if (message?.role !== "assistant") return false;
  const rc = message.reasoning_content;
  if (typeof rc === "string" && rc.length > 0) return false;
  if (scope === "toolCalls") {
    return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  }
  return true;
}

function applyRule(body, rule) {
  if (!rule || !body?.messages) return body;
  const messages = body.messages.map((m) =>
    shouldInject(m, rule.scope) ? { ...m, reasoning_content: PLACEHOLDER } : m
  );
  return { ...body, messages };
}

export function injectReasoningContent(model, body) {
  const rule = MODEL_RULES.find((r) => r.match(model));
  return applyRule(body, rule);
}