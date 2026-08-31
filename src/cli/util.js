import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";

export function errMsg(err) { return String(err?.message || err); }

export function readModelsCache(cacheFile) {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    return null;
  }
}

export function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function run(cmd, args, opts = {}) {
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    const execOpts = isWin ? { shell: true, windowsHide: true } : {};
    execFile(cmd, args, { timeout: 120_000, ...execOpts, ...opts }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}
