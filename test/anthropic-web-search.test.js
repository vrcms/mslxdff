// 网关代跑 Anthropic web_search 服务端工具（ADR-0049 / change gateway-web-search）。
// 覆盖：命中判据、server tool 剥除、三个后端（tavily 首腿）的解析与降级、逐后端 chain 耗时、自造响应的两种外壳、失败一律 400。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { messagesToChatBody } from "../src/anthropic/translate.js";
import {
  SEARCH_PROMPT_PREFIX,
  detectSearchRequest,
  isServerTool,
  unwrapRpcText,
  parseParallelItems,
  parseExaItems,
  parseTavilyItems,
  runWebSearch,
  searchConfig,
  buildSearchMessage,
  searchEvents,
} from "../src/anthropic/web-search.js";

const TOKEN = "b".repeat(64);
const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const SIDE_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
const sideQuery = (q) => ({
  model: "prov/model",
  max_tokens: 64,
  stream: false,
  system: [{ type: "text", text: "You are an assistant for performing a web search tool use" }],
  messages: [{ role: "user", content: `${SEARCH_PROMPT_PREFIX}${q}` }],
  tools: [SIDE_TOOL],
});

// ---------- 判据 ----------

test("detectSearchRequest：三条件齐才命中，并剥出查询词", () => {
  assert.deepEqual(detectSearchRequest(sideQuery("claude code changelog")), { hit: true, query: "claude code changelog" });
  // content 是块数组也要认
  const asBlocks = sideQuery("x");
  asBlocks.messages[0].content = [{ type: "text", text: `${SEARCH_PROMPT_PREFIX}x` }];
  assert.deepEqual(detectSearchRequest(asBlocks), { hit: true, query: "x" });
  // 缺 prompt → 不命中（主循环请求照旧走上游）
  const noPrompt = sideQuery("x");
  noPrompt.messages = [{ role: "user", content: "帮我看看代码" }];
  assert.equal(detectSearchRequest(noPrompt).hit, false);
  // prompt 在但没有 server tool → 不命中
  const noTool = sideQuery("x");
  noTool.tools = [{ name: "Read", description: "d", input_schema: { type: "object" } }];
  assert.equal(detectSearchRequest(noTool).hit, false);
  // 工具名不是 web_search → 不命中
  const otherName = sideQuery("x");
  otherName.tools = [{ type: "web_fetch_20250910", name: "web_fetch" }];
  assert.equal(detectSearchRequest(otherName).hit, false);
  // 空前缀：命中但 query 为空（调用方据此不打后端）
  assert.deepEqual(detectSearchRequest(sideQuery("   ")), { hit: true, query: "" });
  // 主循环请求正文里**引用**这句套话（不是以它开头）→ 不许被劫持代跑
  const quoting = sideQuery("x");
  quoting.messages = [{ role: "user", content: `客户端文档里写着「${SEARCH_PROMPT_PREFIX}…」，帮我核对措辞` }];
  assert.equal(detectSearchRequest(quoting).hit, false);
  // 超长查询词被截断，不把整段上下文当查询送出网
  const longQ = detectSearchRequest(sideQuery("q".repeat(5000)));
  assert.equal(longQ.hit, true);
  assert.equal(longQ.query.length, 400);
});

test("isServerTool：反向判据——带 type 且无 input_schema 就剥，未知新类型不漏", () => {
  assert.equal(isServerTool(SIDE_TOOL), true);
  assert.equal(isServerTool({ type: "web_fetch_20250910", name: "web_fetch" }), true);
  assert.equal(isServerTool({ type: "advisor_20260101", name: "advisor" }), true); // 未登记的新 server tool 也不能漏给上游
  assert.equal(isServerTool({ name: "Read", description: "d", input_schema: { type: "object" } }), false);
  assert.equal(isServerTool({ type: "custom", name: "Read", description: "d", input_schema: { type: "object" } }), false);
  assert.equal(isServerTool({ type: "function", function: { name: "Read" } }), false);
  // 评审路 1 Q1：Anthropic 的自由文本 custom 工具**天生没有** input_schema（只有 format），剥了就是吞掉用户自己的工具
  assert.equal(isServerTool({ type: "custom", name: "greet", format: { type: "text/plain" } }), false);
});

