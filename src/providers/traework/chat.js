// traework 对话服务：createTransport 直调（仿 workbuddy/chat.js），不走 base.js Bearer runner。
// 上游恒 stream:true；请求方 stream=true 直接透传转换后的 OpenAI SSE，false 则聚合回 JSON。
import { joinUrl } from "../base.js";
import { createTransport } from "../../transport/index.js";
import { AGENT_HOST, EP_CHAT, FUNCTION } from "./constants.js";
import { soloHeaders } from "./headers.js";
import { prepareBody } from "./payload.js";
import { ErrKind, UpstreamError, SOLOStreamError, classify, isSessionDead } from "./errors.js";
import { aggregateStreamReader, convertToOpenAIChunks } from "./sse.js";
import { exchangeRefresh } from "./token.js";
import { applyTokenRefresh } from "./account-store.js";

const REFRESH_SKEW_S = 24 * 60 * 60;

function needsRefresh(auth) {
  const exp = Number(auth?.expiresAt) || 0;
  if (!exp) return false;
  return Math.floor(Date.now() / 1000) + REFRESH_SKEW_S >= exp;
}

function stripOwnPrefix(model, providerId) {
  const s = String(model || "");
  const i = s.indexOf("/");
  if (i <= 0) return s;
  return s.slice(0, i).toLowerCase() === String(providerId || "").toLowerCase() ? s.slice(i + 1) : s;
}

function errRes(status, msg, reason) {
  return new Response(JSON.stringify({ error: { message: msg, type: "upstream_error", reason } }), {
    status, headers: { "Content-Type": "application/json" },
  });
}

