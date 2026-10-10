// /v1/messages 端点级测试：Anthropic 外壳端到端（真 router + stub 上游）+ 垫片收口单测。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createAnthropicForwarder } from "../src/routes/messages-route.js";
import { createAnthropicChunkTranslator } from "../src/anthropic/translate.js";

const TOKEN = "a".repeat(64);
const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

function stubUpstream(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

async function boot(upstreamHandler) {
  const up = await stubUpstream(upstreamHandler);
  const client = createUpstreamClient({ baseUrl: `http://127.0.0.1:${up.address().port}`, retry: {} });
  const srv = startServer({ router: createRouter({ token: TOKEN, upstream: client }) }, 0);
  await srv.ready();
  const port = srv.server.address().port;
  return {
    port,
    close: async () => {
      await srv.close();
      srv.server.closeAllConnections?.();
      await new Promise((r) => up.close(r));
      up.closeAllConnections?.();
    },
  };
}

const chatJsonHandler = (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    id: "chatcmpl-1",
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  }));
};

test("401 无 Bearer，且带 WWW-Authenticate", async () => {
  const app = await boot(chatJsonHandler);
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "m", max_tokens: 8, messages: [] }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
  } finally { await app.close(); }
});

test("坏 JSON body → 400 anthropic 错误形状", async () => {
  const app = await boot(chatJsonHandler);
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages`, { method: "POST", headers: AUTH, body: "{坏掉的" });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.type, "error");
    assert.equal(j.error.type, "invalid_request_error");
  } finally { await app.close(); }
});

test("缺 model → 400 invalid_request_error", async () => {
  const app = await boot(chatJsonHandler);
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.type, "invalid_request_error");
  } finally { await app.close(); }
});

test("?beta=true 命中 + 非流式返回 Anthropic message", async () => {
  const app = await boot(chatJsonHandler);
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages?beta=true`, {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ model: "m", max_tokens: 8, system: [{ type: "text", text: "be nice" }], messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.id.startsWith("msg_"));
    assert.equal(j.type, "message");
    assert.equal(j.role, "assistant");
    assert.deepEqual(j.content, [{ type: "text", text: "你好" }]);
    assert.equal(j.stop_reason, "end_turn");
    assert.equal(j.usage.input_tokens, 12);
    assert.equal(j.usage.output_tokens, 3);
  } finally { await app.close(); }
});

test("流式：具名 event: 帧、无 [DONE]、以 message_stop 收尾", async () => {
  const app = await boot((req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"content":"好"}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
    res.end("data: [DONE]\n\n");
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages?beta=true`, {
      method: "POST", headers: { ...AUTH, Accept: "text/event-stream" },
      body: JSON.stringify({ model: "m", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const text = await res.text();
    assert.ok(!text.includes("[DONE]"), "Anthropic 协议无 [DONE] 哨兵");
    assert.ok(!text.includes("data: ["), "不得混入 OpenAI 风格裸数组帧");
    const named = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    assert.equal(named[0], "message_start");
    assert.equal(named[named.length - 1], "message_stop");
    for (const want of ["content_block_start", "content_block_delta", "content_block_stop"]) assert.ok(named.includes(want), `缺事件 ${want}`);
    assert.ok(named.includes("message_delta"));
    assert.match(text, /"text_delta","text":"你"/);
    assert.match(text, /"stop_reason":"end_turn"/);
    assert.match(text, /"input_tokens":9/);
  } finally { await app.close(); }
});

test("count_tokens：200 正整数，无凭据 401", async () => {
  const app = await boot(chatJsonHandler);
  try {
    const ok = await fetch(`http://127.0.0.1:${app.port}/v1/messages/count_tokens`, {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "x".repeat(400) }] }),
    });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.ok(Number.isInteger(j.count_tokens) && j.count_tokens >= 100, `实得 ${JSON.stringify(j)}`);
    const no = await fetch(`http://127.0.0.1:${app.port}/v1/messages/count_tokens`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(no.status, 401);
  } finally { await app.close(); }
});

