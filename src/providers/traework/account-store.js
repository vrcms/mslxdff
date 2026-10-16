// traework 账号落盘单一源：auths/trae-<uid>.json（0600 tmp+rename）+ state.json keys/auths 按 uid 去重。
// 仿 src/providers/workbuddy/account-store.js。
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { isTestEnv, defaultStateFile } from "../../state/store.js";
// 市场侧伪设备身份：派生算法在 market-identity.js（纯函数），本文件只管落盘与取用。
import { deriveMarketIdentity, marketUsable } from "./market-identity.js";

export function authDirFor({ explicit = "", testEnv = false, stateFile } = {}) {
  if (explicit) return explicit;
  if (testEnv) return join(tmpdir(), "mslxdff-test-auths");
  return join(dirname(stateFile), "auths");
}

export function resolveAuthDir() {
  return authDirFor({
    explicit: process.env.TRAEWORK_AUTH_DIR || "",
    testEnv: isTestEnv(),
    stateFile: defaultStateFile(),
  });
}

export function authDirCandidates({ primary, explicit = "", testEnv = false, cwdDir = "" } = {}) {
  const dirs = [primary];
  if (!explicit && !testEnv && cwdDir && cwdDir !== primary) dirs.push(cwdDir);
  return dirs;
}

export function resolveAuthDirs() {
  return authDirCandidates({
    primary: resolveAuthDir(),
    explicit: process.env.TRAEWORK_AUTH_DIR || "",
    testEnv: isTestEnv(),
    cwdDir: join(process.cwd(), "auths"),
  });
}

export function findAccountFile(uid, { dirs } = {}) {
  for (const dir of dirs || resolveAuthDirs()) {
    const fp = join(dir, `trae-${uid}.json`);
    if (existsSync(fp)) return fp;
  }
  return null;
}

// 扫描 trae-*.json，返回已校验的凭证行。读取侧单一真相。
export function listAccountDocs({ dirs } = {}) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs || resolveAuthDirs()) {
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => f.startsWith("trae-") && f.endsWith(".json"));
    } catch { continue; }
    for (const f of files) {
      try {
        const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const uid = doc?.account?.uid || doc?.uid;
        const at = doc?.auth?.accessToken || doc?.accessToken;
        if (!uid || !at) continue;
        if (seen.has(String(uid))) continue;
        seen.add(String(uid));
        out.push({ uid: String(uid), file: join(dir, f), dir, doc });
      } catch {}
    }
  }
  return out;
}

