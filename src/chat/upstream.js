import { performance } from "node:perf_hooks";
import { CHAT_PREFERRED, CHAT_FALLBACK, CHAT_TIMEOUT_MS, CHAT_GATEWAY_TIMEOUT_MS } from "./config.js";
import { createUpstreamClient } from "../upstream.js";
import { DEFAULT_PORT } from "../state.js";

function modelForAttempt(attempt) {
  return attempt === 0 ? CHAT_PREFERRED : CHAT_FALLBACK;
}

export async function chatOnce({ messages, tools, model }) {
  // 直连 mimo/pickle 不走 anon 3s 额外探测，避免 800ms 对冲被拖慢
  const prevAnon = process.env.MSLXDFF_FREE_ANON;
  const needDisableAnon = model === CHAT_PREFERRED || model === CHAT_FALLBACK;
  if (needDisableAnon) process.env.MSLXDFF_FREE_ANON = "0";
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
    if (needDisableAnon) {
      if (prevAnon === undefined) delete process.env.MSLXDFF_FREE_ANON;
      else process.env.MSLXDFF_FREE_ANON = prevAnon;
    }
  }
}

async function chatOnceNoTools({ messages, model }) {
  const prevAnon2 = process.env.MSLXDFF_FREE_ANON;
  const needDisable2 = model === CHAT_PREFERRED || model === CHAT_FALLBACK;
  if (needDisable2) process.env.MSLXDFF_FREE_ANON = "0";
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
  } finally {
    try { await client.close(); } catch {}
    if (needDisable2) {
      if (prevAnon2 === undefined) delete process.env.MSLXDFF_FREE_ANON;
      else process.env.MSLXDFF_FREE_ANON = prevAnon2;
    }
  }
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
          let toolCallsMap = new Map();
          let model = "auto";
          let usage = null;
          let finishReason = "stop";
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
              if (ch?.finish_reason) finishReason = ch.finish_reason;
              // content / reasoning_content
              if (ch?.delta?.content) content += ch.delta.content;
              else if (ch?.delta?.reasoning_content) content += ch.delta.reasoning_content;
              else if (ch?.message?.content) content += ch.message.content;
              else if (ch?.message?.reasoning_content) content += ch.message.reasoning_content;
              else if (typeof ch?.text === "string") content += ch.text;
              else if (typeof obj.content === "string") content += obj.content;
              if (ch?.delta?.tool_calls) {
                for (const tc of ch.delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const cur = toolCallsMap.get(idx) || { id: tc.id || `chatcmpl-tool-${idx}`, type: tc.type || "function", function: { name: "", arguments: "" } };
                  if (tc.id) cur.id = tc.id;
                  if (tc.type) cur.type = tc.type;
                  if (tc.function?.name) cur.function.name = tc.function.name;
                  if (typeof tc.function?.arguments === "string") cur.function.arguments += tc.function.arguments;
                  toolCallsMap.set(idx, cur);
                }
              }
              if (ch?.message?.tool_calls) {
                for (const tc of ch.message.tool_calls) {
                  const idx = tc.index ?? toolCallsMap.size;
                  toolCallsMap.set(idx, tc);
                }
              }
              if (obj.model) model = obj.model;
              if (obj.usage) usage = obj.usage;
              if (obj.choices?.[0]?.message?.content && !content) content = obj.choices[0].message.content;
              if (obj.choices?.[0]?.message?.reasoning_content && !content) content = obj.choices[0].message.reasoning_content;
              if (obj.choices?.[0]?.message?.tool_calls && toolCallsMap.size === 0) {
                for (const tc of obj.choices[0].message.tool_calls) toolCallsMap.set(tc.index ?? 0, tc);
              }
            } catch {}
          }
          const hasToolCalls = toolCallsMap.size > 0;
          const hasContent = !!content;
          if (sseOk && (hasContent || hasToolCalls)) {
            const tool_calls = hasToolCalls ? [...toolCallsMap.values()].sort((a,b)=>(a.index??0)-(b.index??0)) : undefined;
            const msg = { role: "assistant", content: content || "" };
            if (tool_calls) msg.tool_calls = tool_calls;
            // 若 finish_reason 为 tool_calls 但 content 为空，仍视为有效 tool_calls
            if (hasToolCalls && !hasContent) finishReason = "tool_calls";
            j = { id: `sse-${Date.now()}`, object: "chat.completion", model, choices: [{ index: 0, finish_reason: finishReason, message: msg }], usage };
          } else if (sseOk) {
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
    // 推断供应商：读 models.json 前缀表，匹配 raw → provider
    let provider = "opencode";
    const rawModel = effectiveJ.model || j.model || choice.message?.model || "auto";
    try {
      const { readFileSync: rfs, existsSync: es } = await import("node:fs");
      const { join: jn } = await import("node:path");
      const { homedir: hd } = await import("node:os");
      const cache = jn(hd(), ".config", "mslxdff", "models.json");
      if (es(cache)) {
        const c = JSON.parse(rfs(cache, "utf8"));
        const ids = (c.data || []).map((x) => x.id).filter(Boolean);
        for (const pid of ids) {
          const slash = pid.indexOf("/");
          const prov = slash > 0 ? pid.slice(0, slash) : "opencode";
          const raw = slash > 0 ? pid.slice(slash + 1) : pid;
          if (pid === rawModel || raw === rawModel || pid.endsWith("/" + rawModel)) {
            provider = prov;
            break;
          }
        }
        if (provider === "opencode" && rawModel.includes("/")) {
          const maybe = rawModel.split("/")[0];
          if (["workbuddy", "clinebot", "sensenova", "openrouter", "generic"].includes(maybe)) provider = maybe;
        }
      }
    } catch {}
    if (TRACE) {
      const dt = Math.round(performance.now() - t0);
      const m = rawModel;
      console.log(`\x1b[90m· [LLM] gateway auto OK · ${dt}ms · 模型 ${provider !== "opencode" ? provider + "/" : ""}${m} · 总 ${Math.round(performance.now() - t0)}ms (gateway-fallback)\x1b[0m`);
    }
    // 透传 usage/raw，并标记 gateway（兼容 data 包装）
    return { ok: true, message: choice.message, usage: effectiveJ.usage || j.usage, raw: j, status: res.status, model: rawModel, provider, viaGateway: true };
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

const CHAT_COOLDOWN_MS = 10 * 60 * 1000; // mimo 429 后至少 10min 不再试直连
const CHAT_SLOW_COOLDOWN_MS = 10 * 60 * 1000;

async function isCoolingAsync(id) {
  try {
    const state = await import("../state.js");
    const errors = state.loadModelErrors();
    const e = errors[id];
    if (!e || typeof e !== "object") return false;
    const at = Number(e.at || 0);
    if (!at) return false;
    const isSlow = !!e.slow;
    const cd = isSlow ? CHAT_SLOW_COOLDOWN_MS : CHAT_COOLDOWN_MS;
    return Date.now() - at < cd && (e.status === "limit" || e.status === "error");
  } catch { return false; }
}

async function recordChatError(id, status, { slow = false, latencyMs = 0 } = {}) {
  try {
    const state = await import("../state.js");
    const errors = state.loadModelErrors();
    const isLimit = Number(status) === 429 || String(status).includes("429");
    // 复用 auto 的分类：429/limit → limit，否则 error
    const entryStatus = isLimit ? "limit" : "error";
    errors[id] = { status: entryStatus, at: Date.now(), code: Number.isInteger(Number(status)) ? Number(status) : null, slow: !!slow };
    state.saveModelErrors(errors);
    try { state.flushStateSync(); } catch {}
    if (slow && Number.isFinite(latencyMs) && latencyMs > 0) {
      try {
        const lat = state.loadModelLatencies();
        const prev = lat[id]?.emaMs;
        const ema = prev ? Math.round(prev * 0.7 + latencyMs * 0.3) : Math.round(latencyMs);
        lat[id] = { emaMs: ema, lastMs: Math.round(latencyMs), at: Date.now(), count: (lat[id]?.count ?? 0) + 1 };
        state.saveModelLatencies(lat);
        try { state.flushStateSync(); } catch {}
      } catch {}
    }
  } catch {}
}

async function recordChatOk(id, latencyMs) {
  try {
    const state = await import("../state.js");
    const errors = state.loadModelErrors();
    errors[id] = { status: "normal", at: Date.now(), code: 200, slow: false };
    state.saveModelErrors(errors);
    try { state.flushStateSync(); } catch {}
    if (Number.isFinite(latencyMs) && latencyMs > 0) {
      const lat = state.loadModelLatencies();
      const prev = lat[id]?.emaMs;
      const ema = prev ? Math.round(prev * 0.7 + latencyMs * 0.3) : Math.round(latencyMs);
      lat[id] = { emaMs: ema, lastMs: Math.round(latencyMs), at: Date.now(), count: (lat[id]?.count ?? 0) + 1 };
      state.saveModelLatencies(lat);
      try { state.flushStateSync(); } catch {}
    }
  } catch {}
}

export async function chatWithFallback(opts) {
  const TRACE = process.env.MSLXDFF_CHAT_TRACE !== "0";
  const HEDGE_MS = (() => {
    const v = Number(process.env.MSLXDFF_HEDGE_DELAY_MS);
    return Number.isInteger(v) && v >= 0 ? v : 800;
  })();
  const t0 = TRACE ? performance.now() : 0;
  // 若上次已确认冷却（429/limit），直接跳过，避免 7+7 秒白等，第二次直接走“上次成功”的网关
  const firstCooling = await isCoolingAsync(CHAT_PREFERRED);
  let first;
  let firstMs = 0;
  if (firstCooling) {
    if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} 跳过（冷却中）· 直接试 ${CHAT_FALLBACK}\x1b[0m`);
    first = { ok: false, error: "skip cooling", status: 429 };
  } else {
    const t = performance.now();
    first = await safeChatOnce(opts, CHAT_PREFERRED);
    firstMs = Math.round(performance.now() - t);
    if (TRACE) {
      const dt = Math.round(performance.now() - t0);
      console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} ${first.ok ? "OK" : "FAIL"} · ${dt}ms${first.ok ? "" : ` · ${String(first.error).slice(0, 80)}`}\x1b[0m`);
    }
    if (first.ok) {
      await recordChatOk(CHAT_PREFERRED, firstMs);
      return { ...first, model: CHAT_PREFERRED };
    } else {
      const slow = firstMs > 20000;
      await recordChatError(CHAT_PREFERRED, first.status, { slow, latencyMs: firstMs });
    }
  }
  if (firstCooling) {
    // 已跳过，无需重复日志
  } else if (TRACE) {
    // fail 日志已在上面
  }
  const t1 = TRACE ? performance.now() : 0;
  // 按用户要求：mimo 一旦 429，10min 内第二次直接走 gateway，跳过 big-pickle
  if (firstCooling) {
    if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} 冷却中（${CHAT_COOLDOWN_MS/60000}min）· 直接走网关 auto，跳过 ${CHAT_FALLBACK}\x1b[0m`);
    const t2 = TRACE ? performance.now() : 0;
    if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} 冷却，直接走网关 auto（:8989）\x1b[0m`);
    const third = await chatViaGateway(opts);
    if (TRACE) {
      const dt = Math.round(performance.now() - t2);
      const total = Math.round(performance.now() - t0);
      console.log(`\x1b[90m· [LLM] gateway auto ${third.ok ? "OK" : "FAIL"} · ${dt}ms · 总 ${total}ms (gateway-fallback)\x1b[0m`);
    }
    if (third.ok) return { ...third, model: third.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: "skip big-pickle (mimo cooling)", viaGateway: true };
    return { ok: false, error: `${CHAT_PREFERRED} cooling: ${first.error}; gateway auto failed: ${third.error}`, status: third.status || 429 };
  }
  const secondCooling = await isCoolingAsync(CHAT_FALLBACK);
  // 800ms 对冲：big-pickle 与 gateway 并发，谁快谁赢
  // 若 big-pickle 冷却则只走 gateway；否则两者并行 800ms staggered
  const doGateway = () => chatViaGateway(opts);
  const doSecond = async () => {
    const t = performance.now();
    const r = await safeChatOnce(opts, CHAT_FALLBACK);
    const ms = Math.round(performance.now() - t);
    if (r.ok) await recordChatOk(CHAT_FALLBACK, ms);
    else await recordChatError(CHAT_FALLBACK, r.status, { slow: ms > 20000, latencyMs: ms });
    return { res: r, ms };
  };

  if (secondCooling) {
    if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_FALLBACK} 跳过（冷却中）· 直接走网关 auto\x1b[0m`);
    const t2 = performance.now();
    const third = await doGateway();
    if (TRACE) {
      const dt = Math.round(performance.now() - t2);
      const total = Math.round(performance.now() - t0);
      console.log(`\x1b[90m· [LLM] gateway auto ${third.ok ? "OK" : "FAIL"} · ${dt}ms · 总 ${total}ms (gateway-fallback)\x1b[0m`);
    }
    if (third.ok) return { ...third, model: third.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: "skip cooling", viaGateway: true };
    return { ok: false, error: `${CHAT_PREFERRED} failed: ${first.error}; ${CHAT_FALLBACK} failed: skip cooling; gateway auto failed: ${third.error}`, status: third.status || first.status };
  }

  // 两者皆需尝试：并行对冲（800ms staggered），首个 OK 即胜
  if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} 失败，${CHAT_FALLBACK} + gateway 对冲中（${HEDGE_MS}ms）\x1b[0m`);
  const hedgeStart = performance.now();
  let secondRes = null;
  let secondMs = 0;
  let gatewayRes = null;

  const secondPromise = doSecond().then(({ res, ms }) => {
    secondRes = res; secondMs = ms;
    if (TRACE) {
      const dt = Math.round(performance.now() - t1);
      console.log(`\x1b[90m· [LLM] ${CHAT_FALLBACK} ${res.ok ? "OK" : "FAIL"} · ${dt}ms · 总 ${Math.round(performance.now() - t0)}ms (hedge)\x1b[0m`);
    }
    return res;
  });

  // gateway 800ms 后启动，对冲慢链路
  let gatewayPromise = null;
  const gatewayDelay = HEDGE_MS > 0 ? HEDGE_MS : 0;
  if (gatewayDelay > 0) {
    gatewayPromise = new Promise((resolve) => {
      setTimeout(async () => {
        const r = await doGateway();
        gatewayRes = r;
        resolve(r);
      }, gatewayDelay);
    });
    // 同时也准备一个立即启动的 fallback 若 second 极快失败，则不等待 delay（用 raceFirstOk 覆盖）
    // 为保证“谁快用谁”，实际让 gateway 立即也准备好，若 second 800ms 内未回，gateway 已在路上
  } else {
    gatewayPromise = doGateway().then((r) => { gatewayRes = r; return r; });
  }
  // 为了不让 gatewayDelay 成为必经等待，采用并发 race 策略：
  // 若 secondPromise 在 hedgeDelay 内成功，则直接返回；否则等待 gateway
  const raceFirstOk = async () => {
    // 等 second 或 timeout
    const secondOrTimeout = await Promise.race([
      secondPromise.then((r) => ({ kind: "second", r })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), gatewayDelay)),
    ]);
    if (secondOrTimeout.kind === "second" && secondOrTimeout.r?.ok) {
      // second 成功，直接赢
      // 取消后续 gateway（无需等待）
      return { ok: true, res: secondOrTimeout.r, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
    }
    // second 失败或超时 → 等 gateway
    // 确保 gateway 已启动：若之前延迟启动，立即再启动一个即时 gateway 并 race
    if (!gatewayPromise || secondOrTimeout.kind === "timeout") {
      // 若 gateway 仍在延迟窗口，提前触发
      const immediate = doGateway().then((r) => { gatewayRes = r; return r; });
      if (gatewayPromise) {
        // 有延迟版本，race 即时 vs 延迟
        gatewayRes = await Promise.race([gatewayPromise, immediate]);
      } else {
        gatewayRes = await immediate;
      }
    } else {
      // second 已失败但 gatewayDelay 已过，等待 gateway
      gatewayRes = await gatewayPromise;
    }
    if (gatewayRes?.ok) return { ok: true, res: gatewayRes, model: gatewayRes.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: secondRes?.error, viaGateway: true };
    // 两者皆败
    if (secondRes?.ok) return { ok: true, res: secondRes, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
    return { ok: false, gatewayRes, secondRes };
  };

  // 若 gatewayDelay 0，则直接双并发
  if (gatewayDelay === 0) {
    const [sRes, gRes] = await Promise.all([secondPromise.catch((e) => ({ ok: false, error: String(e), status: 502 })), doGateway().catch((e) => ({ ok: false, error: String(e), status: 502 }))]);
    secondRes = sRes; gatewayRes = gRes;
    if (sRes?.ok) return { ...sRes, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
    if (gRes?.ok) return { ...gRes, model: gRes.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: sRes?.error, viaGateway: true };
    return { ok: false, error: `${CHAT_PREFERRED} failed: ${first.error}; ${CHAT_FALLBACK} failed: ${sRes?.error}; gateway auto failed: ${gRes?.error}`, status: gRes?.status || sRes?.status || first.status };
  }

  const raced = await raceFirstOk();
  if (raced.ok) {
    const r = raced.res;
    return { ...r, model: raced.model, fallback: raced.fallback, fallbackGateway: raced.fallbackGateway, firstError: raced.firstError, secondError: raced.secondError, viaGateway: raced.viaGateway };
  }
  // 双失败兜底：若 race 未决出 OK，取最终结果
  if (!secondRes) {
    try { secondRes = await secondPromise; } catch (e) { secondRes = { ok: false, error: String(e), status: 502 }; }
  }
  if (secondRes?.ok) return { ...secondRes, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
  if (!gatewayRes) {
    try { gatewayRes = await (gatewayPromise || doGateway()); } catch (e) { gatewayRes = { ok: false, error: String(e), status: 502 }; }
  }
  if (gatewayRes?.ok) return { ...gatewayRes, model: gatewayRes.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: secondRes?.error, viaGateway: true };
  return { ok: false, error: `${CHAT_PREFERRED} failed: ${first.error}; ${CHAT_FALLBACK} failed: ${secondRes?.error}; gateway auto failed: ${gatewayRes?.error}`, status: gatewayRes?.status || secondRes?.status || first.status };
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
