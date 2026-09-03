// 桌面端登录态定位：跨机器可用，不硬编码盘符/厂商目录名。
// 优先级：显式 file > MSLXDFF_WORKBUDDY_DESKTOP_INFO > 已知后缀快查 > 按文件名 BFS（depth≤6，多命中取 mtime 最新）。
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DESKTOP_INFO_NAME = "workbuddy-desktop.info";
const KNOWN_SUFFIX = join("CodeBuddyExtension", "Data", "Public", "auth", DESKTOP_INFO_NAME);
const MAX_DEPTH = 6;
const MAX_ENTRIES = 30000;

export function candidateRoots({ platform = process.platform, env = process.env, homedir = "" } = {}) {
  if (platform === "win32") return [env.LOCALAPPDATA, env.APPDATA].filter(Boolean);
  if (platform === "darwin") return [join(homedir, "Library", "Application Support")].filter(Boolean);
  return [join(homedir, ".config"), join(homedir, ".local", "share")].filter(Boolean);
}

function searchByName(roots) {
  const hits = [];
  let seen = 0;
  for (const root of roots) {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length && seen < MAX_ENTRIES) {
      const { dir, depth } = queue.shift();
      let names;
      try { names = readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (++seen > MAX_ENTRIES) break;
        const fp = join(dir, n);
        let st;
        try { st = statSync(fp); } catch { continue; }
        if (st.isFile() && n === DESKTOP_INFO_NAME) hits.push({ path: fp, mtimeMs: st.mtimeMs });
        else if (st.isDirectory() && depth < MAX_DEPTH) queue.push({ dir: fp, depth: depth + 1 });
      }
    }
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hits;
}

export function resolveDesktopInfoPath({ file, env = process.env, platform = process.platform, homedir = "", extraRoots = [], roots: rootsArg = null } = {}) {
  const explicit = file || env.MSLXDFF_WORKBUDDY_DESKTOP_INFO;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`桌面登录态文件不存在: ${explicit}`);
    return { path: explicit, via: explicit === file ? "file" : "env" };
  }
  const roots = rootsArg ?? [...extraRoots, ...candidateRoots({ platform, env, homedir })];
  for (const r of roots) {
    const fast = join(r, KNOWN_SUFFIX);
    if (existsSync(fast)) return { path: fast, via: "known-path" };
  }
  const hits = searchByName(roots);
  if (hits.length) return { path: hits[0].path, via: "search" };
  throw new Error(
    `找不到桌面端登录态（已搜: ${roots.join("; ") || "无可用根目录"}）。` +
    "确认桌面端已登录，或用 --file=路径 / MSLXDFF_WORKBUDDY_DESKTOP_INFO 显式指定 workbuddy-desktop.info"
  );
}

export function readDesktopAccount(fp) {
  let j;
  try {
    j = JSON.parse(readFileSync(fp, "utf8"));
  } catch (e) {
    throw new Error(`读桌面登录态失败: ${fp}（${e.message}，确认桌面端已登录）`);
  }
  if (!j?.account?.uid || !j?.auth?.accessToken) throw new Error(`桌面登录态不完整（无 uid/accessToken）: ${fp}`);
  let exp = Number(j.auth.expiresAt) || 0;
  if (exp > 1e12) exp = Math.floor(exp / 1000);
  return {
    uid: j.account.uid,
    enterpriseId: "",
    nickname: j.account.nickname || j.account.phoneNumber || "",
    accessToken: j.auth.accessToken,
    refreshToken: j.auth.refreshToken || "",
    expiresAt: exp,
    domain: j.auth.domain || "www.codebuddy.cn",
  };
}