test("detectSearchRequest：主循环请求（带着全套用户态工具）即便正文以套话开头也不被劫持", () => {
  const mainLoop = sideQuery("anthropic changelog");
  mainLoop.tools = [
    { name: "Read", description: "r", input_schema: { type: "object" } },
    { name: "Bash", description: "b", input_schema: { type: "object" } },
    SIDE_TOOL,
  ];
  assert.equal(detectSearchRequest(mainLoop).hit, false);
  // 粘着套话再续写一行指令（同一段落里换行）→ 也不是旁路
  const multiline = sideQuery("anthropic changelog\n然后帮我改代码");
  assert.equal(detectSearchRequest(multiline).hit, false);
  // 旁路原形（tools 里只有那一个 server tool、查询词一行）照旧命中
  assert.equal(detectSearchRequest(sideQuery("anthropic changelog")).hit, true);
});

test("messagesToChatBody：server tool 不污染上游，点名被剥工具时降 auto", () => {
  const mixed = {
    model: "m",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "Read", description: "r", input_schema: { type: "object" } },
      { name: "Bash", description: "b", input_schema: { type: "object" } },
      SIDE_TOOL,
      { type: "web_fetch_20250910", name: "web_fetch" },
    ],
  };
  const body = messagesToChatBody(mixed);
  assert.equal(body.tools.length, 2);
  assert.deepEqual(body.tools.map((t) => t.function.name), ["Read", "Bash"]);

  const forced = messagesToChatBody({ ...mixed, tool_choice: { type: "tool", name: "web_fetch" } });
  assert.equal(forced.tool_choice, "auto");
  const kept = messagesToChatBody({ ...mixed, tool_choice: { type: "tool", name: "Read" } });
  assert.deepEqual(kept.tool_choice, { type: "function", function: { name: "Read" } });

  // 全是 server tool → 宁可不带 tools，也不发空数组（上游会当畸形请求）
  const onlyServer = { model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }], tools: [SIDE_TOOL] };
  assert.equal("tools" in messagesToChatBody(onlyServer), false);
});

// ---------- 后端解析 ----------

test("unwrapRpcText：整包 JSON、SSE 帧与 RPC error 都处理", () => {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hello" }] } });
  assert.equal(unwrapRpcText(payload), "hello");
  assert.equal(unwrapRpcText(`event: message\ndata: ${payload}\n\n`), "hello");
  assert.throws(() => unwrapRpcText(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "boom" } })), /boom/);
  assert.equal(unwrapRpcText(""), "");
});

test("三个后端的回包各解成统一形状", () => {
  const par = parseParallelItems(JSON.stringify({
    results: [
      { url: "https://a.example", title: "A", excerpts: ["x", "y"] },
      { url: "  ", title: "no url" },
      { title: "无 url 字段" },
      { url: "https://b.example" },
    ],
  }));
  assert.deepEqual(par.map((r) => [r.url, r.title, r.snippet]), [["https://a.example", "A", "x\ny"], ["https://b.example", "https://b.example", ""]]);

  const exa = parseExaItems([
    "Title: T1\nURL: https://e1.example\nHighlights:\n  hi1",
    "---",
    "URL: https://e2.example",
    "---",
    "Title: 没 URL 的块",
  ].join("\n---\n"));
  assert.deepEqual(exa.map((r) => [r.url, r.title]), [["https://e1.example", "T1"], ["https://e2.example", "https://e2.example"]]);

  const tav = parseTavilyItems(JSON.stringify({ results: [{ title: "T1", url: "https://t1.example", content: "c1" }, { title: "没有 url" }, { url: "https://t2.example" }] }));
  assert.deepEqual(tav.map((r) => [r.url, r.title, r.snippet]), [["https://t1.example", "T1", "c1"], ["https://t2.example", "https://t2.example", ""]]);
  assert.deepEqual(parseTavilyItems("不是 JSON 的限流文案"), []); // 200 但不是 JSON → 空 → 换下一个后端
});

// ---------- runWebSearch：降级、限流、上限 ----------

function fakeFetch(routes) {
  return async (url) => {
    const hit = routes.find((r) => url.includes(r.on));
    if (!hit) return { status: 599, async text() { return "no route"; } };
    return { status: hit.status || 200, async text() { return typeof hit.body === "function" ? hit.body() : hit.body; } };
  };
}
const wrapped = (obj) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] } });
const parallelBody = (n = 2) => wrapped({ results: Array.from({ length: n }, (_, i) => ({ url: `https://p${i}.example`, title: `P${i}`, excerpts: ["snippet"] })) });
const exaBody = () => "Title: E1\nURL: https://e1.example\nHighlights:\n  e text\n---\nTitle: E2\nURL: https://e2.example";
const tavilyBody = () => JSON.stringify({ results: [{ title: "T1", url: "https://t1.example", content: "正文" }] });
const cfgOf = (over = {}) => ({ ...searchConfig({}), enabled: true, backends: ["parallel", "exa"], ...over });

