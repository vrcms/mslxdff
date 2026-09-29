// zcode 模型转发：OpenAI 请求 → Anthropic messages（网关出站恒流式；非流式本地聚合回 OpenAI JSON）。
// 失败响应带 x-mslxdff-zcode-kind 标记，供 provider 工厂决定冷却策略。
import { timeoutSignal } from "../../compat.js";
import { ZCODE_MESSAGES_URL, canonicalZcodeModel, zcodeErrorKind } from "./const.js";
import { buildZcodeHeaders } from "./headers.js";
import { aggregateAnthropicToOpenAi, anthropicToOpenAiStream } from "./sse.js";

const DEFAULT_MAX_TOKENS = 4096;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === "text").map((p) => p.text || "").join("");
  return "";
}

function mapToolChoice(tc) {
  if (!tc) return undefined;
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (tc === "none") return { type: "none" };
  const name = tc?.function?.name;
  return name ? { type: "tool", name: String(name) } : undefined;
}

export function toAnthropicRequest(body = {}) {
  const messages = [];
  let system = "";
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const role = String(m?.role || "");
    if (role === "system") {
      const part = textOf(m.content);
      if (part) system += (system ? "\n\n" : "") + part;
      continue;
    }
    if (role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: String(m.tool_call_id || ""), content: typeof m.content === "string" ? m.content : textOf(m.content) }],
      });
      continue;
    }
    if (role === "assistant") {
      const blocks = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        let input = {};
        try {
          input = JSON.parse(tc?.function?.arguments || "{}");
        } catch {}
        blocks.push({ type: "tool_use", id: String(tc?.id || ""), name: String(tc?.function?.name || ""), input });
      }
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
      continue;
    }
    messages.push({ role: "user", content: textOf(m.content) });
  }

  const req = {
    model: canonicalZcodeModel(body.model),
    max_tokens: Number(body.max_tokens ?? body.max_completion_tokens) || DEFAULT_MAX_TOKENS,
    messages,
    stream: true, // 上游恒流式；非流式在本地聚合
  };
  if (system) req.system = system;
  if (Number.isFinite(Number(body.temperature))) req.temperature = Number(body.temperature);
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools
      .map((t) => ({
        name: String(t?.function?.name || t?.name || ""),
        description: String(t?.function?.description || t?.description || ""),
        input_schema: t?.function?.parameters || t?.parameters || { type: "object", properties: {} },
      }))
      .filter((t) => t.name);
  }
  // tool_choice 独立映射（不依赖 tools 是否在场，客户端显式给定即按 Anthropic 形状透出）
  const choice = mapToolChoice(body.tool_choice);
  if (choice) req.tool_choice = choice;
  if (body.stop !== undefined && body.stop !== null) {
    req.stop_sequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];
  }
  return req;
}

export function classifyZcodeFailure(status, payload) {
  const code = Number(payload?.code) || 0;
  let kind = zcodeErrorKind(code);
  if (kind === "unknown") {
    if (status === 401) kind = "auth";
    else if (status === 429) kind = "rate_limit";
    else if (status >= 500) kind = "server";
  }
  return { kind, code, status, message: String(payload?.msg || payload?.message || "").trim() };
}

const ERROR_MAP = {
  auth: { status: 401, type: "auth_error", text: (f) => `zcode: 登录已失效（code ${f.code || 1006}）。请运行 mslxdff -provider zcode login 重新登录` },
  quota: { status: 429, type: "quota_exhausted", text: () => "zcode: 免费额度已用完（按日重置），请明日再试或添加账号" },
  rate_limit: { status: 429, type: "all_cooling", text: () => "zcode: 上游限流（账号冷却中），请稍后重试" },
  security: { status: 403, type: "security_reject", text: (f) => `zcode: 安全校验拒绝（code ${f.code || 3007}）${f.message ? `：${f.message}` : ""} · 该额度走 Start Plan 验证码通道（每条请求需一次性 x-aliyun-captcha-verify-param；未启用验证码农场时必现），见 docs/adr/0038` },
  param: { status: 400, type: "invalid_request", text: (f) => `zcode: 请求参数被上游拒绝（code ${f.code}）${f.message ? `：${f.message}` : ""}` },
  server: { status: 502, type: "upstream_error", text: (f) => `zcode: 上游服务异常${f.code ? `（code ${f.code}）` : ""}${f.message ? `：${f.message}` : ""}` },
  network: { status: 502, type: "upstream_error", text: (f) => `zcode: 网络错误 ${f.message || ""}`.trim() },
  unknown: { status: 502, type: "upstream_error", text: (f) => `zcode: 上游错误（HTTP ${f.status || "?"}${f.code ? ` code ${f.code}` : ""}）${f.message ? `：${f.message}` : ""}` },
};

export function zcodeErrorResponse(fail = {}) {
  const kind = ERROR_MAP[fail.kind] ? fail.kind : "unknown";
  const entry = ERROR_MAP[kind];
  const headers = { "Content-Type": "application/json" };
  if (fail.kind) headers["x-mslxdff-zcode-kind"] = fail.kind;
  return new Response(JSON.stringify({ error: { message: entry.text(fail), type: entry.type, code: fail.code || 0 } }), {
    status: entry.status,
    headers,
  });
}

export async function forwardZcodeChat({ body, token, deviceMid, fetchImpl, version, timeoutMs = 120_000 } = {}) {
  const anthropicBody = toAnthropicRequest(body);
  const modelId = anthropicBody.model;
  const headers = {
    ...buildZcodeHeaders({ token, deviceMid, version }),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  let res;
  try {
    res = await fetchImpl(ZCODE_MESSAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    return zcodeErrorResponse({ kind: "network", message: String(e?.message || e).slice(0, 160) });
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    return zcodeErrorResponse({ ...classifyZcodeFailure(res.status, payload), model: modelId });
  }

  // 上游业务错误惯例：HTTP 200 + JSON body（code 非 0/200）→ 同样按错误分类
  if (!String(res.headers.get("content-type") || "").includes("text/event-stream")) {
    const payload = await res.json().catch(() => null);
    const code = Number(payload?.code);
    const bizOk = payload?.success !== false && (!Number.isFinite(code) || code === 0 || code === 200);
    if (payload && !bizOk) {
      return zcodeErrorResponse({ ...classifyZcodeFailure(res.status, payload), model: modelId });
    }
    if (payload && body?.stream === false) {
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }

  if (body?.stream !== false) {
    const stream = anthropicToOpenAiStream(res.body, { model: modelId });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  const text = await res.text();
  const out = await aggregateAnthropicToOpenAi(text, { model: modelId });
  if (out.error) {
    return zcodeErrorResponse({ kind: out.error.kind || "server", code: out.error.code || 0, status: 200, message: out.error.message });
  }
  return new Response(JSON.stringify(out.openAi), { status: 200, headers: { "Content-Type": "application/json" } });
}
