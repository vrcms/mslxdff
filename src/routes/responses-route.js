import { json, readBody } from "./helpers.js";
import { createChatPipeline } from "../chat-pipeline/index.js";
import { responsesToChatBody, chatJsonToResponse, createChunkTranslator, chunkToString } from "../responses/translate.js";

/**
 * POST /v1/responses — 给 Codex/ChatGPT 桌面端用的 Responses API 薄壳。
 * 复用 ChatPipeline 全链路（auto/hedge/failover/tool_calls），只做形状翻译。
 * 非流式：收集 chat JSON → 转 Response 对象；流式：逐块实时翻成 responses SSE。
 */

function withBody(req, body) {
  return Object.assign(Object.create(Object.getPrototypeOf(req)), req, { body });
}

function errorShape(text, status) {
  let msg = String(text || "").slice(0, 500);
  try {
    const j = JSON.parse(String(text || ""));
    msg = String(j?.error?.message || j?.error || msg);
  } catch {}
  return { error: { message: msg || "upstream error", type: "server_error", code: status } };
}

// 最小事件发射器：pipeline 靠 res.on("close") 感知下游断开，垫片必须有
function createEmitter() {
  const map = new Map();
  const self = {
    on(ev, fn) { if (typeof fn === "function") { if (!map.has(ev)) map.set(ev, []); map.get(ev).push(fn); } return self; },
    once(ev, fn) { const w = (...a) => { self.off(ev, w); fn(...a); }; return self.on(ev, w); },
    off(ev, fn) { const l = map.get(ev); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return self; },
    removeListener(ev, fn) { return self.off(ev, fn); },
    emit(ev, ...a) { for (const fn of [...(map.get(ev) || [])]) { try { fn(...a); } catch {} } return true; },
  };
  return self;
}

// 非流式：收集捕获
export function createCollector() {
  let status = 200;
  let text = "";
  const res = {
    ...createEmitter(),
    set statusCode(v) { status = v; },
    get statusCode() { return status; },
    headersSent: false,
    setHeader() {},
    write(c) { text += chunkToString(c); return true; },
    end(c) { if (c != null) text += chunkToString(c); res.headersSent = true; },
  };
  return { res, get: () => ({ status, text }) };
}

// 流式：逐 write 实时翻译并转发（head 延迟到首块，避免错误状态码已发送）
export function createLiveForwarder(realRes, translator) {
  let status = 200;
  let headSent = false;
  let ended = false;
  const sendHead = () => {
    if (headSent) return;
    headSent = true;
    realRes.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const e of translator.begin()) realRes.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const res = {
    ...createEmitter(),
    set statusCode(v) { status = v; },
    get statusCode() { return status; },
    headersSent: false,
    setHeader() {},
    write(c) {
      if (ended) return true;
      sendHead();
      for (const e of translator.push(chunkToString(c))) realRes.write(`data: ${JSON.stringify(e)}\n\n`);
      return true;
    },
    end(c) {
      if (ended) return;
      ended = true;
      res.headersSent = true;
      if (status >= 400 && !headSent) {
        json(realRes, status, errorShape(c, status));
        return;
      }
      sendHead();
      if (c != null) for (const e of translator.push(chunkToString(c))) realRes.write(`data: ${JSON.stringify(e)}\n\n`);
      const fin = translator.getFinal();
      for (const e of translator.end({ finish: fin.finish, usage: fin.usage })) realRes.write(`data: ${JSON.stringify(e)}\n\n`);
      realRes.write("data: [DONE]\n\n");
      try { realRes.end(); } catch {}
    },
  };
  return res;
}

const RDEBUG = process.env.MSLXDFF_RESPONSES_DEBUG === "1";
function rlog(...a) {
  if (RDEBUG) console.log("[responses]", ...a);
}

export async function responsesHandler(ctx) {
  const { req, res } = ctx;
  const t0 = Date.now();
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: { message: "Invalid JSON body" } });
  }
  rlog("req", JSON.stringify({
    model: body?.model, stream: body?.stream,
    inputType: typeof body?.input, inputLen: Array.isArray(body?.input) ? body.input.length : String(body?.input || "").length,
    inputKinds: Array.isArray(body?.input) ? [...new Set(body.input.map((i) => i?.type))] : null,
    tools: Array.isArray(body?.tools) ? body.tools.length : 0,
    instructionsLen: String(body?.instructions || "").length,
  }));
  let chatBody;
  try {
    chatBody = responsesToChatBody(body);
  } catch (e) {
    rlog("translate-req-400", String(e?.message || e));
    return json(res, 400, { error: { message: String(e?.message || e) } });
  }
  rlog("chat", JSON.stringify({ model: chatBody.model, stream: chatBody.stream, msgs: chatBody.messages.map((m) => `${m.role}:${String(m.content || "").length}${m.tool_calls ? `+${m.tool_calls.length}tc` : ""}`) }));
  const pipeline = createChatPipeline(ctx);
  const fakeReq = withBody(req, chatBody);
  // 真连接断开 → 透传给垫片，pipeline 的 abort 链路不断
  const forwardClose = (shim) => { try { req.on?.("close", () => shim.emit("close")); } catch {} };
  try {
    if (chatBody.stream) {
      const translator = createChunkTranslator(chatBody.model);
      const live = createLiveForwarder(res, translator);
      forwardClose(live);
      await pipeline.execute({ req: fakeReq, res: live });
      const st = translator.stats();
      rlog("done-stream", JSON.stringify({ ms: Date.now() - t0, model: chatBody.model, ...st, finish: translator.getFinal().finish, usage: translator.getFinal().usage }));
    } else {
      const cap = createCollector();
      forwardClose(cap.res);
      await pipeline.execute({ req: fakeReq, res: cap.res });
      const { status, text } = cap.get();
      rlog("done-json", JSON.stringify({ ms: Date.now() - t0, model: chatBody.model, status, bytes: text.length, head: text.slice(0, 160) }));
      if (status >= 400) return json(res, status, errorShape(text, status));
      let chatJson = null;
      try { chatJson = JSON.parse(text); } catch {}
      if (!chatJson || chatJson.object === "error" || chatJson.error) {
        rlog("translate-resp-502", text.slice(0, 300));
        return json(res, status >= 400 ? status : 502, errorShape(text, status));
      }
      const respObj = chatJsonToResponse(chatJson, chatBody.model);
      rlog("done-resp", JSON.stringify({ ms: Date.now() - t0, model: chatBody.model, status: respObj.status, items: respObj.output.length, textLen: JSON.stringify(respObj.output).length, usage: respObj.usage }));
      // 非 JSON 透传（上游偶发）：包成纯文本 Response
      if (!chatJson.choices) {
        return json(res, 200, { id: chatJson.id || `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: chatBody.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: String(text).slice(0, 8000) }] }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
      return json(res, 200, respObj);
    }
  } catch (err) {
    rlog("execute-throw", String(err?.message || err).slice(0, 300));
    if (!res.headersSent) return json(res, 502, { error: { message: String(err?.message || err).slice(0, 500) } });
    try { res.end(); } catch {}
  }
}
