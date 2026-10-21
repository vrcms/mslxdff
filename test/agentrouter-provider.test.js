// agentrouter 定制供应商：① UA 身份白名单（非 opencode/claude-cli 恒 401）；
// ② gpt-6* 只吃 /v1/responses，其余走 /v1/chat/completions。两条现网实测行为在此锁死。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentRouterProvider,
  isAgentRouterResponsesModel,
  resolveAgentRouterBase,
  stripAgentRouterSensitive,
} from "../src/providers/agentrouter.js";

const CHAT_SSE = [
  { id: "c1", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", content: "PONG" } }] },
  { id: "c1", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

// 复刻上游两道门：UA 白名单 + gpt-6* 拒绝 chat 端点
function agentRouterStub() {
  const seen = [];
  const allowed = (ua = "") => /^opencode\//i.test(ua) || /^claude-cli\/\S*\s*\(external/i.test(ua);
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = (req.url || "").split("?")[0];
      const ua = req.headers["user-agent"] || "";
      seen.push({ url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (!allowed(ua)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "UNAUTHENTICATED", type: "unauthorized_client_error" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [
          { id: "deepseek-v4-flash", object: "model" },
          { id: "gpt-6.1-sol", object: "model" },
          { id: "gpt-6-astra", object: "model" },
        ] }));
        return;
      }
      if (req.method === "POST" && url === "/v1/chat/completions") {
        const body = raw ? JSON.parse(raw) : {};
        if (/^gpt-6/.test(String(body.model || ""))) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "请改用 /v1/responses" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(CHAT_SSE.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n");
        return;
      }
      if (req.method === "POST" && url === "/v1/responses") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "resp_1", object: "response", status: "completed", model: "gpt-6-astra",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "PONG" }] }],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        }));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${srv.address().port}`,
    seen,
    close: () => new Promise((x) => srv.close(x)),
  })));
}

describe("agentrouter：模型分流判定", () => {
  test("gpt-6 族走 responses", () => {
    assert.equal(isAgentRouterResponsesModel("gpt-6.1-sol"), true);
    assert.equal(isAgentRouterResponsesModel("gpt-6-astra"), true);
    assert.equal(isAgentRouterResponsesModel("GPT-6-ASTRA"), true);
  });
  test("deepseek 等走 chat", () => {
    assert.equal(isAgentRouterResponsesModel("deepseek-v4-flash"), false);
    assert.equal(isAgentRouterResponsesModel(""), false);
  });
  test("baseUrl 尾部 /v1 被剥掉，避免 /v1/v1", () => {
    assert.equal(resolveAgentRouterBase("https://agentrouter.org/v1/"), "https://agentrouter.org");
    assert.equal(resolveAgentRouterBase("https://agentrouter.org"), "https://agentrouter.org");
  });
});

describe("agentrouter：内容闸剥离", () => {
  test("所有 role 的 content 里 x-anthropic 被掩码，且不污染原 body", () => {
    const body = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "x-anthropic-billing-header: foo" },
        { role: "user", content: "see x-anthropic in docs" },
        { role: "assistant", content: [{ type: "text", text: "x-anthropic 说明" }] },
        { role: "tool", name: "read_x-anthropic", content: "no hit here" },
      ],
    };
    const out = stripAgentRouterSensitive(body);
    assert.notEqual(out, body, "必须返回新对象");
    assert.ok(!/x-anthropic/i.test(out.messages[0].content), "system content 应被掩码");
    assert.ok(!/x-anthropic/i.test(out.messages[1].content), "user content 应被掩码");
    assert.ok(!/x-anthropic/i.test(out.messages[2].content[0].text), "assistant 块 text 应被掩码");
    assert.ok(!/x-anthropic/i.test(out.messages[3].name), "tool name 应被掩码");
    // 原 body 不变（dispatcher 可能复用）
    assert.ok(/x-anthropic/i.test(body.messages[0].content), "原 body 不得被污染");
  });
  test("不含触发串的正文原样保留", () => {
    const body = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hello anthropic world" }] };
    const out = stripAgentRouterSensitive(body);
    assert.equal(out.messages[0].content, "hello anthropic world");
  });
});

describe("agentrouter：工厂行为", () => {
  let srv, dir, savedEnv;
  const setup = async () => {
    srv = await agentRouterStub();
    dir = mkdtempSync(join(tmpdir(), "agentrouter-"));
    savedEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = join(dir, "state.json");
  };
  const teardown = async () => {
    process.env.MSLXDFF_STATE_FILE = savedEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    await srv.close();
  };

  test("chat 模型：打 /v1/chat/completions，带 opencode 身份 UA 与 Bearer key", async () => {
    await setup();
    try {
      const p = createAgentRouterProvider({ baseUrl: srv.url, apiKeys: ["sk-test"] });
      const res = await p.chat({ model: "deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200, "UA 正确才不被 401 拦");
      assert.match(await res.text(), /PONG/);
      const sent = srv.seen.at(-1);
      assert.equal(sent.url, "/v1/chat/completions");
      assert.match(sent.headers["user-agent"], /^opencode\//);
      assert.equal(sent.headers.authorization, "Bearer sk-test");
      await p.close();
    } finally { await teardown(); }
  });

  test("gpt-6 模型：自动改走 /v1/responses 并回 chat 形状", async () => {
    await setup();
    try {
      const p = createAgentRouterProvider({ baseUrl: srv.url, apiKeys: ["sk-test"] });
      const res = await p.chat({ model: "gpt-6-astra", stream: false, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.choices[0].message.content, "PONG");
      const sent = srv.seen.at(-1);
      assert.equal(sent.url, "/v1/responses");
      assert.match(sent.headers["user-agent"], /^opencode\//);
      assert.ok(sent.body.input, "responses 通道的 body 用 input 而非 messages");
      await p.close();
    } finally { await teardown(); }
  });

  test("listModels：带身份 UA，返回 agentrouter/ 前缀", async () => {
    await setup();
    try {
      const p = createAgentRouterProvider({ baseUrl: srv.url, apiKeys: ["sk-test"] });
      const list = await p.listModels();
      assert.deepEqual(list.map((m) => m.id).sort(), [
        "agentrouter/deepseek-v4-flash",
        "agentrouter/gpt-6-astra",
        "agentrouter/gpt-6.1-sol",
      ]);
      const sent = srv.seen.at(-1);
      assert.equal(sent.url, "/v1/models");
      assert.match(sent.headers["user-agent"], /^opencode\//, "模型列表同样卡 UA");
      await p.close();
    } finally { await teardown(); }
  });
});