// 上游 SOLO SSE Response → OpenAI SSE Response（边读边转，透传流）。
function reshapeSoloStream(upstreamRes, { model, chatId }) {
  const src = upstreamRes.body;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  let usage = null;
  let finishSent = false;
  const stream = new ReadableStream({
    async start(ctrl) {
      const reader = src.getReader();
      const send = (text) => ctrl.enqueue(enc.encode(text));
      const sendChunk = (delta, finish) => {
        const chunk = { id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "", choices: [{ index: 0, delta }] };
        if (finish) chunk.choices[0].finish_reason = finish;
        if (usage) { chunk.usage = usage; usage = null; }
        send(`data: ${JSON.stringify(chunk)}\n\n`);
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (value) buf += dec.decode(value, { stream: !done });
          const lines = buf.split("\n");
          buf = lines.pop();
          let event = "";
          let data = "";
          const emit = (ev, dt) => {
            if (ev === "output") {
              let raw = null;
              try { raw = JSON.parse(dt); } catch { return; }
              const delta = {};
              if (typeof raw.response === "string" && raw.response) delta.content = raw.response;
              if (typeof raw.reasoning_content === "string" && raw.reasoning_content) delta.reasoning_content = raw.reasoning_content;
              if (raw.tool_calls != null) {
                const arr = Array.isArray(raw.tool_calls) ? raw.tool_calls : [raw.tool_calls];
                delta.tool_calls = arr.filter(Boolean).map((c) => {
                  const call = { ...(c || {}) };
                  if (call.function_call && typeof call.function_call === "object") { call.function = call.function_call; delete call.function_call; }
                  if (call.function && typeof call.function === "object") { delete call.function.namespace; delete call.function.partial_arguments; }
                  return call;
                });
              }
              if (Object.keys(delta).length) sendChunk(delta, "");
            } else if (ev === "token_usage") { try { usage = JSON.parse(dt); } catch {} }
            else if (ev === "done") { let f = "stop"; try { f = JSON.parse(dt)?.finish_reason || "stop"; } catch {} sendChunk({}, f); send("data: [DONE]\n\n"); finishSent = true; }
            else if (ev === "error") { let m = dt; try { const j = JSON.parse(dt); m = `solo error code=${j.code} msg=${j.message}`; } catch {} send(`event: error\ndata: ${JSON.stringify(m)}\n\n`); send("data: [DONE]\n\n"); finishSent = true; }
          };
          for (const line of lines) {
            const s = line.replace(/\r$/, "");
            if (s === "") { if (event) { emit(event, data); event = ""; data = ""; } continue; }
            if (s.startsWith("event:")) event = s.slice(6).trim();
            else if (s.startsWith("data:")) data += s.slice(5);
          }
          if (done) { if (event) emit(event, data); break; }
        }
      } catch (e) { try { ctrl.error(e); } catch {} return; }
      if (!finishSent) { try { send("data: [DONE]\n\n"); } catch {} }
      try { ctrl.close(); } catch {}
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

export function createChatService({
  id = "traework",
  baseUrl = AGENT_HOST,
  chatPath = EP_CHAT,
  keys = [],
  authList = [],
  ring,
  fetchImpl,
  dispatcher,
  connectTimeoutMs = 30_000,
  file,
  clock = Date.now,
  cooldownMs = 30_000,
} = {}) {
  const resolvedBase = String(baseUrl || AGENT_HOST).trim().replace(/\/+$/, "");
  const transport = createTransport({ fetchImpl, dispatcher, keepAlive: !!dispatcher, timeoutMs: connectTimeoutMs, retry: {} });

  function authForKey(key) {
    const idx = keys.indexOf(key);
    if (idx >= 0 && authList[idx]) return authList[idx];
    if (authList.length) return authList[0];
    return { uid: "", accessToken: key || "", refreshToken: "", expiresAt: 0, domain: "trae.cn", apiHost: "", machineId: "", deviceId: "" };
  }

  async function maybeRefresh(auth, key) {
    if (!auth?.uid || !needsRefresh(auth) || !auth.refreshToken) return;
    try {
      const r = await exchangeRefresh(fetchImpl, auth.apiHost, auth.refreshToken);
      await applyTokenRefresh({ uid: auth.uid, oldKey: key, newToken: r.token, refreshToken: r.refreshToken, domain: auth.domain, apiHost: auth.apiHost, machineId: auth.machineId, deviceId: auth.deviceId, enterpriseId: auth.enterpriseId, auth, keys, authList, file });
      try { ring.replace(key, r.token); } catch {}
    } catch {}
  }

  async function postOnce(key, auth, payload) {
    const cred = { ...auth, accessToken: key };
    return transport.request({
      url: joinUrl(resolvedBase, chatPath),
      method: "POST",
      headers: soloHeaders(cred, true),
      body: payload,
      stream: true,
      timeoutMs: connectTimeoutMs,
    });
  }

  async function runChat(body, activeRing, opts = {}) {
    const t0 = clock();
    const wantStream = body?.stream !== false;
    const rawModel = stripOwnPrefix(body?.model, id);
    const payload = prepareBody({ ...(body || {}), model: rawModel || body?.model, stream: true, function: FUNCTION });
    const chatId = `chatcmpl-${Date.now()}`;
    const tried = new Set();
    const maxTries = Math.min(3, Math.max(1, activeRing?.size || keys.length || 1));
    let lastErr = null;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      const key = activeRing ? activeRing.next() : keys[attempt];
      if (!key) break;
      const auth = authForKey(key);
      const uid = auth?.uid || "";
      if (tried.has(uid || key)) continue;
      tried.add(uid || key);
      await maybeRefresh(auth, key);
      const curKey = keys.includes(key) ? key : (keys[keys.indexOf(key)] || key);
      let res;
      try { res = await postOnce(curKey, authForKey(curKey), payload); }
      catch (e) { try { activeRing?.onError(key); } catch {} lastErr = e; continue; }
      if (res.status >= 400) {
        const txt = await res.text().catch(() => "");
        const kind = classify(res.status, txt);
        if (kind === ErrKind.SESSION_DEAD || isSessionDead(res.status, txt)) {
          try { activeRing?.onError(key); } catch {}
          continue; // 禁用语义：换号（同请求最多轮转3号）
        }
        if (kind === ErrKind.PLAN_LIMIT || kind === ErrKind.SOFT_RATE || res.status >= 500) {
          try { activeRing?.onError(key); } catch {}
          lastErr = new UpstreamError(kind, res.status, txt.slice(0, 200));
          continue;
        }
        if (res.status === 404) { lastErr = new UpstreamError(kind, res.status, txt.slice(0, 200)); continue; }
        return new Response(txt, { status: res.status, headers: { "Content-Type": "application/json" } });
      }
      if (wantStream) {
        const out = reshapeSoloStream(res, { model: rawModel, chatId });
        try { out._t = { attempts: [], waitMs: 0, totalMs: Math.round(clock() - t0) }; } catch {}
        return out;
      }
      try {
        const completion = await aggregateStreamReader(res.body, { model: rawModel, chatId });
        const out = new Response(JSON.stringify(completion), { status: 200, headers: { "Content-Type": "application/json" } });
        try { out._t = { attempts: [], waitMs: 0, totalMs: Math.round(clock() - t0) }; } catch {}
        return out;
      } catch (e) {
        // 流内 event:error：4023 上游瞬时错误/1005 plan 权益不足等。错误体原样透传给客户端（冷却按分类）：
        // 1005 → 长冷却语义；其他 code（如 4023 通用失败）→ 短冷却换号重试，不把号拉黑。
        if (e instanceof SOLOStreamError) {
          const kind = e.kind();
          // 1005 plan 权益不足：冷却该号换号重试；其余 code 上游通用失败：错误透传（不冷却，防雪崩）
          if (kind === ErrKind.PLAN_LIMIT) {
            try { activeRing?.onError(key); } catch {}
            if ((activeRing?.available?.() ?? keys.length) > tried.size) { lastErr = e; continue; }
          }
          lastErr = e;
          return errRes(502, e.message, kind);
        }
        if (e?.code !== undefined) { try { activeRing?.onError(key); } catch {} lastErr = e; continue; }
        throw e;
      }
    }
    if (lastErr instanceof UpstreamError) return errRes(lastErr.status >= 400 ? lastErr.status : 502, lastErr.message, lastErr.kind);
    if (lastErr) throw lastErr;
    return errRes(503, `${id}: all traework accounts exhausted or unavailable`, "exhausted");
  }

  return { runChat, authForKey, convertToOpenAIChunks, aggregateStreamReader };
}
