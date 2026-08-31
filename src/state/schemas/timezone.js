import { readState, writeStateImmediate, defaultStateFile } from "../store.js";

const DEFAULT_TZ = "Asia/Shanghai";
const ENV_KEYS = ["MSLXDFF_TZ", "MSLXDFF_TIMEZONE", "TZ"];

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch { return false; }
}

export function getTimezoneEnv() {
  for (const k of ENV_KEYS) {
    const v = String(process.env[k] || "").trim();
    if (v && isValidTimezone(v)) return v;
  }
  return "";
}

export function loadTimezone({ file } = {}) {
  const env = getTimezoneEnv();
  if (env) return env;
  try {
    const f = file || defaultStateFile();
    const s = readState(f);
    const v = String(s?.timezone || s?.tz || "").trim();
    if (v && isValidTimezone(v)) return v;
  } catch {}
  return DEFAULT_TZ;
}

export function loadTimezoneState({ file } = {}) {
  try {
    const f = file || defaultStateFile();
    const s = readState(f);
    const v = String(s?.timezone || s?.tz || "").trim();
    if (v && isValidTimezone(v)) return v;
  } catch {}
  return DEFAULT_TZ;
}

export function saveTimezone(tz, { file } = {}) {
  const v = String(tz || "").trim();
  if (!v) throw new Error("timezone 不能为空");
  if (!isValidTimezone(v)) throw new Error(`无效时区: ${v}（示例: Asia/Shanghai, UTC, America/New_York）`);
  const f = file || defaultStateFile();
  const patch = { timezone: v };
  // 兼容旧字段 tz
  const cur = readState(f);
  if (cur?.tz !== undefined) patch.tz = undefined;
  return writeStateImmediate(f, patch);
}

export function clearTimezone({ file } = {}) {
  const f = file || defaultStateFile();
  const cur = readState(f);
  const patch = {};
  if (cur?.timezone !== undefined) patch.timezone = undefined;
  if (cur?.tz !== undefined) patch.tz = undefined;
  if (!Object.keys(patch).length) return cur;
  // 通过写 undefined 触发 merge 覆盖？用直接删后写回
  const next = { ...cur };
  delete next.timezone;
  delete next.tz;
  writeStateImmediate(f, next);
  return next;
}

export { DEFAULT_TZ, isValidTimezone };
