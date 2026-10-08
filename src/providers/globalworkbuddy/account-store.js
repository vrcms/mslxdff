// globalworkbuddy 账号落盘单一源：`auths/globalworkbuddy-<uid>.json`（0600 tmp+rename）+ `state.json` 双写。
// 结构 vendor 自 `globalqwenwork/account-store.js`（同仓库的多租户先例，ADR-0041），三处命名空间独立：
//   ① 文件前缀 `globalworkbuddy-`：与 `workbuddy-` **互不为前缀**，故两区凭据同目录也扫不串
//      （反向亦然：`workbuddy-x.json` 不 startsWith("globalworkbuddy-")）；
//   ② state 键 `providerConfigs.globalworkbuddy`；
//   ③ 凭据目录 env 独立 `GLOBALWORKBUDDY_AUTH_DIR`（不与国内版 WORKBUDDY_AUTH_DIR 共享）。
// ⚠ region 守卫：`state/provider-config.js:14-29` 的 `normalizeAuths` 会把缺失的 domain **默认成 www.codebuddy.cn**。
//   所以这里写入时必须显式带 domain，读取时又按 `isGlobalDomain` 复核一遍 —— 否则一枚国内号一旦被误写进来，
//   就会被当国际号发给 .ai（或反向），那是跨产品泄露凭据（参考仓库 auth.ts:377-395 对此直接抛错）。
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { isTestEnv, defaultStateFile } from "../../state/store.js";
import { DOMAIN, isGlobalDomain } from "./constants.js";

const PROVIDER_ID = "globalworkbuddy";
const FILE_PREFIX = "globalworkbuddy-";

export function authDirFor({ explicit = "", testEnv = false, stateFile } = {}) {
  if (explicit) return explicit;
  if (testEnv) return join(tmpdir(), "mslxdff-test-auths-globalworkbuddy");
  return join(dirname(stateFile), "auths");
}

export function resolveAuthDir() {
  return authDirFor({
    explicit: process.env.GLOBALWORKBUDDY_AUTH_DIR || "",
    testEnv: isTestEnv(),
    stateFile: defaultStateFile(),
  });
}

/** 读取候选：主位置优先；显式 env 或测试环境不带 cwd 兜底（防把凭据写进任意目录，教训见 ADR-0025）。 */
export function resolveAuthDirs() {
  const primary = resolveAuthDir();
  const cwdDir = join(process.cwd(), "auths");
  const explicit = process.env.GLOBALWORKBUDDY_AUTH_DIR || "";
  if (explicit || isTestEnv() || !cwdDir || cwdDir === primary) return [primary];
  return [primary, cwdDir];
}

function parseDoc(fp) {
  try {
    const doc = JSON.parse(readFileSync(fp, "utf8"));
    const uid = doc?.account?.uid;
    if (!uid || !doc?.auth?.accessToken) return null;
    return doc;
  } catch { return null; }
}

/** 这枚凭据是否属于国际版（domain 判定；缺失即视为国内号，绝不默认放行）。 */
export function isGlobalDoc(doc) {
  return isGlobalDomain(doc?.auth?.domain || "");
}

/**
 * 列国际版账号。**非 global domain 的文件直接跳过并计数**，供上层打一条人话告警：
 * 表现上就是「CN 号被误写进本 provider」的唯一出口。
 */
export function listAccountDocs({ dirs } = {}) {
  const out = [];
  const rejected = [];
  const seen = new Set();
  for (const dir of dirs || resolveAuthDirs()) {
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(".json"));
    } catch { continue; }
    for (const f of files) {
      const fp = join(dir, f);
      const doc = parseDoc(fp);
      if (!doc) continue;
      const uid = String(doc.account.uid);
      if (seen.has(uid)) continue;
      if (!isGlobalDoc(doc)) { rejected.push({ uid, file: fp, domain: doc?.auth?.domain || "" }); continue; }
      seen.add(uid);
      out.push({ uid, file: fp, dir, doc });
    }
  }
  return { docs: out, rejectedRegionMismatch: rejected };
}

/** 兼容旧调用面：只要 docs。 */
export function listAccounts(opts) {
  return listAccountDocs(opts).docs;
}

export function findAccountFile(uid) {
  for (const { file } of listAccounts()) {
    if (file.endsWith(`${FILE_PREFIX}${uid}.json`)) return file;
  }
  return null;
}

