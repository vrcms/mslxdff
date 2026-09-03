import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { isFreeModel } from "./models.js";
import { fmtShanghaiYMDHMS } from "./time.js";
import { createTransport } from "./transport/index.js";

function genId(prefix) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}
function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
function isPreheatDisabled() {
  const raw = process.env.MSLXDFF_PREHEAT;
  if (raw === undefined || raw === null || raw === "") return false;
  const s = String(raw).trim().toLowerCase();
  return s === "0" || s === "off" || s === "false" || s === "no" || s === "disable" || s === "disabled";
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
} = {}) {
  function isAnonFirst() {
    const raw = process.env.MSLXDFF_OPENCOD_ANON_FIRST ?? process.env.MSLXDFF_ANON_FIRST ?? process.env.MSLXDFF_OPENCOD_ANON;
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
        "User-Agent": "opencode",
        "HTTP-Referer": "https://hermes-agent.nousresearch.com",
        "X-Title": "Hermes Agent",
      }
    : {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "x-opencode-client": "desktop",
      };
  function buildHeaders(body, { anonymous = anonFirst } = {}) {
    const isStream = body?.stream !== false;
    const base = {
      ...baseHeaders,
      Accept: isStream ? "text/event-stream" : "*/*",
      "User-Agent": "opencode",
      "x-opencode-session": genId("ses_"),
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
  function shouldTryAnonFree() {
    const raw = process.env.MSLXDFF_FREE_ANON;
    if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
    return true;
  }
  function isResponsesModel(model) {
    return String(model || "").toLowerCase().startsWith("muse-spark");
  }
  function chatToResponsesBody(chatBody) {
    const msgs = Array.isArray(chatBody?.messages) ? chatBody.messages : [];
    const system = msgs.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
    const nonSystem = msgs.filter((m) => m.role !== "system");
    const inputParts = nonSystem.map((m) => {
      const c = m.content;
      if (typeof c === "string") return `${m.role}: ${c}`;
      if (Array.isArray(c)) return `${m.role}: ${c.map((x) => x.text || "").join("")}`;
      return `${m.role}: ${String(c || "")}`;
    });
    const input = inputParts.join("\n\n") || "hi";
    const out = { model: chatBody.model, input, stream: false };
    if (system) out.instructions = system;
    if (chatBody.tools) out.tools = chatBody.tools;
    if (chatBody.tool_choice) out.tool_choice = chatBody.tool_choice;
    if (chatBody.temperature != null) out.temperature = chatBody.temperature;
    if (chatBody.max_tokens != null) out.max_output_tokens = chatBody.max_tokens;
    return out;
  }
  function responsesToChatJson(respJson) {
    let text = "";
    for (const item of respJson.output || []) {
      if (item.type === "message" && item.role === "assistant") {
        for (const c of item.content || []) {
          if (c.type === "output_text") text += c.text || "";
          else if (c.type === "text") text += c.text || "";
        }
      }
    }
    if (!text) {
      for (const item of respJson.output || []) {
        if (item.type === "message") {
          const t = item.content?.[0]?.text;
          if (t) { text = t; break; }
        }
      }
    }
    const chatJson = {
      id: respJson.id || `resp_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor((respJson.created_at || Date.now() / 1000)),
      model: respJson.model,
      choices: [{ index: 0, finish_reason: respJson.status === "completed" ? "stop" : "length", message: { role: "assistant", content: text } }],
      usage: respJson.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return chatJson;
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
    fetchImpl,
    timeoutMs: connectTimeoutMs,
    retry,
    hooks,
  });

  async function chat(body) {
    const isResp = isResponsesModel(body?.model);
    const url = isResp ? `${baseUrl}/zen/v1/responses` : `${baseUrl}/zen/v1/chat/completions`;
    const reqBody = isResp ? chatToResponsesBody(body) : body;
    const t0 = performance.now();

    // 首发请求（transport 已处理 network/429 等重试）
    let res;
    try {
      res = await transport.request({
        url,
        method: "POST",
        headers: buildHeaders(reqBody),
        body: reqBody,
        stream: body?.stream !== false,
        timeoutMs: connectTimeoutMs,
        retry,
      });
    } catch (e) {
      e._t = e._t || { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - t0) };
      throw e;
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
            headers: buildHeaders(reqBody, { anonymous: true }),
            body: reqBody,
            stream: body?.stream !== false,
            timeoutMs: connectTimeoutMs,
            retry,
          });
        } catch (e) {
          continue;
        }
        if (anonRes.status !== 429) {
          // responses 模型需转回 chat 形状
          let outAnon = anonRes;
          if (isResp && anonRes.ok) {
            try {
              const txt = await anonRes.text();
              const j = JSON.parse(txt);
              if (j && Array.isArray(j.output)) {
                const chatJson = responsesToChatJson(j);
                outAnon = new Response(JSON.stringify(chatJson), { status: anonRes.status, headers: new Headers(anonRes.headers) });
                outAnon.headers.set("content-type", "application/json");
              } else {
                outAnon = new Response(txt, { status: anonRes.status, headers: anonRes.headers });
              }
            } catch { outAnon = anonRes; }
          }
          outAnon._t = { ...(outAnon._t || {}), anonTried: true, anonAttempts: i + 1, totalMs: Math.round(performance.now() - t0) };
          consecutiveHits += 1;
          logFreeAnon({ model: body?.model, publicStatus: 429, anonStatus: anonRes.status, anonAttempts: i + 1, hit: true, totalMs: outAnon._t.totalMs });
          if (consecutiveHits >= 2) {
            try { appendFile(freeAnonLogFile(), `  -> 连续额外额度 ${consecutiveHits} 次\n`).catch(() => {}); } catch {}
          }
          return outAnon;
        }
      }
      if (anonRes) {
        anonRes._t = { ...(anonRes._t || {}), anonTried: true, anonAttempts: anonRetries, totalMs: Math.round(performance.now() - t0) };
        consecutiveHits = 0;
        logFreeAnon({ model: body?.model, publicStatus: 429, anonStatus: anonRes.status, anonAttempts: anonRetries, hit: false, totalMs: anonRes._t.totalMs });
        return anonRes;
      }
    }

    // responses 模型成功态转 chat
    if (isResp && res.ok) {
      try {
        const txt = await res.text();
        const j = JSON.parse(txt);
        if (j && Array.isArray(j.output)) {
          const chatJson = responsesToChatJson(j);
          const headers = new Headers(res.headers);
          headers.set("content-type", "application/json");
          const transformed = new Response(JSON.stringify(chatJson), { status: res.status, headers });
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
    return res;
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
