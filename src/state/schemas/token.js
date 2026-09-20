import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { defaultStateFile, tokenFile, generateToken, readState, writeStateImmediate, getEntry } from "../store.js";
import { fmtShanghaiYMDHMS } from "../../time.js";

// 主 Bearer token 镜像落盘：0600 + 显式 chmod。
// 注意 writeFileSync 的 mode 只在“新建文件”时生效，已存在的文件权限不会被它改；
// 升级前生成的老文件会永远停在 0644（同机其他用户可读），所以必须再 chmod 一次兜住。
function syncTokenFile(token, file) {
  try {
    const tf = tokenFile(file);
    mkdirSync(dirname(tf), { recursive: true });
    writeFileSync(tf, String(token || "").trim() + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(tf, 0o600); } catch {}
  } catch {}
}

export async function loadToken({ file = defaultStateFile() } = {}) {
  const state = readState(file);
  if (typeof state.token === "string" && state.token.length > 0) {
    syncTokenFile(state.token, file);
    return { token: state.token, created: false };
  }
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (typeof raw.token === "string" && raw.token.length > 0) {
        syncTokenFile(raw.token, file);
        const e = getEntry(file);
        e.data = raw;
        try { e.mtimeMs = statSync(file).mtimeMs; } catch {}
        return { token: raw.token, created: false };
      }
    } catch {}
  }
  const tok = generateToken();
  const saved = writeStateImmediate(file, { token: tok, createdAt: fmtShanghaiYMDHMS(new Date()) }).token;
  syncTokenFile(saved, file);
  return { token: saved, created: true };
}

export async function refreshToken({ file = defaultStateFile() } = {}) {
  const tok = writeStateImmediate(file, { token: generateToken(), createdAt: fmtShanghaiYMDHMS(new Date()) }).token;
  syncTokenFile(tok, file);
  return tok;
}

export { generateToken, tokenFile };
