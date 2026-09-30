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

// 模型请求专用形态（zcode-plan 通道）：与官方 CLI 出站同形 —— 双鉴权头、ai-sdk UA、
// x-title=cli、production 渠道、anthropic-version、gzip；**不带** X-Device-Mid，
// **不带** 验证码头（v3.14.4 起模型请求免校验，client/configs captcha.skip_model_request=true）。
export function buildZcodeModelHeaders(opts = {}) {
  const ver = normalizeHeaderValue(opts.version) ?? zcodeAppVersion();
  const platform = normalizeHeaderValue(opts.platform) ?? process.platform;
  const arch = normalizeHeaderValue(opts.arch) ?? process.arch;
  const intl = (() => { try { return Intl.DateTimeFormat().resolvedOptions() || {}; } catch { return {}; } })();
  const language = normalizeHeaderValue(opts.lang) ?? normalizeHeaderValue(intl.locale) ?? "unknown";
  const timeZone = normalizeHeaderValue(opts.tz) ?? normalizeHeaderValue(intl.timeZone) ?? "unknown";
  const osVersion = "osVersion" in opts ? normalizeHeaderValue(opts.osVersion) : normalizeHeaderValue(os.release());
  const token = normalizeHeaderValue(opts.token);
  const headers = {
    "accept-encoding": "gzip",
    "anthropic-version": "2023-06-01",
    "authorization": token ? `Bearer ${token}` : undefined,
    "http-referer": ZCODE_ORIGIN,
    "user-agent": `ZCode/${ver} ai-sdk/anthropic/3.0.81`,
    "x-api-key": token,
    "x-client-language": language,
    "x-client-timezone": timeZone,
    "x-os-category": osCategory(platform),
    "x-platform": `${platform}-${arch}`,
    "x-release-channel": "production",
    "x-request-id": normalizeHeaderValue(opts.requestId) ?? uuid(),
    "x-title": "Z Code@cli",
    "x-zcode-agent": "glm",
    "x-zcode-app-version": ver,
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": normalizeHeaderValue(opts.traceId) ?? uuid(),
  };
  if (osVersion) headers["x-os-version"] = osVersion;
  for (const k of Object.keys(headers)) {
    if (headers[k] === undefined) delete headers[k];
  }
  return headers;
}
