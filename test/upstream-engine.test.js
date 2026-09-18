import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolveEngineMode, createUpstreamEngine } from "../src/upstream-engine/index.js";
import { attemptOnceResponsesSdk } from "../src/upstream-engine/sdk/responses.js";

function stub(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}`;
async function closeSrv(srv) { await new Promise((r) => srv.close(r)); srv.closeAllConnections?.(); }

function sseLine(delta, extra = {}) {
  return `data: ${JSON.stringify({
    id: "cmb-t", object: "chat.completion.chunk", created: 1, model: "big-pickle",
    choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
  })}\n\n`;
}
function openaiSseServer(onCapture) {
  return stub((req, res, body) => {
    if (onCapture) onCapture(req, body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sseLine({ role: "assistant", content: "", reasoning_content: "让我" }));
    res.write(sseLine({ content: "", reasoning_content: "想想" }));
    res.write(sseLine({ content: "答案" }));
    res.write(sseLine({}, { finish_reason: "stop" }));
    res.end("data: [DONE]\n\n");
  });
}

test("resolveEngineMode：缺省/非法=sdk，显式 legacy 或关闭词=legacy", () => {
  assert.equal(resolveEngineMode({}), "sdk", "缺省即投入 sdk");
  assert.equal(resolveEngineMode({ MSLXDFF_UPSTREAM_ENGINE: "" }), "sdk");
  assert.equal(resolveEngineMode({ MSLXDFF_UPSTREAM_ENGINE: " SDK " }), "sdk");
  assert.equal(resolveEngineMode({ MSLXDFF_UPSTREAM_ENGINE: "garbage" }), "sdk");
  assert.equal(resolveEngineMode({ MSLXDFF_UPSTREAM_ENGINE: "legacy" }), "legacy");
  for (const w of ["0", "off", "false", "no", "disable", "disabled"]) {
    assert.equal(resolveEngineMode({ MSLXDFF_UPSTREAM_ENGINE: w }), "legacy", `关闭词 ${w}`);
  }
});

test("resolveEngineMode：供应商级开关局部覆盖，未设置则继承全局总闸", () => {
  const W = "MSLXDFF_WORKBUDDY_SDK";
  assert.equal(resolveEngineMode({}, W), "sdk", "双缺省=sdk");
  assert.equal(resolveEngineMode({ [W]: "1" }, W), "sdk", "旧写法 1 落非关闭词=sdk");
  assert.equal(resolveEngineMode({ [W]: "legacy" }, W), "legacy", "局部 legacy");
  assert.equal(resolveEngineMode({ [W]: "0" }, W), "legacy", "局部关闭词");
  assert.equal(resolveEngineMode({ MSLXDFF_UPSTREAM_ENGINE: "legacy" }, W), "legacy", "未设置则继承全局熔断");
  assert.equal(resolveEngineMode({ MSLXDFF_UPSTREAM_ENGINE: "legacy", [W]: "1" }, W), "sdk", "局部覆盖全局");
  assert.equal(resolveEngineMode({ MSLXDFF_UPSTREAM_ENGINE: "legacy" }, "MSLXDFF_UPSTREAM_ENGINE"), "legacy", "全局键自身不回退");
});

test("sdk 模式：zen 流式 chat 走 SDK 引擎（身份头 + 帧 + 标记）", async () => {
  let captured = null;
  const srv = await openaiSseServer((req, body) => { captured = { url: req.url, headers: req.headers, body }; });
  try {
    const engine = createUpstreamEngine({ baseUrl: urlOf(srv), env: { MSLXDFF_UPSTREAM_ENGINE: "sdk" } });
    const res = await engine.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-mslxdff-upstream-engine"), "sdk", "引擎标记头");
    const text = await res.text();
    assert.ok(text.includes('"reasoning_content":"让我"'), "reasoning 帧到达");
    assert.ok(text.includes('"content":"答案"'), "content 帧到达");
    assert.ok(text.includes('"finish_reason":"stop"'), "finish 帧到达");
    assert.ok(text.trimEnd().endsWith("[DONE]"), "[DONE] 结尾");
    assert.equal(captured.url, "/zen/v1/chat/completions");
    assert.equal(captured.headers["x-opencode-client"], "desktop");
    assert.match(String(captured.headers["x-opencode-session"] || ""), /^ses_/);
    assert.match(String(captured.headers["user-agent"]), /ai-sdk\/openai-compatible/, "SDK UA 出现即走 SDK 引擎");
    await engine.close();
  } finally { await closeSrv(srv); }
});

test("sdk 模式：responses 类模型走 responses 适配器（不委派 legacy）", async () => {
  let responsesSeen = null;
  let legacyHit = null;
  const srv = await stub((req, res) => { legacyHit = req.url; res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  try {
    const engine = createUpstreamEngine({
      baseUrl: urlOf(srv),
      env: { MSLXDFF_UPSTREAM_ENGINE: "sdk" },
      sdkFactory: () => ({ chat: async () => { throw new Error("chat 适配器不应被 responses 模型调用"); } }),
      responsesFactory: (opts) => ({
        chat: async (body) => {
          responsesSeen = { opts, model: body.model };
          return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream", "x-mslxdff-upstream-engine": "sdk" } });
        },
      }),
    });
    const res = await engine.chat({ model: "muse-spark-1.3-contributor-free", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-mslxdff-upstream-engine"), "sdk");
    assert.ok(responsesSeen, "responses 适配器被调用");
    assert.equal(responsesSeen.model, "muse-spark-1.3-contributor-free");
    assert.equal(typeof responsesSeen.opts.fetchImpl, "function", "连接池注入 responses 适配器");
    assert.equal(legacyHit, null, "未触及 legacy 上游");
    await engine.close();
  } finally { await closeSrv(srv); }
});

test("sdk 模式：非流式请求委派 legacy（JSON 透传不被 SSE 化）", async () => {
  let captured = null;
  const srv = await stub((req, res) => {
    captured = { url: req.url, headers: req.headers };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  });
  try {
    const engine = createUpstreamEngine({ baseUrl: urlOf(srv), env: { MSLXDFF_UPSTREAM_ENGINE: "sdk" } });
    const res = await engine.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-mslxdff-upstream-engine"), null);
    assert.match(String(res.headers.get("content-type")), /application\/json/);
    const j = JSON.parse(await res.text());
    assert.equal(j.choices[0].message.content, "ok");
    assert.ok(!/ai-sdk/.test(String(captured.headers["user-agent"])));
    await engine.close();
  } finally { await closeSrv(srv); }
});

test("sdk 模式：SDK 装载失败（Node16/未安装）自动回退 legacy 且只告警一次", async () => {
  let captured = null;
  const srv = await openaiSseServer((req) => { captured = { url: req.url, headers: req.headers }; });
  try {
    let calls = 0;
    const engine = createUpstreamEngine({
      baseUrl: urlOf(srv),
      env: { MSLXDFF_UPSTREAM_ENGINE: "sdk" },
      sdkFactory: () => ({
        chat: async () => {
          calls += 1;
          const e = new Error("sdk not available");
          e._sdkLoadFailed = true;
          throw e;
        },
      }),
    });
    const res = await engine.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 200, "回退后服务正常");
    assert.equal(res.headers.get("x-mslxdff-upstream-engine"), null, "回退后无标记");
    assert.ok(!/ai-sdk/.test(String(captured.headers["user-agent"])), "回退后走 legacy 请求");
    assert.equal(calls, 1);
    await engine.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(calls, 1, "降级后不再尝试 SDK");
    await engine.close();
  } finally { await closeSrv(srv); }
});

test("默认（无开关）：引擎=sdk，缺省即走 AI SDK", async () => {
  let captured = null;
  const srv = await openaiSseServer((req) => { captured = { url: req.url, headers: req.headers }; });
  try {
    const engine = createUpstreamEngine({ baseUrl: urlOf(srv), env: {} });
    const res = await engine.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-mslxdff-upstream-engine"), "sdk", "缺省引擎标记");
    assert.match(String(captured.headers["user-agent"]), /ai-sdk\/openai-compatible/);
    const text = await res.text();
    assert.ok(text.includes('"content":"答案"'));
    await engine.close();
  } finally { await closeSrv(srv); }
});

test("sdk 模式：复用 legacy 连接池（fetchImpl 透传到适配器）", async () => {
  let seen = null;
  const engine = createUpstreamEngine({
    baseUrl: "http://127.0.0.1:1",
    env: {},
    sdkFactory: (opts) => ({ chat: async () => { seen = opts; return new Response("data: [DONE]\n\n"); } }),
  });
  await engine.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(typeof seen.fetchImpl, "function", "keep-alive dispatcher 以 fetch 形式注入 SDK");
  await engine.close();
});

test("一致性夹具：同上游同请求，legacy 与 sdk 语义帧等价", async () => {
  const srv = await openaiSseServer(null);
  const baseUrl = urlOf(srv);
  try {
    // legacy：transport 的 stream() 逐事件 yield（JSON 文本）
    const legacy = createUpstreamEngine({ baseUrl, env: { MSLXDFF_UPSTREAM_ENGINE: "legacy" } });
    const lres = await legacy.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true });
    const lframes = [];
    for await (const ev of lres.stream()) {
      try { lframes.push(JSON.parse(ev)); } catch {}
    }
    await legacy.close();
    // sdk：读 Response body 的 SSE 帧
    const sdk = createUpstreamEngine({ baseUrl, env: {} });
    const sres = await sdk.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true });
    const stext = await sres.text();
    const sframes = [...stext.matchAll(/data: ([^\n]+)/g)]
      .map((m) => m[1].trim())
      .filter((s) => s && s !== "[DONE]")
      .map((s) => JSON.parse(s));
    await sdk.close();

    const agg = (frames) => ({
      reasoning: frames.map((f) => f.choices?.[0]?.delta?.reasoning_content ?? "").join(""),
      content: frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join(""),
      finish: frames.map((f) => f.choices?.[0]?.finish_reason).filter(Boolean).pop() ?? null,
    });
    assert.deepEqual(agg(sframes), agg(lframes), "两引擎语义聚合一致");
    assert.equal(agg(sframes).content, "答案");
    assert.equal(agg(sframes).reasoning, "让我想想");
    assert.equal(agg(sframes).finish, "stop");
    assert.ok(stext.trimEnd().endsWith("[DONE]"));
  } finally { await closeSrv(srv); }
});

test("responses 适配器：/responses 落点 + 帧序列化 + 标记（注入假 @ai-sdk/openai）", async () => {
  const parts = [
    { type: "response-metadata", id: "resp_1", modelId: "muse-spark-1.3-contributor-free" },
    { type: "reasoning-delta", delta: "想" },
    { type: "text-delta", delta: "答案" },
    { type: "finish", finishReason: { unified: "stop" } },
  ];
  let captured = null;
  const sdkLoader = async () => ({
    createOpenAI: (opts) => {
      captured = opts;
      return { responses: () => ({ doStream: async () => ({ stream: (async function* () { for (const p of parts) yield p; })() }) }) };
    },
  });
  const res = await attemptOnceResponsesSdk({
    url: "http://127.0.0.1:9/zen/v1/responses",
    body: { model: "muse-spark-1.3-contributor-free", messages: [{ role: "user", content: "hi" }] },
    headers: { Authorization: "", "x-opencode-client": "desktop", "Content-Type": "application/json" },
    marker: { name: "x-mslxdff-upstream-engine", value: "sdk" },
    sdkLoader,
  });
  assert.equal(captured.baseURL, "http://127.0.0.1:9/zen/v1", "剥掉 /responses 得 baseURL");
  assert.equal(captured.headers["x-opencode-client"], "desktop");
  assert.equal(captured.headers["Content-Type"], undefined, "Content-Type 由 SDK 固定");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-mslxdff-upstream-engine"), "sdk");
  const text = await res.text();
  assert.ok(text.includes('"content":"答案"'), "content 帧");
  assert.ok(text.includes('"reasoning_content":"想"'), "reasoning 帧");
  assert.ok(text.includes('"finish_reason":"stop"'));
  assert.ok(text.trimEnd().endsWith("[DONE]"));
});

test("responses 适配器：HTTP 错误映射状态码 / 装载失败抛 _sdkLoadFailed", async () => {
  const errLoader = async () => ({
    createOpenAI: () => ({ responses: () => ({ doStream: async () => { const e = new Error("quota"); e.statusCode = 429; e.responseBody = '{"error":"rate"}'; throw e; } }) }),
  });
  const res = await attemptOnceResponsesSdk({
    url: "http://127.0.0.1:9/zen/v1/responses",
    body: { model: "muse-spark-1.3-contributor-free", messages: [] },
    marker: { name: "x-mslxdff-upstream-engine", value: "sdk" },
    sdkLoader: errLoader,
  });
  assert.equal(res.status, 429, "HTTP 错误映射为带状态码 Response");
  assert.equal(res.headers.get("x-mslxdff-upstream-engine"), "sdk");
  assert.equal(await res.text(), '{"error":"rate"}');

  const badLoader = async () => { throw new Error("no module"); };
  await assert.rejects(
    () => attemptOnceResponsesSdk({ url: "http://127.0.0.1:9/zen/v1/responses", body: { model: "m", messages: [] }, sdkLoader: badLoader }),
    (e) => e._sdkLoadFailed === true,
    "装载失败标记 _sdkLoadFailed 供引擎回退",
  );
});

test("agent 形状门禁：免费模型非流式经 engine 委派 legacy 并聚合回 JSON（上游 SSE）", async () => {
  let captured = null;
  const srv = await openaiSseServer((req, body) => { captured = JSON.parse(body); });
  try {
    const engine = createUpstreamEngine({ baseUrl: urlOf(srv), env: { MSLXDFF_UPSTREAM_ENGINE: "sdk" } });
    const res = await engine.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get("content-type")), /application\/json/);
    const j = await res.json();
    assert.equal(j.choices[0].message.content, "答案");
    assert.equal(captured.stream, true, "上游收到强制流式");
    const names = (captured.tools || []).map((t) => t.function?.name);
    for (const n of ["bash", "edit", "glob", "grep", "read"]) assert.ok(names.includes(n), `缺核心工具 ${n}`);
    await engine.close();
  } finally { await closeSrv(srv); }
});

test("agent 形状门禁：SDK 流式路径请求体也补核心五工具", async () => {
  let captured = null;
  const srv = await openaiSseServer((req, body) => { captured = JSON.parse(body); });
  try {
    const engine = createUpstreamEngine({ baseUrl: urlOf(srv), env: { MSLXDFF_UPSTREAM_ENGINE: "sdk" } });
    const res = await engine.chat({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-mslxdff-upstream-engine"), "sdk");
    const names = (captured.tools || []).map((t) => t.function?.name || t.name);
    for (const n of ["bash", "edit", "glob", "grep", "read"]) assert.ok(names.includes(n), `缺核心工具 ${n}`);
    await engine.close();
  } finally { await closeSrv(srv); }
});
