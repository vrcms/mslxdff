// zcode CLI 轮询 OAuth：POST cli/init → 浏览器授权 → GET cli/poll/{flow_id} 拿 zcode JWT。
// 契约对齐 zcode-switch oauth.rs（init 自带 poll_token 鉴权；服务端返回的 poll_token 优先；3004=流程过期）。
import { randomBytes } from "node:crypto";
import { timeoutSignal } from "../../compat.js";
import { sleep } from "../base.js";
import { ZCODE_CLI_INIT_URL, zcodeCliPollUrl, zcodeAppVersion } from "./const.js";
import { buildZcodeHeaders } from "./headers.js";

const INIT_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_MS = 15_000;
const DEFAULT_FLOW_TTL_MS = 300_000;

export class ZcodeOAuthError extends Error {
  constructor(message, code = 0) {
    super(message);
    this.name = "ZcodeOAuthError";
    this.code = code;
  }
}

function parseExpiresAtMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
}

export async function initZcodeFlow({ provider = "zai", fetchImpl, deviceMid, version } = {}) {
  const pollToken = randomBytes(32).toString("hex");
  const headers = {
    ...buildZcodeHeaders({ token: pollToken, deviceMid, version: version || zcodeAppVersion() }),
    "Content-Type": "application/json",
  };
  const res = await fetchImpl(ZCODE_CLI_INIT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ provider }),
    signal: timeoutSignal(INIT_TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || payload?.code !== 0) {
    const msg = String(payload?.msg || "").trim();
    throw new ZcodeOAuthError(`zcode 登录初始化失败：HTTP ${res.status}${msg ? ` ${msg}` : ""}`, Number(payload?.code) || 0);
  }
  const data = payload?.data || {};
  const flowId = String(data.flow_id || "").trim();
  const authorizeUrl = String(data.authorize_url || "").trim();
  if (!flowId || !authorizeUrl) throw new ZcodeOAuthError("zcode 登录初始化响应缺少 flow_id/authorize_url");
  let parsed;
  try { parsed = new URL(authorizeUrl); } catch { throw new ZcodeOAuthError("zcode authorize_url 非法"); }
  if (parsed.protocol !== "https:") throw new ZcodeOAuthError("zcode authorize_url 必须 https");
  const state = parsed.searchParams.get("state") || "";
  if (!state) throw new ZcodeOAuthError("zcode authorize_url 缺少 state");
  return {
    provider,
    flowId,
    authorizeUrl,
    state,
    deviceMid: String(deviceMid || ""),
    pollUrl: zcodeCliPollUrl(flowId),
    pollToken: String(data.poll_token || "").trim() || pollToken,
    expiresAtMs: parseExpiresAtMs(data.expires_at) || Date.now() + DEFAULT_FLOW_TTL_MS,
    pollIntervalMs: Math.max(1000, Number(data.poll_interval_sec) * 1000 || 3000),
  };
}

// 单次轮询：pending 继续、ready 返回凭据；3004/failed 抛终态；网络抖动按 pending（不判死）。
export async function pollZcodeFlowOnce({ pollUrl, pollToken, deviceMid, version, fetchImpl } = {}) {
  let res;
  try {
    res = await fetchImpl(pollUrl, {
      headers: buildZcodeHeaders({ token: pollToken, deviceMid, version: version || zcodeAppVersion() }),
      signal: timeoutSignal(POLL_TIMEOUT_MS),
    });
  } catch {
    return { status: "pending" };
  }
  if (res.status >= 400) {
    if (res.status === 408 || res.status === 429) return { status: "pending" };
    const body = await res.json().catch(() => null);
    const code = Number(body?.code) || 0;
    if (code === 3004) throw new ZcodeOAuthError("授权已过期，请重新运行 login", 3004);
    const msg = String(body?.msg || "").trim();
    throw new ZcodeOAuthError(`zcode 登录轮询失败：HTTP ${res.status}${msg ? ` ${msg}` : ""}`, code);
  }
  const payload = await res.json().catch(() => null);
  if (!payload || payload.code !== 0) {
    const msg = String(payload?.msg || "响应异常").trim();
    throw new ZcodeOAuthError(`zcode 登录轮询失败：${msg}`, Number(payload?.code) || 0);
  }
  const data = payload?.data || {};
  const status = String(data.status || "").trim();
  if (status === "pending") return { status: "pending" };
  if (status === "failed") throw new ZcodeOAuthError("授权失败（服务端标记 failed），请重试", 0);
  if (status === "ready") {
    const jwt = String(data.token || "").trim();
    const accessToken = String(data?.zai?.access_token || data?.bigmodel?.access_token || "").trim();
    const user = {
      userId: String(data?.user?.user_id || "").trim(),
      name: String(data?.user?.name || "").trim(),
      email: String(data?.user?.email || "").trim(),
    };
    if (!jwt || !user.userId) throw new ZcodeOAuthError("zcode 登录响应缺少 token/user_id");
    return { status: "ready", jwt, accessToken, user };
  }
  throw new ZcodeOAuthError(`zcode 登录轮询未知状态：${status || "(空)"}`);
}

export async function waitForZcodeLogin({ flow, fetchImpl, log = () => {}, sleepFn = sleep, now = Date.now } = {}) {
  if (!flow?.pollUrl) throw new ZcodeOAuthError("缺少轮询信息");
  while (now() < (flow.expiresAtMs || 0)) {
    const out = await pollZcodeFlowOnce({
      pollUrl: flow.pollUrl,
      pollToken: flow.pollToken,
      deviceMid: flow.deviceMid,
      fetchImpl,
    });
    if (out.status === "ready") return { ...out, provider: flow.provider || "zai" };
    await sleepFn(flow.pollIntervalMs || 3000);
  }
  throw new ZcodeOAuthError("授权已过期，请重新运行 login", 3004);
}
