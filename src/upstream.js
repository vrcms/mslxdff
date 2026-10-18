import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { isFreeModel } from "./models.js";
import { fmtShanghaiYMDHMS } from "./time.js";
import { createTransport } from "./transport/index.js";
import { isResponsesModel, chatToResponsesBody, toChatResponse, reshapeResponsesSse } from "./upstream-responses.js";
import { ensureFreeLaneShape, aggregateChatSse } from "./free-lane.js";
import { digestIdTail, genId, opencodeClientIdentity, opencodeUa } from "./opencode-identity.js";

export { opencodeClientIdentity, opencodeUa };
// 上游按 session 做粘性路由（实测：固定 session 两次请求均 ~1.2s；每次随机时可能撞冷机器 26s+）。
// 客户端（opencode AI SDK 路径）不带会话标识 → 用对话首两条消息（system + 首条 user）哈希做稳定会话：
// 同一会话多轮里这两条不变 ⇒ 路由亲和稳定；不同会话天然分散。
function sessionFromMessages(messages) {
  try {
    const msgs = Array.isArray(messages) ? messages : [];
    const pick = (role) => {
      const m = msgs.find((x) => x?.role === role);
      if (!m) return "";
      return typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    };
    const seed = `${pick("system")}|${pick("user")}`.slice(0, 4000);
    if (seed === "|") return null;
    return `ses_${digestIdTail(crypto.createHash("sha1").update(seed).digest())}`;
  } catch {
    return null;
  }
}
function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
/** 允许 0 的数值 env（G1a 的逃生阀要认 0=关；envInt 的 `v>0` 会把 0 吞回默认值，那就是个假开关）。 */
function envIntOrZero(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}
function isPreheatDisabled() {
  const raw = process.env.MSLXDFF_PREHEAT;
  if (raw === undefined || raw === null || raw === "") return false;
  const s = String(raw).trim().toLowerCase();
  return s === "0" || s === "off" || s === "false" || s === "no" || s === "disable" || s === "disabled";
}
// opencode 上游身份头单一来源（legacy 与 SDK 引擎共用，free 层门禁头必须一致）。
// anonFirst 语义：authToken==="public" 时默认匿名（hermes referer）；env 可显式覆盖。
export function createOpencodeHeaderBuilder({ authToken = "public", env = process.env } = {}) {
  function isAnonFirst() {
    const raw = env.MSLXDFF_OPENCOD_ANON_FIRST ?? env.MSLXDFF_ANON_FIRST ?? env.MSLXDFF_OPENCOD_ANON;
    if (raw === undefined || raw === null || raw === "") return authToken === "public";
    const s = String(raw).trim().toLowerCase();
    if (s === "0" || s === "false" || s === "off" || s === "no" || s === "disable" || s === "disabled") return false;
    return authToken === "public";
  }
  const anonFirst = isAnonFirst();
  const baseHeaders = anonFirst
    ? {
        "Content-Type": "application/json",
        Authorization: "",
        "x-opencode-client": "desktop",
        "User-Agent": opencodeUa(),
        "HTTP-Referer": "https://hermes-agent.nousresearch.com",
        "X-Title": "Hermes Agent",
      }
    : {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "x-opencode-client": "desktop",
      };
  // 无 messages 可哈希时的进程级兜底：至少 daemon 生命周期内稳定，不再每请求随机
  const FALLBACK_SESSION = genId("ses_");
  function buildHeaders(body, { anonymous = anonFirst, sessionId = null } = {}) {
    const isStream = body?.stream !== false;
    const session = sessionId || sessionFromMessages(body?.messages) || FALLBACK_SESSION;
    const base = {
      ...baseHeaders,
      Accept: isStream ? "text/event-stream" : "*/*",
      "User-Agent": opencodeUa(),
      "x-opencode-session": session,
      "x-opencode-request": genId("msg_"),
      "x-opencode-project": "global",
    };
    if (anonymous) {
      return { ...base, Authorization: "", "HTTP-Referer": "https://hermes-agent.nousresearch.com", "X-Title": "Hermes Agent" };
    }
    if (anonFirst) {
      const { "HTTP-Referer": _a, "X-Title": _b, ...rest } = base;
      return { ...rest, Authorization: `Bearer ${authToken}` };
    }
    return base;
  }
  return { buildHeaders, anonFirst };
}

