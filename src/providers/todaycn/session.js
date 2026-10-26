// todaycn 本机登录态导入（Windows/DPAPI 专用）：Local State → DPAPI(os_crypt.encrypted_key)
// → AES-256-GCM(v10 信封) → account-credentials.slot-{a,b} → { uid, refreshCredential }。
// 只读客户端文件，绝不写回；非 Windows 平台无 DPAPI，返回 ok:false 并指引手填。
//
// 弹窗教训（对齐 src/providers/curl-fetch.js）：daemon 是无控制台后台进程，spawn **必须** windowsHide，
// 否则每次导入都弹一个 powershell 控制台窗口。

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createDecipheriv } from "node:crypto";
import { join } from "node:path";
import { TODAYCN_DESKTOP_DIR_ENV } from "./const.js";

const SLOTS = ["account-credentials.slot-b", "account-credentials.slot-a"];
const V10_MAGIC = "v10";
const NONCE_LEN = 12;
const TAG_LEN = 16;

/** 候选数据目录：显式 env > 平台默认（Windows %APPDATA%/Today CN）。 */
export function todaycnDesktopDirs({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const explicit = String(env[TODAYCN_DESKTOP_DIR_ENV] || "").trim();
  if (explicit) return [explicit];
  if (platform === "win32") {
    const out = [];
    if (env.APPDATA) out.push(join(env.APPDATA, "Today CN"));
    out.push(join(home, "AppData", "Roaming", "Today CN"));
    return [...new Set(out)];
  }
  if (platform === "darwin") return [join(home, "Library", "Application Support", "Today CN")];
  return [join(home, ".config", "Today CN")];
}

/** 命中第一个带 Local State 的目录；无则空串。 */
export function findTodaycnDesktopDir(opts) {
  for (const dir of todaycnDesktopDirs(opts)) {
    try { if (existsSync(join(dir, "Local State"))) return dir; } catch {}
  }
  return "";
}

/** DPAPI 解封：base64 进 / base64 出，不落临时文件（命令行长度足够，encrypted_key 约 200 字符）。 */
export function dpapiUnprotect(b64) {
  const cmd =
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
    `$b=[Convert]::FromBase64String('${b64}');` +
    "$k=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,1);" +
    "[Convert]::ToBase64String($k)";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    windowsHide: true,
    timeout: 15_000,
    encoding: "utf8",
  });
  return Buffer.from(String(out).trim(), "base64");
}

/** AES-256-GCM 密钥：Local State 的 os_crypt.encrypted_key（DPAPI 前缀 5 字节需剥）。 */
export function todaycnAesKey(dir) {
  const ls = JSON.parse(readFileSync(join(dir, "Local State"), "utf8"));
  const enc = Buffer.from(ls?.os_crypt?.encrypted_key || "", "base64");
  if (!enc.length) throw new Error("Local State 缺 os_crypt.encrypted_key");
  const head = enc.subarray(0, 5).toString("latin1");
  const dpapi = head === "DPAPI" ? enc.subarray(5) : enc;
  return dpapiUnprotect(dpapi.toString("base64"));
}

/** v10 信封：3 字节前缀 + 12 字节 nonce + 密文 + 16 字节 tag。 */
export function decryptV10(key, blob) {
  if (blob.subarray(0, 3).toString("latin1") !== V10_MAGIC) throw new Error("非 v10 信封");
  const nonce = blob.subarray(3, 3 + NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(3 + NONCE_LEN, blob.length - TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/**
 * 读本机登录态。返回 { ok, uid, name, email, refreshCredential, dir } 或 { ok:false, reason }。
 * 不抛异常：调用方（CLI login / provider 装配）需要拿到人话原因。
 */
export function readTodaycnDesktopSession({ dir, platform = process.platform } = {}) {
  const root = dir || findTodaycnDesktopDir();
  if (!root) return { ok: false, reason: "未找到本机 Today 客户端数据目录（没装或没登录过）" };
  if (platform !== "win32") {
    return { ok: false, reason: "本机登录态解密目前仅支持 Windows（DPAPI）；其它平台请用 -provider todaycn login --refresh <串> 手填" };
  }
  let key = null;
  try { key = todaycnAesKey(root); } catch (e) { return { ok: false, reason: `取密钥失败：${String(e?.message || e).slice(0, 160)}` }; }
  for (const slot of SLOTS) {
    try {
      const raw = readFileSync(join(root, slot));
      const rec = JSON.parse(decryptV10(key, raw).toString("utf8"))?.record;
      if (rec?.environment === "prod" && rec.refreshCredential) {
        return {
          ok: true,
          dir: root,
          uid: String(rec?.user?.id || ""),
          name: String(rec?.user?.displayName || ""),
          email: String(rec?.user?.email || ""),
          refreshCredential: String(rec.refreshCredential),
        };
      }
    } catch {}
  }
  return { ok: false, reason: "slot-a/b 里没有 prod 登录记录（先在桌面客户端登录一次）" };
}