test("runWebSearch：主后端成功即收场", async () => {
  const r = await runWebSearch("q", cfgOf({ maxResults: 8, maxChars: 700 }), { fetchImpl: fakeFetch([{ on: "parallel", body: parallelBody() }]) });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "parallel");
  assert.equal(r.results.length, 2);
  assert.equal(r.query, "q");
});

test("runWebSearch：免 key 限流也是 200，必须换下一个后端", async () => {
  const r = await runWebSearch("q", cfgOf(), {
    fetchImpl: fakeFetch([
      { on: "parallel", body: wrapped({ results: [] }) },
      { on: "exa", body: wrapped(exaBody()) },
    ]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "exa");
  assert.equal(r.results[0].url, "https://e1.example");
});

test("runWebSearch：全挂只回原因，不抛", async () => {
  const r = await runWebSearch("q", cfgOf(), {
    fetchImpl: fakeFetch([
      { on: "parallel", status: 503, body: "down" },
      { on: "exa", body: "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key." },
    ]),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /parallel: HTTP 503/);
  assert.match(r.error, /exa: no usable results/);
  assert.deepEqual(r.chain.map((c) => c.name), ["parallel", "exa"]); // 逐腿都记进 chain：耗时与原因可自诊
  assert.ok(r.chain.every((c) => typeof c.ms === "number" && c.ms >= 0));
});

test("readCapped：响应体边读边判上限，到顶即 cancel（不整包物化）", async () => {
  // 假 fetch 给一个「无限流」的 body：不封上限就会永远读下去 / 把内存吃穿。
  let cancelled = false;
  const endless = {
    status: 200,
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: Buffer.from("x".repeat(1 << 16)) }), // 每次 64KB，永不结束
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }),
    },
    text: async () => { throw new Error("不该走整包 text()"); },
  };
  const r = await runWebSearch("q", cfgOf({ maxResults: 3 }), { fetchImpl: async () => endless });
  assert.equal(r.ok, false); // 读到的永远不是合法 RPC 包 → 判失败并换后端（两个后端同一假体）
  assert.equal(cancelled, true); // 到顶即断，不把无限流读完
  assert.match(r.error, /no usable results/);
});

test("runWebSearch：条数与每条字数上限", async () => {
  const r = await runWebSearch("q", cfgOf({ maxResults: 1, maxChars: 3 }), {
    fetchImpl: fakeFetch([{ on: "parallel", body: parallelBody(5) }]),
  });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].snippet.length, 3);
});

test("runWebSearch：空查询不出网", async () => {
  let calls = 0;
  const r = await runWebSearch("   ", cfgOf(), { fetchImpl: async () => { calls++; throw new Error("should not be called"); } });
  assert.equal(r.ok, false);
  assert.equal(calls, 0);
});

test("runWebSearch：缺省顺序以 Tavily 打头（keyless REST），首腿成功即收场", async () => {
  assert.deepEqual(searchConfig({}).backends, ["tavily", "exa", "parallel"]);
  const r = await runWebSearch("q", searchConfig({}), { fetchImpl: fakeFetch([{ on: "tavily", body: tavilyBody() }]) });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "tavily");
  assert.deepEqual(r.chain.map((c) => c.name), ["tavily"]);
  assert.equal(r.chain[0].error, undefined);
});

