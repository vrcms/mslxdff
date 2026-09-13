import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWorkbuddyProvider } from "../src/providers/workbuddy/index.js";

let sdkInstalled = true;
try { await import("@ai-sdk/openai-compatible"); } catch { sdkInstalled = false; }

const SDK_ENV = "MSLXDFF_WORKBUDDY_SDK";
const ENGINE_ENV = "MSLXDFF_UPSTREAM_ENGINE";
const ENV_KEYS = [SDK_ENV, ENGINE_ENV];
const skipSdk = sdkInstalled ? false : "SDK 未安装";

function wbStub() {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "cmb-t", model: "glm-5.3-flash", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "让我" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "cmb-t", model: "glm-5.3-flash", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content: "", reasoning_content: "想想" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "cmb-t", model: "glm-5.3-flash", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content: "答案" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "cmb-t", model: "glm-5.3-flash", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}`;
async function closeSrv(srv) { await new Promise((r) => srv.close(r)); srv.closeAllConnections?.(); }

function makeProvider(baseUrl) {
  return createWorkbuddyProvider({
    baseUrl,
    apiKeys: ["k1"],
    auths: [{ uid: "uid-a", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt" }],
    logger: { append() {} },
  });
}

async function withEnv(patch, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) {
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function readFrames(envPatch) {
  const srv = await wbStub();
  try {
    return await withEnv(envPatch, async () => {
      const p = makeProvider(urlOf(srv));
      const res = await p.chat({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] });
      const text = await res.text();
      await p.close();
      return { status: res.status, channel: res.headers.get("x-mslxdff-workbuddy-channel"), text };
    });
  } finally { await closeSrv(srv); }
}

test("缺省（无 env）：请求走 SDK 通道（标记头 + reshape 后帧完整）", { skip: skipSdk }, async () => {
  const { status, channel, text } = await readFrames({ [SDK_ENV]: undefined, [ENGINE_ENV]: undefined });
  assert.equal(status, 200);
  assert.equal(channel, "sdk", "缺省即 SDK 通道标记头");
  assert.ok(text.includes('"reasoning_content":"让我想想"'), "reasoning 经 reshape 聚合");
  assert.ok(text.includes('"content":"答案"'), "content 帧");
  assert.ok(text.includes('"finish_reason":"stop"'), "finish 帧");
  assert.ok(text.includes("[DONE]"), "[DONE]");
});

test("MSLXDFF_WORKBUDDY_SDK=1：旧写法兼容，仍走 SDK 通道", { skip: skipSdk }, async () => {
  const { status, channel } = await readFrames({ [SDK_ENV]: "1" });
  assert.equal(status, 200);
  assert.equal(channel, "sdk");
});

test("MSLXDFF_WORKBUDDY_SDK=0：局部回退原生通道（无 SDK 标记头）", async () => {
  const { status, channel, text } = await readFrames({ [SDK_ENV]: "0" });
  assert.equal(status, 200);
  assert.equal(channel, null, "原通道不得带 SDK 标记头");
  assert.ok(text.includes('"content":"答案"'), "原通道帧正常");
});

test("MSLXDFF_UPSTREAM_ENGINE=legacy：继承全局熔断 → 原生通道", { skip: skipSdk }, async () => {
  const { status, channel } = await readFrames({ [SDK_ENV]: undefined, [ENGINE_ENV]: "legacy" });
  assert.equal(status, 200);
  assert.equal(channel, null, "全局熔断时 workbuddy 亦回退原生");
});
