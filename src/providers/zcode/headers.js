// zcode source headers 构造：与官方客户端同形的 12 项（zcode-source-headers.ts / quota.rs 双源核对）。
// 官方要求 header value 必须是可见 ASCII，非法值一律剔除（缺失优于脏值）。
import os from "node:os";
import { uuid } from "../../compat.js";
import { ZCODE_ORIGIN, ZCODE_RELEASE_CHANNEL, zcodeAppVersion } from "./const.js";

const ASCII = /^[\x20-\x7e]+$/;

export function normalizeHeaderValue(v) {
  const t = typeof v === "string" ? v.trim() : "";
  return t && ASCII.test(t) ? t : undefined;
}

export function osCategory(platform) {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}

export function buildZcodeHeaders(opts = {}) {
  const ver = normalizeHeaderValue(opts.version) ?? zcodeAppVersion();
  const platform = normalizeHeaderValue(opts.platform) ?? process.platform;
  const arch = normalizeHeaderValue(opts.arch) ?? process.arch;
  const intl = (() => { try { return Intl.DateTimeFormat().resolvedOptions() || {}; } catch { return {}; } })();
  const language = normalizeHeaderValue(opts.lang) ?? normalizeHeaderValue(intl.locale) ?? "unknown";
  const timeZone = normalizeHeaderValue(opts.tz) ?? normalizeHeaderValue(intl.timeZone) ?? "unknown";
  // osVersion 显式传空 = 未知（省略该头）；未传则取系统 release。
  const osVersion = "osVersion" in opts ? normalizeHeaderValue(opts.osVersion) : normalizeHeaderValue(os.release());
  const deviceMid = normalizeHeaderValue(opts.deviceMid);
  const requestId = normalizeHeaderValue(opts.requestId) ?? uuid();

  const headers = {
    "User-Agent": `ZCode/${ver}`,
    "HTTP-Referer": ZCODE_ORIGIN,
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": ver,
    "X-Platform": `${platform}-${arch}`,
    "X-Release-Channel": ZCODE_RELEASE_CHANNEL,
    "X-Client-Language": language,
    "X-Client-Timezone": timeZone,
    "X-Os-Category": osCategory(platform),
  };
  if (osVersion) headers["X-Os-Version"] = osVersion;
  if (deviceMid) headers["X-Device-Mid"] = deviceMid;
  headers["x-request-id"] = requestId;

  const token = normalizeHeaderValue(opts.token);
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}
