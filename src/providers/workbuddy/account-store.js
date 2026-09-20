// WorkBuddy 账号落盘单一源：auths/workbuddy-<uid>.json（0600 tmp+rename）+ state.json keys/auths 按 uid 去重。
// token-auto / device-login / 刷新（服务端 saveFn 与 CLI 定时任务）共用同一实现，安全细节只维护一份。
// Note: 刷新落盘只走 applyTokenRefresh，别再各自内联一套 — 见 .agents/notes/implemented/architecture/2026-09-17-workbuddy-persist-single-seam.md
// Note: 凭据目录别再用 cwd 兜底 — 见 .agents/notes/implemented/architecture/2026-09-20-workbuddy-authdir-follows-state.md
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { isTestEnv, defaultStateFile } from "../../state/store.js";

// 凭据目录单一真相：跟着「账本」（state 文件）走 —— 默认 ~/.config/mslxdff/auths。
// 旧实现末尾兜底 `join(process.cwd(), "auths")`：在任意目录里起服务就把企业长效
// refreshToken 写进那个目录，而 .gitignore 只管自己所在的仓库 → 凭据落到不受保护的目录
// （本机实测：两个真实账号因此分居 `~/.config/mslxdff/auths` 与 `项目根/auths` 两处）。已修。
// 纯策略：写入目录的唯一目标（explicit > 测试隔离 > 「跟账本走」＝ state 文件同目录/auths）。
// 抽成纯函数是为了可测 —— `node --test` 下 isTestEnv() 恒真，环境态没法在测试里翻面。
export function authDirFor({ explicit = "", testEnv = false, stateFile } = {}) {
  if (explicit) return explicit;
  if (testEnv) return join(tmpdir(), "mslxdff-test-auths");
  return join(dirname(stateFile), "auths");
}

export function resolveAuthDir() {
  return authDirFor({
    explicit: process.env.WORKBUDDY_AUTH_DIR || "",
    testEnv: isTestEnv(),
    stateFile: defaultStateFile(),
  });
}

// 纯策略：算出读取候选目录（主位置优先，历史 cwd/auths 只读兜底，相同则去重）。
// 抽成纯函数是为了可测 —— `node --test` 下 isTestEnv() 恒真，环境态没法在测试里翻面。
export function authDirCandidates({ primary, explicit = "", testEnv = false, cwdDir = "" } = {}) {
  const dirs = [primary];
  if (!explicit && !testEnv && cwdDir && cwdDir !== primary) dirs.push(cwdDir);
  return dirs;
}

// 读取候选（迁移期兼容）：主位置优先，历史 `cwd()/auths` 只读兜底。
// 显式 WORKBUDDY_AUTH_DIR 或测试环境不兜底：既避免测试扫到真实目录，也避免重新引入 cwd 依赖。
export function resolveAuthDirs() {
  return authDirCandidates({
    primary: resolveAuthDir(),
    explicit: process.env.WORKBUDDY_AUTH_DIR || "",
    testEnv: isTestEnv(),
    cwdDir: join(process.cwd(), "auths"),
  });
}

// 按 uid 定位账号文件（主位置优先，旧位置兜底）；找不到返回 null。
export function findAccountFile(uid) {
  for (const dir of resolveAuthDirs()) {
    const fp = join(dir, `workbuddy-${uid}.json`);
    if (existsSync(fp)) return fp;
  }
  return null;
}

// 扫描账号文件（主位置先扫，同 uid 以主位置为准），返回已校验的凭证行。
// 读取侧单一真相：provider 构造、CLI 账号加载、token-auto 都走这里，别再各自 readdir 一套。
export function listAccountDocs({ dirs } = {}) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs || resolveAuthDirs()) {
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => f.startsWith("workbuddy-") && f.endsWith(".json"));
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

function jwtExp(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return 0;
    let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    return Number(JSON.parse(Buffer.from(b64, "base64").toString("utf8")).exp || 0);
  } catch {
    return 0;
  }
}

