// raccoon 模型转发：OpenAI 形进、OpenAI 形出（上游同形，**不做协议转换**）。
// 失败响应带 `x-mslxdff-raccoon-kind` 标记，供 provider 工厂决定冷却策略。
import { timeoutSignal } from "../../compat.js";
import {
  RACCOON_DEFAULT_EFFORT,
  RACCOON_REQUEST_TIMEOUT_MS,
  canonicalRaccoonModel,
  raccoonChatUrl,
  raccoonEffortFromEnv,
  raccoonThinkingType,
} from "./const.js";
import { RACCOON_CHAT_ACCEPT, raccoonAuthHeaders } from "./headers.js";
import {
  aggregateRaccoonSse,
  classifyRaccoonFailure,
  isRaccoonSseContentType,
  raccoonErrorResponse,
} from "./sse.js";

/** 首帧窥探上限：超过这个字节数还没形成完整 SSE 帧就不再等（避免慢首包把请求卡住）。 */
const PEEK_MAX_BYTES = 8192;

/**
 * 出站请求体：剥 `raccoon/` 前缀 + 注入 `extra_body.thinking`。
 * 思考取值优先级：**请求体自带的 `extra_body.thinking.type`**（客户端显式声明）＞ 构造/调用方 `effort`
 * ＞ env `MSLXDFF_RACCOON_THINKING` ＞ 默认「开」。
 * **绝不发 `reasoning_effort`**：上游不认该参数（实测传与不传无可测差异），发了只会多一处形态差异。
 */
export function buildRaccoonWireBody(body = {}, { effort, env = process.env } = {}) {
  const wire = { ...body };
  wire.model = canonicalRaccoonModel(body?.model);
  delete wire.reasoning_effort;
  const extra = typeof body?.extra_body === "object" && body.extra_body !== null ? { ...body.extra_body } : {};
  const declared = extra?.thinking?.type;
  const type = declared === "enabled" || declared === "disabled"
    ? declared
    : raccoonThinkingType(effort ?? raccoonEffortFromEnv(env) ?? RACCOON_DEFAULT_EFFORT);
  extra.thinking = { type };
  wire.extra_body = extra;
  return wire;
}

/** 上游用 `application/json` 回完整 SSE 帧序列（高负载下的已知行为）时，按**体形状**判定。 */
function looksLikeSse(text) {
  return /^\s*(data:|:)/m.test(String(text || ""));
}

/** 从一段 SSE 文本里取首个 `data:` 载荷（可能还没凑成完整帧）。 */
function firstDataPayload(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .find((l) => l.startsWith("data:"));
  return line ? line.slice(5).trim() : "";
}

/**
 * 预读上游首帧取判决（对齐 qoder 的 `peekEnvelopeVerdict` 思路）。
 * 流式请求若把 `{"code":200003}` 这种**流内错误信封**原样透给客户端，既不返 401 也不冷却该号，
 * 下次还会继续撞同一面墙 —— 所以返回 Response 前先看一眼。
 * 首个完整帧不是错误时立刻停止窥探，并把已读字节原样回灌（`chunks`），不丢一个字节。
 */
async function peekStreamVerdict(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return { chunks: [] };
  const decoder = new TextDecoder();
  const chunks = [];
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      buf += decoder.decode(value, { stream: true });
      const end = buf.indexOf("\n\n");
      if (end >= 0) {
        const payload = firstDataPayload(buf.slice(0, end));
        if (payload && payload !== "[DONE]") {
          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            parsed = null;
          }
          if (parsed && ((parsed.code !== undefined && Number(parsed.code) !== 0) || parsed.error)) {
            await reader.cancel().catch(() => {});
            return { error: classifyRaccoonFailure(200, parsed) };
          }
        }
        break; // 首个完整帧不是错误 → 停止窥探
      }
      if (buf.length >= PEEK_MAX_BYTES) break; // 还没形成完整帧就别再等
    }
  } catch {
    // 窥探本身失败不算错误：把已读字节回灌，后续由正常流路径暴露
  }
  return { chunks, reader };
}

/** 把「已预读的字节 + 剩余 reader」拼回一条流。 */
function rebuildStream(chunks, reader) {
  if (!reader) {
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
  }
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
}

export async function forwardRaccoonChat({
  body,
  credential,
  fetchImpl,
  timeoutMs = RACCOON_REQUEST_TIMEOUT_MS,
  effort,
  env = process.env,
} = {}) {
  const wireBody = buildRaccoonWireBody(body, { effort, env });
  const modelId = wireBody.model;

  let res;
  try {
    res = await fetchImpl(raccoonChatUrl(), {
      method: "POST",
      headers: raccoonAuthHeaders(credential, { accept: RACCOON_CHAT_ACCEPT, env }),
      body: JSON.stringify(wireBody),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    return raccoonErrorResponse({ kind: "server", message: String(e?.message || e).slice(0, 160) });
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    return raccoonErrorResponse({ ...classifyRaccoonFailure(res.status, payload), model: modelId });
  }

  // 业务错误惯例：HTTP 200 + JSON 信封（code 非 0）→ 同样按错误分类，不谎报成功
  if (!isRaccoonSseContentType(res.headers.get("content-type"))) {
    const text = await res.text().catch(() => "");
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    if (!payload && looksLikeSse(text)) {
      // 形状是 SSE 而 header 不是 —— 信形状（参考实现踩过这个坑：按 header 判会把可用模型判成不可用）
      if (body?.stream === false) {
        const agg = await aggregateRaccoonSse(text, { model: modelId });
        if (agg.error) return raccoonErrorResponse({ ...agg.error, model: modelId });
        return new Response(JSON.stringify(agg.openAi), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const peeked = await peekStreamVerdict(new Response(text, { headers: { "Content-Type": "text/event-stream" } }));
      if (peeked.error) return raccoonErrorResponse({ ...peeked.error, model: modelId });
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    if (payload && ((payload.code !== undefined && Number(payload.code) !== 0) || payload.error)) {
      return raccoonErrorResponse({ ...classifyRaccoonFailure(res.status, payload), model: modelId });
    }
    if (payload) {
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return raccoonErrorResponse({ kind: "server", status: 200, message: "上游返回了既非 JSON 也非 SSE 的响应" });
  }

  if (body?.stream !== false) {
    // 上游已是 OpenAI 形 SSE：先窥探首帧取流内判决，再把字节原样回灌（逐字节透传，不整形）
    const peeked = await peekStreamVerdict(res);
    if (peeked.error) return raccoonErrorResponse({ ...peeked.error, model: modelId });
    return new Response(rebuildStream(peeked.chunks, peeked.reader), {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  const text = await res.text();
  const out = await aggregateRaccoonSse(text, { model: modelId });
  if (out.error) return raccoonErrorResponse({ ...out.error, model: modelId });
  return new Response(JSON.stringify(out.openAi), { status: 200, headers: { "Content-Type": "application/json" } });
}
