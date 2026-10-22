// qoder 对话服务：上游恒 stream:true；请求方 stream=true → 真流式转发边收边吐，
// false → 聚合回 JSON。装配走 request.js，帧格式走 sse.js，两条管线共享。
import { compatFetch, timeoutSignal } from "../../compat.js";
import { mapModel } from "./payload.js";
import { effortFromBody, effortLevelFromBody, isReasoningEnabled } from "../../thinking-effort.js";
import { normalizeRegion } from "./constants.js";
import { buildUpstreamRequest } from "./request.js";
import { reshapeQoderStream } from "./stream.js";
import { aggregateQoderStream, toCompletionJson } from "./aggregate.js";
import { errorStatus, extractDelta, findQuotaSignal, findLoginSignal, findQueueSignal, retryAfterFrom } from "./sse.js";

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

// 判决旗标（统一出口）：登录过期/额度/排队（含无容量子型）+ retryAfter 秒数。
// 非 200 直出与 200 信封裹身两条路径共用同一解析口，防两处漂移。
function verdictFlagsFrom(objOrText) {
  const v = { login: false, quota: false, queued: false, noCapacity: false, retryAfter: 0 };
  if (findLoginSignal(objOrText)) v.login = true;
  else if (findQuotaSignal(objOrText)) v.quota = true;
  else {
    const q = findQueueSignal(objOrText);
    if (q) { v.queued = true; v.noCapacity = q.noCapacity === true; }
  }
  const ra = retryAfterFrom(typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText ?? ""));
  if (ra.retryAfter) v.retryAfter = ra.retryAfter;
  return v;
}

