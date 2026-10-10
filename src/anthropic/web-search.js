/**
 * 网关代跑 Anthropic 的 `web_search` 服务端工具（ADR-0049）。
 *
 * 为什么需要它：Claude Code 的内置 WebSearch 不是客户端搜索——它单发一发 `/v1/messages`
 * 旁路请求，把 `{type:"web_search_20250305",name:"web_search",max_uses:8}`（**没有** input_schema）
 * 交给推理服务端，由服务端执行搜索、以 `server_tool_use` + `web_search_tool_result` 块回结果。
 * 本网关的上游是 OpenAI 兼容端点，没人执行搜索，于是那次旁路只能拿到模型瞎猜的假工具调用
 * （实测：CLI 判 0 次搜索并连开 5 轮空转）。这里由**网关自己**跑搜索并把合规块还回去。
 *
 * 纯逻辑 + 可注入 fetch：判据与形状不碰网络，便于单测；出网统一走 compatFetch。
 */
import { compatFetch, timeoutSignal } from "../compat.js";

const PARALLEL_URL = "https://search.parallel.ai/mcp";
const EXA_URL = "https://mcp.exa.ai/mcp";
const TAVILY_URL = "https://api.tavily.com/search";
// 客户端旁路请求里那句固定 prompt（CLI 内部常量，版本可能变：认不出来就退回既有链路）
export const SEARCH_PROMPT_PREFIX = "Perform a web search for the query: ";
// 旁路 prompt 是 CLI 内部常量，理论上一条查询词很短；截一刀防畸形请求把整段上下文当查询送出去网
const MAX_QUERY_CHARS = 400;
// 搜索端点回包的读取上限（字符）：边读边判，到顶即 cancel，不让 `*_URL` 指向的端点把内存吃穿
const MAX_RESPONSE_CHARS = 2_000_000;
// 结果条目 type 的唯一开关：真 Anthropic 用 `web_search_result`，若 CLI 侧口径不同只改这一行
const RESULT_ITEM_TYPE = "web_search_result";

let seq = 0;
export function newSearchMessageId() {
  return `msg_${Date.now().toString(36)}${(seq++).toString(36)}`;
}
export function newServerToolUseId() {
  return `srvtoolu_${Date.now().toString(36)}${(seq++).toString(36)}`;
}

// ---------- 判据 ----------

/**
 * server tool：Anthropic 的 `tools[]` 条目里，用户态工具要么带 `input_schema`，要么是 OpenAI 风格
 * `type:"function"`，要么是自由文本的 `type:"custom"`（按 Anthropic 形状它**不带** `input_schema`，
 * 只有 `format`，剥掉就把用户自己的工具吞了）。除此之外带字符串 `type` 的就是服务端工具——
 * **反向判据**（而非枚举前缀白名单）才不会被 Anthropic 新发的带日期类型绕过（ADR-0049）。
 */
export function isServerTool(t) {
  if (!t || typeof t !== "object") return false;
  if (t.input_schema) return false;
  const type = t.type;
  return typeof type === "string" && type !== "function" && type !== "custom";
}

/** 这一发是不是 web_search 的 server tool 条目。 */
export function isSearchTool(t) {
  return !!t && typeof t === "object" && t.name === "web_search" && /^web_search(_\d{8})?$/.test(String(t.type || ""));
}

function messageText(m) {
  if (!m || typeof m !== "object") return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  let t = "";
  for (const b of c) if (b && typeof b === "object" && typeof b.text === "string") t += (t ? "\n" : "") + b.text;
  return t;
}

/**
 * 命中判据（ADR-0049 D2，五条件与）：
 *  1. `tools[]` 里存在 web_search 的 server tool 条目（type + name 双对，见 `isSearchTool`）
 *  2. **同一份 `tools[]` 里没有任何用户态工具**（带 `input_schema`、`type:"function"` 或 `type:"custom"`）
 *     ——主循环请求永远全套都带着，这一条把「用户正文恰好以那句套话开头」的劫持口堵死
 *  3. 某条非 system 消息的文本**以** CLI 固定套话开头（`startsWith`，不是「正文里包含」）
 *  4. 剥掉套话后**不含换行**（旁路的查询词是一行；粘贴套话再续写指令的多半是主循环）
 *  5. 剥出的查询词截到 `MAX_QUERY_CHARS`
 * `hit` 为真时 `query` 仍可能是空串（调用方据此不打后端）。
 */
