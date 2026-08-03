import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

export function defaultStateFile() {
  return process.env.MSLXDFREE_STATE_FILE ||
    join(os.homedir(), ".config", "mslxdfree", "state.json");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

export async function loadToken({ file = defaultStateFile() } = {}) {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved.token === "string" && saved.token.length > 0) return saved.token;
  } catch {
    // missing or unreadable → generate fresh below
  }
  return writeToken(file);
}

export async function refreshToken({ file = defaultStateFile() } = {}) {
  return writeToken(file);
}

function writeToken(file) {
  const state = {
    token: generateToken(),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  return state.token;
}