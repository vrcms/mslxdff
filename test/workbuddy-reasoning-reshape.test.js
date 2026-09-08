import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

function stub(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
function urlOf(srv) { return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv) { await new Promise((r) => srv.close(r)); srv.closeAllConnections?.(); }

function sseChunk(delta, extra = {}) {
  return `data: ${JSON.stringify({
    id: "cmb-test",
    model: "test-model",
    object: "chat.completion.chunk",
    created: 1788834056,
    choices: [{ index: 0, delta, finish_reason: "", ...extra }],
    usage: null,
  })}\n\n`;
}

async function collectStream(res) {
  const text = await res.text();
  return text.split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]")).map((l) => {
    try { return JSON.parse(l.slice(5).trim()); } catch { return null; }
  }).filter(Boolean);
}

async function makeProvider(baseUrl) {
  const { createWorkbuddyProvider } = await import("../src/providers/workbuddy/index.js");
  const p = createWorkbuddyProvider({
    baseUrl,
    apiKeys: ["k1"],
    auths: [{ uid: "uid-a", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt" }],
    logger: { append() {} },
  });
  return p;
}

test("US1: 碎片 reasoning_content 聚合为单个 reasoning 帧，content 前一次性 flush", async () => {
  const srv = await stub((req, res) => {
    if (!req.url.includes("/v2/chat/completions")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { accessToken: "k1" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sseChunk({ role: "assistant", content: "", reasoning_content: "让我" }) +
      sseChunk({ content: "", reasoning_content: "想想" }) +
      sseChunk({ content: "", reasoning_content: "怎么" }) +
      sseChunk({ content: "答案", reasoning_content: "" }) +
      sseChunk({}, { finish_reason: "stop" }) +
      "data: [DONE]\n\n"
    );
  });
  try {
    const p = await makeProvider(urlOf(srv));
    const res = await p.chat({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    const frames = await collectStream(res);
    const reasoningFrames = frames.filter((f) => f.choices?.[0]?.delta?.reasoning_content);
    assert.equal(reasoningFrames.length, 1, `应恰好 1 个 reasoning 帧，实际 ${reasoningFrames.length}`);
    assert.equal(reasoningFrames[0].choices[0].delta.reasoning_content, "让我想想怎么");
    const contentFrames = frames.filter((f) => f.choices?.[0]?.delta?.content);
    assert.equal(contentFrames.length, 1);
    assert.equal(contentFrames[0].choices[0].delta.content, "答案");
    assert.equal(reasoningFrames[0].id, "cmb-test", "上游 id 保留");
    assert.equal(reasoningFrames[0].model, "test-model", "上游 model 保留");
    await p.close();
  } finally { await closeSrv(srv); }
});

test("US2: 只有 reasoning 直到流结束 → 结束前 flush 单块 + finish/DONE 正常", async () => {
  const srv = await stub((req, res) => {
    if (!req.url.includes("/v2/chat/completions")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { accessToken: "k1" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sseChunk({ role: "assistant", content: "", reasoning_content: "思考A" }) +
      sseChunk({ content: "", reasoning_content: "思考B" }) +
      sseChunk({}, { finish_reason: "stop" }) +
      "data: [DONE]\n\n"
    );
  });
  try {
    const p = await makeProvider(urlOf(srv));
    const res = await p.chat({ model: "glm-5.3-flash", messages: [] });
    const raw = await res.text();
    assert.ok(raw.includes("[DONE]"));
    const frames = raw.split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(5).trim()));
    const reasoningFrames = frames.filter((f) => f.choices?.[0]?.delta?.reasoning_content);
    assert.equal(reasoningFrames.length, 1);
    assert.equal(reasoningFrames[0].choices[0].delta.reasoning_content, "思考A思考B");
    const finishFrames = frames.filter((f) => f.choices?.[0]?.finish_reason === "stop");
    assert.equal(finishFrames.length, 1, "finish_reason 帧保留");
    await p.close();
  } finally { await closeSrv(srv); }
});

test("US3: 恒空 reasoning 的 content 流（deepseek-v4-flash 形态）帧序不变", async () => {
  const srv = await stub((req, res) => {
    if (!req.url.includes("/v2/chat/completions")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { accessToken: "k1" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sseChunk({ role: "assistant", content: "", reasoning_content: "" }) +
      sseChunk({ content: "一个", reasoning_content: "" }) +
      sseChunk({ content: "以探索", reasoning_content: "" }) +
      sseChunk({}, { finish_reason: "stop" }) +
      "data: [DONE]\n\n"
    );
  });
  try {
    const p = await makeProvider(urlOf(srv));
    const res = await p.chat({ model: "deepseek-v4-flash", messages: [] });
    const frames = await collectStream(res);
    assert.equal(frames.length, 4, "帧数不变");
    assert.equal(frames[1].choices[0].delta.content, "一个");
    assert.equal(frames[2].choices[0].delta.content, "以探索", "content 逐帧原样，不被合并");
    assert.ok(!frames.some((f) => f.choices?.[0]?.delta?.reasoning_content), "无 reasoning 帧产生");
    await p.close();
  } finally { await closeSrv(srv); }
});

test("US4: 非 event-stream 的 JSON Response 原样返回（不整形）", async () => {
  const { reshapeWorkbuddySse } = await import("../src/providers/workbuddy/reshape.js");
  const payload = JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" } }] });
  const fake = new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } });
  const out = reshapeWorkbuddySse(fake);
  assert.equal(out, fake, "非 SSE 必须返回原 Response 实例");
  const j = await out.json();
  assert.equal(j.choices[0].message.content, "ok");
});

test("US4b: 错误状态（4xx/5xx）原样返回不整形", async () => {
  const { reshapeWorkbuddySse } = await import("../src/providers/workbuddy/reshape.js");
  const fake = new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "text/event-stream" } });
  const out = reshapeWorkbuddySse(fake);
  assert.equal(out, fake);
});
