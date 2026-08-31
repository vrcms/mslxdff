import { joinUrl } from "../base.js";
import { WORKBUDDY_DEFAULT_BASE_URL } from "../../state/schemas/provider.js";

export function decodeJwtExp(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return 0;
    let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return Number(json.exp || 0);
  } catch {
    return 0;
  }
}

export function isInsufficientStatus(status, bodyText, cached) {
  if (cached && Number(cached.total) === 0) return true;
  if (status === 402) return true;
  if (status === 403 || status === 429) {
    const t = String(bodyText || "").toLowerCase();
    if (t.includes("insufficient") || t.includes("quota") || t.includes("balance") || t.includes("credit") || t.includes("exhaust") || t.includes("402") || t.includes("10002") || t.includes("10003")) return true;
  }
  return false;
}

export function isAuthError(status, bodyText) {
  if (status === 401 || status === 403) return true;
  const t = String(bodyText || "").toLowerCase();
  if (t.includes("unauthorized") || t.includes("authenticate") || t.includes("invalid token") || t.includes("token expired") || t.includes("token invalid") || t.includes("access token") || t.includes("login expired") || t.includes("need login") || t.includes("session expired")) return true;
  if (t.includes("code") && (t.includes("401") || t.includes("403")) && t.includes("token")) return true;
  if (status === 400 && t.includes("token")) return true;
  return false;
}

export function createAuthService({
  baseUrl,
  fetchImpl,
  clock = Date.now,
  dispatcher,
  file,
  store, // optional { saveProviderConfig, keysRef, authListRef } or custom saveFn
  saveFn,
} = {}) {
  const resolvedBase = baseUrl ? String(baseUrl).trim().replace(/\/+$/, "") : WORKBUDDY_DEFAULT_BASE_URL;
  if (!fetchImpl) {
    try {
      const { getUndici } = awaitImportUndici();
      fetchImpl = getUndici()?.UndiciFetch || fetch;
    } catch {
      fetchImpl = fetch;
    }
  }
  // lazy resolve UndiciFetch if not provided
  if (!fetchImpl) fetchImpl = fetch;

  const inflightRefresh = new Map();

  async function refreshTokenFor(key, auth) {
    const rt = auth?.refreshToken;
    const uid = auth?.uid;
    if (!rt || !uid) return null;
    const dedupKey = String(uid);
    if (inflightRefresh.has(dedupKey)) {
      try { return await inflightRefresh.get(dedupKey); } catch { return null; }
    }
    const p = (async () => {
      const url = joinUrl(resolvedBase, "/v2/plugin/auth/token/refresh");
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "X-Refresh-Token": rt,
        "X-User-Id": uid,
        "X-Domain": auth.domain || "www.codebuddy.cn",
        "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
        Origin: "https://www.codebuddy.cn",
        Referer: "https://www.codebuddy.cn/",
      };
      try {
        const opts = { method: "POST", headers, body: "{}" };
        if (dispatcher) opts.dispatcher = dispatcher;
        const res = await fetchImpl(url, opts);
        const text = await res.text();
        let j;
        try { j = JSON.parse(text); } catch { return null; }
        if (j.code === 0 && j.data?.accessToken) {
          const newAt = j.data.accessToken;
          const newRt = j.data.refreshToken || rt;
          // attempt to persist if store provided
          try {
            if (saveFn) {
              await saveFn({ newAt, newRt, uid, oldKey: key, auth });
            } else if (store && typeof store.save === "function") {
              await store.save({ newAt, newRt, uid, oldKey: key, auth });
            } else if (store && Array.isArray(store.keys) && Array.isArray(store.authList)) {
              // direct mutation fallback (legacy shape)
              const idx = store.keys.indexOf(key);
              if (idx >= 0) {
                store.keys[idx] = newAt;
                store.authList[idx] = { ...auth, refreshToken: newRt };
                try {
                  const { saveProviderConfig } = await import("../../state.js");
                  saveProviderConfig("workbuddy", { baseUrl: resolvedBase, keys: [...store.keys], auths: [...store.authList] }, file ? { file } : {});
                } catch {}
                try {
                  const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
                  const { join, dirname } = await import("node:path");
                  const { tmpdir } = await import("node:os");
                  const isTest = process.env.NODE_ENV === "test" || (process.env.MSLXDFF_STATE_FILE && String(process.env.MSLXDFF_STATE_FILE).includes("mslxdff-test"));
                  const authDir = process.env.WORKBUDDY_AUTH_DIR || (isTest ? join(tmpdir(), "mslxdff-test-auths") : (file && String(file).includes("mslxdff-") ? join(dirname(String(file)), "auths") : join(process.cwd(), "auths")));
                  mkdirSync(authDir, { recursive: true });
                  const expAt = (() => { try { return JSON.parse(Buffer.from(newAt.split(".")[1], "base64").toString()).exp; } catch { return Math.floor(Date.now() / 1000) + 5184000; } })();
                  const doc = { account: { uid, enterpriseId: auth.enterpriseId || "", nickname: "" }, auth: { accessToken: newAt, refreshToken: newRt, expiresAt: expAt, domain: auth.domain || "www.codebuddy.cn" } };
                  const fp = join(authDir, `workbuddy-${uid}.json`);
                  const tmp = fp + ".tmp";
                  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
                  try {
                    if (existsSync(fp)) {
                      const { unlinkSync, renameSync } = await import("node:fs");
                      unlinkSync(fp);
                      renameSync(tmp, fp);
                    } else {
                      const { renameSync } = await import("node:fs");
                      renameSync(tmp, fp);
                    }
                  } catch {
                    writeFileSync(fp, JSON.stringify(doc, null, 2), { mode: 0o600 });
                  }
                } catch {}
              }
            }
          } catch {}
          return newAt;
        }
      } catch {}
      return null;
    })();
    inflightRefresh.set(dedupKey, p);
    try {
      const r = await p;
      return r;
    } finally {
      inflightRefresh.delete(dedupKey);
    }
  }

  function maybeProactiveRefresh(auth, key) {
    try {
      const exp = decodeJwtExp(key);
      if (!exp) return;
      const remain = exp * 1000 - clock();
      if (remain < 5 * 60 * 1000 && remain > -60 * 60 * 1000) {
        void refreshTokenFor(key, auth).catch(() => {});
      }
    } catch {}
  }

  return { refreshTokenFor, maybeProactiveRefresh, decodeJwtExp, isAuthError, isInsufficientStatus, _inflight: inflightRefresh };
}

function awaitImportUndici() {
  try {
    // dynamic to avoid top-level await
    let UndiciFetch = null;
    try {
      // eslint-disable-next-line no-undef
      const mod = globalThis.__mslxdff_undici || null;
      if (mod) return mod;
    } catch {}
    return { UndiciFetch: null };
  } catch {
    return { UndiciFetch: null };
  }
}
