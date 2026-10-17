import { json, readBody } from "./helpers.js";
import { createChatPipeline } from "../chat-pipeline/index.js";
import { responsesToChatBody, chatJsonToResponse, createChunkTranslator, chunkToString } from "../responses/translate.js";

/**
 * POST /v1/responses — 给 Codex/ChatGPT 桌面端用的 Responses API 薄壳。
 * 复用 ChatPipeline 全链路（auto/hedge/failover/tool_calls），只做形状翻译。
 * 非流式：收集 chat JSON → 转 Response 对象；流式：逐块实时翻成 responses SSE。
 */

export function withBody(req, body) {
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
export function createEmitter() {
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

/**
 * 纯错误帧直通判定（垫片 write 的前置拦截）：整段只含 `data:` 行、且每帧都是
 * `{error:{…}}` 形状（无 `choices`）时，返回原样 SSE 帧数组；否则返回 null（交翻译器）。
 * 为什么必须拦：翻译器只认 chat 帧（choices.delta），错误帧会被它静默 `continue` 掉。
 */
function passthroughErrorFrames(text) {
  const src = String(text ?? "");
  if (!src.includes("data:")) return null;
  const out = [];
  let sawError = false;
  for (const rawLine of src.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(":")) { out.push(`${line}\n\n`); continue; } // 注释帧照原样（翻译器也是跳过）
    if (!line.startsWith("data:")) return null;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") { out.push("data: [DONE]\n\n"); continue; }
    let j;
    try { j = JSON.parse(payload); } catch { return null; } // 解析失败 = 不是我们的错误帧，交翻译器（它自会记 jsonFails）
    if (!j || typeof j !== "object" || Array.isArray(j) || j.choices) return null; // 有 choices = chat 帧，绝不拦
    if (!j.error) return null; // 无 choices 又无 error：形状未知，交翻译器
    sawError = true;
    out.push(`data: ${JSON.stringify(j)}\n\n`);
  }
  return sawError ? out : null;
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
  // headersSent 必须是**计算值**：垫片的 write() 会调 sendHead() 真发头，若 headersSent 仍是普通属性
  // （只在 end() 里置真），则「头已发但流未结束」这段窗口里它为假 ⇒ helpers.json() 会走 `!headersSent`
  // 分支去 setHeader+end（而本垫片 setHeader 是 no-op、且真头已发）⇒ 错误体静默丢失、只剩裸关流。
  // messages-route 的 createAnthropicForwarder 早已用 getter 实现并点名了同一个坑；本处是同契约的遗漏。
  // 口径与 messages-route 的 createAnthropicForwarder 逐字对齐（哪里算「头已发」只此一处判）。
  const sent = () => headSent || realRes.headersSent === true;
  const res = {
    ...createEmitter(),
    set statusCode(v) { status = v; },
    get statusCode() { return status; },
    get headersSent() { return sent(); },
    set headersSent(_v) { /* 兼容旧赋值点：真实状态由 headSent/ended 推导，不接受外部覆写 */ },
    getHeader(k) { return String(k).toLowerCase() === "content-type" && sent() ? "text/event-stream" : undefined; },
    setHeader() {},
    write(c) {
      if (ended) return true;
      sendHead();
      const text = chunkToString(c);
      // 纯错误帧直写：helpers.json() 的 in-band 收场写的是 OpenAI 形状 `{error:{…}}`（无 choices），
      // 若交给 chat→responses 翻译器，会被当作「非 chat 帧」静默忽略（translate.js 只认 choices.delta）——
      // 错误在翻译层被吞掉，客户端只看到流被关。错误帧与 chat 帧形状互斥，故这里拦下直通。
      const errOut = passthroughErrorFrames(text);
      if (errOut != null) { for (const chunk of errOut) realRes.write(chunk); return true; }
      for (const e of translator.push(text)) realRes.write(`data: ${JSON.stringify(e)}\n\n`);
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
    // 文本丢失定位：各 message item 的 content 形状（part 类型 + 文本长度 + 头部）
    contentShapes: Array.isArray(body?.input)
      ? body.input.filter((i) => i && (i.type === "message" || i.role)).map((m) => ({
          type: m.type ?? "(无type)", role: m.role,
          cType: Array.isArray(m.content) ? "array" : typeof m.content,
          parts: Array.isArray(m.content) ? m.content.map((p) => `${p?.type ?? "?"}:${typeof p?.text === "string" ? p.text.length : "-"}`).slice(0, 6) : null,
          textHead: typeof m.content === "string" ? m.content.slice(0, 50) : null,
        })).slice(0, 10)
      : null,
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
