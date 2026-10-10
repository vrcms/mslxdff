// Anthropic Messages ⇄ OpenAI chat 翻译层单测（/v1/messages 外壳）。
// 形状依据：code.claude.com/docs/en/llm-gateway-protocol + 参考实现 lamdt1/ms-copilot365-2api。
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  messagesToChatBody,
  chatJsonToAnthropic,
  createAnthropicChunkTranslator,
  toAnthropicUsage,
  estimateTokens,
  anthropicError,
  newMessageId,
} from "../src/anthropic/translate.js";

describe("messagesToChatBody — 请求映射", () => {
  test("最小请求：model + 字符串 content", () => {
    const b = messagesToChatBody({ model: "qwenwork/qwork-auto", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
    assert.equal(b.model, "qwenwork/qwork-auto");
    assert.equal(b.stream, false);
    assert.equal(b.max_tokens, 64);
    assert.deepEqual(b.messages, [{ role: "user", content: "hi" }]);
  });

  test("缺 model 抛错（路由转 400）", () => {
    assert.throws(() => messagesToChatBody({ messages: [{ role: "user", content: "hi" }] }), /model/);
  });

  test("system 字符串 → 单条 system 置首", () => {
    const b = messagesToChatBody({ model: "m", system: "你是助手", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(b.messages[0], { role: "system", content: "你是助手" });
  });

  test("system 数组多块折叠，cache_control 不致错", () => {
    const b = messagesToChatBody({
      model: "m",
      system: [
        { type: "text", text: "A", cache_control: { type: "ephemeral" } },
        { type: "text", text: "B" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(b.messages[0].role, "system");
    assert.equal(b.messages[0].content, "A\n\nB");
  });

  test("text 块数组 content 折叠为字符串", () => {
    const b = messagesToChatBody({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] }] });
    assert.equal(b.messages[0].content, "xy");
  });

  test("base64 图 → data URL 多模态数组，url 图源样转", () => {
    const b = messagesToChatBody({
      model: "m",
      messages: [{ role: "user", content: [
        { type: "text", text: "看图" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        { type: "image", source: { type: "url", url: "https://e/x.png" } },
      ] }],
    });
    const c = b.messages[0].content;
    assert.ok(Array.isArray(c));
    assert.deepEqual(c[0], { type: "text", text: "看图" });
    assert.deepEqual(c[1], { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
    assert.deepEqual(c[2], { type: "image_url", image_url: { url: "https://e/x.png" } });
  });

  test("assistant tool_use → tool_calls（保留 id、input 序列化为字符串）", () => {
    const b = messagesToChatBody({ model: "m", messages: [{ role: "assistant", content: [
      { type: "text", text: "先看一眼" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } },
    ] }] });
    const msg = b.messages[0];
    assert.equal(msg.role, "assistant");
    assert.equal(msg.content, "先看一眼");
    assert.deepEqual(msg.tool_calls, [{ id: "toolu_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"/a\"}" } }]);
  });

  test("user tool_result → role:tool 在前、同消息文本随后成 user", () => {
    const b = messagesToChatBody({ model: "m", messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "文件内容…" },
      { type: "text", text: "继续" },
    ] }] });
    assert.deepEqual(b.messages[0], { role: "tool", tool_call_id: "toolu_1", content: "文件内容…" });
    assert.deepEqual(b.messages[1], { role: "user", content: "继续" });
  });

  test("tool_result 数组内容与 is_error 前缀", () => {
    const b = messagesToChatBody({ model: "m", messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] },
      { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "炸了" }], is_error: true },
    ] }] });
    assert.equal(b.messages[0].content, "第一段\n第二段");
    assert.equal(b.messages[1].content, "[tool_error] 炸了");
  });

  test("重复 tool_use_id 的 tool_result 只留首个", () => {
    const b = messagesToChatBody({ model: "m", messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "一份" },
      { type: "tool_result", tool_use_id: "t1", content: "二份" },
    ] }] });
    assert.equal(b.messages.length, 1);
    assert.equal(b.messages[0].content, "一份");
  });

  test("thinking/redacted_thinking 与 metadata/top_k 忽略不报错", () => {
    const b = messagesToChatBody({
      model: "m", metadata: { user_id: "u" }, top_k: 5, thinking: { type: "enabled", budget_tokens: 1000 },
      output_config: { effort: "high" }, context_management: {},
      messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "内心戏", signature: "sig" },
        { type: "redacted_thinking", data: "xx" },
        { type: "text", text: "答案" },
      ] }],
    });
    assert.equal(b.messages[0].content, "答案");
    assert.equal(b.thinking, undefined);
    assert.equal(b.output_config, undefined);
    assert.equal(b.metadata, undefined);
    assert.equal(b.top_k, undefined);
  });

  test("tools 映射 input_schema→parameters，beta 工具字段丢弃", () => {
    const b = messagesToChatBody({
      model: "m",
      tools: [{ name: "Read", description: "读文件", input_schema: { type: "object", properties: {} }, strict: true, defer_loading: true, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.deepEqual(b.tools, [{ type: "function", function: { name: "Read", description: "读文件", parameters: { type: "object", properties: {} } } }]);
  });

  test("tool_choice 四种取值", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
    assert.equal(messagesToChatBody({ ...base, tool_choice: "auto" }).tool_choice, "auto");
    assert.equal(messagesToChatBody({ ...base, tool_choice: { type: "none" } }).tool_choice, "none");
    assert.equal(messagesToChatBody({ ...base, tool_choice: { type: "auto" } }).tool_choice, "auto");
    assert.equal(messagesToChatBody({ ...base, tool_choice: { type: "any" } }).tool_choice, "required");
    assert.deepEqual(messagesToChatBody({ ...base, tools: [{ name: "Read", description: "d", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "Read" } }).tool_choice, { type: "function", function: { name: "Read" } });
    // ADR-0049 修订：点名一个没随请求声明的工具（如被剥掉的 server tool）时降为 auto——强制点名不存在的函数上游必拒
    assert.equal(messagesToChatBody({ ...base, tool_choice: { type: "tool", name: "Read" } }).tool_choice, "auto");
    assert.equal(messagesToChatBody(base).tool_choice, undefined);
  });

  test("stop_sequences/temperature/top_p/stream 直传", () => {
    const b = messagesToChatBody({ model: "m", stream: true, temperature: 0.3, top_p: 0.9, stop_sequences: ["\n\nHuman:", "DONE"], messages: [{ role: "user", content: "hi" }] });
    assert.equal(b.stream, true);
    assert.equal(b.temperature, 0.3);
    assert.equal(b.top_p, 0.9);
    assert.deepEqual(b.stop, ["\n\nHuman:", "DONE"]);
  });

  test("空 messages / 全无内容 → 抛错走 400，绝不伪造 user 消息打上游", () => {
    assert.throws(() => messagesToChatBody({ model: "m", messages: [] }), /缺少用户消息/);
    assert.throws(() => messagesToChatBody({ model: "m", messages: [{ role: "user", content: "" }] }), /缺少用户消息/);
  });
});

describe("错误形状与 id", () => {
  test("anthropicError 形状", () => {
    assert.deepEqual(anthropicError("invalid_request_error", "缺 model"), { type: "error", error: { type: "invalid_request_error", message: "缺 model" } });
  });
  test("newMessageId 前缀 msg_ 且唯一", () => {
    const a = newMessageId();
    const b = newMessageId();
    assert.ok(a.startsWith("msg_"));
    assert.notEqual(a, b);
  });
});

// ---------- 非流式响应（tasks 1.3/1.4） ----------

describe("chatJsonToAnthropic — 非流式响应", () => {
  test("文本 + 2 工具调用 → text 块在前、tool_use 块在后，stop_reason=tool_use", () => {
    const r = chatJsonToAnthropic({
      id: "chatcmpl-x",
      choices: [{ finish_reason: "tool_calls", message: { content: "先看", tool_calls: [
        { id: "c1", type: "function", function: { name: "Read", arguments: '{"p":"/a"}' } },
        { id: "c2", type: "function", function: { name: "Bash", arguments: "{}" } },
      ] } }],
    }, "qwenwork/qwork-auto");
    assert.equal(r.type, "message");
    assert.equal(r.role, "assistant");
    assert.equal(r.model, "qwenwork/qwork-auto");
    assert.ok(r.id.startsWith("msg_")); // 上游 chatcmpl id 不合规，必须换 msg_
    assert.deepEqual(r.content[0], { type: "text", text: "先看" });
    assert.deepEqual(r.content[1], { type: "tool_use", id: "c1", name: "Read", input: { p: "/a" } });
    assert.equal(r.content[2].name, "Bash");
    assert.equal(r.stop_reason, "tool_use");
    assert.equal(r.stop_sequence, null);
  });

  test("arguments 非法 JSON → input 退化 {raw}，不整轮失败", () => {
    const r = chatJsonToAnthropic({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c1", function: { name: "Read", arguments: "{坏掉的" } }] } }] }, "m");
    assert.deepEqual(r.content[0].input, { raw: "{坏掉的" });
  });

  test("arguments 是数组或标量 → 包成 {value}，保持 input 为对象", () => {
    const r = chatJsonToAnthropic({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "T", arguments: "[1,2]" } }] } }] }, "m");
    assert.deepEqual(r.content[0].input, { value: [1, 2] });
  });

  test("finish_reason 映射：length→max_tokens、stop→end_turn、空内容兜底单 text 块", () => {
    assert.equal(chatJsonToAnthropic({ choices: [{ finish_reason: "length", message: { content: "x" } }] }, "m").stop_reason, "max_tokens");
    const empty = chatJsonToAnthropic({ choices: [{ finish_reason: "stop", message: { content: "" } }] }, "m");
    assert.equal(empty.stop_reason, "end_turn");
    assert.deepEqual(empty.content, [{ type: "text", text: "" }]);
  });

  test("usage 缺失全 0；缓存命中从 input 扣除（Anthropic 口径两者分开计）", () => {
    assert.deepEqual(chatJsonToAnthropic({ choices: [{ message: { content: "x" } }] }, "m").usage, {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    });
    assert.deepEqual(toAnthropicUsage({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } }), {
      input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 60, cache_creation_input_tokens: 0,
    });
  });
});

