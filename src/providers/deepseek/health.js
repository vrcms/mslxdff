// DeepSeek health 探活（防禁言体系）：对池内每个账号发最小真实请求，检测 muted/限频/凭据坏
// 语义对齐 NIyueeE/ds-free-api health_check（biz_code 非 0 = 异常；FINISHED/INCOMPLETE = 正常）
import { androidHeaders, solveChallenge, DEEPSEEK_DEFAULT_BASE, DEEPSEEK_API_PREFIX } from "./pow.js";
import { buildUpstreamBody } from "./bridge.js";
import { createChatSession } from "./session.js";
import { compatFetch } from "../../compat.js";
import { dsDebug } from "./debug.js";

const MUTED_RE = /user is muted|account is muted|\bmuted\b|禁言/i;
const FREQ_RE = /消息发送过于频繁[\s，,、:：]*请稍后重试/;
const HEALTH_PROMPT = "只回复Hello, world!";

function tail(token) {
  return String(token).slice(-6);
}

function extractBizMsg(text) {
  try {
    const j = JSON.parse(text);
    return j?.data?.biz_msg || j?.msg || "";
  } catch {
    return "";
  }
}

// 单账号探活：challenge → session → completion（SSE 判定）
async function probeToken({ token, fetchImpl, dispatcher, baseUrl, connectTimeoutMs, onError }) {
  try {
    const pow = await solveChallenge({ token, fetchImpl, dispatcher, baseUrl, connectTimeoutMs });
    let sessionId = "";
    try {
      sessionId = await createChatSession({ token, fetchImpl, dispatcher, baseUrl, connectTimeoutMs });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/401|403|未登录/i.test(msg)) {
        onError(token, {});
        return { ok: false, detail: `凭据被拒（创建会话失败: ${msg.slice(0, 80)}）` };
      }
      onError(token, {});
      return { ok: false, detail: `创建会话失败: ${msg.slice(0, 120)}` };
    }
    const body = buildUpstreamBody({ sessionId, prompt: HEALTH_PROMPT, thinking: false, search: false, expert: false });
    const url = `${baseUrl}${DEEPSEEK_API_PREFIX}/chat/completion`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: androidHeaders(token, { "x-ds-pow-response": pow.header }),
      body: JSON.stringify(body),
      ...(dispatcher ? { dispatcher } : {}),
    });
    const text = await res.text();
    dsDebug("health", { event: "probe", tokenTail: tail(token), status: res.status, len: text.length });

    if (!res.ok) {
      const bizMsg = extractBizMsg(text);
      onError(token, {});
      if (MUTED_RE.test(text)) return { ok: false, detail: "禁言（muted）：已冷却 5 分钟，解封后再次探活自动恢复" };
      if (res.status === 429 || FREQ_RE.test(text)) return { ok: false, detail: `触发频率风控（${bizMsg || `http ${res.status}`}）` };
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `凭据被拒 (http ${res.status})` };
      return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 100)}` };
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const bizMsg = extractBizMsg(text);
      try {
        const bizCode = JSON.parse(text)?.data?.biz_code;
        if (bizCode != null && bizCode !== 0) {
          onError(token, {});
          if (MUTED_RE.test(text)) return { ok: false, detail: "禁言（muted）：已冷却 5 分钟，解封后再次探活自动恢复" };
          return { ok: false, detail: `异常（biz_code=${bizCode} ${bizMsg}）` };
        }
      } catch {}
      return { ok: false, detail: `非 SSE 响应: ${text.slice(0, 100)}` };
    }

    if (/"biz_code"\s*:\s*[^0]/.test(text)) {
      const m = text.match(/"biz_msg"\s*:\s*"([^"]+)"/);
      onError(token, {});
      const msg = m?.[1] || "";
      if (MUTED_RE.test(msg)) return { ok: false, detail: "禁言（muted）：已冷却 5 分钟，解封后再次探活自动恢复" };
      return { ok: false, detail: `异常（biz_msg=${msg}）` };
    }
    if (!/"FINISHED"|"INCOMPLETE"|APPEND/.test(text)) {
      return { ok: false, detail: "SSE 未正常结束（无 ready/response 事件）" };
    }
    return { ok: true, detail: "健康" };
  } catch (err) {
    dsDebug("health", { event: "error", tokenTail: tail(token), err: String(err?.message || err) });
    // 网络异常不冷却（不误伤可用账号）
    return { ok: false, detail: `网络失败: ${String(err?.message || err).slice(0, 100)}` };
  }
}

// 对池内全部账号（绕过冷却——探活本来就是要测禁言状态）逐个探活，返回报告
export async function deepseekHealth({ authPool, fetchImpl, dispatcher, baseUrl = DEEPSEEK_DEFAULT_BASE, connectTimeoutMs = 30_000 } = {}) {
  const doFetch = fetchImpl || compatFetch;
  const report = [];
  for (const token of authPool.keys || []) {
    const r = await probeToken({ token, fetchImpl: doFetch, dispatcher, baseUrl: String(baseUrl).replace(/\/+$/, ""), connectTimeoutMs, onError: (t, opts) => authPool.onError(t, opts) });
    report.push({ tokenTail: tail(token), ...r });
    dsDebug("health", { event: "result", tokenTail: tail(token), ok: r.ok, detail: r.detail });
  }
  return report;
}
