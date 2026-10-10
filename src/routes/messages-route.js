/**
 * POST /v1/messages + /v1/messages/count_tokens — 给 Claude Code 用的 Anthropic Messages 外壳（ADR-0047）。
 * 复用 ChatPipeline 全链路（auto/hedge/failover/tool_calls/空轮重试），只做形状翻译：
 * 非流式：收集 chat JSON → 转 Anthropic message；流式：逐块实时翻成 Anthropic 具名事件。
 *
 * 出站格式与 /v1/responses **不兼容**，故不能复用 createLiveForwarder（它写死 `data:` + `[DONE]`）：
 * Anthropic 用 `event: <type>` 具名帧、无 `[DONE]`，且需网关自发 `ping` 扛过客户端 idle watchdog。
 *
 * 三条收口纪律（第 1 轮评审 P0-2/P0-3 立下的，别改回去）：
 *  1. 上游一有动静（含 pipeline 的 keepalive 注释帧）就发头 + `message_start` + 武装 ping —— 首块前的静默期正是客户端 watchdog 咬人的窗口；
 *  2. `headersSent`/`getHeader` 必须真反映已发头，否则 `helpers.js:32` 的「已 flush 走 in-band 错误帧」守卫永远判假，
 *     错误会被当成普通文本喂进 push() 后静默消失；
 *  3. 没等到 `finish_reason`（也没有 `[DONE]`）就收线 = 截断，发 `event: error`，**不伪装成功收场**。
 */
import { json, readBody } from "./helpers.js";
import { createChatPipeline } from "../chat-pipeline/index.js";
import { withBody, createCollector, createEmitter } from "./responses-route.js";
import {
  messagesToChatBody,
  chatJsonToAnthropic,
  createAnthropicChunkTranslator,
  estimateTokens,
  anthropicError,
} from "../anthropic/translate.js";
import {
  detectSearchRequest,
  runWebSearch,
  searchConfig,
  buildSearchMessage,
  searchEvents,
} from "../anthropic/web-search.js";

const ADEBUG = process.env.MSLXDFF_ANTHROPIC_DEBUG === "1";
function alog(...a) {
  if (ADEBUG) console.log("[messages]", ...a);
}

const THINKING = process.env.MSLXDFF_ANTHROPIC_THINKING === "1";
// 空闲 ping 周期（ms）：`0` 关闭；客户端长思考期靠它扛过 streaming idle timeout
const PING_MS = (() => {
  const raw = Number(process.env.MSLXDFF_ANTHROPIC_PING_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15000;
})();

function frameOf(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// pipeline 在已 flush 的流里用 OpenAI 形状收口（`{error:{...}}` + `[DONE]`）：
// 检出后改发 Anthropic 的 `error` 帧，别把错误伪装成正常收场（grill-decisions Q2）
function detectInBandError(text) {
  let msg = null;
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      const e = j?.error;
      if (e) msg = String(e?.message || e).slice(0, 500);
    } catch { /* 非 JSON 帧忽略 */ }
  }
  return msg;
}


// pipeline 未 flush 时用 json() 直写聚合错误体（无 `data:` 前缀）：认出来只取 message，
// 别把整坨 OpenAI JSON 当人话塞进 Anthropic error.message。
function jsonErrorText(text) {
  const t = String(text || "").trim();
  if (!t || t.startsWith(":") || t.includes("data:")) return null;
  try {
    const j = JSON.parse(t);
    const e = j?.error;
    if (!e) return null;
    return String(e?.message || e).slice(0, 500);
  } catch {
    return null;
  }
}

/** 两种上游收场形状（in-band `data:` 帧 / 聚合 JSON 体）统一取错误文案。 */
function errorText(text) {
  return detectInBandError(text) || jsonErrorText(text);
}
// 客户端要流式而上游给了聚合 JSON（muse-spark / workbuddy 聚合 / zcode 非流式聚合都是现网常态）：
// 那体没有 `data:` 前缀，会被 push() 当噪声整段丢掉 → 正文静默消失。认出来交给 fromChatJson 兜底。
function tryAggregate(text) {
  const t = String(text || "").trim();
  if (!t || t.includes("data:") || t.startsWith(":")) return null;
  try {
    const j = JSON.parse(t);
    // 只认「非空 choices」：`{choices:[]}` 之类的空包什么也带不来，若当合法聚合包会跳过截断检测 → 零正文还谎报成功
    return j && Array.isArray(j.choices) && j.choices.length > 0 ? j : null;
  } catch {
    return null;
  }
}

