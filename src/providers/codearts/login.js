// codearts 浏览器登录：OAuth2 PKCE + DPoP，双通道取凭证：
//   1) 本地回调 server（portal 307 → ?secret=... → ?code=...）→ 授权码换 token
//   2) ticket 轮询（无浏览器机器：任意设备打开链接后，凭 ticket_id+secret 轮询下发）
// 凭证落盘 providerConfigs.codearts.keys（blob，见 auth-pool.js），并默认放行模型目录。
import crypto from "node:crypto";
import http from "node:http";
import { SNAP_BASE, STS_HOST, PORTAL_HOST, SNAP_MANAGER_PATH, EP_LOGIN_TICKET, CLIENT_ID, PLUGIN_NAME, PLUGIN_VERSION } from "./const.js";
import { exchangeAuthorizationCode, normalizeTokenResponse } from "./sts.js";
import { newDpopPrivateJwk } from "./dpop.js";
import { compatFetch } from "../../compat.js";

const hex = (n) => crypto.randomBytes(n).toString("hex");
const b64url = (b) => Buffer.from(b).toString("base64url");

export function buildLoginState({ clientId = CLIENT_ID } = {}) {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash("sha256").update(verifier, "utf8").digest());
  return { clientId, ticketId: hex(16), secret: hex(16), codeVerifier: verifier, codeChallenge: challenge, dpopJwk: newDpopPrivateJwk() };
}

export function buildAuthorizeUrl({ state, port }) {
  const q = new URLSearchParams({
    theme: "2",
    locale: "zh-cn",
    uri_scheme: state.clientId,
    client_id: state.clientId,
    port: String(port ?? ""),
    code_challenge: state.codeChallenge,
    code_challenge_method: "SHA-256",
    ticket_id: state.ticketId,
    "plugin-name": PLUGIN_NAME,
    "plugin-version": PLUGIN_VERSION,
  });
  return `${PORTAL_HOST}/authorize?${q.toString()}`;
}

function startCallbackServer() {
  return new Promise((resolve, reject) => {
    const hits = [];
    const waiters = new Set();
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      const hit = Object.fromEntries(u.searchParams.entries());
      hits.push(hit);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h3>CodeArts 登录回调已收到</h3>可关闭此页面，回到 mslxdff 终端查看结果。</body></html>");
      for (const w of waiters) w(hit);
      waiters.clear();
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve({
      port: srv.address().port,
      nextHit: (timeoutMs) => new Promise((r) => {
        if (hits.length) return r(hits.shift());
        const t = setTimeout(() => { waiters.delete(w); r(null); }, timeoutMs);
        const w = (hit) => { clearTimeout(t); r(hit); };
        waiters.add(w);
      }),
      close: () => { try { srv.close(); } catch {} },
    }));
  });
}

// 兜底通道：无浏览器机器上，任意设备完成授权后凭 ticket_id+secret 轮询拿凭证。
export async function pollTicket({ state, snapBase = SNAP_BASE, fetchImpl, timeoutMs = 5 * 60_000, intervalMs = 2000, log = () => {}, signal } = {}) {
  const doFetch = fetchImpl || compatFetch;
  const url = `${snapBase}${SNAP_MANAGER_PATH}${EP_LOGIN_TICKET}?ticket_id=${encodeURIComponent(state.ticketId)}&secret=${encodeURIComponent(state.secret)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const res = await doFetch(url, { headers: { "plugin-name": PLUGIN_NAME, "plugin-version": PLUGIN_VERSION } });
      const raw = await res.text().catch(() => "");
      if (res.ok) {
        const account = normalizeTokenResponse(JSON.parse(raw));
        if (account) return account;
      }
    } catch { /* 未下发/网络抖动：继续轮询 */ }
    await new Promise((r) => {
      const t = setTimeout(r, intervalMs);
      signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
    });
    log(`等待授权下发…（ticket 轮询中，剩余 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s）`);
  }
  return null;
}

/**
 * 跑完整登录流程。
 * @param {object} [opts] { clientId, snapBase, stsHost, fetchImpl, timeoutMs, log, openBrowser }
 * @returns {{account, redirectUri}} 成功返回账号（含 refreshToken/AK/SK/dpopJwk 等）
 */
export async function runCodeartsLogin({
  clientId = CLIENT_ID,
  snapBase = SNAP_BASE,
  stsHost = STS_HOST,
  fetchImpl,
  timeoutMs = 5 * 60_000,
  log = console.log,
} = {}) {
  const state = buildLoginState({ clientId });
  const server = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${server.port}/oauth/callback`;
  const authorizeUrl = buildAuthorizeUrl({ state, port: server.port });
  log("");
  log("请用浏览器打开下面的链接并登录华为云（授权 CodeArts Agent）：");
  log("");
  log(`  ${authorizeUrl}`);
  log("");
  log(`本机回调：${redirectUri}（回调通道优先；ticket 轮询后台兜底，谁先到用谁）`);

  const deadline = Date.now() + timeoutMs;
  const ticketAbort = new AbortController();
  let ticketPromise = null;
  try {
    while (Date.now() < deadline) {
      const hit = await server.nextHit(Math.min(3000, deadline - Date.now()));
      // 通道 1：浏览器回调带 code → 直接换 token（谁先到用谁；portal 带 port 参数走这路，ticket 不会下发）
      if (hit?.code) {
        log("已收到授权码，正在换取 STS 凭证…");
        const account = await exchangeAuthorizationCode({
          code: hit.code,
          verifier: state.codeVerifier,
          redirectUri,
          clientId: state.clientId,
          dpopJwk: state.dpopJwk,
          fetchImpl,
          stsHost,
        });
        ticketAbort.abort(); // 回调已赢，停掉后台 ticket 轮询
        return { account, state, redirectUri };
      }
      // 授权失败（用户拒绝等）：把上游原因说人话抛出
      if (hit?.error) throw new Error(`codearts authorize failed: ${hit.error}${hit.error_description ? ` — ${hit.error_description}` : ""}`);
      // 通道 2：首次（portal 307 带 secret 一跳，或 3s 无回调）→ 后台起 ticket 轮询
      // 关键：绝不 await 阻塞主循环——否则浏览器 code 回调无人消费，永远轮询（真机首登实测死锁）
      if ((hit?.secret || !hit) && !ticketPromise) {
        ticketPromise = pollTicket({ state, snapBase, fetchImpl, timeoutMs: deadline - Date.now(), log, signal: ticketAbort.signal }).catch(() => null);
      }
      // ticket 后台结果非阻塞查询：未决立即返回 null，主循环继续收回调
      if (ticketPromise) {
        const acc = await Promise.race([ticketPromise, Promise.resolve(null)]);
        if (acc) return { account: acc, state, redirectUri };
      }
    }
  } finally {
    server.close();
  }
  throw new Error("codearts login timed out — 未在时限内拿到授权（可重跑：mslxdff -provider codearts login）");
}

/** 账号对象 → 可持久化 blob 字符串（与 auth-pool.blobFromAccount 同形状）。 */
export function accountToBlob(account, { codeVerifier, dpopJwk, clientId = CLIENT_ID }) {
  return JSON.stringify({
    userId: account.userId,
    userName: account.userName,
    domainId: account.domainId,
    refreshToken: account.refreshToken,
    clientId,
    codeVerifier,
    dpopJwk,
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    securityToken: account.securityToken,
    expiration: account.expiration,
  });
}
