// qoder 对话服务：上游恒 stream:true；请求方 stream=true → 真流式转发边收边吐，
// false → 聚合回 JSON。装配走 request.js，帧格式走 sse.js，两条管线共享。
import { compatFetch, timeoutSignal } from "../../compat.js";
import { normalizeRegion } from "./constants.js";
import { buildUpstreamRequest } from "./request.js";
import { reshapeQoderStream } from "./stream.js";
import { aggregateQoderStream, toCompletionJson } from "./aggregate.js";
import { errorStatus, extractDelta } from "./sse.js";

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return "-"; }
}

function errRes(status, msg, type = "upstream_error") {
  return new Response(JSON.stringify({ error: { message: msg, type } }), { status, headers: { "Content-Type": "application/json" } });
}

function mapUpstreamError(status, detail) {
  return { kind: status === 401 || status === 403 ? "auth" : "upstream", status, detail: String(detail || "").slice(0, 300) };
}

// 预读上限：判决恒在首帧（实测 457 字节），8 帧足够覆盖"角色帧先到、判决帧随后"，
// 又不会把首字节延迟拖到不可控。超窗未得判决即放弃（退化为无冷却的流内 error，见 SPEC 已知上限）。
const PEEK_MAX_FRAMES = 8;

// 预读上游首帧只为取「流内判决」：qoder 把限流/鉴权判决裹在 HTTP 200 的 SSE 信封里
//（statusCodeValue:403 + serviceAvailable:false），upRes.status 恒 200，判决只有读完帧才知道。
// 不预读则状态码永远出不来流式路径 → 门面不冷却该号（ADR-0036 的粘号会把重试继续粘在它上面）。
// 返回 { res, status, frames }：res 是把预读帧回灌后的等价上游响应，frames 交回灌用。
// 任何异常都降级为「无判决」（status=0）：排障手段不得变成故障源。
async function peekEnvelopeVerdict(upRes, cdbg) {
  if (!upRes?.body) return { res: upRes, status: 0, quota: false, queued: false, frames: [] };
  let reader;
  try { reader = upRes.body.getReader(); } catch { return { res: upRes, status: 0, quota: false, queued: false, frames: [] }; }
  const dec = new TextDecoder();
  const frames = [];
  let text = "";
  let status = 0;
  let quota = false;
  let queued = false;
  let decided = false;
  try {
    for (let i = 0; i < PEEK_MAX_FRAMES && !decided; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { frames.push(value); text += dec.decode(value, { stream: true }); }
      // 逐行判定：先到判决（err）或先到有效载荷即停，避免无谓等待
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (!p || p === "[DONE]") continue;
        const d = extractDelta(p);
        if (d.err) { status = Number(d.err.status) || 0; quota = d.err.kind === "quota"; queued = d.err.queued === true; decided = true; break; }
        if (d.content || d.reasoning || d.toolCalls || d.usageIn || d.usageOut) { decided = true; break; }
      }
    }
  } catch (e) {
    cdbg(`[peek-throw] ${String(e?.message || e).slice(0, 160)}`);
  }
  cdbg(`[peek] frames=${frames.length} verdict=${status || "none(正常流)"} quota=${quota} queued=${queued}`);
  // 回灌：已读帧先按原样吐出，再接续同一个 reader 的剩余部分
  const body = new ReadableStream({
    start(ctrl) {
      for (const f of frames) { try { ctrl.enqueue(f); } catch {} }
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) ctrl.enqueue(value);
          }
        } catch {}
        try { ctrl.close(); } catch {}
      })();
    },
  });
  return { res: new Response(body, { status: upRes.status, headers: upRes.headers }), status, quota, queued, frames };
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
  // Note: 流内判决需预读首帧才能拿到（HTTP 200 里裹 statusCodeValue）— 见 .agents/notes/implemented/bug-fix/2026-09-27-qoder-envelope-verdict-cooldown.md
  const withUpstreamStatus = (res, st) => {
    try { res.headers.set("x-mslxdff-qoder-upstream-status", String(st)); } catch {}
    return res;
  };
  // 额度耗尽标记（内部交接，不落日志）：门面据此换号（长冷却该号）而非普通短冷却
  const withQuota = (res) => {
    try { res.headers.set("x-mslxdff-qoder-quota", "1"); } catch {}
    return res;
  };
  // 排队标记（内部交接，不落日志）：与额度同为「换号」信号但冷却档不同——
  // 排队是「稍后再来」，长冷却到点自动回池；额度是「今天没了」，按天重置才回。
  const withQueued = (res) => {
    try { res.headers.set("x-mslxdff-qoder-queued", "1"); } catch {}
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
    // 排障日志（QODER_DEBUG_STREAM=1 开）：记录出口/状态/耗时/响应头，便于对比"200 但空轮"
    const cdbg = (...a) => { if (process.env.QODER_DEBUG_STREAM === "1") console.log("[qoder-chat]", ...a); };
    let upMs = 0;
    try {
      const req = buildUpstreamRequest({ sess, region: normalizeRegion(region), model, messages, tools, maxTokens });
      reqUrl = req.url;
      cdbg(`[req] url=${hostOf(req.url)} region=${normalizeRegion(region)} model=${model} msgs=${messages.length} tools=${tools?.length ?? 0} maxTokens=${maxTokens} stream=${stream} bodyBytes=${req.bodyStr?.length ?? 0}`);
      const t0 = Date.now();
      upRes = await fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.bodyStr,
        signal: timeoutSignal(timeoutMs || 120_000),
      });
      upMs = Date.now() - t0;
      cdbg(`[res] status=${upRes.status} ms=${upMs} ct=${upRes.headers.get("content-type")} host=${hostOf(reqUrl)}`);
    } catch (e) {
      const detail = String(e?.message || e).slice(0, 300);
      cdbg(`[res-throw] ms=${upMs} err=${detail}`);
      // 网络异常（超时/连接失败）折成 502：门面据此冷却该号（否则坏号恒在轮换池里）
      if (stream) return withUpstreamStatus(echo(reshapeQoderStream(new Response("data: [DONE]\n\n"), { model, chatId })), 502);
      return withUpstreamStatus(echo(errRes(502, detail)), 502);
    }
    if (upRes.status !== 200) {
      const detail = await upRes.text().catch(() => "");
      cdbg(`[res-non200] status=${upRes.status} body=${detail.slice(0, 300)}`);
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
    if (stream) {
      // 预读首帧取流内判决（qoder 把 403/429 裹在 200 的信封里），预读帧原样回灌给整形器。
      // 判决状态码经 withUpstreamStatus 出门面 → index.js 据此 ring.onError 冷却该号 →
      // 粘号选择器下次因 isCooling 为真而换号。对外仍恒 200（契约不变）。
      const peek = await peekEnvelopeVerdict(upRes, cdbg);
      let shaped = echo(reshapeQoderStream(peek.res, { model, chatId, prefetched: peek.frames }));
      // 只在真有判决时挂状态码：正常流不写这个头（index.js 靠它区分"要不要冷却"）
      if (peek.status) shaped = withUpstreamStatus(shaped, peek.status);
      if (peek.quota) shaped = withQuota(shaped);
      // 排队旗标（内部交接）：门面据此走队列档冷却并在同一请求内换号，别把排队号送回客户端
      if (peek.queued) shaped = withQueued(shaped);
      return shaped;
    }
    try {
      const agg = await aggregateQoderStream(upRes);
      const out = toCompletionJson({ model, chatId, ...agg });
      return echo(new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } }));
    } catch (e) {
      const out = echo(errRes(errorStatus(e), String(e?.detail || e?.message || e).slice(0, 300), e?.kind || "upstream_error"));
      const marked = e?.kind === "quota" ? withQuota(out) : out;
      return e?.queued ? withQueued(marked) : marked;
    }
  }

  return { runChat };
}