export function detectSearchRequest(req = {}) {
  const tools = Array.isArray(req.tools) ? req.tools : [];
  const tool = tools.find(isSearchTool);
  if (!tool) return { hit: false, query: "" };
  if (tools.some((t) => !isServerTool(t) && !isSearchTool(t))) return { hit: false, query: "" };
  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (m && m.role === "system") continue;
    const text = messageText(m).trimStart(); // 只去前导空白：整段 trim 会吃掉前缀结尾那个空格，导致「空前缀」判不命中
    if (!text.startsWith(SEARCH_PROMPT_PREFIX)) continue;
    const query = text.slice(SEARCH_PROMPT_PREFIX.length).trim();
    if (query.includes("\n")) return { hit: false, query: "" };
    return { hit: true, query: query.slice(0, MAX_QUERY_CHARS) };
  }
  return { hit: false, query: "" };
}

// ---------- 配置 ----------

/** env 面：`MSLXDFF_WEB_SEARCH` = 后端顺序（逗号分隔）或 `off`；非法列表值退缺省。 */
export function searchConfig(env = process.env) {
  const raw = String(env.MSLXDFF_WEB_SEARCH ?? "").trim().toLowerCase();
  const known = ["tavily", "exa", "parallel"]; // 缺省顺序＝首腿最稳的那个（grill Q13）
  let backends;
  if (raw === "off" || raw === "none" || raw === "0") backends = [];
  else if (!raw) backends = [...known];
  else {
    backends = raw.split(",").map((s) => s.trim()).filter((b) => known.includes(b));
    if (!backends.length) backends = [...known]; // 写错了别静默变成「关」
  }
  const int = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  const str = (v) => String(v || "").trim();
  return {
    enabled: backends.length > 0,
    backends,
    timeoutMs: int(env.MSLXDFF_WEB_SEARCH_TIMEOUT_MS, 15000),
    maxResults: int(env.MSLXDFF_WEB_SEARCH_MAX_RESULTS, 8),
    maxChars: int(env.MSLXDFF_WEB_SEARCH_MAX_CHARS, 700),
    tavilyKey: str(env.MSLXDFF_WEB_SEARCH_TAVILY_KEY),
    parallelKey: str(env.MSLXDFF_WEB_SEARCH_PARALLEL_KEY),
    exaKey: str(env.MSLXDFF_WEB_SEARCH_EXA_KEY),
    // `_URL` 三个覆盖点：自建/换端点用，测试也走它（不 mock 模块，少一层假象）
    parallelUrl: str(env.MSLXDFF_WEB_SEARCH_PARALLEL_URL) || PARALLEL_URL,
    exaUrl: str(env.MSLXDFF_WEB_SEARCH_EXA_URL) || EXA_URL,
    tavilyUrl: str(env.MSLXDFF_WEB_SEARCH_TAVILY_URL) || TAVILY_URL,
  };
}

// ---------- 后端（免 key 可用的公开端点：Tavily 走 REST，Exa/Parallel 走 MCP） ----------

function rpcBody(name, args) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

/** MCP 端点可能回整包 JSON，也可能回 SSE 帧；两种都认。RPC error 一律抛（200 也可能是错）。 */
export function unwrapRpcText(bodyText) {
  const trimmed = String(bodyText || "").trim();
  if (!trimmed) return "";
  const candidates = [];
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (row.startsWith("data:")) candidates.push(row.slice(5).trim());
  }
  for (const c of candidates) {
    let parsed;
    try { parsed = JSON.parse(c); } catch { continue; }
    if (parsed && parsed.error) {
      const msg = typeof parsed.error.message === "string" ? parsed.error.message : "rpc error";
      throw new Error(`search endpoint rejected the request: ${msg}`.slice(0, 200));
    }
    const content = parsed && parsed.result && parsed.result.content;
    if (Array.isArray(content)) {
      const hit = content.find((i) => i && typeof i.text === "string" && i.text.trim());
      if (hit) return hit.text;
    }
  }
  return "";
}