function writeAccountFile({ uid, accessToken, refreshToken = "", expiresAt = 0, domain = DOMAIN, enterpriseId = "", nickname = "" }) {
  const authDir = resolveAuthDir();
  mkdirSync(authDir, { recursive: true });
  const doc = {
    account: { uid, enterpriseId, nickname },
    auth: { accessToken, refreshToken, expiresAt, domain },
  };
  const fp = join(authDir, `${FILE_PREFIX}${uid}.json`);
  const tmp = `${fp}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  try {
    if (existsSync(fp)) { try { chmodSync(fp, 0o600); } catch {} unlinkSync(fp); }
    renameSync(tmp, fp);
  } catch {
    writeFileSync(fp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    try { unlinkSync(tmp); } catch {} // 失败路径别把含凭据的 .tmp 留在盘上
  }
  try { chmodSync(fp, 0o600); } catch {}
  return fp;
}

/** state 落盘：keys[i] 存裸 accessToken（对话直接当 Bearer 用，与国内版家族一致）。 */
async function persistAccounts(accounts, file) {
  const { loadProviderConfigs, saveProviderConfig } = await import("../../state.js");
  const cfg = (loadProviderConfigs(file ? { file } : {})?.[PROVIDER_ID]) || {};
  const keys = [...(Array.isArray(cfg.keys) ? cfg.keys : [])];
  const auths = [...(Array.isArray(cfg.auths) ? cfg.auths : [])];
  let updated = 0;
  for (const acc of accounts) {
    if (!acc?.uid || !acc?.accessToken) continue;
    const row = {
      uid: String(acc.uid),
      domain: acc.domain || DOMAIN, // **必须显式**：normalizeAuths 缺省会填国内域
      enterpriseId: acc.enterpriseId || "",
      refreshToken: acc.refreshToken || "",
    };
    const idx = auths.findIndex((a) => String(a?.uid) === String(acc.uid));
    if (idx >= 0) { keys[idx] = acc.accessToken; auths[idx] = row; updated += 1; }
    else { keys.push(acc.accessToken); auths.push(row); }
  }
  saveProviderConfig(PROVIDER_ID, { baseUrl: cfg.baseUrl || "", keys, auths }, file ? { file } : {});
  return { keys, auths, updated };
}

export async function saveGlobalworkbuddyAccount({ uid, accessToken, refreshToken = "", expiresAt = 0, domain = DOMAIN, enterpriseId = "", nickname = "", file } = {}) {
  if (!uid || !accessToken) throw new Error("saveGlobalworkbuddyAccount: 缺少 uid/accessToken");
  if (!isGlobalDomain(domain)) throw new Error(`saveGlobalworkbuddyAccount: domain=${domain || "(空)"} 不是国际版域，拒绝写入（防跨区串号）`);
  const fp = writeAccountFile({ uid, accessToken, refreshToken, expiresAt, domain, enterpriseId, nickname });
  const st = await persistAccounts([{ uid, accessToken, refreshToken, domain, enterpriseId, nickname }], file);
  return { file: fp, accounts: st.keys.length, updated: st.updated > 0 };
}

/** 刷新后回写：accessToken 换新的、refreshToken 可能被上游一并轮换、expiresAt 取上游 expiresIn。 */
export async function applyTokenRefresh({ uid, oldKey = "", accessToken, refreshToken = "", expiresAt = 0, domain = DOMAIN, enterpriseId = "", file } = {}) {
  if (!uid || !accessToken) return { updated: false, accounts: 0, file: null };
  const prevDocs = listAccounts();
  const prev = prevDocs.find((d) => String(d.uid) === String(uid))?.doc || {};
  const fp = writeAccountFile({
    uid,
    accessToken,
    refreshToken: refreshToken || prev?.auth?.refreshToken || "",
    expiresAt: expiresAt || 0,
    domain: prev?.auth?.domain || domain,
    enterpriseId: enterpriseId || prev?.account?.enterpriseId || "",
    nickname: prev?.account?.nickname || "",
  });
  const st = await persistAccounts([{
    uid,
    accessToken,
    refreshToken: refreshToken || prev?.auth?.refreshToken || "",
    domain: prev?.auth?.domain || domain,
    enterpriseId: enterpriseId || prev?.account?.enterpriseId || "",
  }], file);
  return { updated: Boolean(oldKey) || st.updated > 0, accounts: st.keys.length, file: fp };
}

/** 删号：扫全部候选目录，防旧副本「复活」（与国内版同纪律）。 */
export async function removeAccount(uid) {
  let removed = 0;
  for (const dir of resolveAuthDirs()) {
    const fp = join(dir, `${FILE_PREFIX}${uid}.json`);
    try { if (existsSync(fp)) { unlinkSync(fp); removed += 1; } } catch {}
  }
  const { loadProviderConfigs, saveProviderConfig } = await import("../../state.js");
  const cfg = loadProviderConfigs()?.[PROVIDER_ID] || {};
  const rawKeys = Array.isArray(cfg.keys) ? cfg.keys : [];
  const rawAuths = Array.isArray(cfg.auths) ? cfg.auths : [];
  // keys[i] ↔ auths[i] 是平行数组：**必须成对摘**。按 uid 命中时整对丢弃，
  // 否则会出现「keys 少一格、auths 少另一格」的错位串号（比留个孤儿更糟）。
  const newKeys = [];
  const newAuths = [];
  const n = Math.max(rawKeys.length, rawAuths.length);
  for (let i = 0; i < n; i++) {
    const a = rawAuths[i];
    if (a && String(a.uid) === String(uid)) continue;
    if (rawKeys[i] !== undefined) newKeys.push(rawKeys[i]);
    if (a !== undefined) newAuths.push(a);
  }
  saveProviderConfig(PROVIDER_ID, { baseUrl: cfg.baseUrl || "", keys: newKeys, auths: newAuths }, {});
  return { removed, accounts: newAuths.length };
}

export const PROVIDER_ID_FOR_STORE = PROVIDER_ID;
