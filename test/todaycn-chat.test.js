// todaycn chat/sse/index 单测：SSE 自造帧、单次尝试的判决面、多号轮换与分档冷却（全部注入假 fetch，不触网）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCompletion, completionToResponse } from "../src/providers/todaycn/sse.js";
import {
  classifyStatus,
  forwardTodaycnChat,
  pickFinalReply,
  createTodaycnHttp,
  TODAYCN_KIND_HEADER,
  TODAYCN_ACCOUNT_HEADER,
} from "../src/providers/todaycn/chat.js";
import { createTodaycnProvider } from "../src/providers/todaycn/index.js";

const FUTURE_JWT = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64").replace(/=+$/, "")}.y`;

function okTokenStore(token = FUTURE_JWT) {
  return { getToken: async () => ({ ok: true, token }) };
}

function finalMsg(text, clientMessageId = "") {
  return {
    id: "m1",
    role: "assistant",
    isFinal: true,
    createdAt: new Date().toISOString(),
    originClientMessageId: clientMessageId,
    messages: [{ messageType: "text", content: { text } }],
  };
}

test("sse：createCompletion 与自造帧序（role → content → finish → [DONE]）", async () => {
  const c = createCompletion({ id: "chatcmpl_x", model: "todaycn/flash", content: "你好" });
  assert.equal(c.object, "chat.completion");
  assert.equal(c.choices[0].finish_reason, "stop");
  assert.equal(c.choices[0].message.content, "你好");

  const res = completionToResponse(c, { stream: true });
  assert.match(res.headers.get("Content-Type"), /text\/event-stream/);
  const body = await res.text();
  const frames = body.split("\n\n").filter(Boolean);
  assert.match(frames[0], /"role":"assistant"/);
  assert.match(frames[1], /"content":"你好"/);
  assert.match(frames[2], /"finish_reason":"stop"/);
  assert.equal(frames[3], "data: [DONE]");
});

test("sse：tool_calls 帧走 tool_calls 通道并标 finish_reason=tool_calls", async () => {
  const c = createCompletion({ toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"p\"}" } }] });
  assert.equal(c.choices[0].finish_reason, "tool_calls");
  assert.equal(c.choices[0].message.content, null);
  const body = await completionToResponse(c, { stream: true }).text();
  assert.match(body, /"tool_calls":\[/);
  assert.match(body, /"finish_reason":"tool_calls"/);
});

test("pickFinalReply：先按 originClientMessageId 认领，认不到退回发送时间之后的最新 final", () => {
  const older = { ...finalMsg("旧"), createdAt: "2026-10-26T07:00:00.000Z" };
  const mine = { ...finalMsg("我的", "cid-1"), createdAt: "2026-10-26T07:00:01.000Z" };
  assert.equal(pickFinalReply({ data: [older, mine] }, "cid-1"), mine);
  const after = pickFinalReply({ data: [older, mine] }, "cid-x", "2026-10-26T06:59:00.000Z");
  assert.equal(after.text || after.id, "m1");
});

test("classifyStatus：auth/quota/server/param/unknown 分档", () => {
  assert.equal(classifyStatus(401), "auth");
  assert.equal(classifyStatus(403), "auth");
  assert.equal(classifyStatus(429), "quota");
  assert.equal(classifyStatus(500), "server");
  assert.equal(classifyStatus(400), "param");
  assert.equal(classifyStatus(202), "unknown");
});

