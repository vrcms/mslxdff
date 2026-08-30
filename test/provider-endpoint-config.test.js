import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpStateFile() {
  const d = mkdtempSync(join(tmpdir(), "mslxdff-ep-"));
  return join(d, "state.json");
}

test("state: save/load modelsPath/chatPath round-trip", async () => {
  const file = tmpStateFile();
  const { saveProviderConfig, loadProviderConfig } = await import("../src/state.js");
  saveProviderConfig("myapi", { baseUrl: "https://api.example.com/v1", keys: ["sk-xxx"], modelsPath: "/v1/models", chatPath: "/v1/chat/completions" }, { file });
  const cfg = loadProviderConfig("myapi", { file });
  assert.equal(cfg.baseUrl, "https://api.example.com/v1");
  assert.equal(cfg.modelsPath, "/v1/models");
  assert.equal(cfg.chatPath, "/v1/chat/completions");
});

test("state: defaults when not configured", async () => {
  const file = tmpStateFile();
  const { saveProviderConfig, loadProviderConfig } = await import("../src/state.js");
  saveProviderConfig("myapi2", { baseUrl: "https://api.example.com/v1", keys: ["sk-xxx"] }, { file });
  const cfg = loadProviderConfig("myapi2", { file });
  // generic defaults
  assert.equal(cfg.modelsPath, "/models");
  assert.equal(cfg.chatPath, "/chat/completions");
});

test("state: workbuddy defaults", async () => {
  const file = tmpStateFile();
  const { saveProviderConfig, loadProviderConfig } = await import("../src/state.js");
  saveProviderConfig("workbuddy", { baseUrl: "https://copilot.tencent.com", keys: ["k1"], auths: [{ uid: "u1", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt1" }] }, { file });
  const cfg = loadProviderConfig("workbuddy", { file });
  assert.equal(cfg.modelsPath, "/console/enterprises/personal/models");
  assert.equal(cfg.chatPath, "/v2/chat/completions");
});

test("state: set-models-path via saveProviderConfig", async () => {
  const file = tmpStateFile();
  const { saveProviderConfig, loadProviderConfig } = await import("../src/state.js");
  saveProviderConfig("myapi", { baseUrl: "https://api.example.com/v1", keys: ["sk-xxx"] }, { file });
  saveProviderConfig("myapi", { baseUrl: "https://api.example.com/v1", keys: ["sk-xxx"], modelsPath: "/custom/models" }, { file });
  const cfg = loadProviderConfig("myapi", { file });
  assert.equal(cfg.modelsPath, "/custom/models");
  // chatPath should remain default
  assert.equal(cfg.chatPath, "/chat/completions");
});

test("generic provider uses custom modelsPath/chatPath", async () => {
  const { createServer } = await import("node:http");
  const { createGenericProvider } = await import("../src/providers/generic.js");
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
  let seenModelsPath = null;
  let seenChatPath = null;
  const srv = await stub((req, res, body) => {
    if (req.url.includes("/custom/models")) {
      seenModelsPath = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "g1" }, { id: "g2" }] }));
    } else if (req.url.includes("/custom/chat")) {
      seenChatPath = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404); res.end("not found " + req.url);
    }
  });
  try {
    const base = urlOf(srv);
    const p = createGenericProvider({ id: "myapi", baseUrl: base, apiKeys: ["sk-test"], modelsPath: "/custom/models", chatPath: "/custom/chat" });
    const models = await p.listModels();
    assert.ok(seenModelsPath?.includes("/custom/models"), `modelsPath not hit: ${seenModelsPath}`);
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "myapi/g1");
    // chat path
    const res = await p.chat({ model: "g1", messages: [{ role: "user", content: "hi" }] });
    assert.ok(seenChatPath?.includes("/custom/chat"), `chatPath not hit: ${seenChatPath}`);
    assert.equal(res.status, 200);
    await p.close();
  } finally { await closeSrv(srv); }
});

test("generic provider defaults to /models and /chat/completions", async () => {
  const { createServer } = await import("node:http");
  const { createGenericProvider } = await import("../src/providers/generic.js");
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
  let seenUrl = null;
  const srv = await stub((req, res) => {
    seenUrl = req.url;
    if (req.url === "/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "x" }] }));
    } else {
      res.writeHead(404); res.end("not found " + req.url);
    }
  });
  try {
    const base = urlOf(srv);
    const p = createGenericProvider({ id: "myapi2", baseUrl: base, apiKeys: ["sk-test"] });
    const models = await p.listModels();
    assert.equal(seenUrl, "/models");
    assert.equal(models[0].id, "myapi2/x");
    await p.close();
  } finally { await closeSrv(srv); }
});

test("workbuddy provider uses custom modelsPath", async () => {
  const { createServer } = await import("node:http");
  const { createWorkbuddyProvider } = await import("../src/providers/workbuddy.js");
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
  let seenUrl = null;
  const srv = await stub((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { models: [{ id: "hy3", credits: "x0.00" }] } }));
  });
  try {
    const base = urlOf(srv);
    const p = createWorkbuddyProvider({ baseUrl: base, apiKeys: ["k1"], auths: [{ uid: "u1", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt1" }], modelsPath: "/custom/models" });
    const models = await p.listModels();
    assert.ok(seenUrl?.includes("/custom/models"), `workbuddy custom modelsPath not hit: ${seenUrl}`);
    assert.equal(models[0].id, "workbuddy/hy3");
    await p.close();
  } finally { await closeSrv(srv); }
});
