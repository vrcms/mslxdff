// raccoon 账号落盘单一源：auths/raccoon-<uid>.json（0600 tmp+rename）+ state.json providerConfigs.raccoon.keys 同步。
// office_identity 与 device_id（per-account 持久 UUID）随账号文档走，**不进 providerConfigs**——
// 规避 providerConfig 重建路径（allowlist/baseUrl 写回）静默丢字段的既有故障类（与 zcode 同款理由）。
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { uuid } from "../../compat.js";
import { isTestEnv, defaultStateFile } from "../../state/store.js";

export function raccoonAuthDir({ explicit = "", testEnv = false, stateFile } = {}) {
  if (explicit) return explicit;
  if (testEnv) return join(tmpdir(), "mslxdff-test-auths");
  return join(dirname(stateFile), "auths");
}

export function resolveRaccoonAuthDir() {
  return raccoonAuthDir({
    explicit: process.env.MSLXDFF_RACCOON_AUTH_DIR || "",
    testEnv: isTestEnv(),
    stateFile: defaultStateFile(),
  });
}

/** 主目录 + 历史遗留 cwd/auths（只读兜底，防旧副本「复活」）。 */
export function resolveRaccoonAuthDirs() {
  const primary = resolveRaccoonAuthDir();
  const cwdDir = join(process.cwd(), "auths");
  return primary === cwdDir ? [primary] : [primary, cwdDir];
}

/** 列出全部落盘账号（同 uid 主位置优先），跳过无 access_token 的残档。 */
export function listRaccoonAccountDocs({ dirs } = {}) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs || resolveRaccoonAuthDirs()) {
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => f.startsWith("raccoon-") && f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const uid = doc?.account?.uid;
        const token = doc?.auth?.access_token;
        if (!uid || !token) continue;
        if (seen.has(String(uid))) continue;
        seen.add(String(uid));
        out.push({
          uid: String(uid),
          accessToken: String(token),
          refreshToken: String(doc.auth.refresh_token || ""),
          expiresAt: String(doc.auth.expires_at || ""),
          officeIdentity: String(doc.auth.office_identity || ""),
          deviceId: String(doc.auth.device_id || ""),
          name: String(doc.account.name || ""),
          phone: String(doc.account.phone || ""),
          file: join(dir, f),
          dir,
          doc,
        });
      } catch {}
    }
  }
  return out;
}

function accountFilePath(uid, dir) {
  return join(dir, `raccoon-${uid}.json`);
}

export function writeRaccoonAccountFile(
  { uid, accessToken, refreshToken = "", expiresAt = "", officeIdentity = "", deviceId = "", name = "", phone = "" },
  { dir = resolveRaccoonAuthDir() } = {},
) {
  mkdirSync(dir, { recursive: true });
  const doc = {
    account: { uid, name, phone },
    auth: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      office_identity: officeIdentity,
      device_id: deviceId,
    },
  };
  const fp = accountFilePath(uid, dir);
  const tmp = `${fp}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`; // 唯一名：防并发写（daemon 续期 vs CLI login）互相踩
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  try {
    if (existsSync(fp)) {
      try { chmodSync(fp, 0o600); } catch {}
      unlinkSync(fp);
    }
    renameSync(tmp, fp);
  } catch {
    // 兜底也走「唯一 tmp + rename」，绝不直写正式文件（直写非原子，并发读者会读到半截 JSON → 该号静默消失）
    try { const t2 = `${fp}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`; writeFileSync(t2, JSON.stringify(doc, null, 2), { mode: 0o600 }); if (existsSync(fp)) unlinkSync(fp); renameSync(t2, fp); } catch {}
    try { unlinkSync(tmp); } catch {}
  }
  try { chmodSync(fp, 0o600); } catch {} // mode 只在新建成时生效，存量必须补 chmod
  return fp;
}

export function readRaccoonAccountDoc(uid, { dir = resolveRaccoonAuthDir() } = {}) {
  try {
    return JSON.parse(readFileSync(accountFilePath(uid, dir), "utf8"));
  } catch {
    return null;
  }
}

/** 落盘账号文档并同步 state 的 keys；已有 device_id 时复用，不覆盖。 */
export async function saveRaccoonAccount({
  uid,
  accessToken,
  refreshToken = "",
  expiresAt = "",
  officeIdentity = "",
  deviceId = "",
  name = "",
  phone = "",
  dir,
  file,
} = {}) {
  if (!uid || !accessToken) throw new Error("saveRaccoonAccount: 缺少 uid/accessToken");
  const targetDir = dir || resolveRaccoonAuthDir();
  const existing = readRaccoonAccountDoc(uid, { dir: targetDir });
  const device = deviceId || existing?.auth?.device_id || uuid();
  const fp = writeRaccoonAccountFile(
    { uid, accessToken, refreshToken, expiresAt, officeIdentity, deviceId: device, name, phone },
    { dir: targetDir },
  );

  const { loadProviderConfig, saveProviderConfig } = await import("../../state.js");
  const cur = loadProviderConfig("raccoon", file ? { file } : {}) || {};
  const keys = [...new Set([...(Array.isArray(cur.keys) ? cur.keys : []), accessToken])];
  // spread cur：保留 allowlist/allowAnyModels 等既有字段，绝不 `{keys}` 重建
  saveProviderConfig("raccoon", { ...cur, keys }, file ? { file } : {});
  return { file: fp, keys: keys.length, updated: Boolean(existing) };
}

/** device_id：账号文档内持久复用；缺失且已有 token 时生成并写回。 */
export function ensureRaccoonDeviceId({ uid, dir } = {}) {
  if (!uid) return "";
  const targetDir = dir || resolveRaccoonAuthDir();
  const doc = readRaccoonAccountDoc(uid, { dir: targetDir });
  const cur = String(doc?.auth?.device_id || "").trim();
  if (cur) return cur;
  const device = uuid();
  if (doc?.auth?.access_token) {
    writeRaccoonAccountFile(
      {
        uid,
        accessToken: doc.auth.access_token,
        refreshToken: doc.auth?.refresh_token || "",
        expiresAt: doc.auth?.expires_at || "",
        officeIdentity: doc.auth?.office_identity || "",
        deviceId: device,
        name: doc.account?.name || "",
        phone: doc.account?.phone || "",
      },
      { dir: targetDir },
    );
  }
  return device;
}

/** 续期结果回写（refresh 可能不返回新 refresh_token，不能覆盖成空串）。 */
export function applyRaccoonRefresh(existing, { accessToken, refreshToken, expiresAt }) {
  return {
    ...existing,
    access_token: accessToken,
    refresh_token: refreshToken && refreshToken.length > 0 ? refreshToken : existing.refresh_token,
    expires_at: expiresAt || existing.expires_at || "",
  };
}