/**
 * Anthropic 出站垫片：具名事件 + 无 [DONE] + 空闲自发 ping + 真 headersSent。
 * @param realRes 真 HTTP response
 * @param translator createAnthropicChunkTranslator 实例
 * @param opts { pingMs?: number } 测试注入口，缺省读 env
 */
export function createAnthropicForwarder(realRes, translator, opts = {}) {
  const pingMs = opts.pingMs ?? PING_MS;
  let status = 200;
  let headSent = false;
  let ended = false;
  let timer = null;
  let pendingError = null;
  let aggregate = null;
  let rawAcc = ""; // 攒住无事件字节，供聚合回落识别
  const sent = () => headSent || realRes.headersSent === true; // headersSent 与 getHeader 的唯一口径
  // 上游按字节粒度喂 Buffer/Uint8Array：非流式解码会把多字节汉字切成 U+FFFD 并永久固化在行缓冲里
  const decoder = new TextDecoder("utf-8");
  const decode = (c, flush) => {
    if (c == null) return flush ? String(decoder.decode()) : "";
    if (typeof c === "string") return c;
    const bytes = (typeof Buffer !== "undefined" && Buffer.isBuffer(c)) || c instanceof Uint8Array ? c : null;
    if (bytes) return decoder.decode(bytes, { stream: !flush });
    return String(c);
  };
  const dead = () => ended || realRes.writableEnded === true || realRes.destroyed === true;
  const raw = (type, data) => { if (dead()) return; try { realRes.write(frameOf(type, data)); } catch { /* 下游已断 */ } };
  const stopPing = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const armPing = () => {
    if (!pingMs || dead()) return;
    stopPing();
    timer = setTimeout(() => { if (dead()) return; raw("ping", { type: "ping" }); armPing(); }, pingMs);
    if (typeof timer.unref === "function") timer.unref();
  };
  const sendHead = () => {
    if (headSent) return;
    headSent = true;
    try { realRes.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); } catch { /* 已发 */ }
    for (const e of translator.begin()) raw(e.type, e);
    armPing();
  };
  const finish = () => { if (ended) return; ended = true; stopPing(); try { realRes.end(); } catch { /* ignore */ } };
  // 错误收场：一帧 error 后关连接，不补 message_delta/message_stop（真 Anthropic API 即此行为）
  const closeError = (msg) => { sendHead(); raw("error", { type: "error", error: { type: "api_error", message: String(msg || "upstream error").slice(0, 500) } }); finish(); };

  // 整包聚合体可能被分多次 write：攒住「没产出任何事件」的字节再判一次（有事件即清空，防陈旧拼接）
  const RAW_ACC_CAP = 262144;
  let rawOverflow = false;
  const tryAccumulate = (text) => {
    if (aggregate || !text || rawOverflow) return;
    rawAcc += text;
    if (rawAcc.length > RAW_ACC_CAP) {
      // 超上限就停手并留标记：继续攒也拼不出完整 JSON，静默攒下去只会让错误文案说谎
      rawAcc = rawAcc.slice(0, RAW_ACC_CAP);
      rawOverflow = true;
    }
    const agg = tryAggregate(rawAcc);
    if (agg) aggregate = agg;
  };
  const res = {
    ...createEmitter(),
    set statusCode(v) { status = v; },
    get statusCode() { return status; },
    // helpers.js 的 json() 靠 headersSent + getHeader("content-type") 判「能不能回头」；
    // 两者必须同源说真话，否则会出现「判成已 flush、却又拿不到 event-stream」的全静默窗口（错误既不 in-band 也不 JSON）。
    get headersSent() { return sent(); },
    // json() 的幂等早退判据；补上它才不会在我们已收场后再被当「可写」的响应对待
    get writableEnded() { return ended || realRes.writableEnded === true; },
    setHeader() { /* Anthropic SSE 的头由 sendHead 统一发，逐键 set 无意义 */ },
    getHeader(name) {
      if (String(name).toLowerCase() === "content-type" && sent()) return "text/event-stream";
      return undefined;
    },
    write(c) {
      if (ended) { alog("late-write-ignored", JSON.stringify({ id: translator.id, bytes: String(c?.length ?? 0) })); return true; }
      const text = decode(c);
      const err = errorText(text);
      if (err) { pendingError = err; return true; } // 留给 end() 统一收口，不在这里半截发
      // 上游一有动静（连 pipeline 的 keepalive 注释帧都算）就落头 + message_start + 武装 ping：
      // 首块前的静默期正是客户端 idle watchdog 咬人的窗口。没收到任何字节时错误仍走干净 JSON（见 end()）。
      sendHead();
      const evs = translator.push(text);
      for (const e of evs) raw(e.type, e);
      if (evs.length) rawAcc = ""; else tryAccumulate(text);
      armPing();
      return true;
    },
    end(c) {
      if (ended) return;
      const tail = decode(c, true);
      const err = pendingError || errorText(tail);
      if (status >= 400 && !headSent) {
        ended = true;
        stopPing();
        json(realRes, status, anthropicError("api_error", err || String(tail).slice(0, 500) || "upstream error"));
        return;
      }
      if (err) { closeError(err); return; }
      // 客户端要的是流：先落头 + message_start + 武装 ping，再处理残余
      sendHead();
      if (tail) {
        const evs = translator.push(tail);
        for (const e of evs) raw(e.type, e);
        if (evs.length) rawAcc = ""; else tryAccumulate(tail);
      }
      // 末帧常常没有收尾换行：补一个 `\n` 把残行逼出来，否则合法正文与 finish_reason 会一起烂在缓冲里（被误判成截断）
      for (const e of translator.push("\n")) raw(e.type, e);
      // 上游整包聚合（无 SSE 帧）：喂同一套状态机兜底，别让正文静默消失
      if (aggregate && !translator.stats().blocks) { for (const e of translator.fromChatJson(aggregate)) raw(e.type, e); }
      const fin = translator.getFinal();
      if (!fin.finish && !aggregate) {
        alog("truncated", JSON.stringify({ id: translator.id, ...translator.stats() }));
        closeError(rawOverflow
          ? "upstream sent an oversized non-SSE body that could not be aggregated (no finish_reason)"
          : "upstream stream ended before the model finished its turn (no finish_reason)");
        return;
      }
      for (const e of translator.end({ finish: fin.finish, usage: fin.usage })) raw(e.type, e);
      finish();
    },
  };
  // 客户端提前断开：pipeline 会感知 close，但 ping 定时器归本垫片管，必须自己停
  try { realRes.on?.("close", () => { if (!ended) { ended = true; stopPing(); } }); } catch { /* ignore */ }
  return res;
}

