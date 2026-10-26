// todaycn 账号落盘单一源：auths/todaycn-<uid>.json（0600，tmp+rename）与 state.providerConfigs.todaycn.keys 同步。
// 号 = refreshCredential（实测不轮换，可长期复用）；uid/name/deviceId 只进账号文档，
// 不进 providerConfigs —— 规避「providerConfig 重建路径静默丢字段」的既有故障类（对齐 zcode 的 deviceMid 处理）。

import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { isTestEnv, defaultStateFile } from "../../state/store.js";

const ACCOUNT_PREFIX = "todaycn-";
const PROVIDER = "todayai";

export function todaycnAuthDir({ explicit = "", testEnv = false, stateFile } = {}) {
  if (explicit) return explicit;
  if (testEnv) return join(tmpdir(), "mslxdff-test-auths");
  return join(dirname(stateFile), "auths");
}

export function resolveTodaycnAuthDir() {
  return todaycnAuthDir({
    explicit: process.env.MSLXDFF_TODAYCN_AUTH_DIR || "",
    testEnv: isTestEnv(),
    stateFile: defaultStateFile(),
  });
}

/** 只读兜底：账本旁 auths/ 为主，cwd/auths 为辅（旧副本不复活靠 remove 扫全部，见下）。 */
export function resolveTodaycnAuthDirs() {
  const primary = resolveTodaycnAuthDir();
  const cwdDir = join(process.cwd(), "auths");
  return primary === cwdDir ? [primary] : [primary, cwdDir];
}

function accountFilePath(uid, dir) {
  return join(dir, `${ACCOUNT_PREFIX}${uid}.json`);
}

/** 列出全部落盘账号（去重按 uid，文件损坏即跳过）。 */
export function listTodaycnAccountDocs({ dirs } = {}) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs || resolveTodaycnAuthDirs()) {
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => f.startsWith(ACCOUNT_PREFIX) && f.endsWith(".json"));
    } catch { continue; }
    for (const f of files) {
      try {
        const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const uid = doc?.account?.uid;
        const cred = doc?.auth?.refreshCredential;
        if (!uid || !cred) continue;
        if (seen.has(String(uid))) continue;
        seen.add(String(uid));
        out.push({
          uid: String(uid),
          refreshCredential: String(cred),
          name: String(doc?.account?.name || ""),
          email: String(doc?.account?.email || ""),
          deviceId: String(doc?.auth?.deviceId || ""),
          optionId: String(doc?.auth?.optionId || ""),
          file: join(dir, f),
          dir,
          doc,
        });
      } catch {}
    }
  }
  return out;
}

export function readTodaycnAccountDoc(uid, { dir = resolveTodaycnAuthDir() } = {}) {
  try { return JSON.parse(readFileSync(accountFilePath(uid, dir), "utf8")); } catch { return null; }
}

export function writeTodaycnAccountFile({ uid, refreshCredential, name = "", email = "", deviceId = "", optionId = "" }, { dir = resolveTodaycnAuthDir() } = {}) {
  if (!uid || !refreshCredential) throw new Error("writeTodaycnAccountFile: 缺少 uid/refreshCredential");
  mkdirSync(dir, { recursive: true });
  const doc = { account: { uid, name, email }, auth: { provider: PROVIDER, refreshCredential, deviceId, optionId } };
  const fp = accountFilePath(uid, dir);
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

/** 落盘 + 同步 providerConfigs.keys（只增不减；spread cur 保留 allowlist/allowAnyModels 等既有字段）。 */
export async function saveTodaycnAccount({ uid, refreshCredential, name = "", email = "", deviceId = "", optionId = "", dir, file } = {}) {
  if (!uid || !refreshCredential) throw new Error("saveTodaycnAccount: 缺少 uid/refreshCredential");
  const targetDir = dir || resolveTodaycnAuthDir();
  const existing = readTodaycnAccountDoc(uid, { dir: targetDir });
  const fp = writeTodaycnAccountFile(
    {
      uid,
      refreshCredential,
      name: name || String(existing?.account?.name || ""),
      email: email || String(existing?.account?.email || ""),
      deviceId: deviceId || String(existing?.auth?.deviceId || ""),
      optionId: optionId || String(existing?.auth?.optionId || ""),
    },
    { dir: targetDir },
  );
  const { loadProviderConfig, saveProviderConfig } = await import("../../state.js");
  const opts = file ? { file } : {};
  const cur = loadProviderConfig("todaycn", opts) || {};
  const keys = [...new Set([...(Array.isArray(cur.keys) ? cur.keys : []), refreshCredential])];
  saveProviderConfig("todaycn", { ...cur, keys }, opts);
  return { file: fp, keys: keys.length, updated: Boolean(existing) };
}

/** 删号：扫全部候选目录（防旧副本复活），并从 providerConfigs.keys 摘掉该号。 */
export async function removeTodaycnAccount({ uid, refreshCredential = "", dirs, file } = {}) {
  const removed = [];
  for (const dir of dirs || resolveTodaycnAuthDirs()) {
    const docs = [];
    try {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.startsWith(ACCOUNT_PREFIX) && x.endsWith(".json"))) {
        try {
          const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
          if (uid && String(doc?.account?.uid) !== String(uid)) continue;
          if (!uid && refreshCredential && String(doc?.auth?.refreshCredential) !== refreshCredential) continue;
          docs.push({ f, cred: String(doc?.auth?.refreshCredential || "") });
        } catch {}
      }
    } catch { continue; }
    for (const d of docs) {
      try { unlinkSync(join(dir, d.f)); removed.push({ file: join(dir, d.f), refreshCredential: d.cred }); } catch {}
    }
  }
  if (removed.length) {
    const { loadProviderConfig, saveProviderConfig } = await import("../../state.js");
    const opts = file ? { file } : {};
    const cur = loadProviderConfig("todaycn", opts) || {};
    const drop = new Set(removed.map((r) => r.refreshCredential).filter(Boolean));
    const keys = (Array.isArray(cur.keys) ? cur.keys : []).filter((k) => !drop.has(String(k)));
    saveProviderConfig("todaycn", { ...cur, keys }, opts);
  }
  return { removed };
}

/** 记「号↔模型位」绑定：账号级设置的本地事实缓存，供选路与状态展示；失败静默，不影响请求。 */
export async function setTodaycnAccountOption({ uid, optionId, dir } = {}) {
  if (!uid || !optionId) return { ok: false, reason: "缺少 uid/optionId" };
  const targetDir = dir || resolveTodaycnAuthDir();
  const doc = readTodaycnAccountDoc(uid, { dir: targetDir });
  const cred = String(doc?.auth?.refreshCredential || "");
  if (!cred) return { ok: false, reason: "账号文档不存在" };
  writeTodaycnAccountFile(
    {
      uid,
      refreshCredential: cred,
      name: String(doc?.account?.name || ""),
      email: String(doc?.account?.email || ""),
      deviceId: String(doc?.auth?.deviceId || ""),
      optionId: String(optionId),
    },
    { dir: targetDir },
  );
  return { ok: true, optionId: String(optionId) };
}