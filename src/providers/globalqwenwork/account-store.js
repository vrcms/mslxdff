// globalqwenwork 账号落盘单一源：auths/globalqwenwork-<uid>.json（0600 tmp+rename）+ state.json 双写。
// vendor 自 src/providers/qwenwork/account-store.js 逐字搬，改三处命名空间：
//  ① 文件名前缀 `globalqwenwork-`（与 cn 的 `qwenwork-` **互不为前缀**，故两站号同目录也不串；
//     反向亦然：`qwenwork-x.json` 不 startsWith("globalqwenwork-")）
//  ② state 键 `providerConfigs.globalqwenwork`
//  ③ auth 目录 env 独立为 `GLOBALQWENWORK_AUTH_DIR`（不与 cn 的 QWENWORK_AUTH_DIR 共享，防两站串号）
// 国际站与 cn 站凭证**不互通**（实测 cn token 打 .ai userinfo → 401 INVALID_TOKEN），故必须各存各的。
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { isTestEnv, defaultStateFile } from "../../state/store.js";

const PROVIDER_ID = "globalqwenwork";
const FILE_PREFIX = "globalqwenwork-";

export function authDirFor({ explicit = "", testEnv = false, stateFile } = {}) {
  if (explicit) return explicit;
  if (testEnv) return join(tmpdir(), "mslxdff-test-auths-globalqwenwork");
  return join(dirname(stateFile), "auths");
}

export function resolveAuthDir() {
  return authDirFor({
    explicit: process.env.GLOBALQWENWORK_AUTH_DIR || "",
    testEnv: isTestEnv(),
    stateFile: defaultStateFile(),
  });
}

export function resolveAuthDirs() {
  const primary = resolveAuthDir();
  const cwdDir = join(process.cwd(), "auths");
  return primary === cwdDir ? [primary] : [primary, cwdDir];
}

export function listAccountDocs({ dirs } = {}) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs || resolveAuthDirs()) {
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(".json"));
    } catch { continue; }
    for (const f of files) {
      try {
        const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const uid = doc?.account?.uid;
        if (!uid || !doc?.auth?.accessToken) continue;
        if (seen.has(String(uid))) continue;
        seen.add(String(uid));
        out.push({ uid: String(uid), file: join(dir, f), dir, doc });
      } catch {}
    }
  }
  return out;
}

function writeAccountFile({ uid, accessToken, refreshToken = "", expiresAt = 0, name = "", email = "" }) {
  const authDir = resolveAuthDir();
  mkdirSync(authDir, { recursive: true });
  const doc = {
    account: { uid, name, email },
    auth: { accessToken, refreshToken, expiresAt },
  };
  const fp = join(authDir, `${FILE_PREFIX}${uid}.json`);
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

// state 落盘：keys[i] 存 JSON blob（{device_token, refresh_token}，对齐家族形状），auths 存 uid 索引行。
async function persistAccounts(accounts, file) {
  const { loadProviderConfigs } = await import("../../state.js");
  const { saveProviderConfig } = await import("../../state.js");
  const cfg = (loadProviderConfigs(file ? { file } : {})?.[PROVIDER_ID]) || {};
  const keys = [...(Array.isArray(cfg.keys) ? cfg.keys : [])];
  const auths = [...(Array.isArray(cfg.auths) ? cfg.auths : [])];
  let updated = 0;
  for (const acc of accounts) {
    if (!acc?.uid || !acc?.accessToken) continue;
    const blob = JSON.stringify({ device_token: acc.accessToken, refresh_token: acc.refreshToken || "" });
    const row = { uid: acc.uid, name: acc.name || "", refreshToken: acc.refreshToken || "" };
    const idx = auths.findIndex((a) => String(a?.uid) === String(acc.uid));
    if (idx >= 0) { keys[idx] = blob; auths[idx] = row; updated += 1; }
    else { keys.push(blob); auths.push(row); }
  }
  // saveProviderConfig 起手保留 allowAnyModels（已在 state 层修复，见 ADR-0033 字段保留修复）
  saveProviderConfig(PROVIDER_ID, { baseUrl: cfg.baseUrl || "", keys, auths }, file ? { file } : {});
  return { keys, auths, updated };
}

export async function saveGlobalQwenworkAccount({ uid, accessToken, refreshToken = "", expiresAt = 0, name = "", email = "", file } = {}) {
  if (!uid || !accessToken) throw new Error("saveGlobalQwenworkAccount: 缺少 uid/accessToken");
  const fp = writeAccountFile({ uid, accessToken, refreshToken, expiresAt, name, email });
  const st = await persistAccounts([{ uid, accessToken, refreshToken, name }], file);
  return { file: fp, accounts: st.keys.length, updated: st.updated > 0 };
}

/** 回写刷新后的 token（上游每次 refresh 会轮换 refreshToken，必须落盘）。 */
export async function updateGlobalQwenworkTokens({ uid, accessToken, refreshToken = "", expiresAt = 0, file } = {}) {
  if (!uid || !accessToken) throw new Error("updateGlobalQwenworkTokens: 缺少 uid/accessToken");
  const docs = listAccountDocs();
  const hit = docs.find((d) => String(d.uid) === String(uid));
  const prev = hit?.doc || {};
  const fp = writeAccountFile({
    uid,
    accessToken,
    refreshToken: refreshToken || prev?.auth?.refreshToken || "",
    expiresAt: expiresAt || 0,
    name: prev?.account?.name || "",
    email: prev?.account?.email || "",
  });
  await persistAccounts([{ uid, accessToken, refreshToken: refreshToken || prev?.auth?.refreshToken || "", name: prev?.account?.name || "" }], file);
  try {
    const { invalidateSession } = await import("./cosy.js");
    invalidateSession({ uid, accessToken: prev?.auth?.accessToken });
  } catch {}
  return { file: fp };
}

// 从 provider keys 的 blob 还原凭据（device_token/deviceToken 双形状兼容）
export function accountFromBlob(blob) {
  try {
    const j = JSON.parse(String(blob || "{}"));
    const accessToken = String(j.device_token || j.accessToken || "");
    const refreshToken = String(j.refresh_token || j.refreshToken || "");
    if (!accessToken) return null;
    return { accessToken, refreshToken };
  } catch {
    return null;
  }
}
