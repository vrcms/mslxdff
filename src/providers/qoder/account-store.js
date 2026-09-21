// qoder 账号落盘单一源：auths/qoder-<uid>.json（0600 tmp+rename）+ state.json providerConfigs.qoder keys/auths 按 uid 去重。
// 凭证形状对齐 qoder2api：secret = {"device_token":"dt-xxx","refresh_token":"drt-xxx"}，region 进 auth 行。
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { isTestEnv, defaultStateFile } from "../../state/store.js";
import { normalizeRegion } from "./constants.js";

export function authDirFor({ explicit = "", testEnv = false, stateFile } = {}) {
  if (explicit) return explicit;
  if (testEnv) return join(tmpdir(), "mslxdff-test-auths");
  return join(dirname(stateFile), "auths");
}

export function resolveAuthDir() {
  return authDirFor({
    explicit: process.env.QODER_AUTH_DIR || "",
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
      files = readdirSync(dir).filter((f) => f.startsWith("qoder-") && f.endsWith(".json"));
    } catch { continue; }
    for (const f of files) {
      try {
        const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const uid = doc?.account?.uid;
        if (!uid || !doc?.auth?.deviceToken) continue;
        if (seen.has(String(uid))) continue;
        seen.add(String(uid));
        out.push({ uid: String(uid), file: join(dir, f), dir, doc });
      } catch {}
    }
  }
  return out;
}

function writeAccountFile({ uid, deviceToken, refreshToken = "", region = "global", name = "", email = "", userType = "personal_standard", organizationId = "", organizationName = "" }) {
  const authDir = resolveAuthDir();
  mkdirSync(authDir, { recursive: true });
  const doc = {
    account: { uid, name, email, userType, organizationId, organizationName },
    auth: { deviceToken, refreshToken, region: normalizeRegion(region) },
  };
  const fp = join(authDir, `qoder-${uid}.json`);
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

// state 落盘：key 存 JSON blob（对齐 qoder2api ParseOAuthSecret 形状），auths 存 uid 索引行。
async function persistAccounts(accounts, file) {
  const { loadProviderConfigs, saveProviderConfig } = await import("../../state.js");
  const cfg = (loadProviderConfigs(file ? { file } : {})?.qoder) || {};
  const keys = [...(Array.isArray(cfg.keys) ? cfg.keys : [])];
  const auths = [...(Array.isArray(cfg.auths) ? cfg.auths : [])];
  let updated = 0;
  for (const acc of accounts) {
    if (!acc?.uid || !acc?.deviceToken) continue;
    const blob = JSON.stringify({ device_token: acc.deviceToken, refresh_token: acc.refreshToken || "" });
    const row = { uid: acc.uid, domain: acc.domain || "qoder.com", region: normalizeRegion(acc.region), name: acc.name || "", refreshToken: acc.refreshToken || "" };
    const idx = auths.findIndex((a) => a?.uid === acc.uid);
    if (idx >= 0) { keys[idx] = blob; auths[idx] = row; updated += 1; }
    else { keys.push(blob); auths.push(row); }
  }
  saveProviderConfig("qoder", { baseUrl: cfg.baseUrl || "", keys, auths }, file ? { file } : {});
  return { keys, auths, updated };
}

export async function saveQoderAccount({ uid, deviceToken, refreshToken = "", region = "global", name = "", email = "", userType = "personal_standard", organizationId = "", organizationName = "", domain = "qoder.com", file } = {}) {
  if (!uid || !deviceToken) throw new Error("saveQoderAccount: 缺少 uid/deviceToken");
  const fp = writeAccountFile({ uid, deviceToken, refreshToken, region, name, email, userType, organizationId, organizationName });
  const st = await persistAccounts([{ uid, deviceToken, refreshToken, region, name, domain }], file);
  return { file: fp, accounts: st.keys.length, updated: st.updated > 0 };
}

// 重建 provider 的行级 auth：由 keys[i] blob + auths[i] 还原 deviceToken。
export function accountFromBlob(blob) {
  try {
    const j = JSON.parse(String(blob || "{}"));
    return { deviceToken: String(j.device_token || ""), refreshToken: String(j.refresh_token || "") };
  } catch {
    return null;
  }
}