/**
 * 有上限地读响应体：`await res.text()` 会把整包先物化进内存（`_URL` 可指向任意端点，
 * 恶意/异常的大回包会按并发数放大），故能拿 reader 就边读边判、到顶即 cancel。
 * 拿不到 reader（假 fetch / 已消费）才退回一次性 text() 后再截。
 */
async function readCapped(res, cap) {
  const body = res && res.body;
  if (!body || typeof body.getReader !== "function") {
    return String((await res.text?.()) ?? "").slice(0, cap);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      out += decoder.decode(value, { stream: true });
      if (out.length >= cap) {
        try { await reader.cancel(); } catch { /* 已尽 */ }
        break;
      }
    }
    out += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return out.slice(0, cap);
}

async function callMcp(url, tool, args, { timeoutMs, bearer, fetchImpl }) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await (fetchImpl || compatFetch)(url, {
    method: "POST",
    headers,
    body: rpcBody(tool, args),
    signal: timeoutSignal(timeoutMs),
  });
  const text = await readCapped(res, MAX_RESPONSE_CHARS);
  if (Number(res.status) >= 400) throw new Error(`HTTP ${res.status}`);
  return unwrapRpcText(text);
}

/** Parallel 的回包是 JSON 字符串：`results[].{url,title,excerpts[]}`。 */
export function parseParallelItems(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const out = [];
  for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
    const url = typeof r?.url === "string" ? r.url.trim() : "";
    if (!url) continue;
    out.push({ title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : url, url, snippet: Array.isArray(r.excerpts) ? r.excerpts.join("\n") : "" });
  }
  return out;
}

/** Exa 的回包是预排好的文本块：`Title:` / `URL:` / `Highlights:`，块间 `---`。 */
export function parseExaItems(text) {
  const out = [];
  for (const block of String(text || "").split(/\n-{3,}\n/)) {
    const url = /^URL:\s*(.+)$/m.exec(block);
    if (!url) continue;
    const title = /^Title:\s*(.+)$/m.exec(block);
    const at = block.search(/^Highlights:/m);
    out.push({ title: (title && title[1].trim()) || url[1].trim(), url: url[1].trim(), snippet: at === -1 ? "" : block.slice(at).replace(/^Highlights:\s*/, "").trim() });
  }
  return out;
}

/** Tavily 的回包是普通 REST JSON：`results[].{title,url,content}`；免 key 档限流回 4xx（≥400 已在调用处抛）。 */
export function parseTavilyItems(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const out = [];
  for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
    const url = typeof r?.url === "string" ? r.url.trim() : "";
    if (!url) continue;
    out.push({ title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : url, url, snippet: typeof r.content === "string" ? r.content : "" });
  }
  return out;
}

const BACKENDS = {
  async parallel(query, cfg, fetchImpl) {
    const text = await callMcp(cfg.parallelUrl, "web_search", { objective: query, search_queries: [query] }, { timeoutMs: cfg.timeoutMs, bearer: cfg.parallelKey, fetchImpl });
    return parseParallelItems(text);
  },
  async exa(query, cfg, fetchImpl) {
    const url = cfg.exaKey ? `${cfg.exaUrl}?exaApiKey=${encodeURIComponent(cfg.exaKey)}` : cfg.exaUrl;
    const text = await callMcp(url, "web_search_exa", { query, type: "auto", numResults: cfg.maxResults, livecrawl: "fallback" }, { timeoutMs: cfg.timeoutMs, fetchImpl });
    return parseExaItems(text);
  },
  // 首腿：免注册的 keyless REST（2026-10-09 压测 10 路并发 10/10；exa/parallel 免 key 档当刻 429/空回）
  async tavily(query, cfg, fetchImpl) {
    const headers = { "Content-Type": "application/json" };
    if (cfg.tavilyKey) headers.Authorization = `Bearer ${cfg.tavilyKey}`;
    else headers["X-Tavily-Access-Mode"] = "keyless";
    const res = await (fetchImpl || compatFetch)(cfg.tavilyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, max_results: cfg.maxResults, search_depth: "basic" }),
      signal: timeoutSignal(cfg.timeoutMs),
    });
    const text = await readCapped(res, MAX_RESPONSE_CHARS);
    if (Number(res.status) >= 400) throw new Error(`HTTP ${res.status}`);
    return parseTavilyItems(text);
  },
};

