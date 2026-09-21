// traework 账号落盘单一源：auths/trae-<uid>.json（0600 tmp+rename）+ state.json keys/auths 按 uid 去重。
// 仿 src/providers/workbuddy/account-store.js。
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { isTestEnv, defaultStateFile } from "../../state/store.js";

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

export function findAccountFile(uid) {
  for (const dir of resolveAuthDirs()) {
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