/**
 * 代跑结果回给客户端：非流式整包 JSON，流式由同一份块生成的具名事件（无 `[DONE]`）。
 * 搜索在调用前就跑完了，这里一次写完即可，不需要 createAnthropicForwarder 的 ping 垫片。
 */
function respondSearch(res, { message, stream, provider }, isDead) {
  if (isDead && isDead()) return undefined; // 搜索期间客户端断连：别再写任何字节
  if (!stream) {
    try { res.setHeader?.("x-mslxdff-web-search", provider); } catch { /* 已 flush */ }
    try { return json(res, 200, message); } catch { return undefined; /* 下游已断 */ }
  }
  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-mslxdff-web-search": provider,
    });
    for (const e of searchEvents(message)) res.write(frameOf(e.type, e));
    res.end();
  } catch { /* 下游已断 */ }
  return undefined;
}

export async function messagesHandler(ctx) {
  const { req, res } = ctx;
  const t0 = Date.now();
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, anthropicError("invalid_request_error", "Invalid JSON body"));
  }
  // —— 网关代跑 web_search（ADR-0049）：旁路请求**一律由网关作答**——命中判据即不打模型。
  // 搜到就回结果块；关了/全挂/空查询就回一条明确的 400（把无工具的旁路丢给上游，只会让模型凭空
  // 编 URL 并让客户端按「0 次搜索」空转重试，那才是改前的老毛病）。主循环请求不受影响。
  // 整段包 try：搜索期最长 15s，其间客户端可能已断连（`isDead`），任何意外都不得逃逸成 5xx。
  const det = detectSearchRequest(body);
  if (det.hit) {
    const isDead = () => res.writableEnded === true || res.destroyed === true || res.headersSent === true;
    const wsCfg = searchConfig();
    let r;
    if (!wsCfg.enabled) r = { ok: false, error: "disabled by MSLXDFF_WEB_SEARCH=off" };
    else {
      try {
        r = det.query ? await runWebSearch(det.query, wsCfg) : { ok: false, error: "empty query" };
      } catch (e) {
        r = { ok: false, error: String(e?.message || e) };
      }
    }
    if (r.ok) {
      const readout = { provider: r.provider, ms: r.ms, results: r.results.length, queryChars: r.query.length, chain: r.chain || [] };
      alog("web-search", JSON.stringify(readout));
      try { ctx.logs?.appendEvent?.({ type: "web-search", ...readout }); } catch { /* 观测产物不参与判决 */ }
      return respondSearch(res, {
        message: buildSearchMessage({ model: String(body.model || ""), query: r.query, results: r.results }),
        stream: Boolean(body.stream),
        provider: r.provider,
      }, isDead);
    }
    const why = String(r.error || "unknown").slice(0, 200);
    alog("web-search-unavailable", why);
    try { ctx.logs?.appendEvent?.({ type: "web-search-unavailable", queryChars: (det.query || "").length, error: why, chain: r.chain || [] }); } catch { /* 同上 */ }
    if (isDead()) return undefined;
    try { return json(res, 400, anthropicError("invalid_request_error", `web search failed at the gateway: ${why}`)); } catch { return undefined; }
  }
  let chatBody;
  try {
    chatBody = messagesToChatBody(body);
  } catch (e) {
    alog("translate-req-400", String(e?.message || e));
    return json(res, 400, anthropicError("invalid_request_error", String(e?.message || e)));
  }
  alog("req", JSON.stringify({
    model: chatBody.model, stream: chatBody.stream,
    msgs: chatBody.messages.map((m) => `${m.role}:${(typeof m.content === "string" ? m.content : "[parts]").length}${m.tool_calls ? `+${m.tool_calls.length}tc` : ""}`),
    tools: Array.isArray(chatBody.tools) ? chatBody.tools.length : 0,
  }));
  const pipeline = createChatPipeline(ctx);
  const fakeReq = withBody(req, chatBody);
  const forwardClose = (shim) => { try { req.on?.("close", () => shim.emit("close")); } catch { /* ignore */ } };
  try {
    if (chatBody.stream) {
      const translator = createAnthropicChunkTranslator(chatBody.model, { thinking: THINKING });
      const live = createAnthropicForwarder(res, translator);
      forwardClose(live);
      await pipeline.execute({ req: fakeReq, res: live });
      alog("done-stream", JSON.stringify({ ms: Date.now() - t0, id: translator.id, ...translator.stats(), ...translator.getFinal() }));
    } else {
      const cap = createCollector();
      forwardClose(cap.res);
      await pipeline.execute({ req: fakeReq, res: cap.res });
      const { status, text } = cap.get();
      if (status >= 400) return json(res, status, anthropicError("api_error", errorText(text) || String(text).slice(0, 500)));
      let chatJson = null;
      try { chatJson = JSON.parse(text); } catch { /* 非 JSON */ }
      if (!chatJson || chatJson.error || chatJson.object === "error") {
        return json(res, status >= 400 ? status : 502, anthropicError("api_error", errorText(text) || String(text).slice(0, 500)));
      }
      // 上游偶发非 chat 形状（无 choices）：包成单 text 块，绝不 500（照 responses-route.js 先例）
      if (!Array.isArray(chatJson.choices)) {
        const r = chatJsonToAnthropic({ choices: [{ message: { content: String(text).slice(0, 8000) } }] }, chatBody.model);
        alog("done-nonchat", JSON.stringify({ ms: Date.now() - t0, bytes: text.length }));
        return json(res, 200, r);
      }
      const out = chatJsonToAnthropic(chatJson, chatBody.model);
      alog("done-json", JSON.stringify({ ms: Date.now() - t0, status, blocks: out.content.length, stop: out.stop_reason, usage: out.usage }));
      return json(res, 200, out);
    }
  } catch (err) {
    alog("execute-throw", String(err?.message || err).slice(0, 300));
    if (!res.headersSent) return json(res, 502, anthropicError("api_error", String(err?.message || err)));
    try { res.end(); } catch { /* ignore */ }
  }
}

export async function countTokensHandler(ctx) {
  const { req, res } = ctx;
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, anthropicError("invalid_request_error", "Invalid JSON body"));
  }
  const out = estimateTokens(body);
  alog("count-tokens", JSON.stringify({ model: body?.model, input_tokens: out.input_tokens }));
  return json(res, 200, out);
}
