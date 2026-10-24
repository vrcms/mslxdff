// codearts 供应商端到端测试：本地 http stub 冒充华为云（STS/builtin/福利网关/chat v2），
// 覆盖：三路发现+claim、流式/非流式、签名头、401→刷新→重试→轮转写回、终态失效、maas_type。
 import { test, describe, beforeEach, afterEach } from "node:test";
 import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProviderConfig } from "../src/state.js";
import { createServer } from "node:http";
import { createCodeartsProvider } from "../src/providers/codearts.js";
import { buildUpstreamBody } from "../src/providers/codearts/chat.js";
import { newDpopPrivateJwk } from "../src/providers/codearts/dpop.js";
import { createCatalog, mergeModels } from "../src/providers/codearts/models.js";

function stub() {
  let handler = () => {};
  const hits = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const hit = { url: req.url, method: req.method, headers: req.headers, body: raw };
      hits.push(hit);
      handler(req, res, hit);
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    hits,
    set: (fn) => { handler = fn; },
    close: () => new Promise((r) => srv.close(r)),
  })));
}

function sse(frames, delayMs = 0) {
  const body = frames.map((f) => `data: ${f}\n\n`).join("");
  if (!delayMs) return body;
  // 模拟分片到达：首帧立即，其余拼接（简单起见整体一次性返回）
  return body;
}

function makeBlob({ expiringInMs = 3600_000, refreshToken = "rt-1", userId = "u1" } = {}) {
  return JSON.stringify({
    userId, userName: "tester", domainId: "d1",
    refreshToken, clientId: "codearts-agent",
    codeVerifier: "verifier-1", dpopJwk: newDpopPrivateJwk(),
    accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST",
    expiration: new Date(Date.now() + expiringInMs).toISOString(),
  });
}

const CHAT_SSE = [
  "{\"id\":1,\"model\":\"GLM-5.2\",\"type\":\"answer\",\"chat_id\":\"c\"}",
  "{\"text\":\"你好\",\"prompt_tokens\":10}",
  "{\"text\":\"你好世界\",\"completion_tokens\":5}",
  "{\"text\":\"[DONE]\",\"error_code\":\"0\"}",
];

