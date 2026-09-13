import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { attemptOnceSdk, sdkBaseFromUrl } from "../src/providers/workbuddy/sdk-chat.js";

let sdkInstalled = true;
try { await import("@ai-sdk/openai-compatible"); } catch { sdkInstalled = false; }
const skip = sdkInstalled ? false : "SDK 未安装（optionalDependencies 缺省）";

function wbStub(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}`;
async function closeSrv(srv) { await new Promise((r) => srv.close(r)); srv.closeAllConnections?.(); }

const BODY = { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: true };

describe("sdkBaseFromUrl", () => {
  it("只接受 /chat/completions 结尾", () => {
    assert.equal(sdkBaseFromUrl("https://copilot.tencent.com/v2/chat/completions"), "https://copilot.tencent.com/v2");
    assert.equal(sdkBaseFromUrl("https://copilot.tencent.com/v2/custom"), null);
  });
});

describe("attemptOnceSdk", { skip }, () => {
  it("直连 stub 上游：SSE 帧含 role/reasoning/content/finish/usage/[DONE]，带通道标记头", async () => {
    const srv = await wbStub((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "cmb-1", model: "glm-5.3-flash", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "让我" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "cmb-1", model: "glm-5.3-flash", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content: "", reasoning_content: "想想" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "cmb-1", model: "glm-5.3-flash", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content: "答案" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "cmb-1", model: "glm-5.3-flash", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    try {
      const res = await attemptOnceSdk({
        url: `${urlOf(srv)}/v2/chat/completions`,
        body: BODY,
        key: "k1",
        auth: { uid: "uid-a", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt" },
        buildHeaders: (key, auth) => ({ Authorization: `Bearer ${key}`, Accept: "text/event-stream", "X-User-Id": auth.uid, "X-Domain": auth.domain }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-mslxdff-workbuddy-channel"), "sdk");
      const text = await res.text();
      assert.ok(text.includes('"reasoning_content":"让我"'), "reasoning 帧");
      assert.ok(text.includes('"reasoning_content":"想想"'), "reasoning 帧2");
      assert.ok(text.includes('"content":"答案"'), "content 帧");
      assert.ok(text.includes('"finish_reason":"stop"'), "finish 帧");
      assert.ok(text.includes('"prompt_tokens":3'), "usage 帧");
      assert.ok(text.trimEnd().endsWith("data: [DONE]"), "[DONE] 结尾");
      const roleCount = text.split('"role":"assistant"').length - 1;
      assert.equal(roleCount, 1, "role 帧只一次");
    } finally { await closeSrv(srv); }
  });

  it("上游 401 → 返回带状态码的 Response（不抛出），供上层刷新/轮换", async () => {
    const srv = await wbStub((req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "token expired" } }));
    });
    try {
      const res = await attemptOnceSdk({
        url: `${urlOf(srv)}/v2/chat/completions`,
        body: BODY,
        key: "bad",
        auth: { uid: "u", domain: "www.codebuddy.cn" },
        buildHeaders: () => ({ Accept: "text/event-stream" }),
      });
      assert.equal(res.status, 401);
      const text = await res.text();
      assert.ok(text.includes("token expired"), "错误体透传");
    } finally { await closeSrv(srv); }
  });

  it("自定义 chatPath（非 /chat/completions）→ 明确报错（上层回退）", async () => {
    await assert.rejects(
      () => attemptOnceSdk({ url: "https://x.example/custom/chat", body: BODY, key: "k", auth: {} , buildHeaders: () => ({}) }),
      /chatPath/,
    );
  });
});