// ---------- 流式 translator（tasks 1.5/1.6） ----------

const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
const typesOf = (evs) => evs.map((e) => e.type);

describe("createAnthropicChunkTranslator — 具名事件序列", () => {
  test("纯文本流：start→block_start→delta*→block_stop→message_delta→message_stop", () => {
    const t = createAnthropicChunkTranslator("m");
    const head = t.begin();
    assert.equal(head[0].type, "message_start");
    assert.equal(head[0].message.usage.input_tokens, 0);
    assert.equal(head[0].message.usage.output_tokens, 0);
    assert.deepEqual(head[0].message.content, []);
    const mid = t.push(frame({ choices: [{ delta: { content: "你好" } }] }) + frame({ choices: [{ delta: { content: "世界" } }] }));
    assert.deepEqual(typesOf(mid), ["content_block_start", "content_block_delta", "content_block_delta"]);
    assert.equal(mid[0].index, 0);
    assert.deepEqual(mid[0].content_block, { type: "text", text: "" });
    assert.deepEqual(mid[1].delta, { type: "text_delta", text: "你好" });
    const tail = t.end({ finish: "stop", usage: { prompt_tokens: 9, completion_tokens: 2 } });
    assert.deepEqual(typesOf(tail), ["content_block_stop", "message_delta", "message_stop"]);
    assert.equal(tail[0].index, 0);
    assert.equal(tail[1].delta.stop_reason, "end_turn");
    assert.equal(tail[1].usage.input_tokens, 9);
    assert.equal(tail[1].usage.output_tokens, 2);
  });

  test("文本→工具：文本块先封口，工具块带 id/name/input:{}，参数走 input_json_delta", () => {
    const t = createAnthropicChunkTranslator("m");
    t.begin();
    const a = t.push(frame({ choices: [{ delta: { content: "我要调工具" } }] }));
    const b = t.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_1", function: { name: "Read", arguments: "" } }] } }] }));
    assert.deepEqual(typesOf(b), ["content_block_stop", "content_block_start"]);
    assert.equal(b[0].index, 0);
    assert.deepEqual(b[1].content_block, { type: "tool_use", id: "toolu_1", name: "Read", input: {} });
    assert.equal(b[1].index, 1);
    const c = t.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"p":' } }] } }] }));
    assert.deepEqual(c, [{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"p":' } }]);
    const d = t.push(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    assert.deepEqual(d, []);
    const tail = t.end({});
    assert.deepEqual(typesOf(tail), ["content_block_stop", "message_delta", "message_stop"]);
    assert.equal(tail[1].delta.stop_reason, "tool_use");
  });

  test("工具后再来文本 → 另起新 text 块，index 递增不重复", () => {
    const t = createAnthropicChunkTranslator("m");
    t.begin();
    t.push(frame({ choices: [{ delta: { content: "前" } }] }));
    t.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{}" } }] } }] }));
    const after = t.push(frame({ choices: [{ delta: { content: "后" } }] }));
    assert.deepEqual(typesOf(after), ["content_block_stop", "content_block_start", "content_block_delta"]);
    assert.equal(after[1].index, 2); // 0=text,1=tool_use,2=新 text：工具块必须先封口再开新块
    const all = [];
    const t2 = createAnthropicChunkTranslator("m");
    for (const evs of [t2.begin(), t2.push(frame({ choices: [{ delta: { content: "x" } }] })), t2.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "N", arguments: "{}" } }, { index: 1, id: "b", function: { name: "M", arguments: "{}" } }] } }] })), t2.end({})]) all.push(...evs);
    const starts = all.filter((e) => e.type === "content_block_start").map((e) => e.index);
    assert.deepEqual(starts, [0, 1, 2]);
    assert.equal(new Set(starts).size, starts.length);
  });

  test("arguments 增量早于 id/name 到达 → 攒着，announce 时补发", () => {
    const t = createAnthropicChunkTranslator("m");
    t.begin();
    const early = t.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }));
    assert.deepEqual(early, []); // 未 announce，不外发
    const later = t.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read" } }] } }] }));
    assert.deepEqual(typesOf(later), ["content_block_start", "content_block_delta"]);
    assert.equal(later[1].delta.partial_json, '{"a":1}');
  });

  test("只有 arguments 无 name 的退化：end() 补 announce 并封口，事件序列仍完整", () => {
    const t = createAnthropicChunkTranslator("m");
    t.begin();
    t.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "xx" } }] } }] }));
    const tail = t.end({ finish: "stop" });
    assert.deepEqual(typesOf(tail), ["content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    assert.equal(t.getFinal().sawToolUse, true);
  });

  test("end() 无条件封口：文本块未关也补 stop，绝不半截", () => {
    const t = createAnthropicChunkTranslator("m");
    t.begin();
    t.push(frame({ choices: [{ delta: { content: "只有开头" } }] }));
    const tail = t.end({});
    assert.equal(tail[0].type, "content_block_stop");
    assert.equal(tail[tail.length - 1].type, "message_stop");
  });

  test("注释帧与上游 [DONE] 不进事件序列", () => {
    const t = createAnthropicChunkTranslator("m");
    t.begin();
    const evs = t.push(": keepalive\n\n" + 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' + "data: [DONE]\n\n" + "garbage line\n");
    assert.deepEqual(typesOf(evs), ["content_block_start", "content_block_delta"]);
    assert.equal(t.stats().skippedLines, 1);
  });

  test("thinking 缺省丢弃；opts.thinking=true 才发 thinking 块且不发 signature", () => {
    const off = createAnthropicChunkTranslator("m");
    off.begin();
    assert.deepEqual(off.push(frame({ choices: [{ delta: { reasoning_content: "内心戏" } }] })), []);
    assert.equal(off.stats().thinkingChars, 3);
    const on = createAnthropicChunkTranslator("m", { thinking: true });
    on.begin();
    const evs = on.push(frame({ choices: [{ delta: { reasoning_content: "内心戏" } }] }));
    assert.deepEqual(typesOf(evs), ["content_block_start", "content_block_delta"]);
    assert.deepEqual(evs[0].content_block, { type: "thinking", thinking: "" });
    assert.deepEqual(evs[1].delta, { type: "thinking_delta", thinking: "内心戏" });
    assert.ok(!JSON.stringify(evs).includes("signature"));
    // thinking 后来正文 → 另起 text 块
    const after = on.push(frame({ choices: [{ delta: { content: "答案" } }] }));
    assert.deepEqual(typesOf(after), ["content_block_stop", "content_block_start", "content_block_delta"]);
    assert.equal(after[1].content_block.type, "text");
  });

  test("usage 终值可只来自收尾帧（end 不传 usage 时用累积到的 lastUsage）", () => {
    const t = createAnthropicChunkTranslator("m");
    t.begin();
    t.push(frame({ choices: [{ delta: { content: "x" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
    const tail = t.end({ finish: "length" });
    const md = tail.find((e) => e.type === "message_delta");
    assert.equal(md.usage.input_tokens, 11);
    assert.equal(md.usage.output_tokens, 3);
    assert.equal(md.delta.stop_reason, "max_tokens");
  });
});

describe("estimateTokens", () => {
  test("空 body 返回 ≥1 整数，不为 NaN", () => {
    const r = estimateTokens({});
    assert.equal(typeof r.count_tokens, "number");
    assert.ok(Number.isInteger(r.count_tokens));
    assert.ok(r.count_tokens >= 1);
  });
  test("tool_result 全文与 tools 定义都计入", () => {
    const bare = estimateTokens({ messages: [{ role: "user", content: "1234" }] }).count_tokens;
    const withResult = estimateTokens({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(400) }] }] }).count_tokens;
    assert.ok(withResult >= 100, `tool_result 400 字符应至少估到 100 tokens，实得 ${withResult}`);
    const withTools = estimateTokens({ messages: [], tools: [{ name: "Read", input_schema: { properties: { p: { type: "string" } } } }] }).count_tokens;
    assert.ok(withTools > bare, "tools 定义必须计入");
  });
  test("图片按固定面值计", () => {
    const r = estimateTokens({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://e/x.png" } }] }] }).count_tokens;
    assert.ok(r >= 2000);
  });
});

// ---------- 评审补漏（第 1 轮 P1 + 第 2 轮）：入口校验、stream_options、聚合兜底 ----------

describe("评审补漏 — 校验与兜底", () => {
  test("role:\"system\" 混进 messages（官方只允许顶层 system）→ 降级为 user，不算空会话", () => {
    const b = messagesToChatBody({ model: "m", max_tokens: 8, messages: [{ role: "system", content: "s" }] });
    assert.equal(b.messages[0].role, "user");
  });

  test("流式请求注入 stream_options.include_usage；env=0 可关（个别上游不认这字段会 400）", () => {
    const mk = () => messagesToChatBody({ model: "m", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] });
    delete process.env.MSLXDFF_ANTHROPIC_STREAM_USAGE;
    assert.deepEqual(mk().stream_options, { include_usage: true });
    process.env.MSLXDFF_ANTHROPIC_STREAM_USAGE = "0";
    try {
      assert.equal(mk().stream_options, undefined);
    } finally {
      delete process.env.MSLXDFF_ANTHROPIC_STREAM_USAGE;
    }
  });

  test("非流式请求不带 stream_options", () => {
    const b = messagesToChatBody({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
    assert.equal(b.stream, false);
    assert.equal(b.stream_options, undefined);
  });

  test("count_tokens 用 Anthropic 真字段名 input_tokens（count_tokens 仅人读兼容）", () => {
    const r = estimateTokens({ model: "m", messages: [{ role: "user", content: "x".repeat(400) }] });
    assert.equal(r.input_tokens, r.count_tokens);
    assert.ok(Number.isInteger(r.input_tokens) && r.input_tokens >= 100, `实得 ${JSON.stringify(r)}`);
  });

  test("fromChatJson 与流式共用封口：text + tool_use + usage 一次到位", () => {
    const t = createAnthropicChunkTranslator("m");
    const mid = t.fromChatJson({
      choices: [{
        message: {
          role: "assistant",
          content: "结果",
          tool_calls: [{ id: "tc_1", function: { name: "Read", arguments: '{"path":"a.md"}' } }],
        },
        finish_reason: "tool_use",
      }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    });
    const all = [...t.begin(), ...mid, ...t.end({})];
    assert.deepEqual(all.map((e) => e.type), [
      "message_start",
      "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    assert.equal(all[4].content_block.type, "tool_use");
    assert.equal(all[4].content_block.name, "Read");
    assert.equal(all[5].delta.partial_json, '{"path":"a.md"}');
    const md = all[all.length - 2];
    assert.equal(md.delta.stop_reason, "tool_use");
    assert.equal(md.usage.input_tokens, 11);
    assert.equal(md.usage.output_tokens, 3);
    assert.equal(t.getFinal().finish, "tool_use", "fromChatJson 也要把 finish_reason 记进状态机");
  });
});

// ---------- 第 2 轮评审 A 路：上游 content 为部件数组（多模态上游）不得丢正文 ----------

describe("content 部件数组兼容", () => {
  test("chatJsonToAnthropic：text 部件拼成 text 块，image 部件无法映射只能弃", () => {
    const r = chatJsonToAnthropic({
      choices: [{
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "一" },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "二" },
          ],
        },
        finish_reason: "stop",
      }],
    }, "m");
    assert.deepEqual(r.content, [{ type: "text", text: "一二" }]);
    assert.equal(r.stop_reason, "end_turn");
  });

  test("fromChatJson：数组 content 也要进事件流，不静默丢正文", () => {
    const t = createAnthropicChunkTranslator("m");
    const evs = t.fromChatJson({ choices: [{ message: { content: [{ type: "text", text: "数组正文" }] }, finish_reason: "stop" }] });
    assert.ok(JSON.stringify(evs).includes("数组正文"), JSON.stringify(evs));
    assert.equal(t.getFinal().finish, "stop");
  });
});