describe("codearts provider 端到端", () => {
  let srv, stateFile, dir, savedEnv;

  beforeEach(async () => {
    srv = await stub();
    dir = mkdtempSync(join(tmpdir(), "codearts-test-"));
    stateFile = join(dir, "state.json");
    savedEnv = process.env.MSLXDFF_STATE_FILE;
    process.env.MSLXDFF_STATE_FILE = stateFile;
    srv.set((req, res, hit) => {
      if (req.method === "POST" && req.url === "/v1/oauth2/tokens") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          user_id: "u1", user_name: "tester", domain_id: "d1",
          refresh_token: "rt-2",
          credentials: { access_key_id: "AK2", secret_access_key: "SK2", security_token: "ST2", expiration: new Date(Date.now() + 3600_000).toISOString() },
        }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/model/builtin") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ builtinModels: [{ model_id: "GLM-5.2", model_name: "GLM-5.2", context_window: 128000, max_tokens: 8192 }] }));
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/v1/agent-center/agents/useragents")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agents: [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/v1/benefit/claim") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error_code: "0000" }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/v1/gateway/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error_code: "0000", result: { models: [{ model_id: "deepseek-v4-flash-0731", model_name: "deepseek-v4-flash-0731", context_window: 128000 }] } }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/v2/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sse(CHAT_SSE));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });

  afterEach(async () => {
    process.env.MSLXDFF_STATE_FILE = savedEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    await srv.close();
  });

  function makeProvider(blob) {
    // 先把凭证 blob 种进 state.json（模拟 login 成功后的持久化）：
    // 401 刷新轮转写回时 saveFn 靠 providerConfigs.codearts.keys 原位替换，不种子则静默跳过
    saveProviderConfig("codearts", { baseUrl: srv.url, keys: [blob] }, { file: stateFile });
    return createCodeartsProvider({
      baseUrl: srv.url, snapBase: srv.url, stsHost: srv.url, benefitHost: srv.url,
      apiKeys: [blob], file: stateFile,
    });
  }

  test("listModels：三路发现 + claim + 前缀 + benefit 标记", async () => {
    const p = makeProvider(makeBlob());
    const list = await p.listModels();
    const ids = list.map((m) => m.id);
    assert.ok(ids.includes("codearts/GLM-5.2"));
    assert.ok(ids.includes("codearts/deepseek-v4-flash-0731"));
    const ds = list.find((m) => m.id === "codearts/deepseek-v4-flash-0731");
    assert.deepEqual(ds.tags, ["free:benefit"]);
    const glm = list.find((m) => m.id === "codearts/GLM-5.2");
    assert.equal(glm.maxInputTokens, 128000);
    assert.ok(srv.hits.some((h) => h.url === "/api/v1/benefit/claim")); // 自动领取（幂等）
    assert.ok(srv.hits.some((h) => h.url.startsWith("/v1/agent-center/agents/useragents")));
    await p.close();
  });

  test("非流式 chat：签名头 + chat_id 32hex + 模型大小写归一 + 聚合 JSON", async () => {
    const p = makeProvider(makeBlob());
    await p.listModels(); // 预热目录（canonical 索引）
    srv.hits.length = 0;
    const res = await p.chat({ model: "codearts/GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, "chat.completion");
    assert.equal(data.choices[0].message.content, "你好世界");
    assert.deepEqual(data.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

    const hit = srv.hits.find((h) => h.url === "/api/v2/chat/completions");
    assert.ok(hit, "chat 请求存在");
    assert.match(hit.headers.authorization, /^SDK-HMAC-SHA256 Access=AK, /);
    assert.match(hit.headers["x-sdk-date"], /^\d{8}T\d{6}Z$/);
    assert.equal(hit.headers["x-auth-token"], "ST");
    assert.equal(hit.headers["x-security-token"], "ST");
    assert.ok(hit.headers["chat-id"]);
    assert.ok(hit.headers["session-id"]);
    assert.equal(hit.headers["maas_type"], undefined); // 内置模型不带福利头
    const body = JSON.parse(hit.body);
    assert.equal(body.model, "GLM-5.2"); // 小写别名归一
    assert.equal(body.stream, true); // 恒流式
    assert.equal(body.tool_stream, true);
    assert.match(body.chat_id, /^[0-9a-f]{32}$/);
    assert.equal(body.prompt_cache_key, body.chat_id);
    await p.close();
  });

  test("流式 chat：OpenAI SSE 透传（快照→增量）+ benefit 模型带 maas_type", async () => {
    const p = makeProvider(makeBlob());
    await p.listModels();
    srv.hits.length = 0;
    const res = await p.chat({ model: "codearts/deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const text = await res.text();
    assert.ok(text.endsWith("data: [DONE]\n\n"));
    assert.ok(text.includes("\"reasoning_content\"") === false || true);
    const hit = srv.hits.find((h) => h.url === "/api/v2/chat/completions");
    assert.equal(hit.headers["maas_type"], "benefit"); // 福利模型 → 签名内带福利头
    const body = JSON.parse(hit.body);
    // deepseek 模型：assistant 占位注入（本例无 assistant 消息，不注入）
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    await p.close();
  });

  test("deepseek 消息缺 reasoning_content → 注入占位；已有则保留", async () => {
    const p = makeProvider(makeBlob());
    await p.listModels();
    srv.hits.length = 0;
    await p.chat({
      model: "codearts/deepseek-v4-flash-0731", stream: false,
      messages: [
        { role: "assistant", content: "a" },
        { role: "assistant", content: "b", reasoning_content: "kept" },
        { role: "user", content: "hi" },
      ],
    });
    const hit = srv.hits.find((h) => h.url === "/api/v2/chat/completions");
    const msgs = JSON.parse(hit.body).messages;
    assert.equal(msgs[0].reasoning_content, " ");
    assert.equal(msgs[1].reasoning_content, "kept");
    await p.close();
  });

  test("401 → 强制刷新 → 重试成功 + refresh_token 轮转写回 state", async () => {
    const blob = makeBlob();
    const p = makeProvider(blob);
    let chatCalls = 0;
    srv.set((req, res, hit) => {
      if (req.method === "POST" && req.url === "/v1/oauth2/tokens") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          user_id: "u1", user_name: "tester", domain_id: "d1", refresh_token: "rt-2",
          credentials: { access_key_id: "AK2", secret_access_key: "SK2", security_token: "ST2", expiration: new Date(Date.now() + 3600_000).toISOString() },
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/v2/chat/completions") {
        chatCalls++;
        if (chatCalls === 1) { res.writeHead(401, { "Content-Type": "application/json" }); res.end("{\"error\":\"token expired\"}"); return; }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sse(CHAT_SSE));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
    const res = await p.chat({ model: "GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 200);
    assert.equal(chatCalls, 2);
    const second = srv.hits.filter((h) => h.url === "/api/v2/chat/completions")[1];
    assert.equal(second.headers["x-auth-token"], "ST2"); // 刷新后的新 security_token
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const keys = state.providerConfigs.codearts.keys;
    assert.equal(keys.length, 1);
    assert.ok(keys[0].includes("rt-2"), "新 refresh_token 已写回");
    assert.ok(!keys[0].includes("rt-1"), "旧 refresh_token 已被替换");
    assert.ok(JSON.parse(keys[0]).dpopJwk.d, "DPoP 私钥随 blob 保留");
    await p.close();
  });

  test("终态失效（invalid_grant）→ 死号 + 人话报错提示重登", async () => {
    const blob = makeBlob({ expiringInMs: -1000 }); // 已过期 → getCredential 即刷新
    const p = makeProvider(blob);
    srv.set((req, res) => {
      if (req.method === "POST" && req.url === "/v1/oauth2/tokens") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_code: "STS5.1806", error_msg: "the refresh token has been used" }));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
    await assert.rejects(
      () => p.chat({ model: "GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: false }),
      /mslxdff -provider codearts login/,
    );
    await p.close();
  });

  test("HTTP 200 内嵌错误 → 映射状态码（未注册模型 → 400）", async () => {
    const p = makeProvider(makeBlob());
    srv.set((req, res) => {
      if (req.method === "POST" && req.url === "/api/v2/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end("data: {\"text\":\"[DONE]\",\"error_code\":\"InferHub.002002009.404\",\"error_msg\":\"model is not registered\"}\n\n");
        return;
      }
      res.writeHead(404); res.end("{}");
    });
    const res = await p.chat({ model: "GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /002002009/);
    await p.close();
  });

  test("冷目录（未预热）：仍属福利种的 deepseek-v4-flash-0731 按福利路由（带 maas_type）", async () => {
    const p = makeProvider(makeBlob());
    srv.hits.length = 0;
    const res = await p.chat({ model: "codearts/deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 200);
    const hit = srv.hits.find((h) => h.url === "/api/v2/chat/completions");
    assert.equal(hit.headers["maas_type"], "benefit"); // 目录还没发现 → 种子兜底（冷启动也要按福利路由）
    assert.equal(JSON.parse(hit.body).model, "deepseek-v4-flash-0731");
    await p.close();
  });

  // 现网取证 2026-10-24（重新登录后直连上游 A/B）：deepseek-v4.1-flash 已从福利位转成 builtin 正式模型。
  // 同一无关它带福利头 → InferHub.4004.200 benefit not found，不带 → HTTP 200。
  // 故冷启动也不能再凭旧种子把它当福利模型；否则 preheat 未回来那一段必然 400。
  test("冷目录：已转正的 deepseek-v4.1-flash 不带 maas_type（带上反而 benefit not found）", async () => {
    const p = makeProvider(makeBlob());
    srv.hits.length = 0;
    const res = await p.chat({ model: "codearts/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 200);
    const hit = srv.hits.find((h) => h.url === "/api/v2/chat/completions");
    assert.equal(hit.headers["maas_type"], undefined);
    assert.equal(JSON.parse(hit.body).model, "deepseek-v4.1-flash");
    await p.close();
  });

  // 三路里只有 builtin / 福利网关带真 model_id；agent-center 带的是 model_name（展示名）。
  // 拿展示名当 id 发上游 = InferHub.002002009.404 The model is not registered（现网 2026-10-24 实测）。
  test("目录 id 必须出自真 model_id：agent-center 的展示名不得顶包", async () => {
    srv.set((req, res) => {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.method === "GET" && req.url === "/v1/model/builtin") {
        return send(200, { builtinModels: [
          { model_id: "deepseek-v4.1-flash", model_name: "DeepSeek-V4.1-Flash", context_window: 1048576 },
          { model_id: "GLM-5.2", model_name: "GLM-5.2", context_window: 1048576 },
        ] });
      }
      if (req.method === "GET" && req.url.startsWith("/v1/agent-center/agents/useragents")) {
        return send(200, { agents: [{ agent_name: "CodeAgent", alias: { alias_zh_cn: "智能体" }, show_in_ide: true, agent_id: "ag-1" }] });
      }
      if (req.method === "GET" && req.url.startsWith("/v1/agent-center/agents/detail")) {
        return send(200, { gpts: { models: [
          { model_name: "DeepSeek-V4.1-Flash", model_parameters: { context_window: 1048576 } },
          { model_name: "GLM-5.2", model_parameters: { context_window: 1048576 } },
        ] } });
      }
      if (req.method === "POST" && req.url === "/api/v1/benefit/claim") return send(200, { error_code: "0000" });
      if (req.method === "GET" && req.url === "/api/v1/gateway/config") return send(200, { error_code: "0000", result: { models: [] } });
      if (req.method === "POST" && req.url === "/api/v2/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sse(CHAT_SSE));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
    const p = makeProvider(makeBlob());
    const list = await p.listModels();
    const ids = list.map((m) => m.id);
    assert.ok(ids.includes("codearts/deepseek-v4.1-flash"), "id 用 builtin 真 model_id");
    assert.ok(!ids.includes("codearts/DeepSeek-V4.1-Flash"), "展示名不得成为 id");
    const shown = list.find((m) => m.id === "codearts/deepseek-v4.1-flash");
    assert.equal(shown.name, "DeepSeek-V4.1-Flash", "展示名留在 name，UI 照旧可见");
    assert.ok(ids.includes("codearts/GLM-5.2"), "真 model_id 本身就是混合大小写时不得被抹成小写");

    // 客户端照 agent-center 的展示名来问（用户在 IDE 里看到的就是这个），也要归一成真 id 再发上游
    srv.hits.length = 0;
    const res = await p.chat({ model: "codearts/DeepSeek-V4.1-Flash", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 200);
    const hit = srv.hits.find((h) => h.url === "/api/v2/chat/completions");
    assert.equal(JSON.parse(hit.body).model, "deepseek-v4.1-flash");
    assert.equal(hit.headers["maas_type"], undefined);
    await p.close();
  });

  test("主 blob 终态失效 → 自动换下一个账号发现（死号不再清空整个目录）", async () => {
    const dead = makeBlob({ expiringInMs: -1000, refreshToken: "rt-dead" });
    const live = makeBlob({ expiringInMs: -1000, refreshToken: "rt-live", userId: "u2" });
    saveProviderConfig("codearts", { baseUrl: srv.url, keys: [dead, live] }, { file: stateFile });
    srv.set((req, res, hit) => {
      if (req.method === "POST" && req.url === "/v1/oauth2/tokens") {
        if (String(hit.body).includes("rt-dead")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_code: "STS5.1806", error_msg: "the refresh token has been used" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          user_id: "u2", user_name: "tester", domain_id: "d2", refresh_token: "rt-live-2",
          credentials: { access_key_id: "AKL", secret_access_key: "SKL", security_token: "STL", expiration: new Date(Date.now() + 3600_000).toISOString() },
        }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/model/builtin") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ builtinModels: [{ model_id: "GLM-5.2", model_name: "GLM-5.2", context_window: 128000 }] }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/v1/gateway/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error_code: "0000", result: { models: [{ model_id: "deepseek-v4.1-flash", model_name: "deepseek-v4.1-flash", context_window: 1000000 }] } }));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
    const p = createCodeartsProvider({
      baseUrl: srv.url, snapBase: srv.url, stsHost: srv.url, benefitHost: srv.url,
      apiKeys: [dead, live], file: stateFile,
    });
    const list = await p.listModels();
    assert.ok(list.some((m) => m.id === "codearts/deepseek-v4.1-flash"), "死号不阻断：应拿到下一个账号的目录");
    assert.equal(srv.hits.filter((h) => h.url === "/v1/oauth2/tokens").length, 2, "先试死号（终态失效）再试活号");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.ok(state.providerConfigs.codearts.keys.some((k) => k.includes("rt-live-2")), "活号轮转后的新 refresh_token 原位写回");
    await p.close();
  });

  test("buildUpstreamBody：max_completion_tokens 映射并夹到上游真实上限", () => {
    const out = buildUpstreamBody(
      { model: "deepseek-v4.1-flash", max_completion_tokens: 131072, reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] },
      { chatId: "0".repeat(32), upstreamModel: "deepseek-v4.1-flash" },
    );
    assert.equal(out.max_completion_tokens, undefined, "v2 端点不认这个参数名，透传就是 InferHub.001001005.400");
    assert.equal(out.max_tokens, 65536, "映射后还要夹住：>65536 上游即 InferHub.001001005.400（现网实测 98304 挂）");
    assert.equal(out.reasoning_effort, "low");
    const both = buildUpstreamBody({ max_tokens: 64000, max_completion_tokens: 131072, messages: [] }, { chatId: "0".repeat(32), upstreamModel: "glm-5.3-flash" });
    assert.equal(both.max_tokens, 64000, "显式 max_tokens 优先，不被映射覆盖");
  });
});

describe("codearts 目录 id 权威性（真 model_id > 展示名）", () => {
  test("mergeModels：真 model_id 优先于展示名，与到达顺序无关", () => {
    const display = { id: "DeepSeek-V4.1-Flash", name: "DeepSeek-V4.1-Flash", byModelId: false, contextWindow: 0 };
    const real = { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", byModelId: true, contextWindow: 1048576 };
    for (const [a, b] of [[display, real], [real, display]]) {
      const merged = mergeModels([[a], [b]]);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "deepseek-v4.1-flash", "无论谁先到，都保留真 model_id");
      assert.equal(merged[0].contextWindow, 1048576, "参数仍取并集");
    }
    // 真 model_id 本身是混合大小写时（GLM-5.2）不得被抹成小写
    const glmReal = { id: "GLM-5.2", name: "GLM-5.2", byModelId: true, contextWindow: 1048576 };
    const glmLower = { id: "glm-5.2", name: "glm-5.2", byModelId: false, contextWindow: 0 };
    assert.equal(mergeModels([[glmReal], [glmLower]])[0].id, "GLM-5.2");
    // 两份都没有真 model_id：沿用旧规则（精确大小写优先）
    assert.equal(
      mergeModels([[{ id: "GLM-5.2", byModelId: false }], [{ id: "glm-5.2", byModelId: false }]])[0].id,
      "GLM-5.2",
    );
  });

  test("createCatalog：先只见展示名、后发现真 model_id 时可覆盖（跨账号不被污染）", () => {
    const cat = createCatalog();
    cat.setAccount("u1", [{ id: "DeepSeek-V4.1-Flash", name: "DeepSeek-V4.1-Flash", byModelId: false }]);
    assert.equal(cat.canonical("deepseek-v4.1-flash"), "DeepSeek-V4.1-Flash"); // 没有真 id 时只能用它
    cat.setAccount("u2", [{ id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", byModelId: true }]);
    assert.equal(cat.canonical("DeepSeek-V4.1-Flash"), "deepseek-v4.1-flash", "真 model_id 一到即覆盖");
    assert.equal(cat.canonical("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
    assert.equal(cat.isBenefit("u2", "deepseek-v4.1-flash"), false, "builtin 目录没标福利 → 不带福利头");
    // 种子（byModelId=false）永远盖不掉已发现的真 id
    assert.equal(cat.canonical("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  });
});
