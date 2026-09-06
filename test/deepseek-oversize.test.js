import assert from "node:assert/strict";
import test from "node:test";

import { createDeepseekProvider } from "../src/providers/deepseek/index.js";
import { createDeepseekSseParser, splitPromptChunks, promptThresholdFor } from "../src/providers/deepseek/bridge.js";
import { deepSeekHashV1 } from "../src/providers/deepseek/hash.js";

const BASE = "https://chat.deepseek.com";
const EXPERT_THRESHOLD = 122_880;

// 真机抓包：expert 超长输入 → HTTP 200 + event:hint error + event:close（内容为空）
const HINT_SSE = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"expert"}',
  '',
  'event: hint',
  'data: {"type":"error","content":"内容超长，请删减后再试","clear_response":true,"finish_reason":"input_exceeds_limit"}',
  '',
  'event: close',
  'data: {"click_behavior":"none","auto_resume":false}',
  '',
  '',
].join("\n");

const OK_SSE = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"expert"}',
  '',
  'data: {"v":{"response":{"message_id":2,"role":"ASSISTANT","status":"WIP","fragments":[{"type":"RESPONSE","content":"回答"}]}}}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
  'event: close',
  'data: {"click_behavior":"none"}',
  '',
  '',
].join("\n");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function sseRes(text) {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function baseFake({ override, onCall } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, opts = {}) => {
      const path = String(url).replace(BASE, "");
      calls.push(path);
      if (onCall) onCall(path, opts, calls.length);
      if (override) {
        const custom = override(path, opts, calls.length);
        if (custom) return custom;
      }
      if (path === "/api/v0/chat_session/create") {
        return json({ code: 0, data: { biz_code: 0, biz_data: { chat_session: { id: "sess-1" } } } });
      }
      if (path === "/api/v0/chat/create_pow_challenge") {
        return json({ code: 0, data: { biz_code: 0, biz_data: { challenge: {
          algorithm: "DeepSeekHashV1",
          challenge: deepSeekHashV1("salt_1757000000_3"),
          salt: "salt",
          expire_at: 1757000000,
          signature: "sig",
          difficulty: 100,
          target_path: "/api/v0/chat/completion",
        } } } });
      }
      if (path === "/api/v0/chat_session/delete") return json({ code: 0, data: { biz_code: 0 } });
      return json({ msg: "no route" }, 404);
    },
  };
}

function makeProvider(fake) {
  return createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
}

// ── 阈值与切分（纯函数） ────────────────────────────────────────────────

test("promptThresholdFor: expert=122880, default/vision=1966080", () => {
  assert.equal(promptThresholdFor({ expert: true }), 122_880);
  assert.equal(promptThresholdFor({ expert: false }), 1_966_080);
  assert.equal(promptThresholdFor({}), 1_966_080);
});

test("splitPromptChunks: 硬切按字符数，拼接还原原文", () => {
  const prompt = "x".repeat(300_000);
  const chunks = splitPromptChunks(prompt, EXPERT_THRESHOLD);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, EXPERT_THRESHOLD);
  assert.equal(chunks[2].length, 300_000 - 2 * EXPERT_THRESHOLD);
  assert.equal(chunks.join(""), prompt);
});

test("splitPromptChunks: 恰好单块/空串", () => {
  assert.deepEqual(splitPromptChunks("abc", EXPERT_THRESHOLD), ["abc"]);
  assert.deepEqual(splitPromptChunks("", EXPERT_THRESHOLD), []);
});

// ── 01: hint 错误透传 ──────────────────────────────────────────────────

test("aggregate: hint error 非流 → 抛人话错而非空 200，且清理 session", async () => {
  let deleted = 0;
  const fake = baseFake({
    override: (path) => {
      if (path === "/api/v0/chat/completion") return sseRes(HINT_SSE);
      if (path === "/api/v0/chat_session/delete") { deleted += 1; return json({ code: 0, data: { biz_code: 0 } }); }
      return null;
    },
  });
  const provider = makeProvider(fake);
  await assert.rejects(
    () => provider.chat({ model: "deepseek/deepseek-chat-expert-free", messages: [{ role: "user", content: "hi" }] }),
    (err) => /内容超长/.test(String(err.message)) && /input_exceeds_limit/.test(String(err.message))
  );
  assert.equal(deleted, 1);
});

