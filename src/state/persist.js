import { mkdirSync, readFileSync, writeFileSync, statSync, renameSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function loadFromDisk(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

export function getMtimeMs(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

export function atomicWriteSync(file, data) {
  ensureDir(file);
  const tmp = `${file}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch {
    try { writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); } catch {}
    try { unlinkSync(tmp); } catch {}
  }
  return getMtimeMs(file);
}

export async function atomicWriteAsync(file, data) {
  ensureDir(file);
  await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  return getMtimeMs(file);
}