test("runWebSearch：Tavily 429 → 降级 Exa，chain 记下逐腿耗时与失败原因", async () => {
  const r = await runWebSearch("q", searchConfig({}), {
    fetchImpl: fakeFetch([
      { on: "tavily", status: 429, body: '{"detail":"Too many requests"}' },
      { on: "exa", body: wrapped(exaBody()) }, // exa 走 MCP：回包要 JSON-RPC 包一层
    ]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "exa");
  assert.deepEqual(r.chain.map((c) => [c.name, c.error]), [["tavily", "HTTP 429"], ["exa", undefined]]);
  assert.ok(r.chain.every((c) => typeof c.ms === "number" && c.ms >= 0));
});

test("searchConfig：off/none/0 关闭，非法后端名退缺省，非正数 env 退缺省", () => {
  assert.equal(searchConfig({ MSLXDFF_WEB_SEARCH: "off" }).enabled, false);
  assert.equal(searchConfig({ MSLXDFF_WEB_SEARCH: "NONE" }).enabled, false);
  assert.deepEqual(searchConfig({ MSLXDFF_WEB_SEARCH: "exa" }).backends, ["exa"]);
  assert.deepEqual(searchConfig({ MSLXDFF_WEB_SEARCH: "bogus" }).backends, ["tavily", "exa", "parallel"]);
  assert.deepEqual(searchConfig({}).backends, ["tavily", "exa", "parallel"]);
  const cfg = searchConfig({ MSLXDFF_WEB_SEARCH_TIMEOUT_MS: "-1", MSLXDFF_WEB_SEARCH_MAX_RESULTS: "abc", MSLXDFF_WEB_SEARCH_MAX_CHARS: "0" });
  assert.equal(cfg.timeoutMs, 15000);
  assert.equal(cfg.maxResults, 8);
  assert.equal(cfg.maxChars, 700);
  assert.equal(searchConfig({ MSLXDFF_WEB_SEARCH_EXA_KEY: "k1" }).exaKey, "k1");
  assert.deepEqual(searchConfig({ MSLXDFF_WEB_SEARCH: "tavily,exa" }).backends, ["tavily", "exa"]);
  assert.equal(searchConfig({ MSLXDFF_WEB_SEARCH_TAVILY_KEY: "tvly-k" }).tavilyKey, "tvly-k");
  assert.equal(searchConfig({ MSLXDFF_WEB_SEARCH_TAVILY_URL: "http://local/search" }).tavilyUrl, "http://local/search");
});

// ---------- 自造响应 ----------

test("buildSearchMessage / searchEvents：块形状与事件序列同源", () => {
  const results = [{ title: "T", url: "https://t.example", snippet: "S" }];
  const m = buildSearchMessage({ model: "prov/model", query: "q", results });
  assert.equal(m.type, "message");
  assert.equal(m.role, "assistant");
  assert.equal(m.stop_reason, "end_turn");
  const [use, out] = m.content;
  assert.equal(use.type, "server_tool_use");
  assert.match(use.id, /^srvtoolu_/);
  assert.deepEqual(use.input, { query: "q" });
  assert.equal(out.type, "web_search_tool_result");
  assert.equal(out.tool_use_id, use.id);
  assert.equal(out.content[0].url, "https://t.example");
  assert.equal(out.content[0].snippet, "S");
  assert.equal(m.usage.server_tool_use.web_search_requests, 1);

  const evs = searchEvents(m);
  assert.equal(evs[0].type, "message_start");
  assert.deepEqual(evs[0].message.content, []);
  assert.equal(evs.at(-1).type, "message_stop");
  assert.equal(evs.at(-2).type, "message_delta");
  assert.equal(evs.at(-2).delta.stop_reason, "end_turn");
  const starts = evs.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type);
  assert.deepEqual(starts, ["server_tool_use", "web_search_tool_result"]);
  assert.deepEqual(evs.filter((e) => e.type === "content_block_stop").map((e) => e.index), [0, 1]);
  assert.equal(JSON.stringify(evs).includes("[DONE]"), false);
});

// ---------- 端点级（真 router + 假上游 + 假搜索后端） ----------

function stubServer(onRequest) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => onRequest(req, res, body));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