test("forwardTodaycnChat：成功 → 200 + tool_calls + strict 头 + 号回显", async () => {
  const clientIdSeen = [];
  const res = await forwardTodaycnChat({
    body: { model: "todaycn/deepseek-v4.1-flash", messages: [{ role: "user", content: "读文件" }], tools: [{ type: "function", function: { name: "read_file" } }] },
    credential: "cred-1",
    uid: "u1",
    tokenStore: okTokenStore(),
    pollIntervalMs: 1,
    pollTimeoutMs: 500,
    exchange: {
      send: async (payload) => {
        clientIdSeen.push(payload.clientMessageId);
        return { status: 202, json: { threadId: "t1", createdAt: new Date().toISOString() }, text: "" };
      },
      poll: async () => ({ status: 200, json: { data: [finalMsg('{"tool_call":"read_file","arguments":{"path":"C:\\\\a.txt"}}', clientIdSeen[0])] } }),
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get(TODAYCN_ACCOUNT_HEADER), "u1");
  assert.equal(res.headers.get("x-mslxdff-todaycn-strict"), "1");
  const j = await res.json();
  assert.equal(j.choices[0].finish_reason, "tool_calls");
  assert.equal(j.choices[0].message.tool_calls[0].function.name, "read_file");
});

test("forwardTodaycnChat：超时无 final → 504 + kind=empty（可换号）", async () => {
  const res = await forwardTodaycnChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    credential: "c",
    tokenStore: okTokenStore(),
    pollIntervalMs: 1,
    pollTimeoutMs: 3,
    exchange: { send: async () => ({ status: 202, json: { threadId: "t" }, text: "" }), poll: async () => ({ status: 200, json: { data: [] } }) },
  });
  assert.equal(res.status, 504);
  assert.equal(res.headers.get(TODAYCN_KIND_HEADER), "empty");
});

test("forwardTodaycnChat：发送 429 → kind=quota；令牌失败 → kind=auth", async () => {
  const quota = await forwardTodaycnChat({
    body: {},
    credential: "c",
    tokenStore: okTokenStore(),
    exchange: { send: async () => ({ status: 429, json: null, text: "rate limited" }), poll: async () => ({ status: 200, json: { data: [] } }) },
  });
  assert.equal(quota.status, 429);
  assert.equal(quota.headers.get(TODAYCN_KIND_HEADER), "quota");

  const auth = await forwardTodaycnChat({
    body: {},
    credential: "dead",
    tokenStore: { getToken: async () => ({ ok: false, authFailed: true, reason: "refresh 401" }) },
    exchange: { send: async () => ({ status: 202, json: { threadId: "t" }, text: "" }), poll: async () => ({ status: 200, json: { data: [] } }) },
  });
  assert.equal(auth.status, 401);
  assert.equal(auth.headers.get(TODAYCN_KIND_HEADER), "auth");
});

test("createTodaycnHttp：请求头复刻桌面端指纹（含 X-Device-Id / Capabilities）", async () => {
  let seen = null;
  const http = createTodaycnHttp({ fetchImpl: async (url, init) => { seen = { url, init }; return new Response("{}", { status: 202 }); } });
  await http.send({ clientMessageId: "c" }, "tok", "d_real");
  assert.equal(seen.url, "https://api.todayai.cn/v1/messages");
  assert.equal(seen.init.headers.Authorization, "Bearer tok");
  assert.equal(seen.init.headers["X-Device-Id"], "d_real");
  assert.match(seen.init.headers["X-Client-Capabilities"], /chat\.browser\.v1/);
  assert.match(seen.init.headers["User-Agent"], /TodayCN\/1\.23\.0/);
});

test("多号轮换：A 号 429 → 当场换 B 号成功，A 进冷却、B 不冷却", async () => {
  const attempts = [];
  const provider = createTodaycnProvider({ apiKeys: ["cred-a", "cred-b"], fetchImpl: async (url, init) => {
    const auth = String(init?.headers?.Authorization || "");
    if (url.includes("/v1/messages")) {
      attempts.push(auth);
      if (auth.includes("Bearer tok-auth-a")) return new Response("busy", { status: 429 });
      return new Response(JSON.stringify({ threadId: "t1", createdAt: new Date().toISOString() }), { status: 202 });
    }
    if (url.includes("/api/auth/token")) {
      return new Response(JSON.stringify({ token: auth.includes("cred-a") ? "tok-auth-a" : "tok-auth-b" }), { status: 200 });
    }
    if (url.includes("/v2/messages")) {
      return new Response(JSON.stringify({ data: [finalMsg("好的", "")] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }, pollIntervalMs: 1, pollTimeoutMs: 200 });
  const res = await provider.chat({ model: "todaycn/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, "好的");
  assert.deepEqual(attempts, ["Bearer tok-auth-a", "Bearer tok-auth-b"]);
  assert.equal(provider.keyRing.isCooling("cred-a"), true, "A 号 429 应进冷却（quota=长冷却）");
  assert.equal(provider.keyRing.isCooling("cred-b"), false, "B 号成功不应冷却");
});