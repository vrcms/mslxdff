// zcode 账号落盘单一源：auths/zcode-<uid>.json（0600 tmp+rename）+ state.json providerConfigs.zcode.keys 同步。
// deviceMid（per-account 持久 UUID，对齐 zcode-switch 实证）随账号文档走，不进 providerConfigs，
// 规避 providerConfig 重建路径静默丢字段的既有故障类。
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { uuid } from "../../compat.js";
import { isTestEnv, defaultStateFile } from "../../state/store.js";

export function zcodeAuthDir({ explicit = "", testEnv = false, stateFile } = {}) {
  if (explicit) return explicit;
  if (testEnv) return join(tmpdir(), "mslxdff-test-auths");
  return join(dirname(stateFile), "auths");
}

export function resolveZcodeAuthDir() {
  return zcodeAuthDir({
    explicit: process.env.MSLXDFF_ZCODE_AUTH_DIR || "",
    testEnv: isTestEnv(),
    stateFile: defaultStateFile(),
  });
}

export function resolveZcodeAuthDirs() {
  const primary = resolveZcodeAuthDir();
  const cwdDir = join(process.cwd(), "auths");
  return primary === cwdDir ? [primary] : [primary, cwdDir];
}

export function listZcodeAccountDocs({ dirs } = {}) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs || resolveZcodeAuthDirs()) {
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => f.startsWith("zcode-") && f.endsWith(".json"));
    } catch { continue; }
    for (const f of files) {
      try {
        const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const uid = doc?.account?.uid;
        if (!uid || !doc?.auth?.jwt) continue;
        if (seen.has(String(uid))) continue;
        seen.add(String(uid));
        out.push({
          uid: String(uid),
          jwt: String(doc.auth.jwt),
          deviceMid: String(doc.auth.deviceMid || ""),
          name: String(doc.account.name || ""),
          email: String(doc.account.email || ""),
          provider: String(doc.auth.provider || ""),
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
  return join(dir, `zcode-${uid}.json`);
}

export function writeZcodeAccountFile({ uid, jwt, name = "", email = "", provider = "zai", deviceMid = "" }, { dir = resolveZcodeAuthDir() } = {}) {
  mkdirSync(dir, { recursive: true });
  const doc = { account: { uid, name, email }, auth: { jwt, provider, deviceMid } };
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

export function readZcodeAccountDoc(uid, { dir = resolveZcodeAuthDir() } = {}) {
  try {
    return JSON.parse(readFileSync(accountFilePath(uid, dir), "utf8"));
  } catch {
    return null;
  }
}

export async function saveZcodeAccount({ uid, jwt, name = "", email = "", provider = "zai", deviceMid = "", dir, file } = {}) {
  if (!uid || !jwt) throw new Error("saveZcodeAccount: 缺少 uid/jwt");
  const targetDir = dir || resolveZcodeAuthDir();
  const existing = readZcodeAccountDoc(uid, { dir: targetDir });
  const mid = deviceMid || existing?.auth?.deviceMid || uuid();
  const fp = writeZcodeAccountFile({ uid, jwt, name, email, provider, deviceMid: mid }, { dir: targetDir });

  const { loadProviderConfig, saveProviderConfig } = await import("../../state.js");
  const cur = loadProviderConfig("zcode", file ? { file } : {}) || {};
  const keys = [...new Set([...(Array.isArray(cur.keys) ? cur.keys : []), jwt])];
  // spread cur：保留 allowlist/allowAnyModels/baseUrl 等既有字段，不做 `{keys}` 重建
  saveProviderConfig("zcode", { ...cur, keys }, file ? { file } : {});
  return { file: fp, keys: keys.length, updated: Boolean(existing) };
}

// deviceMid：账号文档内持久复用；缺失时生成 UUID 并写回（文档不存在或尚无 jwt 时只返回不落盘）。
export function ensureZcodeDeviceMid({ uid, dir } = {}) {
  if (!uid) return "";
  const targetDir = dir || resolveZcodeAuthDir();
  const doc = readZcodeAccountDoc(uid, { dir: targetDir });
  const cur = String(doc?.auth?.deviceMid || "").trim();
  if (cur) return cur;
  const mid = uuid();
  if (doc?.auth?.jwt) {
    writeZcodeAccountFile(
      {
        uid,
        jwt: doc.auth.jwt,
        name: doc.account?.name || "",
        email: doc.account?.email || "",
        provider: doc.auth?.provider || "zai",
        deviceMid: mid,
      },
      { dir: targetDir },
    );
  }
  return mid;
}