test("aggregate: hint rate_limit_reached 非流 → 抛限流人话错", async () => {
  const hint = HINT_SSE.replace("input_exceeds_limit", "rate_limit_reached").replace("内容超长，请删减后再试", "当前使用人数过多，请稍后再试");
  const fake = baseFake({ override: (path) => (path === "/api/v0/chat/completion" ? sseRes(hint) : null) });
  const provider = makeProvider(fake);
  await assert.rejects(
    () => provider.chat({ model: "deepseek/deepseek-chat-expert-free", messages: [{ role: "user", content: "hi" }] }),
    /使用人数过多|限流/
  );
});

test("stream: hint error → SSE error frame + [DONE]，不再补假 finish stop", async () => {
  const fake = baseFake({ override: (path) => (path === "/api/v0/chat/completion" ? sseRes(HINT_SSE) : null) });
  const provider = makeProvider(fake);
  const res = await provider.chat({ model: "deepseek/deepseek-reasoner-expert-free", messages: [{ role: "user", content: "hi" }], stream: true });
  const text = await res.text();
  assert.match(text, /"error".*内容超长/s);
  assert.match(text, /data: \[DONE\]/);
  const finishStops = text.match(/"finish_reason":"stop"/g) || [];
  assert.equal(finishStops.length, 0);
});

// ── 02: expert 分块 ────────────────────────────────────────────────────

function makeChunkFakeUpstream({ totalCompletions }) {
  const calls = [];
  const completions = [];
  const stops = [];
  let completionN = 0;
  const fetchImpl = async (url, opts = {}) => {
    const path = String(url).replace(BASE, "");
    calls.push(path);
    if (path === "/api/v0/chat_session/create") {
      return json({ code: 0, data: { biz_code: 0, biz_data: { chat_session: { id: "sess-chunk" } } } });
    }
    if (path === "/api/v0/chat/create_pow_challenge") {
      return json({ code: 0, data: { biz_code: 0, biz_data: { challenge: {
        algorithm: "DeepSeekHashV1",
        challenge: deepSeekHashV1("salt_1757000000_3"),
        salt: "salt",
        expire_at: 1757000000,
        signature: "sig",
        difficulty: 100,
        target_path: "/api/v0/chat/completion",
      } } } });
    }
    if (path === "/api/v0/chat/stop_stream") {
      stops.push({ body: JSON.parse(opts.body), headers: opts.headers || {} });
      return json({ code: 0, msg: "", data: { biz_code: 0, biz_msg: "", biz_data: null } });
    }
    if (path === "/api/v0/chat/completion") {
      completionN += 1;
      completions.push({ body: JSON.parse(opts.body), headers: opts.headers || {} });
      if (completionN < totalCompletions) {
        // 真机形态：ready → update_session（上游落库信号）→ close
        return sseRes([
          'event: ready',
          `data: {"request_message_id":${completionN * 2 - 1},"response_message_id":${completionN * 2},"model_type":"expert"}`,
          '',
          'event: update_session',
          'data: {"updated_at":1788621603.9065368}',
          '',
          'event: close',
          'data: {"click_behavior":"none"}',
          '',
          '',
        ].join("\n"));
      }
      return sseRes(OK_SSE);
    }
    if (path === "/api/v0/chat_session/delete") return json({ code: 0, data: { biz_code: 0 } });
    return json({ msg: "no route" }, 404);
  };
  return { calls, completions, stops, fetchImpl };
}

