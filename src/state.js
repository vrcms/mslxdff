import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

export const DEFAULT_PORT = 8989;

export function defaultStateFile() {
  return process.env.MSLXDFF_STATE_FILE ||
    join(os.homedir(), ".config", "mslxdff", "state.json");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

export async function loadToken({ file = defaultStateFile() } = {}) {
  const state = readState(file);
  if (typeof state.token === "string" && state.token.length > 0) {
    return { token: state.token, created: false };
  }
  return { token: writeState(file, { token: generateToken(), createdAt: new Date().toISOString() }).token, created: true };
}

export async function refreshToken({ file = defaultStateFile() } = {}) {
  return writeState(file, { token: generateToken(), createdAt: new Date().toISOString() }).token;
}

export function setPort(port, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, port: Number(port) });
}

export function getPort({ file = defaultStateFile() } = {}) {
  const port = readState(file).port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null;
}

export function loadModelErrors({ file = defaultStateFile() } = {}) {
  const errors = readState(file).modelErrors;
  return errors && typeof errors === "object" && !Array.isArray(errors) ? errors : {};
}

export function saveModelErrors(errors, { file = defaultStateFile() } = {}) {
  const state = readState(file);
  writeState(file, { ...state, modelErrors: errors });
  return errors;
}

function readState(file) {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    return typeof saved === "object" && saved !== null ? saved : {};
  } catch {
    return {};
  }
}

function writeState(file, patch) {
  const merged = { ...readState(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}
