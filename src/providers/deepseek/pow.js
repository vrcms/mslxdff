// DeepSeek PoW 编排：challenge 获取 + 求解 + x-ds-pow-response header 编码
// 上游协议参考 iidamie/deepseek2api（GPL-3.0，协议事实）与 TQZHR/deepseek2api（MIT）
import { deepSeekHashV1, findPowNonce } from "./hash.js";
import { compatFetch } from "../../compat.js";

export const DEEPSEEK_DEFAULT_BASE = "https://chat.deepseek.com";
export const DEEPSEEK_API_PREFIX = "/api/v0";
export const COMPLETION_TARGET_PATH = "/api/v0/chat/completion";

export function androidHeaders(token, extra = {}) {
  return {
    "User-Agent": "DeepSeek/1.0.13 Android/35",
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-client-platform": "android",
    "x-client-version": "2.0.0",
    "x-client-locale": "zh_CN",
    "accept-charset": "UTF-8",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function apiError(payload, status) {
  const bizMsg = payload?.data?.biz_msg || payload?.msg || payload?.error || "";
  const code = payload?.data?.biz_code ?? payload?.code ?? status;
  const err = new Error(`DeepSeek PoW 挑战获取失败${bizMsg ? `: ${bizMsg}` : ""}${code ? ` (code=${code})` : ""}`);
  err.status = status;
  err.bizCode = code;
  return err;
}

// 网络层抖动重试（换新连接）：TUN 断流后 keepAlive 坏 socket 会 fetch failed/aborted，
// 重试即建新 socket。只重试"拿到响应前"的失败，不重试业务错（4xx/5xx 有响应）。
const NET_ERR_PATTERN = /fetch failed|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|socket hang up|network/i;
export async function netRetry(fn, { attempts = 2, delayMs = 400 } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = `${err?.message || err} ${err?.cause?.code || err?.cause?.message || ""}`;
      if (i >= attempts || !NET_ERR_PATTERN.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

export async function fetchPowChallenge({ token, fetchImpl, dispatcher, baseUrl = DEEPSEEK_DEFAULT_BASE, connectTimeoutMs = 30_000 }) {
  const doFetch = fetchImpl || compatFetch;
  const url = `${String(baseUrl).replace(/\/+$/, "")}${DEEPSEEK_API_PREFIX}/chat/create_pow_challenge`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("DeepSeek PoW challenge timed out")), connectTimeoutMs);
  let res;
  try {
    res = await netRetry(() => doFetch(url, {
      method: "POST",
      headers: androidHeaders(token),
      body: JSON.stringify({ target_path: COMPLETION_TARGET_PATH }),
      ...(dispatcher ? { dispatcher } : {}),
      signal: controller.signal,
    }), { attempts: 2, delayMs: 400 });
  } catch (err) {
    throw new Error(`DeepSeek PoW 挑战请求失败: ${String(err?.message || err)}`);
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try { payload = await res.json(); } catch {}
  if (!res.ok || payload?.data?.biz_code !== 0 || !payload?.data?.biz_data?.challenge) {
    throw apiError(payload, res.status);
  }
  return payload.data.biz_data.challenge;
}

export function buildPowHeader(challenge, answer) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path || COMPLETION_TARGET_PATH,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

// 单次全编排：取 challenge → 穷举 nonce → 编 header。
// 返回 { challenge, answer, header }，供 completion 请求直接使用。
export async function solveChallenge({ token, fetchImpl, dispatcher, baseUrl, connectTimeoutMs } = {}) {
  const challenge = await fetchPowChallenge({ token, fetchImpl, dispatcher, baseUrl, connectTimeoutMs });
  const expireAt = challenge.expire_at ?? challenge.expireAt;
  const prefix = `${challenge.salt}_${expireAt}_`;
  const answer = findPowNonce(prefix, challenge.challenge, challenge.difficulty);
  if (answer < 0) {
    throw new Error(`DeepSeek PoW 求解失败: difficulty=${challenge.difficulty} 空间内无解（challenge 不匹配）`);
  }
  return { challenge, answer, header: buildPowHeader(challenge, answer) };
}
