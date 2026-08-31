import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { defaultStateFile, tokenFile, generateToken, readState, writeStateImmediate, getEntry } from "../store.js";
import { fmtShanghaiYMDHMS } from "../../time.js";

function syncTokenFile(token, file) {
  try {
    const tf = tokenFile(file);
    mkdirSync(dirname(tf), { recursive: true });
    writeFileSync(tf, String(token || "").trim() + "\n", "utf8");
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
