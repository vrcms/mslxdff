import { CHAT_PREFERRED, CHAT_FALLBACK, CHAT_TIMEOUT_MS } from "./config.js";
import { createUpstreamClient } from "../upstream.js";

function modelForAttempt(attempt) {
  return attempt === 0 ? CHAT_PREFERRED : CHAT_FALLBACK;
}

export async function chatOnce({ messages, tools, model }) {
  const client = createUpstreamClient({ connectTimeoutMs: CHAT_TIMEOUT_MS });
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
  const client = createUpstreamClient({ connectTimeoutMs: CHAT_TIMEOUT_MS });
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

// 带自动降级：仅 mimo-v2.5-free → big-pickle，不引入其他模型
export async function chatWithFallback(opts) {
  const first = await chatOnce({ ...opts, model: CHAT_PREFERRED });
  if (first.ok) return { ...first, model: CHAT_PREFERRED };
  const second = await chatOnce({ ...opts, model: CHAT_FALLBACK });
  if (second.ok) return { ...second, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
  return { ok: false, error: `${CHAT_PREFERRED} failed: ${first.error}; ${CHAT_FALLBACK} failed: ${second.error}`, status: second.status || first.status };
}

// 压缩用：简短摘要请求（不带 tools）
export async function summarizeHistory(messages) {
  const prompt = [
    { role: "system", content: "你是对话压缩助手，把以下历史对话压缩成 300 字以内的中文摘要，保留关键操作与结果、用户的偏好与待办，不要遗漏模型设置与群组操作。" },
    { role: "user", content: messages.map((m) => `${m.role}: ${m.content || JSON.stringify(m.tool_calls || "")}`).join("\n").slice(0, 12000) },
  ];
  const r = await chatWithFallback({ messages: prompt });
  if (!r.ok) return null;
  const txt = String(r.message?.content || "").trim();
  return txt ? `【历史摘要】${txt}` : null;
}