function writeAccountFile({ uid, accessToken, refreshToken = "", expiresAt = 0, domain = "www.codebuddy.cn", enterpriseId = "", nickname = "" }) {
  const authDir = resolveAuthDir();
  mkdirSync(authDir, { recursive: true });
  const exp = expiresAt || Math.floor(Date.now() / 1000) + 5184000;
  const doc = { account: { uid, enterpriseId, nickname }, auth: { accessToken, refreshToken, expiresAt: exp, domain } };
  const fp = join(authDir, `workbuddy-${uid}.json`);
  const tmp = `${fp}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  try {
    if (existsSync(fp)) unlinkSync(fp);
    renameSync(tmp, fp);
  } catch {
    writeFileSync(fp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    try { unlinkSync(tmp); } catch {} // 失败路径别把含凭据的 .tmp 留在盘上
  }
  return fp;
}

// state.json 落盘单一实现：按 uid 配对更新（存在→更新该账号行，不存在→追加）；extraKeys 为没有 auth 行的裸 key，原样保留。
async function persistAccounts(accounts, file, extraKeys = []) {
  const { loadProviderConfigs, saveProviderConfig } = await import("../../state.js");
  const cfg = (loadProviderConfigs(file ? { file } : {})?.workbuddy) || {};
  const keys = [...(Array.isArray(cfg.keys) ? cfg.keys : [])];
  const auths = [...(Array.isArray(cfg.auths) ? cfg.auths : [])];
  let updated = 0;
  for (const acc of accounts) {
    if (!acc?.uid || !acc?.accessToken) continue;
    const row = { uid: acc.uid, domain: acc.domain || "www.codebuddy.cn", enterpriseId: acc.enterpriseId || "", refreshToken: acc.refreshToken || "" };
    const atIdx = auths.findIndex((a) => a?.uid === acc.uid);
    if (atIdx >= 0) { keys[atIdx] = acc.accessToken; auths[atIdx] = row; updated += 1; }
    else { keys.push(acc.accessToken); auths.push(row); }
  }
  for (const k of extraKeys) {
    if (k && !keys.includes(k)) keys.push(k);
  }
  saveProviderConfig("workbuddy", { baseUrl: cfg.baseUrl || "https://copilot.tencent.com", keys, auths }, file ? { file } : {});
  return { keys, auths, updated };
}

export async function saveWorkbuddyAccount({ uid, enterpriseId = "", nickname = "", accessToken, refreshToken = "", expiresAt = 0, domain = "www.codebuddy.cn", file } = {}) {
  if (!uid || !accessToken) throw new Error("saveWorkbuddyAccount: 缺少 uid/accessToken");
  const fp = writeAccountFile({ uid, accessToken, refreshToken, expiresAt, domain, enterpriseId, nickname });
  const st = await persistAccounts([{ uid, accessToken, refreshToken, domain, enterpriseId }], file);
  return { file: fp, accounts: st.keys.length, updated: st.updated > 0 };
}

// 由平行数组（keys[i] ↔ authList[i]，provider 构造时即如此）还原账号列表；没有 auth 行的裸 key 走 extraKeys 原样保留。
function accountsFromArrays(keys, authList) {
  const accounts = [];
  const extraKeys = [];
  const n = Math.max(keys.length, authList.length);
  for (let i = 0; i < n; i++) {
    const a = authList[i];
    if (a && typeof a === "object" && a.uid) {
      accounts.push({ uid: a.uid, accessToken: keys[i] || "", refreshToken: a.refreshToken || "", domain: a.domain, enterpriseId: a.enterpriseId });
    } else if (keys[i]) {
      extraKeys.push(keys[i]);
    }
  }
  return { accounts, extraKeys };
}

// 刷新后的 token 落盘：keys 与 authList 是两条平行数组，按下标更新命中的槽位（旧 key 命中优先，
// 否则按 uid 命中；都没有 → 追加），再把整表经 persistAccounts 单点落 state + auths 文件。
// 服务端 saveFn 与 CLI/定时任务共用。
export async function applyTokenRefresh({ uid, oldKey, newToken, refreshToken = "", domain = "www.codebuddy.cn", enterpriseId = "", auth = null, keys = [], authList = [], file } = {}) {
  if (!uid || !newToken) return { updated: false, accounts: keys.length, file: null };
  const keyIdx = keys.indexOf(oldKey);
  const uidIdx = authList.findIndex((a) => a && String(a.uid) === String(uid));
  // 平行数组约定：命中任一侧即用该下标（keys[i] 与 authList[i] 同属一个账号，不会覆盖他人）
  const idx = keyIdx >= 0 ? keyIdx : uidIdx;
  const matched = idx >= 0;
  if (idx >= 0) keys[idx] = newToken;
  else if (!keys.includes(newToken)) keys.push(newToken);
  if (uidIdx >= 0) {
    const prev = authList[uidIdx] && typeof authList[uidIdx] === "object" ? authList[uidIdx] : null;
    authList[uidIdx] = {
      ...(prev || auth || {}),
      uid,
      domain: prev?.domain || auth?.domain || domain,
      enterpriseId: prev?.enterpriseId || auth?.enterpriseId || enterpriseId,
      refreshToken,
    };
  } else {
    authList.push({ ...(auth || {}), uid, domain: auth?.domain || domain, enterpriseId: auth?.enterpriseId || enterpriseId, refreshToken });
  }
  const fp = writeAccountFile({ uid, accessToken: newToken, refreshToken, expiresAt: jwtExp(newToken), domain, enterpriseId });
  const { accounts, extraKeys } = accountsFromArrays(keys, authList);
  const st = await persistAccounts(accounts, file, extraKeys);
  return { updated: matched, accounts: st.keys.length, file: fp };
}
