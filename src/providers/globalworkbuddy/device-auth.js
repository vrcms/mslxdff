// 国际版设备授权流（`-provider globalworkbuddy login` 的协议层）。
// 三步（入口 2026-10-05 实测可用，见 FINDINGS 结论 A）：
//   ① POST /v2/plugin/auth/state?platform=workbuddy-ai → {state, authUrl}
//   ② GET  /v2/plugin/auth/token?state=                → 轮询；业务 code≠0 视为「还没登录」，HTTP 5xx 才抛
//   ③ GET  /v2/plugin/login/account?state=             → {uid, enterpriseId, nickname}
// ⚠ 与国内版 `workbuddy-login.js` 的关键差异：本文件**绝不**把凭据写进 `providerConfigs.workbuddy`。
//   国际号混进国内池 = 把 `.ai` 的 Bearer 与 refreshToken 发给 `copilot.tencent.com`（跨产品泄露，
//   且 CN 侧会拿它去 refresh）。落盘只走 `./account-store.js`。
// ⚠ 日志纪律：任何函数都不得打印 accessToken/refreshToken（安全红线）。
import { compatFetch, timeoutSignal } from "../../compat.js";
import {
  BASE, AUTH_STATE_PATH, AUTH_TOKEN_PATH, LOGIN_ACCOUNT_PATH, DEVICE_PLATFORM, DOMAIN, JSON_TIMEOUT_MS,
} from "./constants.js";
import { deviceHeaders } from "./headers.js";

async function readEnvelope(res) {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch {
    throw new Error(`国际版返回非 JSON（HTTP ${res.status}）: ${txt.slice(0, 160)}`);
  }
}

export async function requestDeviceState({ fetchImpl = compatFetch, platform = DEVICE_PLATFORM } = {}) {
  const res = await fetchImpl(`${BASE}${AUTH_STATE_PATH}?platform=${encodeURIComponent(platform)}`, {
    method: "POST",
    headers: deviceHeaders(),
    body: "{}",
    signal: timeoutSignal(JSON_TIMEOUT_MS),
  });
  const j = await readEnvelope(res);
  if (j.code !== 0 || !j.data?.state || !j.data?.authUrl) {
    throw new Error(`获取授权失败: code=${j.code} ${j.msg || ""}`.trim());
  }
  return { state: String(j.data.state), authUrl: String(j.data.authUrl) };
}

/** 单次轮询。pending 返回 null；HTTP 5xx 抛错；成功返回 token bundle。 */
export async function pollDeviceToken({ fetchImpl = compatFetch, state } = {}) {
  const res = await fetchImpl(`${BASE}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`, {
    headers: deviceHeaders(),
    signal: timeoutSignal(JSON_TIMEOUT_MS),
  });
  if (res.status >= 500) throw new Error(`token 端点故障: HTTP ${res.status}`);
  const j = await readEnvelope(res);
  if (j.code !== 0 || !j.data?.accessToken) return null;
  return {
    accessToken: String(j.data.accessToken),
    refreshToken: String(j.data.refreshToken || ""),
    expiresIn: Number(j.data.expiresIn) || 5184000,
    domain: String(j.data.domain || DOMAIN),
  };
}

export async function fetchDeviceAccount({ fetchImpl = compatFetch, state, accessToken } = {}) {
  const res = await fetchImpl(`${BASE}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`, {
    headers: { ...deviceHeaders(), Authorization: `Bearer ${accessToken}` },
    signal: timeoutSignal(JSON_TIMEOUT_MS),
  });
  const j = await readEnvelope(res);
  if (j.code !== 0 || !j.data?.uid) throw new Error(`获取账号失败: code=${j.code} ${j.msg || ""}`.trim());
  return {
    uid: String(j.data.uid),
    enterpriseId: String(j.data.enterpriseId || ""),
    nickname: String(j.data.nickname || ""),
  };
}

/**
 * 完整登录：拿链接 → 回调把 authUrl 交给调用方渲染 → 轮询 → 落盘。
 * 轮询参数全部可注入，测试里塞假 fetch 零网络；`log` 只收 uid 前缀/domain，永不含 token。
 */
export async function loginAndSave({
  fetchImpl = compatFetch,
  platform = DEVICE_PLATFORM,
  save,
  onAuthUrl,
  log = (m) => console.log(m),
  deadlineMs = 5 * 60 * 1000,
  intervalMs = 5000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  const dev = await requestDeviceState({ fetchImpl, platform });
  if (typeof onAuthUrl === "function") await onAuthUrl(dev.authUrl);
  else log(`请在浏览器打开：${dev.authUrl}`);

  const deadline = now() + deadlineMs;
  let bundle = null;
  while (now() < deadline) {
    await sleep(intervalMs);
    try {
      bundle = await pollDeviceToken({ fetchImpl, state: dev.state });
      if (bundle) break;
      process.stdout.write(".");
    } catch (e) {
      log(`\n   轮询出错：${e.message}`);
    }
  }
  if (!bundle) throw new Error("登录超时：未在浏览器完成授权");
  log("\n✅ 授权成功，取账号信息…");

  const acct = await fetchDeviceAccount({ fetchImpl, state: dev.state, accessToken: bundle.accessToken });
  const saveFn = save || (await import("./account-store.js")).saveGlobalworkbuddyAccount;
  const saved = await saveFn({
    uid: acct.uid,
    enterpriseId: acct.enterpriseId,
    nickname: acct.nickname,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + bundle.expiresIn,
    domain: bundle.domain,
  });
  return {
    uid: acct.uid,
    nickname: acct.nickname,
    domain: bundle.domain,
    file: saved.file,
    accounts: saved.accounts,
  };
}
