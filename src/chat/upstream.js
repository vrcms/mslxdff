import { performance } from "node:perf_hooks";
import { CHAT_PREFERRED, CHAT_FALLBACK, CHAT_TIMEOUT_MS, CHAT_GATEWAY_TIMEOUT_MS } from "./config.js";
import { createUpstreamClient } from "../upstream.js";
import { DEFAULT_PORT } from "../state.js";

function modelForAttempt(attempt) {
  return attempt === 0 ? CHAT_PREFERRED : CHAT_FALLBACK;
}

export async function chatOnce({ messages, tools, model }) {
  const client = createUpstreamClient({ connectTimeoutMs: CHAT_TIMEOUT_MS, keepAlive: false, fetchImpl: globalThis.fetch });
  const body = {
    model: model || CHAT_PREFERRED,
    messages,
    stream: false,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  try {
    const res = await client.chat(body);
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch { return { ok: false, error: `non-json upstream: ${txt.slice(0, 800)}`, status: res.status }; }
    if (!res.ok) {
      const msg = j?.error?.message || txt.slice(0, 800);
      const isInput400 = res.status === 400 && /prompt|messages/i.test(msg) && tools?.length;
      if (isInput400) {
        try { await client.close(); } catch {}
        const retry = await chatOnceNoTools({ messages, model });
        if (retry.ok) return { ...retry, retriedWithoutTools: true };
        return { ok: false, error: msg, status: res.status, retried: retry.error };
      }
      return { ok: false, error: msg, status: res.status };
    }
    const choice = j.choices?.[0];
    if (!choice) return { ok: false, error: "no choice", status: res.status };
    return { ok: true, message: choice.message, usage: j.usage, raw: j, status: res.status };
  } finally {
    try { await client.close(); } catch {}
  }
}

async function chatOnceNoTools({ messages, model }) {
  const client = createUpstreamClient({ connectTimeoutMs: CHAT_TIMEOUT_MS, keepAlive: false, fetchImpl: globalThis.fetch });
  const body = { model: model || CHAT_PREFERRED, messages, stream: false };
  try {
    const res = await client.chat(body);
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch { return { ok: false, error: `non-json: ${txt.slice(0,800)}`, status: res.status }; }
    if (!res.ok) return { ok: false, error: j?.error?.message || txt.slice(0,800), status: res.status };
    const choice = j.choices?.[0];
    if (!choice) return { ok: false, error: "no choice", status: res.status };
    return { ok: true, message: choice.message, usage: j.usage, raw: j, status: res.status };
  } finally { try { await client.close(); } catch {} }
}

// 带自动降级：mimo-v2.5-free → big-pickle → 本地 8989 auto（网关 auto，含多供应商择优/hedge/peer）
async function chatViaGateway({ messages, tools }) {
  const TRACE = process.env.MSLXDFF_CHAT_TRACE !== "0";
  const t0 = TRACE ? performance.now() : 0;
  let port = DEFAULT_PORT;
  let token = "";
  try {
    const state = await import("../state.js");
    const loaded = await state.loadToken();
    token = String(loaded?.token || "").trim();
    const p = state.getPort();
    if (Number.isInteger(p) && p > 0) port = p;
    else if (Number.isInteger(Number(process.env.MSLXDFF_PORT)) && Number(process.env.MSLXDFF_PORT) > 0) port = Number(process.env.MSLXDFF_PORT);
  } catch {}
  // token 为空则尝试直接读 state 文件兜底（避免 loadToken 异常时无 token）
  if (!token) {
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const sf = process.env.MSLXDFF_STATE_FILE || join(homedir(), ".config", "mslxdff", "state.json");
      if (existsSync(sf)) {
        const j = JSON.parse(readFileSync(sf, "utf8"));
        if (typeof j.token === "string" && j.token.trim()) token = j.token.trim();
      }
    } catch {}
  }
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const body = { model: "auto", messages, stream: false };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_GATEWAY_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch {
      // 网关可能因 workbuddy 强制 stream:true 而返回 SSE（text/event-stream），需兼容
      if (txt.includes("data:")) {
        try {
          const lines = txt.split(/\r?\n/);
          let content = "";
          let model = "auto";
          let usage = null;
          let sseOk = false;
          for (const line of lines) {
            const t = String(line).trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload);
              sseOk = true;
              const ch = obj.choices?.[0];
              // 兼容 thinking 模型的 reasoning_content（delta 阶段 content 为空，实际在 reasoning_content）
              if (ch?.delta?.content) content += ch.delta.content;
              else if (ch?.delta?.reasoning_content) content += ch.delta.reasoning_content;
              else if (ch?.message?.content) content += ch.message.content;
              else if (ch?.message?.reasoning_content) content += ch.message.reasoning_content;
              else if (typeof ch?.text === "string") content += ch.text;
              else if (typeof obj.content === "string") content += obj.content;
              if (obj.model) model = obj.model;
              if (obj.usage) usage = obj.usage;
              // 有些 SSE 直接是完整 chat.completion
              if (obj.choices?.[0]?.message?.content && !content) content = obj.choices[0].message.content;
              if (obj.choices?.[0]?.message?.reasoning_content && !content) content = obj.choices[0].message.reasoning_content;
            } catch {}
          }
          if (sseOk && content) {
            j = { id: `sse-${Date.now()}`, object: "chat.completion", model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage };
          } else if (sseOk) {
            // SSE 但无 content，按失败处理
            return { ok: false, error: `gateway SSE no content: ${txt.slice(0, 800)}`, status: res.status };
          } else {
            return { ok: false, error: `gateway non-json: ${txt.slice(0, 800)}`, status: res.status };
          }
        } catch {
          return { ok: false, error: `gateway non-json: ${txt.slice(0, 800)}`, status: res.status };
        }
      } else {
        return { ok: false, error: `gateway non-json: ${txt.slice(0, 800)}`, status: res.status };
      }
    }
    if (!res.ok) {
      const msg = j?.error?.message || j?.error || j?.data?.error?.message || j?.data?.error || txt.slice(0, 800);
      if (TRACE) {
        const dt = Math.round(performance.now() - t0);
        console.log(`\x1b[90m· [LLM] gateway auto FAIL · ${dt}ms · HTTP ${res.status} ${String(msg).slice(0, 80)}\x1b[0m`);
      }
      return { ok: false, error: msg, status: res.status };
    }
    // 兼容网关返回的两种形状：标准 {"choices":...} 与 workbuddy 聚合后的 {"data":{"choices":...}}
    const choice = j.choices?.[0] || j.data?.choices?.[0];
    const effectiveJ = j.choices ? j : (j.data?.choices ? j.data : j);
    if (!choice) {
      if (TRACE) console.log(`\x1b[90m· [gateway debug] no choice, txt=${txt.slice(0, 800)} · j=${JSON.stringify(j).slice(0, 800)}\x1b[0m`);
      return { ok: false, error: `gateway no choice: ${txt.slice(0, 800)}`, status: res.status };
    }
    if (TRACE) {
      const dt = Math.round(performance.now() - t0);
      const m = effectiveJ.model || j.model || choice.message?.model || "auto";
      console.log(`\x1b[90m· [LLM] gateway auto OK · ${dt}ms · 模型 ${m} · 总 ${Math.round(performance.now() - t0)}ms (gateway-fallback)\x1b[0m`);
    }
    // 透传 usage/raw，并标记 gateway（兼容 data 包装）
    return { ok: true, message: choice.message, usage: effectiveJ.usage || j.usage, raw: j, status: res.status, model: effectiveJ.model || j.model || "auto", viaGateway: true };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 800);
    if (TRACE) {
      const dt = Math.round(performance.now() - t0);
      console.log(`\x1b[90m· [LLM] gateway auto FAIL · ${dt}ms · ${msg.slice(0, 80)}\x1b[0m`);
    }
    return { ok: false, error: `gateway ${msg}`, status: 502 };
  }
}

