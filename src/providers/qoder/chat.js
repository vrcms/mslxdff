// qoder 对话服务：上游恒 stream:true；请求方 stream=true → 真流式转发边收边吐，
// false → 聚合回 JSON。装配走 request.js，帧格式走 sse.js，两条管线共享。
import { compatFetch, timeoutSignal } from "../../compat.js";
import { normalizeRegion } from "./constants.js";
import { buildUpstreamRequest } from "./request.js";
import { reshapeQoderStream } from "./stream.js";
import { aggregateQoderStream, toCompletionJson } from "./aggregate.js";
import { errorStatus } from "./sse.js";

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return "-"; }
}

function errRes(status, msg, type = "upstream_error") {
  return new Response(JSON.stringify({ error: { message: msg, type } }), { status, headers: { "Content-Type": "application/json" } });
}

function mapUpstreamError(status, detail) {
  return { kind: status === 401 || status === 403 ? "auth" : "upstream", status, detail: String(detail || "").slice(0, 300) };
}

export function createChatService({ id = "qoder", fetchImpl, timeoutMs } = {}) {
  if (!fetchImpl) fetchImpl = compatFetch;

  // body: OpenAI chat 请求；sess: 已建 COSY 会话；region: 该账号所属区（每号独立选端点）。返回 Response。
  // 回显（可观测，不落凭据）：x-mslxdff-upstream=本次请求的 host、x-mslxdff-qoder-region=cn|global；
  // 管线层据此把"这次谁上的、打哪个站"投进模型日志（此前 provider 内部选号/切 URL 完全静默，排障无据）。
  const withEcho = (res, url, region, pick) => {
    try {
      res.headers.set("x-mslxdff-upstream", hostOf(url));
      res.headers.set("x-mslxdff-qoder-region", normalizeRegion(region));
      // 账号选择决定（new/sticky/switch/forced）：管线把它写进模型日志，"为什么会切号"才有据可查
      if (pick) res.headers.set("x-mslxdff-qoder-account", String(pick));
    } catch {}
    return res;
  };

  // 上游状态回显（内部交接用，不落日志）：流式路径按对外契约把非 200 整形成 "200 + 流内 error"，
  // 真实状态码只能靠这个头带出——否则 401/403/429/5xx 到不了 provider 门面，坏号不被冷却，
  // 而"同请求粘号"（ADR-0036）会把后续重试继续粘在这个坏号上。
  const withUpstreamStatus = (res, st) => {
    try { res.headers.set("x-mslxdff-qoder-upstream-status", String(st)); } catch {}
    return res;
  };

  async function runChat(body, sess, region = "global", pick = "") {
    const stream = body?.stream !== false;
    const model = body?.model || "qfmodel";
    const chatId = "chatcmpl-qoder-" + Math.random().toString(16).slice(2, 10);
    const tools = Array.isArray(body?.tools) && body.tools.length ? body.tools : null;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const maxTokens = Number(body?.max_tokens) || 0;

    let upRes; let reqUrl = "";
    const echo = (res) => withEcho(res, reqUrl, region, pick);
    try {
      const req = buildUpstreamRequest({ sess, region: normalizeRegion(region), model, messages, tools, maxTokens });
      reqUrl = req.url;
      upRes = await fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.bodyStr,
        signal: timeoutSignal(timeoutMs || 120_000),
      });
    } catch (e) {
      const detail = String(e?.message || e).slice(0, 300);
      // 网络异常（超时/连接失败）折成 502：门面据此冷却该号（否则坏号恒在轮换池里）
      if (stream) return withUpstreamStatus(echo(reshapeQoderStream(new Response("data: [DONE]\n\n"), { model, chatId })), 502);
      return withUpstreamStatus(echo(errRes(502, detail)), 502);
    }
    if (upRes.status !== 200) {
      const detail = await upRes.text().catch(() => "");
      const e = mapUpstreamError(upRes.status, detail);
      if (stream) {
        // 首包错误也走流内 error 事件（与旧 reshapeStream catch 语义一致：200 + event:error + DONE）
        const enc = new TextEncoder();
        const s = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`));
            c.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ message: e.detail, type: e.kind })}\n\ndata: [DONE]\n\n`));
            c.close();
          },
        });
        // 对外仍是 200（契约不变），真实状态码经回显头交门面决定是否冷却
        return withUpstreamStatus(echo(new Response(s, { status: 200, headers: { "Content-Type": "text/event-stream" } })), upRes.status);
      }
      return withUpstreamStatus(echo(errRes(errorStatus(e), e.detail, e.kind)), upRes.status);
    }
    if (stream) return echo(reshapeQoderStream(upRes, { model, chatId }));
    try {
      const agg = await aggregateQoderStream(upRes);
      const out = toCompletionJson({ model, chatId, ...agg });
      return echo(new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } }));
    } catch (e) {
      return echo(errRes(errorStatus(e), String(e?.detail || e?.message || e).slice(0, 300), e?.kind || "upstream_error"));
    }
  }

  return { runChat };
}