test("chunked: expert 40万字符非流 → 3 块喂养 + 末块正常生成，序列与 flags 正确", async () => {
  const prompt = "x".repeat(300_000); // > 122880 → 3 块
  const fake = makeChunkFakeUpstream({ totalCompletions: 3 });
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  const res = await provider.chat({ model: "deepseek/deepseek-reasoner-expert-free", messages: [{ role: "user", content: prompt }] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.choices[0].message.content, "回答");

  // 调用序：create → (pow → completion → stop_stream)×2 → pow → completion → delete
  const order = fake.calls.map((p) => p.split("?")[0]);
  assert.equal(order.filter((p) => p === "/api/v0/chat/completion").length, 3);
  assert.equal(fake.stops.length, 2);

  // 非末块：thinking/search 关、model_type=expert、parent 链、prompt 是切片
  const [c1, c2, c3] = fake.completions;
  assert.equal(c1.body.parent_message_id, null);
  assert.equal(c1.body.thinking_enabled, false);
  assert.equal(c1.body.search_enabled, false);
  assert.equal(c1.body.model_type, "expert");
  assert.equal(c1.body.prompt, prompt.slice(0, EXPERT_THRESHOLD));
  assert.equal(c2.body.parent_message_id, 2);
  assert.equal(c2.body.thinking_enabled, false);
  assert.equal(c2.body.prompt, prompt.slice(EXPERT_THRESHOLD, EXPERT_THRESHOLD * 2));
  // 末块：真实 flags（reasoner-expert → thinking+expert），parent 指向上一块
  assert.equal(c3.body.parent_message_id, 4);
  assert.equal(c3.body.thinking_enabled, true);
  assert.equal(c3.body.search_enabled, false);
  assert.equal(c3.body.model_type, "expert");
  assert.equal(c3.body.prompt, prompt.slice(EXPERT_THRESHOLD * 2));
  // chunks 拼接还原原文
  assert.equal(c1.body.prompt + c2.body.prompt + c3.body.prompt, prompt);

  // stop_stream：message_id 取 ready 的 response_message_id，且无 PoW 头
  assert.deepEqual(fake.stops.map((s) => s.body.message_id), [2, 4]);
  for (const s of fake.stops) {
    assert.equal(s.headers["x-ds-pow-response"], undefined);
    assert.equal(s.body.chat_session_id, "sess-chunk");
  }
  // 每块 completion 都带 PoW
  for (const c of fake.completions) assert.ok(c.headers["x-ds-pow-response"]);
  // PoW 每块独立请求（非末块 2 次 + 末块 1 次 = 3）
  assert.equal(order.filter((p) => p === "/api/v0/chat/create_pow_challenge").length, 3);
  // 会话最后清理
  assert.equal(order[order.length - 1], "/api/v0/chat_session/delete");
});

test("chunked: expert 流式 40万字符 → 200 SSE 正常内容", async () => {
  const prompt = "x".repeat(200_000); // 2 块
  const fake = makeChunkFakeUpstream({ totalCompletions: 2 });
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  const res = await provider.chat({ model: "deepseek/deepseek-chat-expert-free", messages: [{ role: "user", content: prompt }], stream: true });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"content":"回答"/s);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(fake.completions.length, 2);
  assert.equal(fake.completions[1].body.thinking_enabled, false); // chat-expert 不开思考
});

test("chunked: 阈值内短 prompt 不触发分块（无 stop_stream）", async () => {
  const fake = makeChunkFakeUpstream({ totalCompletions: 1 });
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  const res = await provider.chat({ model: "deepseek/deepseek-chat-expert-free", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.choices[0].message.content, "回答");
  assert.equal(fake.calls.filter((p) => p.includes("stop_stream")).length, 0);
  assert.equal(fake.calls.filter((p) => p.includes("create_pow_challenge")).length, 1);
});

test("chunked: default 模型超阈值 → 人话报错（不做文件回退）", async () => {
  const prompt = "x".repeat(2_000_000); // > 1,966,080
  const fake = makeChunkFakeUpstream({ totalCompletions: 1 });
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl: fake.fetchImpl, file: "/nonexistent/x.json" });
  await assert.rejects(
    () => provider.chat({ model: "deepseek/deepseek-chat-free", messages: [{ role: "user", content: prompt }] }),
    (err) => /超长|上限/.test(String(err.message)) && String(err.message).includes("2,000,000")
  );
  // 未发起 completion
  assert.equal(fake.calls.filter((p) => p.includes("chat/completion")).length, 0);
});

