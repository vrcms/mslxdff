import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

export function workbuddyModelsPath() {
  const env = process.env.WORKBUDDY_MODELS_FILE || process.env.WORKBUDDY_MODELS_PATH;
  if (typeof env === "string" && env.trim()) return env.trim();
  return join(os.homedir(), ".workbuddy", "models.json");
}

export function buildWorkbuddyEntry({ id, token, port }) {
  const p = Number(port) || 8989;
  return {
    id: String(id),
    name: String(id),
    vendor: "Custom",
    url: `http://127.0.0.1:${p}/v1/chat/completions`,
    apiKey: String(token || ""),
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    useCustomProtocol: false,
  };
}

export function isLocalUrl(url) {
  const u = String(url || "");
  return u.includes("127.0.0.1") && u.includes("/v1/chat/completions");
}

function isTargetEntry(m, id) {
  if (!m || typeof m !== "object") return false;
  if (m.id !== id) return false;
  return isLocalUrl(m.url);
}

export async function syncToWorkbuddy({ id, token, port, file } = {}) {
  const targetFile = file || workbuddyModelsPath();
  const cleanId = String(id || "").trim();
  if (!cleanId) throw new Error("model id required");
  const cleanToken = String(token || "");
  const p = Number(port) || 8989;

  let arr = [];
  let corrupted = false;
  let rawText = null;
  try {
    rawText = readFileSync(targetFile, "utf8");
    const parsed = JSON.parse(rawText);
    arr = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (rawText !== null) {
      // file existed but unreadable/corrupted -> backup
      corrupted = true;
      try {
        mkdirSync(dirname(targetFile), { recursive: true });
        // only backup if .bak not exists or corrupted content differs?
        writeFileSync(targetFile + ".bak", rawText ?? "", "utf8");
      } catch {}
      arr = [];
    } else {
      // file not exists
      arr = [];
    }
  }

  // find exact target (id + local url, any port -> will update port)
  let idx = arr.findIndex((m) => isTargetEntry(m, cleanId));
  let action;
  if (idx >= 0) {
    // update token/url/name, preserve other fields
    const old = arr[idx];
    arr[idx] = { ...old, id: cleanId, name: cleanId, url: `http://127.0.0.1:${p}/v1/chat/completions`, apiKey: cleanToken };
    if (!arr[idx].vendor) arr[idx].vendor = "Custom";
    if (arr[idx].supportsToolCall === undefined) arr[idx].supportsToolCall = true;
    if (arr[idx].supportsImages === undefined) arr[idx].supportsImages = true;
    if (arr[idx].supportsReasoning === undefined) arr[idx].supportsReasoning = true;
    if (arr[idx].useCustomProtocol === undefined) arr[idx].useCustomProtocol = false;
    action = "updated";
  } else {
    // ensure existence: no reuse, always insert new entry (preserves other local entries like x-preview)
    arr.push(buildWorkbuddyEntry({ id: cleanId, token: cleanToken, port: p }));
    action = "inserted";
  }

  // atomic write
  mkdirSync(dirname(targetFile), { recursive: true });
  const tmp = `${targetFile}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, JSON.stringify(arr, null, 2), "utf8");
  try {
    // on Windows, rename fails if target exists -> remove first? use renameSync which overwrites on Node 20?
    // try rename, fallback to copy+unlink
    renameSync(tmp, targetFile);
  } catch {
    try { writeFileSync(targetFile, readFileSync(tmp, "utf8"), "utf8"); } catch {}
    try { readFileSync(tmp); } catch {}
    // cleanup tmp
    try { /* remove tmp */ } catch {}
  }
  // cleanup tmp if still exists
  try { if (existsSync(tmp)) { const { unlinkSync } = await import("node:fs"); unlinkSync(tmp); } } catch {}

  return { action, file: targetFile, id: cleanId, corrupted };
}
