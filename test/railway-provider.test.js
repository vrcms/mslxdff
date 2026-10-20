// railway 定制供应商：opencode zen free 层的另一个 IP 出口。
// 关键契约：① 只列 free 模型；② 请求强制补 free-lane 形状（否则 403 FreeTierError）；
//          ③ 非流式请求也要转成「上游 stream + 本地聚合」。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRailwayProvider, isFreeModelId, filterFreeModels } from "../src/providers/railway.js";

const SSE = [
  { id: "c1", object: "chat.completion.chunk", model: "deepseek-v4.1-flash-free", choices: [{ index: 0, delta: { role: "assistant", content: "PONG" } }] },
  { id: "c1", object: "chat.completion.chunk", model: "deepseek-v4.1-flash-free", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

// 模拟 railway：校验 free-lane 形状，不合格回 403 FreeTierError（复刻上游真实行为）
function railwayStub() {
  const seen = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = (req.url || "").split("?")[0];
      if (req.method === "GET" && url === "/zen/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [
            { id: "deepseek-v4.1-flash-free", object: "model", owned_by: "opencode" },
            { id: "glm-5.3-flash-free", object: "model", owned_by: "opencode" },
            { id: "big-pickle", object: "model", owned_by: "opencode" },
            { id: "claude-sonnet-5", object: "model", owned_by: "opencode" },  // 付费，必须被过滤
            { id: "gpt-5.4", object: "model", owned_by: "opencode" },           // 付费
          ],
        }));
        return;
      }
      if (req.method === "POST" && url === "/zen/v1/chat/completions") {
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        seen.push({ body, headers: req.headers });
        const tools = (body.tools || []).map((t) => t?.function?.name);
        const core = ["bash", "edit", "glob", "grep", "read"];
        const okShape = body.stream === true && core.every((n) => tools.includes(n));
        const okIdentity = Boolean(req.headers["x-opencode-session"] && req.headers["x-opencode-client"]);
        if (!okShape || !okIdentity) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "free tier only" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(SSE.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n");
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

describe("railway：free 模型判定", () => {
  test("-free 后缀即 free", () => {
    assert.equal(isFreeModelId("deepseek-v4.1-flash-free"), true);
    assert.equal(isFreeModelId("mimo-v2.6-flash-free"), true);
  });
  test("无后缀的付费模型不是 free", () => {
    assert.equal(isFreeModelId("claude-sonnet-5"), false);
    assert.equal(isFreeModelId("gpt-5.4"), false);
    assert.equal(isFreeModelId("glm-5.3"), false);
  });
  test("已知免费档无后缀模型也算 free（big-pickle / beam）", () => {
    assert.equal(isFreeModelId("big-pickle"), true);
    assert.equal(isFreeModelId("beam"), true);
  });
  test("过滤整张表只留 free", () => {
    const out = filterFreeModels([
      { id: "a-free" }, { id: "claude-opus-5" }, { id: "big-pickle" }, { id: "gpt-6-sol" },
    ]);
    assert.deepEqual(out.map((m) => m.id), ["a-free", "big-pickle"]);
  });
});

describe("railway：工厂行为", () => {
  let srv, dir, savedEnv;
  const setup = async () => {
    srv = await railwayStub();
    dir = mkdtempSync(join(tmpdir(), "railway-"));
    savedEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = join(dir, "state.json");
  };
  const teardown = async () => {
    process.env.MSLXDFF_STATE_FILE = savedEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    await srv.close();
  };

  test("listModels 只返回 free 模型（付费的被滤掉），且带 railway/ 前缀", async () => {
    await setup();
    try {
      const p = createRailwayProvider({ baseUrl: srv.url });
      const list = await p.listModels();
      const ids = list.map((m) => m.id);
      assert.deepEqual(ids.sort(), [
        "railway/big-pickle",
        "railway/deepseek-v4.1-flash-free",
        "railway/glm-5.3-flash-free",
      ]);
      await p.close();
    } finally { await teardown(); }
  });

  test("非流式请求：自动补 free-lane 形状（stream+五工具）+ 身份头，上游 200 并聚合回 JSON", async () => {
    await setup();
    try {
      const p = createRailwayProvider({ baseUrl: srv.url });
      const res = await p.chat({
        model: "deepseek-v4.1-flash-free",
        stream: false,                              // 客户端要非流式
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200, "补形状后应通过 free-lane 门禁");
      const json = await res.json();
      assert.equal(json.object, "chat.completion");
      assert.equal(json.choices[0].message.content, "PONG");

      const sent = srv.seen.at(-1);
      assert.equal(sent.body.stream, true, "上游必须收到 stream:true");
      const names = sent.body.tools.map((t) => t.function.name);
      for (const n of ["bash", "edit", "glob", "grep", "read"]) assert.ok(names.includes(n), `缺核心工具 ${n}`);
      assert.ok(sent.headers["x-opencode-session"], "必须带 opencode session 身份头");
      await p.close();
    } finally { await teardown(); }
  });

  test("流式请求：原样返回 SSE，不聚合", async () => {
    await setup();
    try {
      const p = createRailwayProvider({ baseUrl: srv.url });
      const res = await p.chat({
        model: "deepseek-v4.1-flash-free",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /event-stream/);
      const txt = await res.text();
      assert.match(txt, /data: .*PONG/);
      await p.close();
    } finally { await teardown(); }
  });

  test("调用方已带核心工具时不重复注入", async () => {
    await setup();
    try {
      const p = createRailwayProvider({ baseUrl: srv.url });
      const tools = ["bash", "edit", "glob", "grep", "read"].map((n) => ({
        type: "function", function: { name: n, parameters: { type: "object", properties: {} } },
      }));
      const res = await p.chat({
        model: "deepseek-v4.1-flash-free", stream: false, tools,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
      const sent = srv.seen.at(-1);
      assert.equal(sent.body.tools.length, 5, "不该重复注入已有的五个工具");
      await p.close();
    } finally { await teardown(); }
  });
});