export function createUpstreamClient({
  baseUrl = process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
  authToken = process.env.UPSTREAM_AUTH_TOKEN || "public",
  connectTimeoutMs = Number(process.env.UPSTREAM_CONNECT_TIMEOUT_MS) || 30_000,
  retry = {
    network: { attempts: 2, delayMs: 300 },
    429: { attempts: 1, delayMs: 100 },
    502: { attempts: 1, delayMs: 100 },
    503: { attempts: 1, delayMs: 100 },
    504: { attempts: 1, delayMs: 100 },
  },
  fetchImpl,
  hooks,
  keepAlive = true,
  dispatcher,
} = {}) {
  const { buildHeaders, anonFirst } = createOpencodeHeaderBuilder({ authToken });
  function shouldTryAnonFree() {
    const raw = process.env.MSLXDFF_FREE_ANON;
    if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
    return true;
  }
  function freeAnonLogFile() {
    return process.env.MSLXDFF_FREE_ANON_LOG || join(process.cwd(), "free-anon-extra.txt");
  }
  function logFreeAnon({ model, publicStatus, anonStatus, anonAttempts, hit, totalMs }) {
    const file = freeAnonLogFile();
    const line = `${fmtShanghaiYMDHMS(new Date())} model=${model} public=429 anonTries=${anonAttempts} anonStatus=${anonStatus ?? "none"} hit=${hit ? "YES额外额度" : "NO无额外"} totalMs=${totalMs} count=${hit ? "1" : "0"}\n`;
    try { mkdirSync(dirname(file), { recursive: true }); } catch {}
    appendFile(file, line).catch(() => {});
    try { if (process.env.MSLXDFF_DEBUG === "1") console.log(`[free-anon] ${line.trim()}`); } catch {}
  }
  let consecutiveHits = 0;

  // 深模块：网络层委托 StreamingTransport
  const transport = createTransport({
    keepAlive,
    dispatcher,
    fetchImpl,
    timeoutMs: connectTimeoutMs,
    retry,
    hooks,
  });

  async function chat(body, opts = {}) {
    const isResp = isResponsesModel(body?.model);
    // responses 路径的 reqBody 无 messages，会话哈希必须基于原始 chat body 计算
    const sessionId = opts?.sessionId || sessionFromMessages(body?.messages) || null;
    const url = isResp ? `${baseUrl}/zen/v1/responses` : `${baseUrl}/zen/v1/chat/completions`;
    const reqBody = isResp ? chatToResponsesBody(body) : body;
    const clientWantsStream = body?.stream !== false;
    // zen 免费层 agent 形状门禁（2026-09-18）：必须流式 + 含核心五工具名，否则 403 FreeTierError
    const freeLane = authToken === "public" && isFreeModel(body?.model);
    if (freeLane) ensureFreeLaneShape(reqBody, { responses: isResp });
    const laneDebug = freeLane && envInt("MSLXDFF_FREE_LANE_DEBUG", 0) === 1;
    if (laneDebug) {
      try { console.error(`[free-lane] send model=${body?.model} url=${url} stream=${reqBody.stream} tools=${(reqBody.tools || []).length} ua=${opencodeUa()} want=${clientWantsStream}`); } catch {}
    }
    // 非流式调用者实际拿到的是被强制流式的上游 → 聚合回 chat completion JSON
    async function agentJson(resp) {
      if (!(freeLane && !clientWantsStream && resp.ok)) return resp;
      const ct = resp.headers?.get?.("content-type") || "";
      if (!ct.includes("text/event-stream")) return resp;
      try {
        const out = await aggregateChatSse(resp);
        out._t = resp._t;
        return out;
      } catch {
        return resp;
      }
    }
    const t0 = performance.now();

     // 首发请求（transport 已处理 network/429 等重试）
    let res;
    const firstHeaders = buildHeaders(reqBody, { sessionId });
    try {
      res = await transport.request({
        url,
        method: "POST",
        headers: firstHeaders,
        body: reqBody,
        stream: reqBody.stream !== false,
        timeoutMs: connectTimeoutMs,
        retry,
      });
    } catch (e) {
      e._t = e._t || { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - t0) };
      throw e;
    }
    if (laneDebug) {
      try { console.error(`[free-lane] resp model=${body?.model} status=${res.status} ct=${res.headers?.get?.("content-type") || ""}`); } catch {}
    }

    // G1a（ADR-0061）**请求内**榨干 v6 出口池：free 模型撞出口池级 429 时，await dispatcher 换一个新
    // 源地址、在**同一请求内**重发——额度按出口 IP 计，本节点 v6 池里的其余地址这一发就该用上，
    // 而不是把 429 退回客户端/组长、留给"下一个请求"。
    // 边界（探测实证过的硬约束）：① 仅头部即 429 才换（不碰半开的 200 流）；② 429 错误体已被
    // transport 非流分支读尽，无连接泄漏；③ 每轮换的是 session 粘的那个槽（swap 原地换 addr/e.agent，
    // 粘性映射不失效）；④ 次数上限防 429 风暴空烧认领地址；⑤ 无 rotateFor 的 dispatcher（直连/WARP）
    // 条件短路——WARP 换出口=重注册设备 6s~600s，在请求内做只会白等，**设计上排除**。
    if (freeLane && res.status === 429 && typeof transport.dispatcher?.rotateFor === "function") {
      const maxRot = envIntOrZero("MSLXDFF_V6_INREQUEST_RETRIES", 3); // 0 = 关掉请求内换出口
      let rotated = 0;
      while (res.status === 429 && rotated < maxRot) {
        let next = null;
        try {
          // 用**线上传的那个** session 头定位粘性槽（无 messages 时 buildHeaders 兜底成进程级
          // FALLBACK_SESSION；传 null 会让 selector 轮转到别的槽，换掉一个没准真没耗尽的健康出口）
          next = await transport.dispatcher.rotateFor(firstHeaders["x-opencode-session"] || "");
        } catch { break; }
        if (!next?.agent) break; // 换不到新出口（空池/全在换址/认领失败）⇒ 正常收场，不黑洞
        rotated += 1;
        if (laneDebug) {
          try { console.error(`[free-lane] v6 in-request rotate #${rotated} ${next.from} -> ${next.addr} model=${body?.model}`); } catch {}
        }
        try {
          res = await transport.request({
            url,
            method: "POST",
            headers: buildHeaders(reqBody, { sessionId }),
            body: reqBody,
            stream: reqBody.stream !== false,
            timeoutMs: connectTimeoutMs,
            retry,
            dispatcher: next.agent, // per-call 出口：绕开 extDispatcher 的旧槽选择
          });
        } catch (e) {
          e._t = e._t || { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - t0) };
          throw e;
        }
      }
      if (rotated) {
        res._t = { ...(res._t || {}), egressRotations: rotated, egressRecovered: res.status < 400 };
        try {
          appendFile(freeAnonLogFile(), `${fmtShanghaiYMDHMS(new Date())} model=${body?.model} v6-in-request-rotations=${rotated} finalStatus=${res.status}\n`).catch(() => {});
        } catch {}
      }
    }

    // 匿名兜底：仅非 anonFirst 时，public 429 + free 模型才走 hermes 空头重试
    if (!anonFirst && res.status === 429 && isFreeModel(body?.model) && shouldTryAnonFree()) {
      const anonRetries = envInt("MSLXDFF_FREE_ANON_RETRIES", 3);
      const anonDelay = envInt("MSLXDFF_FREE_ANON_DELAY_MS", 1000);
      let anonRes = null;
      for (let i = 0; i < anonRetries; i++) {
        await new Promise((r) => setTimeout(r, anonDelay));
        try {
          anonRes = await transport.request({
            url,
            method: "POST",
            headers: buildHeaders(reqBody, { anonymous: true, sessionId }),
            body: reqBody,
            stream: reqBody.stream !== false,
            timeoutMs: connectTimeoutMs,
            retry,
          });
        } catch (e) {
          continue;
        }
        if (anonRes.status !== 429) {
          // responses 模型需转回 chat 形状（复用 upstream-responses）
          let outAnon = anonRes;
          if (isResp && anonRes.ok) {
            const ctAnon = anonRes.headers.get("content-type") || "";
            const isStreamAnon = (clientWantsStream || freeLane) && ctAnon.includes("text/event-stream");
            if (isStreamAnon) {
              outAnon = reshapeResponsesSse(anonRes, body.model);
            } else {
              try {
                const txt = await anonRes.text();
                const j = JSON.parse(txt);
                if (j && Array.isArray(j.output)) {
                  outAnon = toChatResponse(anonRes, j);
                } else {
                  outAnon = new Response(txt, { status: anonRes.status, headers: anonRes.headers });
                }
              } catch { outAnon = anonRes; }
            }
          }
          outAnon._t = { ...(outAnon._t || {}), anonTried: true, anonAttempts: i + 1, totalMs: Math.round(performance.now() - t0) };
          consecutiveHits += 1;
          logFreeAnon({ model: body?.model, publicStatus: 429, anonStatus: anonRes.status, anonAttempts: i + 1, hit: true, totalMs: outAnon._t.totalMs });
          if (consecutiveHits >= 2) {
            try { appendFile(freeAnonLogFile(), `  -> 连续额外额度 ${consecutiveHits} 次\n`).catch(() => {}); } catch {}
          }
          return await agentJson(outAnon);
        }
      }
      if (anonRes) {
        anonRes._t = { ...(anonRes._t || {}), anonTried: true, anonAttempts: anonRetries, totalMs: Math.round(performance.now() - t0) };
        consecutiveHits = 0;
        logFreeAnon({ model: body?.model, publicStatus: 429, anonStatus: anonRes.status, anonAttempts: anonRetries, hit: false, totalMs: anonRes._t.totalMs });
        return anonRes;
      }
    }

    // responses 模型成功态转 chat（复用 upstream-responses）
    if (isResp && res.ok) {
      const ct = res.headers.get("content-type") || "";
      const isStream = (clientWantsStream || freeLane) && ct.includes("text/event-stream");
      if (isStream) {
        const transformed = reshapeResponsesSse(res, body.model);
        transformed._t = { ...(res._t || {}), totalMs: Math.round(performance.now() - t0) };
        return await agentJson(transformed);
      }
      try {
        const txt = await res.text();
        const j = JSON.parse(txt);
        if (j && Array.isArray(j.output)) {
          const transformed = toChatResponse(res, j);
          transformed._t = { ...(res._t || {}), totalMs: Math.round(performance.now() - t0) };
          return transformed;
        }
        const fallback = new Response(txt, { status: res.status, headers: res.headers });
        fallback._t = { ...(res._t || {}), totalMs: Math.round(performance.now() - t0) };
        return fallback;
      } catch {
        res._t = { ...(res._t || {}), totalMs: Math.round(performance.now() - t0) };
        return res;
      }
    }
    res._t = { ...(res._t || {}), totalMs: res._t?.totalMs ?? Math.round(performance.now() - t0) };
    return await agentJson(res);
  }

  async function preheat() {
    if (isPreheatDisabled()) return { ok: false, skipped: true, reason: "disabled" };
    const t0 = performance.now();
    try {
      const res = await transport.request({
        url: `${baseUrl}/zen/v1/models`,
        method: "GET",
        headers: buildHeaders({ stream: false }),
        stream: false,
        timeoutMs: 3000,
      });
      try { await res.text().catch(() => {}); } catch {}
      return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), ms: Math.round(performance.now() - t0) };
    }
  }
  async function close() {
    await transport.close();
  }
  const headers = buildHeaders({});
  return { chat, preheat, close, headers, buildHeaders, get dispatcher() { return transport.dispatcher; }, get agent() { return transport.agent; }, [Symbol.asyncDispose]: close };
}
