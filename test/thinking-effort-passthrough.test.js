// 思考档位透传单测（change: fix-thinking-effort-passthrough）。
// 目标：客户端声明的档位在入站保留、出站按各家原生形状映射，显式声明优先于网关默认。
import test from "node:test";
import assert from "node:assert/strict";
import { messagesToChatBody } from "../src/anthropic/translate.js";
import { responsesToChatBody } from "../src/responses/translate.js";
import { effortFromBody, isEffortOff, isReasoningEnabled } from "../src/thinking-effort.js";
import { rewriteWorkbuddyPayload } from "../src/providers/workbuddy/payload.js";
import { buildRaccoonWireBody } from "../src/providers/raccoon/chat.js";
import { toAnthropicRequest } from "../src/providers/zcode/chat.js";
import { buildBody as buildQwenworkBody } from "../src/providers/qwenwork/payload.js";
import { buildBody as buildGlobalQwenworkBody } from "../src/providers/globalqwenwork/payload.js";

// ---------- 入站：/v1/messages ----------

test("messages 入站保留 thinking/effort/reasoning_effort/extra_body", () => {
  const b = messagesToChatBody({
    model: "deepseek/deepseek-v4",
    thinking: { type: "enabled", budget_tokens: 8000 },
    effort: "low",
    reasoning_effort: "medium",
    extra_body: { thinking: { type: "disabled" } },
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(b.thinking, { type: "enabled", budget_tokens: 8000 });
  assert.equal(b.effort, "low");
  assert.equal(b.reasoning_effort, "medium");
  assert.deepEqual(b.extra_body, { thinking: { type: "disabled" } });
});

test("messages 入站 reasoningEffort 驼峰也保留", () => {
  const b = messagesToChatBody({ model: "m", reasoningEffort: "xhigh", messages: [{ role: "user", content: "hi" }] });
  assert.equal(b.reasoningEffort, "xhigh");
});

test("messages 入站不添加未声明的档位字段", () => {
  const b = messagesToChatBody({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.equal("thinking" in b, false);
  assert.equal("effort" in b, false);
  assert.equal("reasoning_effort" in b, false);
  assert.equal("extra_body" in b, false);
});

test("messages 入站把 output_config.effort 归一到 reasoning_effort（原始对象不外发）", () => {
  const b = messagesToChatBody({ model: "m", output_config: { effort: "xhigh" }, messages: [{ role: "user", content: "hi" }] });
  assert.equal(b.reasoning_effort, "xhigh");
  assert.equal("output_config" in b, false);
});

test("messages 入站显式 reasoning_effort 优先于 output_config.effort", () => {
  const b = messagesToChatBody({ model: "m", reasoning_effort: "low", output_config: { effort: "xhigh" }, messages: [{ role: "user", content: "hi" }] });
  assert.equal(b.reasoning_effort, "low");
});

test("messages 入站仍丢弃消息块内的 thinking（ADR-0047）", () => {
  const b = messagesToChatBody({
    model: "m",
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "秘密" }, { type: "text", text: "答案" }] }],
  });
  assert.equal(b.messages[0].content, "答案");
});

// ---------- 入站：/v1/responses ----------

test("responses 入站把 reasoning.effort 映射为 reasoning_effort", () => {
  const b = responsesToChatBody({ model: "m", reasoning: { effort: "medium" }, input: "hi" });
  assert.equal(b.reasoning_effort, "medium");
});

test("responses 入站无 reasoning 时不添加 reasoning_effort", () => {
  const b = responsesToChatBody({ model: "m", input: "hi" });
  assert.equal("reasoning_effort" in b, false);
});

// ---------- 共享词表 ----------

test("isEffortOff 识别 off/none/disabled（大小写不敏感）", () => {
  for (const v of ["off", "none", "disabled", "OFF", "Disabled", "  none  "]) assert.equal(isEffortOff(v), true, v);
  for (const v of ["low", "medium", "high", "xhigh", "max", "on", "", null, undefined]) assert.equal(isEffortOff(v), false, String(v));
});

test("effortFromBody 优先级：extra_body.thinking.type > reasoning_effort > reasoningEffort > effort > thinking.type", () => {
  assert.equal(effortFromBody({ extra_body: { thinking: { type: "enabled" } }, reasoning_effort: "low" }), "enabled");
  assert.equal(effortFromBody({ reasoning_effort: "low", reasoningEffort: "high" }), "low");
  assert.equal(effortFromBody({ reasoningEffort: "high", effort: "low" }), "high");
  assert.equal(effortFromBody({ effort: "low", thinking: { type: "enabled" } }), "low");
  assert.equal(effortFromBody({ thinking: { type: "enabled" } }), "enabled");
  assert.equal(effortFromBody({}), "");
});

