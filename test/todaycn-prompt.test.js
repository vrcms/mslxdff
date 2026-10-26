// todaycn/prompt.js 单测：契约组装（含工具块/纯文本退化/历史裁剪）与回复解析（严格/带尾巴/多调用/围栏）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTodaycnContent, parseTodaycnReply, extractJsonObjects } from "../src/providers/todaycn/prompt.js";

const TOOLS = [
  { type: "function", function: { name: "read_file", description: "读取文本文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

test("buildTodaycnContent：带 tools 时注入工具块与格式契约", () => {
  const s = buildTodaycnContent({
    messages: [{ role: "user", content: "读一下 C:\\a.txt" }],
    tools: TOOLS,
  });
  assert.match(s, /read_file/);
  assert.match(s, /格式约定/);
  assert.match(s, /第一个字符必须是 \{/);
  assert.match(s, /读一下 C:\\a.txt/);
  assert.match(s, /由这个脚本执行/, "必须重述角色：动作由脚本执行，模型只写动作");
  assert.doesNotMatch(s, /优先级/, "禁止出现优先级式措辞（会触发平台抗注入）");
});

test("buildTodaycnContent：无 tools 时纯文本退化，不注入契约", () => {
  const s = buildTodaycnContent({ messages: [{ role: "user", content: "你好" }], tools: [] });
  assert.doesNotMatch(s, /格式约定/);
  assert.doesNotMatch(s, /tool_call/);
  assert.match(s, /\[user\] 你好/);
});

test("buildTodaycnContent：历史里 tool/assistant.tool_calls 都按契约同形渲染", () => {
  const s = buildTodaycnContent({
    messages: [
      { role: "user", content: "读文件" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"C:\\\\a.txt\"}" } }] },
      { role: "tool", tool_call_id: "c1", name: "read_file", content: "OK-1234" },
    ],
    tools: TOOLS,
  });
  assert.match(s, /\[工具结果\] \{"tool_call":"read_file","result":"OK-1234"\}/);
  assert.match(s, /\{"tool_call":"read_file","arguments":\{"path":"C:\\\\a\.txt"\}\}/);
});

test("buildTodaycnContent：超长历史丢最旧并留省略标记", () => {
  const messages = [];
  for (let i = 0; i < 40; i += 1) messages.push({ role: "user", content: `第 ${i} 段 ` + "x".repeat(200) });
  const s = buildTodaycnContent({ messages, tools: TOOLS, maxChars: 1200 });
  assert.match(s, /因长度限制已省略/);
  assert.match(s, /第 39 段/, "最新一段必须在");
  assert.doesNotMatch(s, /第 0 段/, "最旧一段应被丢掉");
});

test("parseTodaycnReply：严格单行 JSON → 无正文、strict=true", () => {
  const r = parseTodaycnReply('{"tool_call":"read_file","arguments":{"path":"C:\\\\a.txt"}}', { idFactory: () => "call_1" });
  assert.equal(r.content, "");
  assert.equal(r.strict, true);
  assert.equal(r.tool_calls.length, 1);
  assert.equal(r.tool_calls[0].id, "call_1");
  assert.equal(r.tool_calls[0].type, "function");
  assert.equal(r.tool_calls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(r.tool_calls[0].function.arguments), { path: "C:\\a.txt" });
});

test("parseTodaycnReply：实验 B 原样（JSON + 尾巴人话）→ 正文留人话、strict=false", () => {
  const text = '{"tool_call":"echo_marker","arguments":{"code":"TODAYFC2"}}\n\n按文本给你的。我这边没有 echo_marker 这个工具，所以这不是一次实际调用。';
  const r = parseTodaycnReply(text);
  assert.equal(r.strict, false);
  assert.equal(r.tool_calls.length, 1);
  assert.match(r.content, /按文本给你的/);
  assert.equal(r.content.includes("tool_call"), false, "tool_call JSON 不该残留在正文里");
});

test("parseTodaycnReply：多动作 / 嵌套参数 / 代码围栏 / 纯文本", () => {
  const two = parseTodaycnReply('{"tool_call":"a","arguments":{"x":{"y":[1,2]}}}\n{"tool_call":"b","arguments":{}}');
  assert.deepEqual(two.tool_calls.map((t) => t.function.name), ["a", "b"]);
  assert.deepEqual(JSON.parse(two.tool_calls[0].function.arguments), { x: { y: [1, 2] } });

  const fenced = parseTodaycnReply('```json\n{"tool_call":"read_file","arguments":{"path":"p"}}\n```');
  assert.equal(fenced.strict, true);
  assert.equal(fenced.tool_calls.length, 1);

  const plain = parseTodaycnReply("今天天气不错。");
  assert.equal(plain.tool_calls.length, 0);
  assert.equal(plain.content, "今天天气不错。");
  assert.equal(plain.strict, false);
});

test("parseTodaycnReply：兼容 name+arguments 与 function 包装", () => {
  const a = parseTodaycnReply('{"name":"write_file","arguments":{"path":"p","content":"c"}}');
  assert.equal(a.tool_calls[0].function.name, "write_file");
  const b = parseTodaycnReply('{"function":{"name":"ls","arguments":{"dir":"."}}}');
  assert.equal(b.tool_calls[0].function.name, "ls");
});

test("extractJsonObjects：花括号在字符串里不误判，未闭合即停", () => {
  const objs = extractJsonObjects('前言 {"a":"}"} 后语 {"b":1} 尾巴 {"c":');
  assert.deepEqual(objs.map((o) => o.obj), [{ a: "}" }, { b: 1 }]);
});

test("buildTodaycnContent：契约必须落在最末尾（长历史也挤不掉它）", () => {
  const messages = [];
  for (let i = 0; i < 30; i += 1) messages.push({ role: i % 2 ? "assistant" : "user", content: `第 ${i} 段 ` + "x".repeat(120) });
  const s = buildTodaycnContent({ messages, tools: TOOLS });
  const atHistory = s.indexOf("【对话历史】");
  const atContract = s.indexOf("格式约定");
  assert.ok(atHistory >= 0 && atContract > atHistory, "契约必须在历史之后（2026-10-26 真机：放最前会被长历史挤出注意力）");
  assert.ok(s.lastIndexOf("第一个字符必须是 {") > s.lastIndexOf("【当前请求】"), "契约的规则要排在当前请求之后");
  assert.ok(s.trimEnd().endsWith("只留该给的东西。"), "全文末尾就是契约的最后一条");
});

test("buildTodaycnContent：客户端 system 提示渲染成中性标签，不冒充最高指令", () => {
  const s = buildTodaycnContent({
    messages: [
      { role: "system", content: "You are PI-Desktop, a coding agent." },
      { role: "user", content: "列出当前目录" },
    ],
    tools: TOOLS,
  });
  assert.match(s, /\[客户端背景说明\] You are PI-Desktop/);
  assert.doesNotMatch(s, /\[system\]/, "别再用 [system] 标签");
  assert.doesNotMatch(s, /优先级/);
});