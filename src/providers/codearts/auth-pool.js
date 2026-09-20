// 账号池：keyring 的 key = 凭证 blob JSON 字符串（一华为账号一 blob，多账号=多 key 自动轮转）。
// 职责：blob 解析；STS 凭证临期（默认提前 30min）单飞刷新；轮转写回（saveFn，原位换 key）；
// 死号（终态失效）标记。瞬时失败保留旧凭证继续用，绝不清已存凭证（对齐 cline isInvalidGrant 纪律）。
import { refreshStsCredential } from "./sts.js";
import { REFRESH_SKEW_MS_DEFAULT } from "./const.js";

/** 校验并解析 blob 字符串 → 账号运行时对象；非 blob（如 Bearer key）返回 null。 */
export function accountFromBlob(raw) {
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return null;
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || !j.refreshToken || !j.codeVerifier || !j.dpopJwk) return null;
  const expMs = j.expiration ? Date.parse(j.expiration) : NaN;
  return {
    blob: raw,
    userId: String(j.userId || j.user_id || ""),
    userName: String(j.userName || j.user_name || ""),
    domainId: String(j.domainId || j.domain_id || ""),
    refreshToken: String(j.refreshToken || ""),
    clientId: String(j.clientId || "codearts-agent"),
    codeVerifier: String(j.codeVerifier || ""),
    dpopJwk: j.dpopJwk || null,
    accessKeyId: String(j.accessKeyId || ""),
    secretAccessKey: String(j.secretAccessKey || ""),
    securityToken: String(j.securityToken || ""),
    expiration: String(j.expiration || ""),
    expiresAtMs: Number.isFinite(expMs) ? expMs : 0,
    dead: false,
    lastError: "",
    refreshInflight: null,
  };
}

/** 账号对象 → 可持久化 blob（JSON 字符串；AK/SK/securityToken 是 STS 临时凭证快照）。 */
export function blobFromAccount(acc) {
  return JSON.stringify({
    userId: acc.userId,
    userName: acc.userName,
    domainId: acc.domainId,
    refreshToken: acc.refreshToken,
    clientId: acc.clientId,
    codeVerifier: acc.codeVerifier,
    dpopJwk: acc.dpopJwk,
    accessKeyId: acc.accessKeyId,
    secretAccessKey: acc.secretAccessKey,
    securityToken: acc.securityToken,
    expiration: acc.expiration,
  });
}

export function createAuthPool({
  keys = [],
  fetchImpl,
  stsHost,
  skewMs = REFRESH_SKEW_MS_DEFAULT,
  clock = () => Date.now(),
  saveFn,
} = {}) {
  const accounts = new Map(); // blob → account
  for (const k of keys) {
    const acc = accountFromBlob(k);
    if (acc) accounts.set(k, acc);
  }

  function findByBlob(blob) { return accounts.get(blob) || null; }
  function aliveAccounts() { return [...accounts.values()].filter((a) => !a.dead); }
  function pickPrimary() { return aliveAccounts()[0] || null; }

  async function doRefresh(acc) {
    const r = await refreshStsCredential(
      { refreshToken: acc.refreshToken, codeVerifier: acc.codeVerifier, dpopJwk: acc.dpopJwk, clientId: acc.clientId },
      { fetchImpl, stsHost },
    );
    if (r.relogin) {
      acc.dead = true;
      acc.lastError = r.error || "re-login required";
      return;
    }
    if (r.error) { acc.lastError = r.error; return; } // 瞬时失败：旧凭证还能用就继续用
    // 成功：STS 字段更新（refreshToken 可能轮转），原位换 blob 写回
    acc.accessKeyId = r.account.accessKeyId;
    acc.secretAccessKey = r.account.secretAccessKey;
    acc.securityToken = r.account.securityToken;
    acc.expiration = r.account.expiration;
    acc.expiresAtMs = r.account.expiresAtMs;
    if (r.account.refreshToken) acc.refreshToken = r.account.refreshToken;
    if (r.account.userId) acc.userId = r.account.userId;
    if (r.account.userName) acc.userName = r.account.userName;
    if (r.account.domainId) acc.domainId = r.account.domainId;
    acc.lastError = "";
    acc.dead = false;
    const newBlob = blobFromAccount(acc);
    if (newBlob !== acc.blob) {
      const oldBlob = acc.blob;
      accounts.delete(oldBlob);
      acc.blob = newBlob;
      accounts.set(newBlob, acc);
      if (saveFn) { try { await saveFn({ oldBlob, newBlob, account: acc }); } catch {} }
    }
  }

  /**
   * 取某账号的有效 STS 凭证（临期自动单飞刷新）。
   * @throws {Error} blob 不在池内 / 死号（message 带 re-login 提示）
   */
  async function getCredential(blob) {
    const acc = findByBlob(blob);
    if (!acc) throw new Error("codearts: credential not in pool — restart daemon or re-login");
    if (acc.dead) throw new Error(`codearts account ${acc.userId || "?"} dead: ${acc.lastError || "re-login required"} — run: mslxdff -provider codearts login`);
    const now = clock();
    const needRefresh = !acc.securityToken || !acc.accessKeyId
      || (acc.expiresAtMs > 0 && now >= acc.expiresAtMs - skewMs);
    if (needRefresh && !acc.refreshInflight) {
      acc.refreshInflight = doRefresh(acc).finally(() => { acc.refreshInflight = null; });
    }
    if (acc.refreshInflight) await acc.refreshInflight;
    if (acc.dead) throw new Error(`codearts account ${acc.userId || "?"} dead: ${acc.lastError || "re-login required"} — run: mslxdff -provider codearts login`);
    return acc;
  }

  /** 强制下次刷新（401 后调用；清掉缓存的 STS 临时凭证）。 */
  function invalidate(blob) {
    const acc = findByBlob(blob);
    if (!acc) return;
    acc.securityToken = "";
    acc.accessKeyId = "";
    acc.secretAccessKey = "";
    acc.expiresAtMs = 0;
  }

  function markDead(blob, reason) {
    const acc = findByBlob(blob);
    if (!acc) return;
    acc.dead = true;
    acc.lastError = reason || acc.lastError;
  }

  /** ring 轮转写回后的重排（saveFn 成功后由 index 调用；saveFn 已处理则幂等）。 */
  function replace(oldBlob, newBlob) {
    const acc = accounts.get(oldBlob);
    if (!acc || oldBlob === newBlob) return;
    accounts.delete(oldBlob);
    acc.blob = newBlob;
    accounts.set(newBlob, acc);
  }

  return { findByBlob, aliveAccounts, pickPrimary, getCredential, invalidate, markDead, replace, accounts: () => [...accounts.values()] };
}