// ---------- 垫片收口（不经 HTTP，构造 pipeline 侧写入） ----------

function fakeRes() {
  const chunks = [];
  return {
    chunks,
    statusCode: undefined,
    headers: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    setHeader(k, v) { this.headers = { ...(this.headers || {}), [k]: v }; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c != null) chunks.push(String(c)); this.ended = true; },
    text() { return chunks.join(""); },
  };
}

test("垫片：上游一动静即落头；in-band 错误改发 event: error 且不补 message_stop", () => {
  const real = fakeRes();
  const t = createAnthropicChunkTranslator("m");
  const shim = createAnthropicForwarder(real, t, { pingMs: 0 });
  shim.write('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
  assert.equal(real.headers["Content-Type"], "text/event-stream");
  // pipeline 用 OpenAI 形状收口错误（helpers.js:33-39）
  shim.write('data: {"error":{"message":"上游炸了","type":"mslxdff_error"}}\n\n');
  shim.write("data: [DONE]\n\n");
  shim.end();
  const text = real.text();
  assert.ok(text.includes("event: error"), "必须发 Anthropic error 帧");
  assert.match(text, /上游炸了/);
  assert.ok(!text.includes("message_stop"), "错误路径不伪装成功收场（grill Q2）");
  assert.ok(!text.includes("[DONE]"));
});

test("垫片：错误在头未发时走干净 JSON，不进事件流", () => {
  const real = fakeRes();
  const t = createAnthropicChunkTranslator("m");
  const shim = createAnthropicForwarder(real, t, { pingMs: 0 });
  shim.statusCode = 502;
  shim.end('data: {"error":{"message":"no upstream"}}\n\n');
  assert.equal(real.status, undefined, "不应已 writeHead");
  const body = JSON.parse(real.text());
  assert.equal(body.type, "error");
  assert.match(body.error.message, /no upstream/);
});

test("垫片：空闲自发 ping，周期 0 关闭", () => {
  const real = fakeRes();
  const t = createAnthropicChunkTranslator("m");
  const shim = createAnthropicForwarder(real, t, { pingMs: 5 });
  shim.write('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n');
  return new Promise((resolve) => setTimeout(() => {
    assert.ok(real.text().includes("event: ping"), `未见 ping：${real.text()}`);
    shim.end();
    resolve();
  }, 30));
});

// ---------- 第 1 轮评审补的收口断言（P0-1/P0-2/P0-3）+ 第 2 轮补的分片聚合 ----------

test("空 messages → 400，绝不伪造请求打上游", async () => {
  let hits = 0;
  const app = await boot((req, res) => { hits++; chatJsonHandler(req, res); });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages?beta=true`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ model: "m", max_tokens: 8, messages: [] }),
    });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.type, "error");
    assert.equal(j.error.type, "invalid_request_error");
    assert.equal(hits, 0, "校验失败的请求不许出现在上游");
  } finally { await app.close(); }
});

test("垫片：headersSent/getHeader 说真话（helpers.js 的 in-band 守卫全靠它）", () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  assert.equal(shim.headersSent, false);
  assert.equal(shim.getHeader("content-type"), undefined);
  shim.write('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n');
  assert.equal(shim.headersSent, true, "已发头必须报真，否则错误会被当正文静默吞掉");
  assert.equal(shim.getHeader("Content-Type"), "text/event-stream");
  assert.equal(shim.getHeader("x-whatever"), undefined);
});

test("垫片：没等到 finish_reason = 截断，发 error 且绝不补 message_stop", () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  shim.write('data: {"choices":[{"index":0,"delta":{"content":"说到一半"}}]}\n\n');
  shim.end();
  const text = real.text();
  assert.match(text, /event: error/);
  assert.match(text, /no finish_reason/);
  assert.ok(!text.includes("message_delta"), "截断不补 message_delta");
  assert.ok(!text.includes("message_stop"), "截断不伪装成功收场");
  assert.equal(real.ended, true, "错误帧后必须关连接");
});

test("垫片：上游回聚合 JSON（无 data: 前缀）→ 正文不静默消失", () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  const agg = JSON.stringify({
    id: "chatcmpl-9",
    choices: [{ index: 0, message: { role: "assistant", content: "整包回来了" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 4 },
  });
  shim.write(agg);
  shim.end();
  const text = real.text();
  assert.match(text, /"text":"整包回来了"/);
  assert.ok(text.includes("event: message_stop"), "聚合兜底也要正常收场");
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.match(text, /"input_tokens":5/);
});

test("垫片：聚合 JSON 只出现在 end(body) 里也能兜住（pipeline 未 flush 的常见形状）", () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  shim.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "一次性回来" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 2 },
  }));
  const text = real.text();
  assert.match(text, /"text":"一次性回来"/);
  assert.ok(text.includes("event: message_stop"));
});

test("垫片：聚合 JSON 是错误体时只取 message，不把整坨 OpenAI JSON 塞进 error.message", () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  shim.statusCode = 502;
  shim.end(JSON.stringify({ error: { message: "上游没这个模型", type: "mslxdff_error" } }));
  assert.equal(real.statusCode, 502, "头未发时仍是干净 JSON + 真状态码");
  const body = JSON.parse(real.text());
  assert.equal(body.error.message, "上游没这个模型");
  assert.ok(!real.text().includes("mslxdff_error"), "不外泄内部错误形状");
});

test("垫片：逐字节 Buffer 投喂不把汉字切成 U+FFFD（上游按字节 flush 时正文不烂）", () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  const bytes = Buffer.from(
    'data: {"choices":[{"index":0,"delta":{"content":"汉字完整"}}]}\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "utf8",
  );
  for (let i = 0; i < bytes.length; i++) shim.write(bytes.subarray(i, i + 1));
  shim.end();
  const text = real.text();
  assert.ok(!text.includes("\uFFFD"), "不得出现替换字符");
  assert.match(text, /"text":"汉字完整"/);
  assert.ok(text.includes("event: message_stop"));
});

test("垫片：keepalive 注释帧即落头并武装 ping —— 首块之前也在呼吸", async () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 8 });
  shim.write(": keepalive\n\n"); // 上游/管道的注释帧，不产生任何 Anthropic 事件
  assert.equal(shim.headersSent, true, "注释帧也要落头，否则客户端在等首块时先超时");
  assert.ok(real.text().includes("event: message_start"));
  const before = real.text();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(real.text().length > before.length && real.text().includes("event: ping"), "静默期必须自发 ping");
  shim.end();
});

test("垫片：下游 close 后 ping 自动停（不留悬空定时器）", async () => {
  const real = fakeRes();
  let onClose = null;
  real.on = (ev, cb) => { if (ev === "close") onClose = cb; };
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 8 });
  shim.write('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n');
  assert.equal(typeof onClose, "function", "必须订阅下游 close");
  onClose();
  const before = real.text();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(real.text(), before, "close 后不许再写 ping");
});

test("垫片：聚合包被分多次 write 拼出（整包无换行时逐块攒字节，不误判成截断）", () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  const body = JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content: "分段送达" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  shim.write(body.slice(0, 30));
  shim.write(body.slice(30));
  shim.end();
  const text = real.text();
  assert.match(text, /"text":"分段送达"/);
  assert.ok(text.includes("event: message_stop"), "拼接成功即正常收场，不走截断");
  assert.ok(!text.includes("event: error"));
});

test("只带 x-api-key（无 Bearer）→ 401：外壳明确不支持 API_KEY 型鉴权", async () => {
  const app = await boot(chatJsonHandler);
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": TOKEN, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 401);
  } finally { await app.close(); }
});

// ---------- 第 2 轮评审 A 路补的收口断言 ----------

test("垫片：上游回 `{choices:[]}` 空包 → 按截断报错，不零正文谎报成功", () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  shim.end(JSON.stringify({ id: "chatcmpl-e", choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } }));
  const text = real.text();
  assert.ok(text.includes("event: error"), `空 choices 不是合法收场：${text}`);
  assert.ok(!text.includes("message_stop"), "零正文不得伪装 message_stop");
});

test("垫片：末帧没有收尾换行也要被逼出来（否则合法正文与 finish_reason 一起烂在缓冲里）", () => {
  const real = fakeRes();
  const NL = String.fromCharCode(10); // 用真换行拼帧，别在源码里写转义（易被双重转义坑）
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  shim.write('data: {"choices":[{"index":0,"delta":{"content":"末帧无换行"}}]}' + NL); // 帧之间有换行
  shim.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}'); // 末帧没有收尾换行
  shim.end();
  const text = real.text();
  assert.match(text, /"text":"末帧无换行"/);
  assert.ok(text.includes("event: message_stop"), "补换行后不得误判成截断");
  assert.ok(!text.includes("event: error"));
});

test("垫片：headersSent 与 getHeader 同源（真 res 已被外部发头时也不留全静默窗口）", () => {
  const real = fakeRes();
  real.headersSent = true; // 模拟外部组件已 flush 响应头
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  assert.equal(shim.headersSent, true);
  assert.equal(shim.getHeader("content-type"), "text/event-stream", "两个判据必须同源，否则 helpers.json() 会既不写 in-band 也不写 JSON");
  assert.equal(shim.writableEnded, false);
  shim.end();
  assert.equal(shim.writableEnded, true, "收场后 writableEnded 要报真（json() 的幂等早退靠它）");
});

test("垫片：超大非 SSE 体攒到上限即停手，错误文案如实说明（不静默继续攒）", () => {
  const real = fakeRes();
  const shim = createAnthropicForwarder(real, createAnthropicChunkTranslator("m"), { pingMs: 0 });
  shim.write('{"junk":"'.repeat(60000)); // > 256KB 且永远 parse 不出完整 JSON
  shim.end();
  const text = real.text();
  assert.ok(text.includes("event: error"), text.slice(0, 200));
  assert.match(text, /oversized non-SSE body/);
});

test("非流式请求 + 上游只会流式（workbuddy 写死 stream:true）→ SSE 聚合成 Anthropic message，不再 502", async () => {
  const app = await boot((req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"id":"cmb-1","choices":[{"index":0,"delta":{"content":"你"}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"content":"好"}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages`, {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ model: "workbuddy/deepseek-v4-flash", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.type, "message");
    assert.deepEqual(j.content, [{ type: "text", text: "你好" }]);
    assert.equal(j.stop_reason, "end_turn");
    assert.equal(j.usage.input_tokens, 7);
    assert.equal(j.usage.output_tokens, 2);
  } finally { await app.close(); }
});

test("非流式 + 上游 SSE 工具调用分片 → 拼成单个 tool_use 块（arguments 增量跨帧拼接）", async () => {
  const app = await boot((req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"北京\\"}"}}]}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":5}}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages`, {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ model: "workbuddy/glm-5.3-flash", max_tokens: 16, messages: [{ role: "user", content: "北京天气" }], tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }] }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.content.length, 1);
    assert.equal(j.content[0].type, "tool_use");
    assert.equal(j.content[0].name, "get_weather");
    assert.deepEqual(j.content[0].input, { city: "北京" });
    assert.equal(j.stop_reason, "tool_use");
  } finally { await app.close(); }
});

test("非流式 + 上游 SSE 夹 in-band 错误帧 → 502 报真实原因，绝不把错误聚合成正文", async () => {
  const app = await boot((req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"choices":[{"index":0,"delta":{"content":"半截"}}]}\n\n');
    res.write('data: {"error":{"message":"upstream dead"}}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/messages`, {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ model: "workbuddy/hy4-preview", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 502);
    const j = await res.json();
    assert.equal(j.type, "error");
    assert.equal(j.error.type, "api_error");
    assert.ok(j.error.message.includes("upstream dead"), j.error.message);
  } finally { await app.close(); }
});