function writeAccountFile({ uid, accessToken, refreshToken = "", expiresAt = 0, domain = "trae.cn", apiHost = "", machineId = "", deviceId = "", enterpriseId = "", nickname = "" }) {
  const authDir = resolveAuthDir();
  mkdirSync(authDir, { recursive: true });
  const exp = expiresAt || Math.floor(Date.now() / 1000) + 5184000;
  const doc = {
    account: { uid, enterpriseId, nickname },
    auth: { accessToken, refreshToken, expiresAt: exp, domain, apiHost, machineId, deviceId },
  };
  const fp = join(authDir, `trae-${uid}.json`);
  const tmp = `${fp}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  try {
    if (existsSync(fp)) { try { chmodSync(fp, 0o600); } catch {} unlinkSync(fp); }
    renameSync(tmp, fp);
  } catch {
    writeFileSync(fp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    try { unlinkSync(tmp); } catch {}
  }
  try { chmodSync(fp, 0o600); } catch {}
  return fp;
}

async function persistAccounts(accounts, file, extraKeys = []) {
  const { loadProviderConfigs, saveProviderConfig } = await import("../../state.js");
  const cfg = (loadProviderConfigs(file ? { file } : {})?.traework) || {};
  const keys = [...(Array.isArray(cfg.keys) ? cfg.keys : [])];
  const auths = [...(Array.isArray(cfg.auths) ? cfg.auths : [])];
  let updated = 0;
  for (const acc of accounts) {
    if (!acc?.uid || !acc?.accessToken) continue;
    const row = { uid: acc.uid, domain: acc.domain || "trae.cn", apiHost: acc.apiHost || "", machineId: acc.machineId || "", deviceId: acc.deviceId || "", enterpriseId: acc.enterpriseId || "", refreshToken: acc.refreshToken || "" };
    const atIdx = auths.findIndex((a) => a?.uid === acc.uid);
    if (atIdx >= 0) { keys[atIdx] = acc.accessToken; auths[atIdx] = row; updated += 1; }
    else { keys.push(acc.accessToken); auths.push(row); }
  }
  for (const k of extraKeys) if (k && !keys.includes(k)) keys.push(k);
  saveProviderConfig("traework", { baseUrl: cfg.baseUrl || "https://trae-api-cn.mchost.guru", keys, auths }, file ? { file } : {});
  return { keys, auths, updated };
}

export async function saveTraeworkAccount({ uid, enterpriseId = "", nickname = "", accessToken, refreshToken = "", expiresAt = 0, domain = "trae.cn", apiHost = "", machineId = "", deviceId = "", file } = {}) {
  if (!uid || !accessToken) throw new Error("saveTraeworkAccount: 缺少 uid/accessToken");
  const fp = writeAccountFile({ uid, accessToken, refreshToken, expiresAt, domain, apiHost, machineId, deviceId, enterpriseId, nickname });
  const st = await persistAccounts([{ uid, accessToken, refreshToken, domain, apiHost, machineId, deviceId, enterpriseId }], file);
  return { file: fp, accounts: st.keys.length, updated: st.updated > 0 };
}

function accountsFromArrays(keys, authList) {
  const accounts = [];
  const extraKeys = [];
  const n = Math.max(keys.length, authList.length);
  for (let i = 0; i < n; i++) {
    const a = authList[i];
    if (a && typeof a === "object" && a.uid) {
      accounts.push({ uid: a.uid, accessToken: keys[i] || "", refreshToken: a.refreshToken || "", domain: a.domain, apiHost: a.apiHost, machineId: a.machineId, deviceId: a.deviceId, enterpriseId: a.enterpriseId });
    } else if (keys[i]) extraKeys.push(keys[i]);
  }
  return { accounts, extraKeys };
}

// 刷新后的 token 落盘：平行数组按下标更新 + state + auths 文件单点落盘。
export async function applyTokenRefresh({ uid, oldKey, newToken, refreshToken = "", domain = "trae.cn", apiHost = "", machineId = "", deviceId = "", enterpriseId = "", auth = null, keys = [], authList = [], file } = {}) {
  if (!uid || !newToken) return { updated: false, accounts: keys.length, file: null };
  const keyIdx = keys.indexOf(oldKey);
  const uidIdx = authList.findIndex((a) => a && String(a.uid) === String(uid));
  const idx = keyIdx >= 0 ? keyIdx : uidIdx;
  const matched = idx >= 0;
  if (idx >= 0) keys[idx] = newToken;
  else if (!keys.includes(newToken)) keys.push(newToken);
  if (uidIdx >= 0) {
    const prev = authList[uidIdx] && typeof authList[uidIdx] === "object" ? authList[uidIdx] : null;
    authList[uidIdx] = { ...(prev || auth || {}), uid, domain: prev?.domain || auth?.domain || domain, apiHost: prev?.apiHost || auth?.apiHost || apiHost, machineId: prev?.machineId || auth?.machineId || machineId, deviceId: prev?.deviceId || auth?.deviceId || deviceId, enterpriseId: prev?.enterpriseId || auth?.enterpriseId || enterpriseId, refreshToken };
  } else {
    authList.push({ ...(auth || {}), uid, domain: auth?.domain || domain, apiHost: auth?.apiHost || apiHost, machineId: auth?.machineId || machineId, deviceId: auth?.deviceId || deviceId, enterpriseId: auth?.enterpriseId || enterpriseId, refreshToken });
  }
  const fp = writeAccountFile({ uid, accessToken: newToken, refreshToken, domain, apiHost, machineId, deviceId, enterpriseId });
  const { accounts, extraKeys } = accountsFromArrays(keys, authList);
  const st = await persistAccounts(accounts, file, extraKeys);
  return { updated: matched, accounts: st.keys.length, file: fp };
}

/**
 * 按 uid 回 auth 文件取「设备身份」（machineId/deviceId/apiHost/enterpriseId/domain）。
 *
 * 为什么必须回文件而不是信 state 行：`src/state/provider-config.js` 的 `normalizeAuths` 是
 * {uid,domain,enterpriseId,refreshToken} **四字段白名单**（为 WorkBuddy 设计），任何写 state 的路径
 * 都会把 machineId/deviceId/apiHost 静默剥光 —— 于是 `persistAccounts:100` 与 `applyTokenRefresh:141`
 * 精心写的这三个字段**从来没落过盘**。缺 X-Device-Id 时上游 `ug/checkin_credits/claim` 回
 * `code=9004 The submitted order parameters are incorrect`（2026-10-15 实测：同一次登录用局部 deviceId
 * 那一发回的是 9074「参与用户太多」，两行代码之差即因果）。
 */
export function traeworkIdentityByUid(uid, { dirs } = {}) {
  const blank = { machineId: "", deviceId: "", apiHost: "", domain: "", enterpriseId: "" };
  const want = String(uid || "");
  if (!want) return blank;
  for (const { uid: u, doc } of listAccountDocs({ dirs })) {
    if (String(u) !== want) continue;
    const a = (doc && doc.auth) || {}, acc = (doc && doc.account) || {};
    return {
      machineId: String(a.machineId || ""),
      deviceId: String(a.deviceId || ""),
      apiHost: String(a.apiHost || ""),
      domain: String(a.domain || ""),
      enterpriseId: String(acc.enterpriseId || a.enterpriseId || ""),
    };
  }
  return blank;
}

/** 批量版：一次扫目录，按 uid 把 authList 行补齐身份（state 已有的值优先，缺的才回文件取）。 */
export function withTraeworkIdentity(authList = [], { dirs } = {}) {
  const byUid = new Map(listAccountDocs({ dirs }).map((d) => [String(d.uid), d.doc]));
  return (Array.isArray(authList) ? authList : []).map((row) => {
    const doc = byUid.get(String((row && row.uid) || ""));
    if (!doc) return { ...(row || {}) };
    const a = (doc && doc.auth) || {}, acc = (doc && doc.account) || {};
    return {
      ...(row || {}),
      machineId: (row && row.machineId) || a.machineId || "",
      deviceId: (row && row.deviceId) || a.deviceId || "",
      apiHost: (row && row.apiHost) || a.apiHost || "",
      domain: (row && row.domain) || a.domain || "trae.cn",
      enterpriseId: (row && row.enterpriseId) || acc.enterpriseId || "",
      // accessToken 仍以 state.keys[i] 为准（keyring 按它轮转），只在行里空时兜一份文件里的
      ...(row && row.accessToken ? {} : (a.accessToken ? { accessToken: a.accessToken } : {})),
    };
  });
}

/**
 * 取该账号的市场侧伪设备身份（UG 接口的 x-device-id / x-market-user-id / vscode-sessionid）。
 *
 * 真相源是 `auths/trae-<uid>.json` 的 `market` 块，**不是 state**：`normalizeAuths` 是四字段白名单
 * （`src/state/provider-config.js:21`），写进 state 的 auths 行必被剥光（2026-10-15 实测）。
 * 存量缺失/形状不对/gen 落后 → 按 uid 确定性重建并回写文档；同 uid 永远得到同一套身份，
 * 因此重登不会换设备（换设备在上游眼里就是新设备，签到风控会跟上来，见参考实现 device.rs:108）。
 */
export function ensureMarketIdentity(uid, { dirs } = {}) {
  const want = String(uid || "").trim();
  const derived = deriveMarketIdentity(want);
  if (!want) return derived; // 无 uid：只可能拿到不可复现的兜底值，不写盘（没有文件名可写）
  const fp = findAccountFile(want, { dirs });
  if (!fp) return derived;
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(fp, "utf8"));
  } catch {
    return derived;
  }
  if (marketUsable(doc && doc.market)) {
    const m = doc.market;
    return { deviceId: String(m.deviceId), marketUserId: String(m.marketUserId), sessionId: String(m.sessionId), created: m.created || "", gen: Number(m.gen) };
  }
  // 就地补写：只加/换 `market` 一个键，其余字段原样保留（不碰 auth/account，防洗掉 token 与身份）
  try {
    const next = { ...doc, market: derived };
    const tmp = `${fp}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    try { renameSync(tmp, fp); } catch { writeFileSync(fp, JSON.stringify(next, null, 2), { mode: 0o600 }); try { unlinkSync(tmp); } catch {} }
    try { chmodSync(fp, 0o600); } catch {}
  } catch {}
  return derived;
}