test("effortFromBody 关断值最高优先（off 压过开启档）", () => {
  assert.equal(effortFromBody({ thinking: { type: "disabled" }, reasoning_effort: "high" }), "disabled");
  assert.equal(effortFromBody({ reasoning_effort: "off", thinking: { type: "enabled" } }), "off");
});

test("isReasoningEnabled：关断→false，非空档→true，空档→回退值", () => {
  assert.equal(isReasoningEnabled("off"), false);
  assert.equal(isReasoningEnabled("none"), false);
  assert.equal(isReasoningEnabled("high"), true);
  assert.equal(isReasoningEnabled(""), false);
  assert.equal(isReasoningEnabled("", true), true);
});

// ---------- 出站：workbuddy ----------

test("workbuddy：入站低档位不再被抬成 high", () => {
  const out = rewriteWorkbuddyPayload({ model: "deepseek-v4.1-flash", reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.reasoning_effort, "low");
  assert.deepEqual(out.thinking, { type: "enabled" });
});

test("workbuddy：缺档仍补 high（旧行为）", () => {
  const out = rewriteWorkbuddyPayload({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.reasoning_effort, "high");
});

// ---------- 出站：raccoon ----------

test("raccoon：body 关断档 → disabled（不再断言为开）", () => {
  const w = buildRaccoonWireBody({ model: "raccoon/sn-kimi-k3", messages: [], reasoning_effort: "off" });
  assert.equal(w.extra_body.thinking.type, "disabled");
  assert.ok(!("reasoning_effort" in w), "绝不发 reasoning_effort");
});

test("raccoon：body 开启档 → enabled", () => {
  const w = buildRaccoonWireBody({ model: "sn-kimi-k3", messages: [], reasoning_effort: "high" });
  assert.equal(w.extra_body.thinking.type, "enabled");
});

test("raccoon：显式 extra_body 声明优先（disabled 压过 reasoning_effort=high）", () => {
  const w = buildRaccoonWireBody({ model: "sn-kimi-k3", messages: [], extra_body: { thinking: { type: "disabled" } }, reasoning_effort: "high" });
  assert.equal(w.extra_body.thinking.type, "disabled");
});

test("raccoon：无 body 档位 → 沿用 effort 参数/env 旧优先级", () => {
  const w = buildRaccoonWireBody({ model: "sn-kimi-k3", messages: [] }, { effort: "off" });
  assert.equal(w.extra_body.thinking.type, "disabled");
});

// ---------- 出站：qwenwork 系布尔推导 ----------

test("qwenwork：body 高档位 → is_reasoning=true", () => {
  const b = JSON.parse(buildQwenworkBody({ model: "flash", reasoning_effort: "high", messages: [{ role: "user", content: "x" }] }, "flash"));
  assert.equal(b.model_config.is_reasoning, true);
  assert.equal(b.chat_context.extra.modelConfig.is_reasoning, true);
});

test("qwenwork：body 关断档 → is_reasoning=false", () => {
  const b = JSON.parse(buildQwenworkBody({ model: "flash", reasoning_effort: "off", messages: [{ role: "user", content: "x" }] }, "flash"));
  assert.equal(b.model_config.is_reasoning, false);
});

test("globalqwenwork：body 高档位 → is_reasoning=true", () => {
  const b = JSON.parse(buildGlobalQwenworkBody({ model: "qwork-auto", reasoning_effort: "medium", messages: [{ role: "user", content: "x" }] }, "qwork-auto"));
  assert.equal(b.model_config.is_reasoning, true);
});

// ---------- 出站：zcode Anthropic 形状 ----------

test("zcode：thinking 对象原样透传 + effort 由 reasoning_effort 回退", () => {
  const out = toAnthropicRequest({
    model: "zcode/glm-5.3-flash",
    thinking: { type: "enabled", budget_tokens: 8000 },
    reasoning_effort: "low",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(out.thinking, { type: "enabled", budget_tokens: 8000 });
  assert.equal(out.effort, "low");
});

test("zcode：档位载体按共享词表优先级（reasoning_effort ＞ reasoningEffort ＞ effort）", () => {
  const out = toAnthropicRequest({ model: "m", effort: "high", reasoning_effort: "low", messages: [] });
  assert.equal(out.effort, "low");
});

test("zcode：无档位时不添加 thinking/effort", () => {
  const out = toAnthropicRequest({ model: "m", messages: [] });
  assert.equal("thinking" in out, false);
  assert.equal("effort" in out, false);
});

test("zcode：认 reasoningEffort，且 thinking.type 不当档位发出去", () => {
  assert.equal(toAnthropicRequest({ model: "m", reasoningEffort: "medium", messages: [] }).effort, "medium");
  assert.equal(toAnthropicRequest({ model: "m", effort: "high", messages: [] }).effort, "high");
  assert.equal("effort" in toAnthropicRequest({ model: "m", thinking: { type: "enabled" }, messages: [] }), false);
});

test("effortLevelFromBody：只取真档位载体，空串不算声明", async () => {
  const { effortLevelFromBody } = await import("../src/thinking-effort.js");
  assert.equal(effortLevelFromBody({ reasoning_effort: "high", effort: "low" }), "high");
  assert.equal(effortLevelFromBody({ reasoningEffort: "medium", effort: "low" }), "medium");
  assert.equal(effortLevelFromBody({ effort: "low" }), "low");
  assert.equal(effortLevelFromBody({ thinking: { type: "enabled" } }), "");
  assert.equal(effortLevelFromBody({ reasoning_effort: "   " }), "");
});

// ---------- 关断值全链路一致 ----------

test("workbuddy：reasoning_effort=off 不再被反转为开（关断最高优先）", () => {
  const out = rewriteWorkbuddyPayload({ model: "deepseek-v4.1-flash", reasoning_effort: "off", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(out.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in out, false);
});

test("workbuddy：effort 载体折成 reasoning_effort（不再无视并补 high）", () => {
  const out = rewriteWorkbuddyPayload({ model: "deepseek-v4.1-flash", effort: "low", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.reasoning_effort, "low");
  assert.equal("effort" in out, false, "归一后删除，免得未知字段裸奔");
});

test("workbuddy：reasoningEffort 驼峰归一为 snake", () => {
  const out = rewriteWorkbuddyPayload({ model: "deepseek-v4.1-flash", reasoningEffort: "xhigh", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.reasoning_effort, "xhigh");
  assert.equal("reasoningEffort" in out, false);
});

// ---------- 空串不算声明 ----------

test("messages 入站：空串档位不写入（免得顶掉下游默认值）", () => {
  const b = messagesToChatBody({ model: "m", reasoning_effort: "", effort: "   ", messages: [{ role: "user", content: "hi" }] });
  assert.equal("reasoning_effort" in b, false);
  assert.equal("effort" in b, false);
  assert.equal(rewriteWorkbuddyPayload({ ...b, model: "deepseek-v4.1-flash" }).reasoning_effort, "high");
});

test("responses 入站：reasoning.effort 空串不写入", () => {
  const b = responsesToChatBody({ model: "m", reasoning: { effort: "" }, input: "hi" });
  assert.equal("reasoning_effort" in b, false);
});

// ---------- qoder 档位优先于模型目录（两向） ----------

test("qoder 组合：目录 false 而客户端 high → 客户端赢", () => {
  assert.equal(isReasoningEnabled(effortFromBody({ reasoning_effort: "high" }), false), true);
});

test("qoder 组合：目录 true 而客户端关断 → 客户端赢", () => {
  assert.equal(isReasoningEnabled(effortFromBody({ reasoning_effort: "off" }), true), false);
});

test("qoder 组合：无档位 → 沿用目录结论", () => {
  assert.equal(isReasoningEnabled(effortFromBody({}), true), true);
  assert.equal(isReasoningEnabled(effortFromBody({}), false), false);
});

// ---------- 其它通道不丢档位 ----------

test("upstream-responses：chat body 的 reasoning_effort 转成 reasoning.effort", async () => {
  const { chatToResponsesBody } = await import("../src/upstream-responses.js");
  assert.deepEqual(chatToResponsesBody({ model: "m", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }).reasoning, { effort: "high" });
  assert.equal("reasoning" in chatToResponsesBody({ model: "m", messages: [{ role: "user", content: "hi" }] }), false);
});

test("SDK 通道：reasoningEffort/effort/extra_body 不再原样 spread，thinking 仍透传", async () => {
  const { toProviderExtras } = await import("../src/upstream-engine/sdk/convert.js");
  const extras = toProviderExtras({ model: "m", reasoningEffort: "high", effort: "low", extra_body: { x: 1 }, thinking: { type: "enabled" }, custom_key: 1 }) || {};
  assert.equal("reasoningEffort" in extras, false);
  assert.equal("effort" in extras, false);
  assert.equal("extra_body" in extras, false);
  assert.deepEqual(extras.thinking, { type: "enabled" }, "workbuddy 依赖 thinking spread");
  assert.equal(extras.custom_key, 1);
});