// 预读上游首帧只为取「流内判决」：qoder 把限流/鉴权判决裹在 HTTP 200 的 SSE 信封里
//（statusCodeValue:403 + serviceAvailable:false），upRes.status 恒 200，判决只有读完帧才知道。
// 不预读则状态码永远出不来流式路径 → 门面不冷却该号（ADR-0036 的粘号会把重试继续粘在它上面）。
// 返回 { res, status, frames }：res 是把预读帧回灌后的等价上游响应，frames 交回灌用。
// 任何异常都降级为「无判决」（status=0）：排障手段不得变成故障源。
async function peekEnvelopeVerdict(upRes, cdbg) {
  if (!upRes?.body) return { res: upRes, status: 0, quota: false, queued: false, noCapacity: false, retryAfter: 0, login: false, frames: [] };
  let reader;
  try { reader = upRes.body.getReader(); } catch { return { res: upRes, status: 0, quota: false, queued: false, noCapacity: false, retryAfter: 0, login: false, frames: [] }; }
  const dec = new TextDecoder();
  const frames = [];
  let text = "";
  let status = 0;
  let quota = false;
  let queued = false;
  let noCapacity = false;
  let retryAfter = 0;
  let login = false;
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
        if (d.err) {
          status = Number(d.err.status) || 0;
          quota = d.err.kind === "quota";
          queued = d.err.queued === true;
          noCapacity = d.err.noCapacity === true;
          retryAfter = Number(d.err.retryAfter) || 0;
          login = d.err.loginExpired === true;
          decided = true; break;
        }
        if (d.content || d.reasoning || d.toolCalls || d.usageIn || d.usageOut) { decided = true; break; }
      }
    }
  } catch (e) {
    cdbg(`[peek-throw] ${String(e?.message || e).slice(0, 160)}`);
  }
  cdbg(`[peek] frames=${frames.length} verdict=${status || "none(正常流)"} quota=${quota} queued=${queued} noCapacity=${noCapacity} ra=${retryAfter} login=${login}`);
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
  return { res: new Response(body, { status: upRes.status, headers: upRes.headers }), status, quota, queued, noCapacity, retryAfter, login, frames };
}
export function createChatService({ id = "qoder", fetchImpl, timeoutMs, getModelMeta } = {}) {
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
  // 无容量旗标：10605 且 queueCount:0 + serviceAvailable:false = 整池共享同一 p3 队列、
  // 换号救不了，只能等 Retry-After。门面据此**不换号轮询**，带 429+Retry-After 如实透给客户端。
  const withNoCapacity = (res, retryAfter) => {
    try {
      res.headers.set("x-mslxdff-qoder-nocapacity", "1");
      if (retryAfter) {
        res.headers.set("x-mslxdff-qoder-retry-after", String(retryAfter));
        res.headers.set("Retry-After", String(retryAfter)); // 对客户端的标准交代（relay 层原样转发响应头）
      }
    } catch {}
    return res;
  };
  // 登录过期标记（内部交接，不落日志）：门面据此走「刷新令牌→原地重发」，不当普通坏号冷却轮询。
  const withLogin = (res) => {
    try { res.headers.set("x-mslxdff-qoder-login", "1"); } catch {}
    return res;
  };
  // 判决结果钉头（2026-10-22 用户实证「没多打日志→排查全靠猜」后补）：verdict 取值
  // login/quota/queue/queue-nocapacity/none，由 model-trace.upstreamEcho 落进模型日志。
  // 关键在 none 也要显式钉——「压根没命中」与「命中但走别的分支」在 403 盲视图里必须分得开。
  const verdictName = (v) => (v.login ? "login" : v.quota ? "quota" : v.queued ? (v.noCapacity ? "queue-nocapacity" : "queue") : "none");
  const withVerdict = (res, v) => {
    try { res.headers.set("x-mslxdff-qoder-verdict", verdictName(v)); } catch {}
    return res;
  };

  async function runChat(body, sess, region = "global", pick = "") {
    const stream = body?.stream !== false;
    const model = body?.model || "qfmodel";
    const chatId = "chatcmpl-qoder-" + Math.random().toString(16).slice(2, 10);
    const tools = Array.isArray(body?.tools) && body.tools.length ? body.tools : null;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const maxTokens = Number(body?.max_tokens) || 0;
    // is_reasoning 与能力元数据（窗口/档位）由模型目录一次供数（index 注入 getModelMeta，
    // 只读 peekModels 快照缓存，chat 路径恒 0 额外上游调用；preheat 负责灌缓存）。
    // 冷缓存/缺失一律降级：isReasoning=false、无 meta（= 旧行为，不阻断对话）。
    let meta = null;
    let isReasoning = false;
    try {
      if (getModelMeta) {
        meta = (await getModelMeta(sess, normalizeRegion(region), mapModel(model))) || null;
        isReasoning = meta?.is_reasoning === true;
      }
    } catch {}
    // 客户端显式档位优先于目录推断（grill-decisions Q3）：关断→false、其余非空→true；无档位→沿用目录结论。
    isReasoning = isReasoningEnabled(effortFromBody(body), isReasoning);
    const effortLevel = effortLevelFromBody(body); // 真档位串（low/medium/high…），透传给装配口对齐模型档位

    let upRes; let reqUrl = "";
    const echo = (res) => withEcho(res, reqUrl, region, pick);
    // 排障日志（QODER_DEBUG_STREAM=1 开）：记录出口/状态/耗时/响应头，便于对比"200 但空轮"
    const cdbg = (...a) => { if (process.env.QODER_DEBUG_STREAM === "1") console.log("[qoder-chat]", ...a); };
    let upMs = 0;
    try {
      const req = buildUpstreamRequest({ sess, region: normalizeRegion(region), model, messages, tools, maxTokens, isReasoning, meta, effort: effortLevel });
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
      // 真 HTTP 403 也可能直出 10605 排队/110 额度/105 登录（不只裹 200 信封）。
      // 旧版一律 mapUpstreamError(403)→auth→冷却换号，把「整池共享的 p3 无容量」当死号轮询白烧。
      // 先解析 body 定旗标：无容量 → 不换号、带 Retry-After 如实透；额度/登录 → 交门面对应处理。
      const vf = verdictFlagsFrom(detail);
      cdbg(`[verdict] status=${upRes.status} login=${vf.login} quota=${vf.quota} queued=${vf.queued} noCapacity=${vf.noCapacity} ra=${vf.retryAfter} bodyLen=${detail.length} body=${detail.slice(0, 300)}`);
      const e = vf.login ? { kind: "auth", status: 401, detail }
        : vf.quota ? { kind: "quota", status: 429, detail }
        : vf.queued ? { kind: "upstream", status: 429, detail }
        : mapUpstreamError(upRes.status, detail);
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
        let shaped = withUpstreamStatus(echo(new Response(s, { status: 200, headers: { "Content-Type": "text/event-stream" } })), upRes.status);
        shaped = withVerdict(shaped, vf);
        if (vf.quota) shaped = withQuota(shaped);
        if (vf.login) shaped = withLogin(shaped);
        if (vf.queued) shaped = vf.noCapacity ? withNoCapacity(shaped, vf.retryAfter) : withQueued(shaped);
        return shaped;
      }
      let out = withUpstreamStatus(echo(errRes(errorStatus(e), e.detail, e.kind)), upRes.status);
      out = withVerdict(out, vf);
      if (vf.quota) out = withQuota(out);
      if (vf.login) out = withLogin(out);
      if (vf.queued) out = vf.noCapacity ? withNoCapacity(out, vf.retryAfter) : withQueued(out);
      return out;
    }
    if (stream) {
      // 预读首帧取流内判决（qoder 把 403/429 裹在 200 的信封里），预读帧原样回灌给整形器。
      // 判决状态码经 withUpstreamStatus 出门面 → index.js 据此 ring.onError 冷却该号 →
      // 粘号选择器下次因 isCooling 为真而换号。对外仍恒 200（契约不变）。
      const peek = await peekEnvelopeVerdict(upRes, cdbg);
      const pvf = { login: peek.login, quota: peek.quota, queued: peek.queued, noCapacity: peek.noCapacity };
      let shaped = echo(reshapeQoderStream(peek.res, { model, chatId, prefetched: peek.frames }));
      // 只在真有判决时挂状态码：正常流不写这个头（index.js 靠它区分"要不要冷却"）
      if (peek.status) shaped = withUpstreamStatus(shaped, peek.status);
      // verdict 钉头同理只钉有判决的流——正常流不写，避免成功请求日志被 verdict=none 刷屏
      if (peek.status) shaped = withVerdict(shaped, pvf);
      if (peek.quota) shaped = withQuota(shaped);
      // 排队旗标（内部交接）：真排队（有人等位）→ 门面换号碰别的号；无容量 → 门面不换号透 Retry-After
      if (peek.queued) shaped = peek.noCapacity ? withNoCapacity(shaped, peek.retryAfter) : withQueued(shaped);
      // 登录过期旗标：门面据此刷新令牌原地重发（不冷却换号轮询整池过期号）
      if (peek.login) shaped = withLogin(shaped);
      return shaped;
    }
    try {
      const agg = await aggregateQoderStream(upRes);
      const out = toCompletionJson({ model, chatId, ...agg });
      return echo(new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } }));
    } catch (e) {
      // 聚合出口的判决折态（2026-10-22 真机实锤 req=mvj6u7wj：HTTP 恒 200、403 裹在 SSE 信封
      // statusCodeValue 里，extractDelta 的 err.status=403 原样 errRes 出去 → nocapacity 头挂了、
      // 状态却还是 403。无容量档必须与非 200 直出路径同口径折 429，否则门面 break 后
      // lastRes 透给客户端仍是 403，Retry-After 语义全丢）。
      const cvf = { login: e?.loginExpired === true, quota: e?.kind === "quota", queued: e?.queued === true, noCapacity: e?.noCapacity === true };
      const aggStatus = cvf.noCapacity ? 429 : errorStatus(e);
      let out = echo(errRes(aggStatus, String(e?.detail || e?.message || e).slice(0, 300), e?.kind || "upstream_error"));
      out = withVerdict(out, cvf);
      if (cvf.noCapacity && e?.retryAfter) out = withNoCapacity(out, e.retryAfter);
      let marked = cvf.quota ? withQuota(out) : out;
      if (cvf.queued && !cvf.noCapacity) marked = withQueued(marked);
      return cvf.login ? withLogin(marked) : marked;
    }
  }

  return { runChat };
}
