import { loadTimezone } from "./state/schemas/timezone.js";

const DEFAULT_TZ = "Asia/Shanghai";

function getTimezone() {
  try { return loadTimezone() || DEFAULT_TZ; } catch { return DEFAULT_TZ; }
}

function tzParts(d, tz) {
  const zone = tz || getTimezone();
  const date = d instanceof Date ? d : new Date(d);
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const m = {};
    for (const p of parts) m[p.type] = p.value;
    return m; // {year, month, day, hour, minute, second}
  } catch {
    // 回退上海
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: DEFAULT_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const m = {};
    for (const p of parts) m[p.type] = p.value;
    return m;
  }
}

function shanghaiParts(d) { return tzParts(d, getTimezone()); }

// "MM-DD HH:mm:ss" e.g. "08-27 15:07:14"
export function fmtShanghai(isoOrTs) {
  if (isoOrTs == null) return "-";
  try {
    const p = shanghaiParts(isoOrTs);
    return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return "-";
  }
}

// "YYYY-MM-DD HH:mm" e.g. "2026-08-27 15:07"
export function fmtShanghaiYMDHM(isoOrTs) {
  if (isoOrTs == null) return "-";
  try {
    const p = shanghaiParts(isoOrTs);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch {
    return "-";
  }
}

// "YYYY-MM-DD HH:mm:ss" e.g. "2026-08-27 15:07:14"
export function fmtShanghaiYMDHMS(isoOrTs) {
  if (isoOrTs == null) return "-";
  try {
    const p = shanghaiParts(isoOrTs);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return "-";
  }
}

// "HH:mm:ss" e.g. "15:07:14"
export function fmtShanghaiHMS(isoOrTs) {
  if (isoOrTs == null) return "--:--:--";
  try {
    const p = shanghaiParts(isoOrTs);
    return `${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return "--:--:--";
  }
}

// 当前上海时间 "YYYY-MM-DD HH:mm" 用于 prompt
export function nowShanghaiYMDHM() {
  return fmtShanghaiYMDHM(new Date());
}

// 兼容：传入 Date 或 ts 或 ISO，都返回 "MM-DD HH:mm:ss"
export function fmtTsShanghai(iso) {
  return fmtShanghai(iso);
}

export { getTimezone };
// 通用别名（实际已可配置，不再仅限上海）
export const fmtYMDHMS = fmtShanghaiYMDHMS;
export const fmtYMDHM = fmtShanghaiYMDHM;
export const fmtHMS = fmtShanghaiHMS;
