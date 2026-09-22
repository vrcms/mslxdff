import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGenericProvider } from "../src/providers/generic.js";

// 假上游：记录收到的 url/body/headers，按 responses / chat 形状回包。
// 全程注入 fetchImpl + 显式传 chatPath/modelsPath，不读真实 state（无凭据参与）。
function fakeUpstream({ responsesStatus = 200 } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    seen.push({ url, headers: init.headers || {}, body });
    if (String(url).endsWith("/responses")) {
      if (responsesStatus !== 200) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: responsesStatus, headers: { "content-type": "application/json" } });
      }
      if (body.stream === true) {
        const sse = [
          'data: {"type":"response.created","response":{"id":"resp_1","model":"muse-spark-1.3-contributor","status":"in_progress"}}',
          "",
          'data: {"type":"response.output_text.delta","delta":"hi there"}',
          "",
          'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"muse-spark-1.3-contributor"}}',
          "",
        ].join("\n");
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        id: "resp_1", model: "muse-spark-1.3-contributor", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "chat_1", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "plain chat" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchImpl };
}

const mk = (over = {}) => createGenericProvider({
  id: "ocgo",
  baseUrl: "https://opencode.ai/zen/go/v1",
  apiKeys: ["sk-test"],
  modelsPath: "/models",
  chatPath: "/chat/completions",
  noAgent: true,
  ...over,
});

async function readAll(res) {
  const chunks = [];
  for await (const c of res.body) chunks.push(Buffer.from(c).toString("utf8"));
  return chunks.join("");
}

describe("generic provider：responses 类模型走 /responses", () => {
  const prevEngine = process.env.MSLXDFF_OCGO_SDK;
  test("setup: 关 SDK 走原生通道（确定性）", () => { process.env.MSLXDFF_OCGO_SDK = "legacy"; });

  test("非流式 muse-spark → POST /responses + responses 形状请求体 + chat.completion 响应", async () => {
    const { seen, fetchImpl } = fakeUpstream();
    const p = mk({ fetchImpl });
    const res = await p.chat({ model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/zen\/go\/v1\/responses$/, "必须打 /responses，不是 /chat/completions");
    assert.equal(seen[0].body.input, "user: hi", "chat messages 必须转成 responses input");
    assert.ok(!("messages" in seen[0].body), "responses 请求体不应带 messages");
    assert.equal(seen[0].body.stream, false, "非流式意图透传");
    const j = await res.json();
    assert.equal(j.object, "chat.completion", "回包必须转回 chat 形状");
    assert.equal(j.choices[0].message.content, "hi there");
    await p.close();
  });

  test("流式 muse-spark → responses SSE 转成 chat.completion.chunk 帧", async () => {
    const { seen, fetchImpl } = fakeUpstream();
    const p = mk({ fetchImpl });
    const res = await p.chat({ model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.match(seen[0].url, /\/responses$/);
    assert.equal(seen[0].body.stream, true);
    const txt = await readAll(res);
    assert.match(txt, /"object":"chat\.completion\.chunk"/, "应产出 chat SSE chunk");
    assert.match(txt, /hi there/, "正文应透到 chunk");
    assert.match(txt, /\[DONE\]/, "收尾应有 DONE");
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    await p.close();
  });

  test("非 responses 模型（mimo/deepseek）仍打 /chat/completions，行为不变", async () => {
    const { seen, fetchImpl } = fakeUpstream();
    const p = mk({ fetchImpl });
    const res = await p.chat({ model: "mimo-v2.5", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.match(seen[0].url, /\/chat\/completions$/, "chat 模型不该被改路由");
    const j = await res.json();
    assert.equal(j.choices[0].message.content, "plain chat");
    await p.close();
  });

  test("opencode.ai 域名身份头在 responses 路径同样带上（防 400 MissingSessionID）", async () => {
    const { seen, fetchImpl } = fakeUpstream();
    const p = mk({ fetchImpl });
    await p.chat({ model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], stream: false }, { sessionId: "aff-1" });
    const h = seen[0].headers;
    assert.match(h["x-opencode-session"], /^ses_.{26}$/, "session 必须 opencode 形状");
    assert.match(h["User-Agent"], /^opencode\//, "UA 必须带版本");
    assert.equal(h["x-opencode-client"], "desktop");
    assert.equal(h["Authorization"], "Bearer sk-test", "responses 路径同样带 key");
    await p.close();
  });

  test("同 sessionId → 同 x-opencode-session（会话亲和跨端点仍成立）", async () => {
    const { seen, fetchImpl } = fakeUpstream();
    const p = mk({ fetchImpl });
    const body = { model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], stream: false };
    await p.chat(body, { sessionId: "aff-2" });
    await p.chat(body, { sessionId: "aff-2" });
    assert.equal(seen[0].headers["x-opencode-session"], seen[1].headers["x-opencode-session"]);
    await p.close();
  });

  test("上游 5xx → 原样返回错误且不吞状态码（不伪装成 200）", async () => {
    const { seen, fetchImpl } = fakeUpstream({ responsesStatus: 503 });
    const p = mk({ fetchImpl, retry: { network: { attempts: 0, delayMs: 0 }, 503: { attempts: 1, delayMs: 0 } } });
    const res = await p.chat({ model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 503);
    assert.ok(seen.length >= 2, "503 应按 retry 表重试一次");
    await p.close();
  });

  test("key 冷却后再次请求 → 人话报错 all API keys are in cooldown", async () => {
    const { fetchImpl } = fakeUpstream({ responsesStatus: 429 });
    const p = mk({ fetchImpl, cooldownMs: 60_000, retry: { network: { attempts: 0, delayMs: 0 }, 429: { attempts: 0, delayMs: 0 } } });
    const body = { model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], stream: false };
    const first = await p.chat(body);
    assert.equal(first.status, 429, "首次应原样回 429");
    await assert.rejects(() => p.chat(body), /all API keys are in cooldown/, "二次应命中冷却短路");
    await p.close();
  });

  test("chatWithKeys 对 responses 模型同样走 /responses（组员借 key 不退化成 chat）", async () => {
    const { seen, fetchImpl } = fakeUpstream();
    const p = mk({ fetchImpl });
    await p.chatWithKeys({ model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], stream: false }, ["sk-borrowed"]);
    assert.match(seen[0].url, /\/responses$/);
    assert.equal(seen[0].headers["Authorization"], "Bearer sk-borrowed");
    await p.close();
  });

  test("teardown: 还原 env", () => {
    if (prevEngine === undefined) delete process.env.MSLXDFF_OCGO_SDK;
    else process.env.MSLXDFF_OCGO_SDK = prevEngine;
    assert.ok(true);
  });
});