/**
 * 按 cfg.backends 顺序试；**只有拿到 ≥1 条带 url 的结果才算成功**
 * （免 key 档的限流文案也是 HTTP 200，见 ADR-0049 已知边界）。
 */
export async function runWebSearch(query, cfg, { fetchImpl } = {}) {
  const q = String(query || "").trim();
  const t0 = Date.now();
  if (!q) return { ok: false, provider: "", query: "", results: [], error: "empty query", ms: 0, chain: [] };
  const errs = [];
  // 一条后端链共享一个 deadline（不是每发一个超时）：各后端串行最坏也只等 cfg.timeoutMs
  const deadline = t0 + cfg.timeoutMs;
  const chain = []; // 逐后端耗时与失败原因：只有总账看不出是谁花的（grill Q15）
  for (const name of cfg.backends) {
    const run = BACKENDS[name];
    if (!run) continue;
    const left = deadline - Date.now();
    const legT0 = Date.now();
    if (left < 250) {
      errs.push(`${name}: skipped (search budget ${cfg.timeoutMs}ms exhausted)`);
      chain.push({ name, ms: 0, error: `skipped (search budget ${cfg.timeoutMs}ms exhausted)` });
      break;
    }
    try {
      const items = await run(q, { ...cfg, timeoutMs: left }, fetchImpl);
      const results = items.slice(0, cfg.maxResults).map((r) => ({
        title: String(r.title || r.url).slice(0, 200),
        url: String(r.url).slice(0, 500),
        snippet: String(r.snippet || "").replace(/[ \t]+\n/g, "\n").trim().slice(0, cfg.maxChars),
      }));
      if (results.length) return { ok: true, provider: name, query: q, results, ms: Date.now() - t0, chain: chain.concat({ name, ms: Date.now() - legT0 }) };
      errs.push(`${name}: no usable results`);
      chain.push({ name, ms: Date.now() - legT0, error: "no usable results" });
    } catch (e) {
      errs.push(`${name}: ${String(e?.message || e).slice(0, 200)}`);
      chain.push({ name, ms: Date.now() - legT0, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return { ok: false, provider: "", query: q, results: [], error: errs.join("; ") || "all search backends failed", ms: Date.now() - t0, chain };
}

// ---------- 自造响应（块定义只此一份，流式与非流式共用） ----------

export function buildSearchBlocks({ query, results }) {
  const id = newServerToolUseId();
  const content = (Array.isArray(results) ? results : []).map((r) => {
    const item = { type: RESULT_ITEM_TYPE, title: String(r.title || r.url), url: String(r.url) };
    if (r.snippet) item.snippet = String(r.snippet);
    return item;
  });
  return [
    { type: "server_tool_use", id, name: "web_search", input: { query: String(query || "") } },
    { type: "web_search_tool_result", tool_use_id: id, content },
  ];
}

export function buildSearchMessage({ model = "", query, results }) {
  return {
    id: newSearchMessageId(),
    type: "message",
    role: "assistant",
    model,
    content: buildSearchBlocks({ query, results }),
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      // 没打模型，但按 Anthropic 口径报「跑了 N 次搜索」：客户端上报的正是这个字段
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
    },
  };
}

/** 由同一份块数组生成 Anthropic 具名事件序列（无 `[DONE]`；见 ADR-0047 收场口径）。 */
export function searchEvents(message) {
  const ev = (type, extra) => ({ type, ...extra });
  const out = [
    ev("message_start", { message: { id: message.id, type: message.type, role: message.role, model: message.model, content: [], stop_reason: null, stop_sequence: null, usage: message.usage } }),
  ];
  message.content.forEach((block, index) => {
    if (block.type === "server_tool_use") {
      out.push(ev("content_block_start", { index, content_block: { type: block.type, id: block.id, name: block.name, input: {} } }));
      out.push(ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } }));
    } else {
      // 结果块一次性给全（真 API 也不逐字滴结果）
      out.push(ev("content_block_start", { index, content_block: block }));
    }
    out.push(ev("content_block_stop", { index }));
  });
  out.push(ev("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage }));
  out.push(ev("message_stop"));
  return out;
}
