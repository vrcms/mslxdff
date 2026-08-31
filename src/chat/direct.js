import { performance } from "node:perf_hooks";

function isInput400(status, msg, hasTools) {
  return status === 400 && /prompt|messages/i.test(String(msg || "")) && hasTools;
}

/**
 * 直连深模块：mimo/pickle 经 createUpstreamClient 的 stream:false 调用
 * 注入化：便于用 fake client 触发 400→去 tools 重试
 */
export function createDirectClient({ createUpstreamClient, chatTimeoutMs = 15000, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const _create = createUpstreamClient || (() => { throw new Error("createUpstreamClient not injected"); });

  async function doChat({ messages, tools, model }, withoutTools) {
    const prevAnon = env.MSLXDFF_FREE_ANON;
    const needDisable = model === "mimo-v2.5-free" || model === "big-pickle";
    if (needDisable) env.MSLXDFF_FREE_ANON = "0";
    const client = _create({ connectTimeoutMs: chatTimeoutMs, keepAlive: false, fetchImpl });
    const body = { model: model || "mimo-v2.5-free", messages, stream: false };
    if (!withoutTools && tools?.length) {
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
        if (!withoutTools && isInput400(res.status, msg, !!tools?.length)) {
          try { await client.close(); } catch {}
          // 重试去 tools
          const retry = await doChat({ messages, model }, true);
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
      if (needDisable) {
        if (prevAnon === undefined) delete env.MSLXDFF_FREE_ANON;
        else env.MSLXDFF_FREE_ANON = prevAnon;
      }
    }
  }

  async function chatOnce(opts) {
    return doChat(opts, false);
  }

  return { chatOnce, _doChat: doChat };
}
