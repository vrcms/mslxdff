import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureFreeLaneShape, aggregateChatSse, CORE_AGENT_TOOL_NAMES } from "../src/free-lane.js";
import { createUpstreamClient } from "../src/upstream.js";

const originalEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
});

const sse = (frames) => frames.map((f) => (typeof f === "string" ? f : `data: ${JSON.stringify(f)}`)).join("\n\n") + "\n\ndata: [DONE]\n\n";
const sseResponse = (text, status = 200) => new Response(text, { status, headers: { "content-type": "text/event-stream" } });

describe("free-lane 形状注入", () => {
  it("无 tools：补核心五件套 + 强制 stream", () => {
    const body = { model: "big-pickle", messages: [], stream: false };
    const r = ensureFreeLaneShape(body);
    assert.equal(body.stream, true);
    assert.equal(r.forcedStream, true);
    assert.deepEqual(r.injected, CORE_AGENT_TOOL_NAMES);
    assert.deepEqual(body.tools.map((t) => t.function.name), CORE_AGENT_TOOL_NAMES);
  });

  it("已有部分工具：只补缺的，不重复", () => {
    const body = { stream: false, tools: [{ type: "function", function: { name: "read" } }] };
    const r = ensureFreeLaneShape(body);
    assert.deepEqual(r.injected, ["bash", "edit", "glob", "grep"]);
    assert.equal(body.tools.length, 5);
    assert.equal(body.tools.filter((t) => t.function.name === "read").length, 1);
  });

  it("五件套齐全：幂等（不再追加）", () => {
    const tools = CORE_AGENT_TOOL_NAMES.map((n) => ({ type: "function", function: { name: n } }));
    const body = { stream: true, tools: [...tools] };
    const r = ensureFreeLaneShape(body);
    assert.deepEqual(r.injected, []);
    assert.equal(r.forcedStream, false);
    assert.equal(body.tools.length, 5);
  });

  it("responses 形状：扁平 name 字段", () => {
    const body = { stream: false, tools: [] };
    ensureFreeLaneShape(body, { responses: true });
    assert.ok(body.tools.every((t) => typeof t.name === "string" && !t.function));
    assert.ok(body.tools.some((t) => t.name === "bash"));
  });

  it("MSLXDFF_FREE_LANE=0：完全不动", () => {
    process.env.MSLXDFF_FREE_LANE = "0";
    const body = { stream: false, messages: [] };
    const r = ensureFreeLaneShape(body);
    assert.equal(r.disabled, true);
    assert.equal(body.stream, false);
    assert.equal(body.tools, undefined);
  });
});

describe("free-lane SSE 聚合", () => {
  it("content + reasoning + usage + finish_reason", async () => {
    const res = await aggregateChatSse(
      sseResponse(
        sse([
          { id: "gen-1", model: "big-pickle", choices: [{ delta: { content: "你" }, finish_reason: null }] },
          { choices: [{ delta: { reasoning_content: "思考" } }] },
          { choices: [{ delta: { content: "好" }, finish_reason: "stop" }], usage: { total_tokens: 3 } },
        ]),
      ),
    );
    const j = await res.json();
    assert.equal(j.object, "chat.completion");
    assert.equal(j.choices[0].message.content, "你好");
    assert.equal(j.choices[0].message.reasoning_content, "思考");
    assert.equal(j.choices[0].finish_reason, "stop");
    assert.equal(j.usage.total_tokens, 3);
    assert.equal(j.model, "big-pickle");
  });

  it("工具调用增量跨帧拼接", async () => {
    const res = await aggregateChatSse(
      sseResponse(
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: "tool_calls" }] },
        ]),
      ),
    );
    const j = await res.json();
    const msg = j.choices[0].message;
    assert.equal(msg.tool_calls[0].function.name, "bash");
    assert.equal(msg.tool_calls[0].function.arguments, '{"cmd":"ls"}');
    assert.equal(j.choices[0].finish_reason, "tool_calls");
  });

  it("纯错误帧 → 502 JSON", async () => {
    const res = await aggregateChatSse(sseResponse(sse([{ error: { type: "FreeTierError", message: "nope" } }])));
    assert.equal(res.status, 502);
    const j = await res.json();
    assert.equal(j.error.type, "FreeTierError");
  });
});

describe("upstream free lane 集成", () => {
  const chatSse = sse([
    { id: "x", model: "big-pickle", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
  ]);

  it("免费模型非流式调用：请求被整形为 agent 形状，响应聚合回 JSON", async () => {
    let captured = null;
    const client = createUpstreamClient({
      fetchImpl: async (url, opts) => {
        captured = { url, opts, body: JSON.parse(opts.body) };
        return sseResponse(chatSse);
      },
    });
    const res = await client.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: false });
    const j = await res.json();
    assert.equal(captured.body.stream, true, "上游必须收到 stream:true");
    const names = captured.body.tools.map((t) => t.function.name);
    for (const n of CORE_AGENT_TOOL_NAMES) assert.ok(names.includes(n), `缺核心工具 ${n}`);
    assert.match(captured.opts.headers.Accept, /event-stream/);
    assert.equal(j.choices[0].message.content, "ok");
    await client.close();
  });

  it("非免费模型：不改形状", async () => {
    let captured = null;
    const client = createUpstreamClient({
      fetchImpl: async (url, opts) => {
        captured = { body: JSON.parse(opts.body) };
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.chat({ model: "some-paid-model", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(captured.body.stream, false);
    assert.equal(captured.body.tools, undefined);
    await client.close();
  });
});