// 带自动降级：mimo-v2.5-free → big-pickle → 本地 8989 auto（网关 auto，含多供应商择优/hedge/peer）
async function safeChatOnce(opts, model) {
  try {
    const r = await chatOnce({ ...opts, model });
    return r;
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 800);
    const status = err?._t ? 502 : (err?.cause?.code ? 502 : 502);
    return { ok: false, error: msg, status, _thrown: err };
  }
}

async function isCoolingAsync(id) {
  try {
    const state = await import("../state.js");
    const errors = state.loadModelErrors();
    const e = errors[id];
    if (!e || typeof e !== "object") return false;
    const at = Number(e.at || 0);
    if (!at) return false;
    const isSlow = !!e.slow;
    const cd = isSlow ? 5 * 60 * 1000 : 60 * 1000;
    return Date.now() - at < cd && (e.status === "limit" || e.status === "error");
  } catch { return false; }
}

export async function chatWithFallback(opts) {
  const TRACE = process.env.MSLXDFF_CHAT_TRACE !== "0";
  const t0 = TRACE ? performance.now() : 0;
  // 若上次已确认冷却（429/limit），直接跳过，避免 7+7 秒白等，第二次直接走“上次成功”的网关
  const firstCooling = await isCoolingAsync(CHAT_PREFERRED);
  let first;
  if (firstCooling) {
    if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} 跳过（冷却中）· 直接试 ${CHAT_FALLBACK}\x1b[0m`);
    first = { ok: false, error: "skip cooling", status: 429 };
  } else {
    first = await safeChatOnce(opts, CHAT_PREFERRED);
  }
  if (TRACE) {
    const dt = Math.round(performance.now() - t0);
    console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} ${first.ok ? "OK" : "FAIL"} · ${dt}ms${first.ok ? "" : ` · ${String(first.error).slice(0, 80)}`}\x1b[0m`);
  }
  if (first.ok) return { ...first, model: CHAT_PREFERRED };
  const t1 = TRACE ? performance.now() : 0;
  const secondCooling = await isCoolingAsync(CHAT_FALLBACK);
  let second;
  if (secondCooling && firstCooling) {
    if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_FALLBACK} 跳过（冷却中）· 直接走网关 auto\x1b[0m`);
    second = { ok: false, error: "skip cooling", status: 429 };
  } else if (secondCooling) {
    if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_FALLBACK} 跳过（冷却中）· 直接走网关 auto\x1b[0m`);
    second = { ok: false, error: "skip cooling", status: 429 };
  } else {
    second = await safeChatOnce(opts, CHAT_FALLBACK);
  }
  if (TRACE) {
    const dt = Math.round(performance.now() - t1);
    const total = Math.round(performance.now() - t0);
    console.log(`\x1b[90m· [LLM] ${CHAT_FALLBACK} ${second.ok ? "OK" : "FAIL"} · ${dt}ms · 总 ${total}ms (fallback)\x1b[0m`);
  }
  if (second.ok) return { ...second, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
  // 两者皆失败 → 兜底到本地网关 auto（会走 auto 择优、hedge、peer 等完整链路）
  const t2 = TRACE ? performance.now() : 0;
  if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} + ${CHAT_FALLBACK} 均失败，尝试本地网关 auto（:8989）\x1b[0m`);
  const third = await chatViaGateway(opts);
  if (TRACE) {
    const dt = Math.round(performance.now() - t2);
    const total = Math.round(performance.now() - t0);
    console.log(`\x1b[90m· [LLM] gateway auto ${third.ok ? "OK" : "FAIL"} · ${dt}ms · 总 ${total}ms (gateway-fallback)\x1b[0m`);
  }
  if (third.ok) return { ...third, model: third.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: second.error, viaGateway: true };
  return { ok: false, error: `${CHAT_PREFERRED} failed: ${first.error}; ${CHAT_FALLBACK} failed: ${second.error}; gateway auto failed: ${third.error}`, status: third.status || second.status || first.status };
}

// 压缩用：简短摘要请求（不带 tools），128k 上下文下仅 95% 触发，需完整摘要
export async function summarizeHistory(messages) {
  const prompt = [
    { role: "system", content: "你是对话压缩助手，把以下历史对话压缩成 800 字以内的中文摘要，保留关键操作与结果、用户的偏好与待办、模型设置与群组操作及时间线，不要遗漏重要细节。" },
    { role: "user", content: messages.map((m) => `${m.role}: ${m.content || JSON.stringify(m.tool_calls || "")}`).join("\n").slice(0, 90000) },
  ];
  const r = await chatWithFallback({ messages: prompt });
  if (!r.ok) return null;
  const txt = String(r.message?.content || "").trim();
  return txt ? `【历史摘要】${txt}` : null;
}