async function withApp({ searchBody, searchStatus = 200, upstreamHits, wsEnv = {} }, fn) {
  const search = await stubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.status = searchStatus;
    res.writeHead(searchStatus);
    res.end(searchBody === null ? "unreachable" : searchBody());
  });
  const up = await stubServer((req, res) => {
    upstreamHits.count++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "chatcmpl-ws", choices: [{ index: 0, message: { role: "assistant", content: "走了上游" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  });
  for (const [k, v] of Object.entries(wsEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = typeof v === "string" ? v.replaceAll("{P}", String(search.address().port)) : v; // {P}＝假搜索后端端口
  }
  const client = createUpstreamClient({ baseUrl: `http://127.0.0.1:${up.address().port}`, retry: {} });
  const app = startServer({ router: createRouter({ token: TOKEN, upstream: client }) }, 0);
  await app.ready();
  try {
    return await fn({ port: app.server.address().port, searchPort: search.address().port });
  } finally {
    await app.close();
    app.server.closeAllConnections?.();
    await new Promise((r) => up.close(r));
    up.closeAllConnections?.();
    await new Promise((r) => search.close(r));
    search.closeAllConnections?.();
    for (const k of Object.keys(wsEnv)) delete process.env[k];
  }
}

test("端点：流式旁路请求由网关代跑，不打上游", async () => {
  const hits = { count: 0 };
  const out = await withApp({
    upstreamHits: hits,
    searchBody: () => tavilyBody(),
    wsEnv: { MSLXDFF_WEB_SEARCH: "tavily", MSLXDFF_WEB_SEARCH_TAVILY_URL: "http://127.0.0.1:{P}/search" },
  }, async ({ port }) => {
    // 端点走 wsEnv 的 {P} 占位，由 withApp 换成假后端端口并在 finally 里回收（单测不许真出网）
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ ...sideQuery("anthropic changelog"), stream: true }),
    });
    return { status: res.status, provider: res.headers.get("x-mslxdff-web-search"), text: await res.text() };
  });
  assert.equal(out.status, 200);
  assert.equal(out.provider, "tavily");
  assert.equal(hits.count, 0); // 一发上游都不该有
  assert.match(out.text, /event: message_start/);
  assert.match(out.text, /"type":"server_tool_use"/);
  assert.match(out.text, /"type":"web_search_tool_result"/);
  assert.match(out.text, /https:\/\/t1\.example/);
  assert.match(out.text, /event: message_stop/);
  assert.equal(out.text.includes("[DONE]"), false);
});

test("端点：非流式同一份块形状，整包 JSON", async () => {
  const hits = { count: 0 };
  const j = await withApp({
    upstreamHits: hits,
    searchBody: () => parallelBody(1),
    wsEnv: { MSLXDFF_WEB_SEARCH: "parallel,exa", MSLXDFF_WEB_SEARCH_PARALLEL_URL: "http://127.0.0.1:{P}/mcp" },
  }, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: AUTH, body: JSON.stringify(sideQuery("q")) });
    return { status: res.status, provider: res.headers.get("x-mslxdff-web-search"), json: await res.json() };
  });
  assert.equal(j.status, 200);
  assert.equal(hits.count, 0);
  assert.equal(j.json.content[0].type, "server_tool_use");
  assert.equal(j.json.content[1].content[0].url, "https://p0.example");
});

test("端点：后端全挂 → 网关明确 400，不把无工具的旁路丢给上游", async () => {
  const hits = { count: 0 };
  const out = await withApp({
    upstreamHits: hits,
    searchBody: () => "You've hit Exa's free MCP rate limit",
    searchStatus: 200,
    // 三个后端端点都指向同一个假后端：回的不是可用结果 ⇒ 三腿全空，网关必须 400
    wsEnv: { MSLXDFF_WEB_SEARCH: "tavily,exa,parallel", MSLXDFF_WEB_SEARCH_TAVILY_URL: "http://127.0.0.1:{P}/t", MSLXDFF_WEB_SEARCH_EXA_URL: "http://127.0.0.1:{P}/mcp", MSLXDFF_WEB_SEARCH_PARALLEL_URL: "http://127.0.0.1:{P}/mcp" },
  }, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: AUTH, body: JSON.stringify(sideQuery("q")) });
    return { status: res.status, json: await res.json() };
  });
  assert.equal(out.status, 400);
  assert.equal(hits.count, 0); // 绝不把「没有工具的旁路请求」交给模型：那只会换来凭空编的 URL
  assert.equal(out.json.type, "error");
  assert.equal(out.json.error.type, "invalid_request_error");
  assert.match(out.json.error.message, /web search failed at the gateway/);
  assert.match(out.json.error.message, /no usable results/);
});

test("端点：off = 不出网也不打上游，400 里说清是被关掉", async () => {
  const hits = { count: 0 };
  let searchHits = 0;
  await withApp({
    upstreamHits: hits,
    searchBody: () => { searchHits++; return parallelBody(1); },
    wsEnv: { MSLXDFF_WEB_SEARCH: "off" },
  }, async ({ port }) => {
    // off ⇒ 一个网络请求都不发（连搜索后端也不发），所以连 URL 都不给
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: AUTH, body: JSON.stringify(sideQuery("q")) });
    const j = await res.json();
    assert.equal(res.status, 400);
    assert.equal(searchHits, 0);
    assert.equal(hits.count, 0);
    assert.match(j.error.message, /MSLXDFF_WEB_SEARCH=off/);
  });
});
