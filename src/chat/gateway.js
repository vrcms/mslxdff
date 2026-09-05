import { performance } from "node:perf_hooks";
import { parseSse } from "./sse.js";
import { DEFAULT_PORT } from "../state.js";
import { compatFetch } from "../compat.js";

/**
 * 网关深模块：POST 127.0.0.1:port/v1/chat/completions model:auto
 * 注入化：fetch/loadToken/getPort/readModelsJson 均可伪，便于单测
 */
export function createGatewayClient({
  fetchImpl = compatFetch,
  loadToken,
  getPort,
  defaultPort = DEFAULT_PORT,
  readModelsJson,
  gatewayTimeoutMs = 25000,
  env = process.env,
} = {}) {
  const _fetch = fetchImpl;
  const _loadToken = loadToken || (async () => {
    try {
      const state = await import("../state.js");
      const loaded = await state.loadToken();
      return String(loaded?.token || "").trim();
    } catch { return ""; }
  });
  const _getPort = getPort || (() => {
    try { const s = require("../state.js"); const p = s.getPort(); if (Number.isInteger(p) && p > 0) return p; } catch {}
    const v = Number(env.MSLXDFF_PORT);
    if (Number.isInteger(v) && v > 0) return v;
    return defaultPort;
  });
  const _readModels = readModelsJson || (async () => {
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const cache = join(homedir(), ".config", "mslxdff", "models.json");
      if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
    } catch {}
    return { data: [] };
  });

  async function chatViaGateway({ messages, tools }) {
    const TRACE = env.MSLXDFF_CHAT_TRACE !== "0";
    const t0 = TRACE ? performance.now() : 0;
    let port = defaultPort;
    let token = "";
    try {
      token = String((await _loadToken()) || "").trim();
      const p = _getPort();
      if (Number.isInteger(p) && p > 0) port = p;
    } catch {}
    if (!token) {
      try {
        const { readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const sf = env.MSLXDFF_STATE_FILE || join(homedir(), ".config", "mslxdff", "state.json");
        if (existsSync(sf)) {
          const j = JSON.parse(readFileSync(sf, "utf8"));
          if (typeof j.token === "string" && j.token.trim()) token = j.token.trim();
        }
      } catch {}
    }
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const body = { model: "auto", messages, stream: false };
    if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), gatewayTimeoutMs);
      const res = await _fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const txt = await res.text();
      let j;
      try { j = JSON.parse(txt); } catch {
        if (txt.includes("data:")) {
          try {
            const parsed = parseSse(txt);
            if (parsed.sseOk && (parsed.content || parsed.toolCalls.length)) {
              const hasToolCalls = parsed.toolCalls.length > 0;
              const hasContent = !!parsed.content;
              let finishReason = parsed.finishReason;
              if (hasToolCalls && !hasContent) finishReason = "tool_calls";
              const tool_calls = hasToolCalls ? parsed.toolCalls : undefined;
              const msg = { role: "assistant", content: parsed.content || "" };
              if (tool_calls) msg.tool_calls = tool_calls;
              j = { id: `sse-${Date.now()}`, object: "chat.completion", model: parsed.model, choices: [{ index: 0, finish_reason: finishReason, message: msg }], usage: parsed.usage };
            } else if (parsed.sseOk) {
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
        if (TRACE) console.log(`\x1b[90m· [LLM] gateway auto FAIL · ${Math.round(performance.now() - t0)}ms · HTTP ${res.status} ${String(msg).slice(0, 80)}\x1b[0m`);
        return { ok: false, error: msg, status: res.status };
      }
      const choice = j.choices?.[0] || j.data?.choices?.[0];
      const effectiveJ = j.choices ? j : (j.data?.choices ? j.data : j);
      if (!choice) {
        if (TRACE) console.log(`\x1b[90m· [gateway debug] no choice, txt=${txt.slice(0, 800)} · j=${JSON.stringify(j).slice(0, 800)}\x1b[0m`);
        return { ok: false, error: `gateway no choice: ${txt.slice(0, 800)}`, status: res.status };
      }
      let provider = "opencode";
      const rawModel = effectiveJ.model || j.model || choice.message?.model || "auto";
      try {
        const c = await _readModels();
        const ids = (c.data || []).map((x) => x.id).filter(Boolean);
        for (const pid of ids) {
          const slash = pid.indexOf("/");
          const prov = slash > 0 ? pid.slice(0, slash) : "opencode";
          const raw = slash > 0 ? pid.slice(slash + 1) : pid;
          if (pid === rawModel || raw === rawModel || pid.endsWith("/" + rawModel)) { provider = prov; break; }
        }
        if (provider === "opencode" && rawModel.includes("/")) {
          const maybe = rawModel.split("/")[0];
          if (["workbuddy", "clinebot", "sensenova", "openrouter", "generic"].includes(maybe)) provider = maybe;
        }
      } catch {}
      if (TRACE) {
        const dt = Math.round(performance.now() - t0);
        console.log(`\x1b[90m· [LLM] gateway auto OK · ${dt}ms · 模型 ${provider !== "opencode" ? provider + "/" : ""}${rawModel} · 总 ${dt}ms (gateway-fallback)\x1b[0m`);
      }
      return { ok: true, message: choice.message, usage: effectiveJ.usage || j.usage, raw: j, status: res.status, model: rawModel, provider, viaGateway: true };
    } catch (err) {
      const raw = String(err?.message || err);
      const msg = raw.slice(0, 800);
      const isConnRefused = /ECONNREFUSED|Failed to fetch|fetch failed|connect ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL/i.test(raw);
      if (isConnRefused) {
        const friendly = `本地服务没有启动无法使用auto模式，请mslxdff -d 启动（本地网关 http://127.0.0.1:${port} 拒绝连接）— 3ms 内失败说明未触达任何模型（非模型额度问题）；若已改端口请用 mslxdff -port N 或 MSLXDFF_PORT=${port} 保持一致`;
        if (TRACE) console.log(`\x1b[90m· [LLM] gateway auto FAIL · ${Math.round(performance.now() - t0)}ms · ${friendly} · ${msg.slice(0, 80)}\x1b[0m`);
        return { ok: false, error: friendly, status: 502, code: "GATEWAY_NOT_RUNNING", port, raw: msg };
      }
      return { ok: false, error: `gateway ${msg}`, status: 502 };
    }
  }

  return { chatViaGateway };
}
