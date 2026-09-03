// WorkBuddy 账号落盘：auths/workbuddy-<uid>.json（0600 tmp+rename）+ state.json keys/auths 按 uid 去重追加。
// token-auto 与 device-login 共用，保证两种入口写出完全一致。
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

export function resolveAuthDir() {
  if (process.env.WORKBUDDY_AUTH_DIR) return process.env.WORKBUDDY_AUTH_DIR;
  const sf = process.env.MSLXDFF_STATE_FILE || "";
  if (sf.includes("mslxdff-test") || process.env.NODE_ENV === "test") return join(tmpdir(), "mslxdff-test-auths");
  if (sf && sf.includes("mslxdff-")) return join(dirname(sf), "auths");
  return join(process.cwd(), "auths");
}

export async function saveWorkbuddyAccount({ uid, enterpriseId = "", nickname = "", accessToken, refreshToken = "", expiresAt = 0, domain = "www.codebuddy.cn", file } = {}) {
  if (!uid || !accessToken) throw new Error("saveWorkbuddyAccount: 缺少 uid/accessToken");
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
  }
  // 同步 state（对话轮换只读 state）
  const { loadProviderConfigs, saveProviderConfig } = await import("../../state.js");
  const cfg = (loadProviderConfigs(file ? { file } : {})?.workbuddy) || {};
  const keys = [...(Array.isArray(cfg.keys) ? cfg.keys : [])];
  const auths = [...(Array.isArray(cfg.auths) ? cfg.auths : [])];
  const row = { uid, domain, enterpriseId, refreshToken };
  const atIdx = auths.findIndex((a) => a?.uid === uid);
  if (atIdx >= 0) { keys[atIdx] = accessToken; auths[atIdx] = row; }
  else { keys.push(accessToken); auths.push(row); }
  saveProviderConfig("workbuddy", { baseUrl: cfg.baseUrl || "https://copilot.tencent.com", keys, auths }, file ? { file } : {});
  return { file: fp, accounts: keys.length, updated: atIdx >= 0 };
}