test("chunked: 非末块缺 update_session（宽松兜底）也能喂进并续 parent 链", async () => {
  const prompt = "x".repeat(200_000);
  const fake = makeChunkFakeUpstream({ totalCompletions: 2 });
  const fetchImpl = async (url, opts = {}) => {
    const path = String(url).replace(BASE, "");
    fake.calls.push(path);
    if (path === "/api/v0/chat/completion") {
      fake.completions.push({ body: JSON.parse(opts.body), headers: opts.headers || {} });
      if (fake.completions.length < 2) {
        // 只有 ready + close，无 update_session
        return sseRes([
          'event: ready',
          'data: {"request_message_id":1,"response_message_id":2,"model_type":"expert"}',
          '',
          'event: close',
          'data: {}',
          '',
          '',
        ].join("\n"));
      }
      return sseRes(OK_SSE);
    }
    if (path === "/api/v0/chat/stop_stream") {
      fake.stops.push({ body: JSON.parse(opts.body), headers: opts.headers || {} });
      return json({ code: 0, msg: "", data: { biz_code: 0 } });
    }
    return fake.fetchImpl(url, opts);
  };
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl, file: "/nonexistent/x.json" });
  const res = await provider.chat({ model: "deepseek/deepseek-chat-expert-free", messages: [{ role: "user", content: prompt }] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.choices[0].message.content, "回答");
  assert.deepEqual(fake.stops.map((s) => s.body.message_id), [2]);
  assert.equal(fake.completions[1].body.parent_message_id, 2);
});

test("muted: 账号被禁言（非 SSE user is muted）→ 人话报错 + 账号冷却不再打上游", async () => {
  const fake = baseFake({
    override: (path) => (path === "/api/v0/chat/completion" ? json({ code: 0, msg: "", data: { biz_code: 1, biz_msg: "user is muted", biz_data: null } }) : null),
  });
  const provider = makeProvider(fake);
  await assert.rejects(
    () => provider.chat({ model: "deepseek/deepseek-chat-free", messages: [{ role: "user", content: "hi" }] }),
    (err) => /禁言|muted/.test(String(err.message))
  );
  assert.equal(provider.keyRing.available(), 0); // 已冷却
});

test("frequency: 「消息发送过于频繁」（非 SSE）→ 禁言前兆识别 + 账号冷却", async () => {
  const fake = baseFake({
    override: (path) => (path === "/api/v0/chat/completion" ? json({ code: 0, msg: "", data: { biz_code: 1, biz_msg: "消息发送过于频繁，请稍后重试", biz_data: null } }) : null),
  });
  const provider = makeProvider(fake);
  await assert.rejects(
    () => provider.chat({ model: "deepseek/deepseek-chat-free", messages: [{ role: "user", content: "hi" }] }),
    (err) => /过于频繁/.test(String(err.message))
  );
  assert.equal(provider.keyRing.available(), 0); // 已冷却
});

test("frequency: SSE 流内 hint error 命中频率文案 → rotateAuth 冷却", async () => {
  const { aggregateFromText } = await import("../src/providers/deepseek/chat.js");
  const sse = 'event: hint\ndata: {"type":"error","content":"消息发送过于频繁，请稍后重试","finish_reason":"rate_limit_reached"}\n\n';
  let caught;
  try { aggregateFromText(sse, "deepseek/chat"); } catch (e) { caught = e; }
  assert.ok(caught, "aggregateFromText 应抛错");
  assert.equal(caught._rotateAuth, true, "频率文案应触发 rotateAuth");
  assert.match(String(caught.message), /过于频繁/);
});

test("chunked: 分块中途 completion 失败 → 抛错且清理 session", async () => {
  let deleted = 0;
  const prompt = "x".repeat(200_000);
  const fake = makeChunkFakeUpstream({ totalCompletions: 2 });
  const fetchImpl = async (url, opts = {}) => {
    const path = String(url).replace(BASE, "");
    fake.calls.push(path);
    if (path === "/api/v0/chat/completion") return json({ msg: "boom" }, 500);
    if (path === "/api/v0/chat_session/delete") { deleted += 1; return json({ code: 0, data: { biz_code: 0 } }); }
    return fake.fetchImpl(url, opts);
  };
  const provider = createDeepseekProvider({ apiKeys: ["tk1"], fetchImpl, file: "/nonexistent/x.json" });
  await assert.rejects(
    () => provider.chat({ model: "deepseek/deepseek-chat-expert-free", messages: [{ role: "user", content: prompt }] }),
    /500|失败/
  );
  assert.equal(deleted, 1);
});
