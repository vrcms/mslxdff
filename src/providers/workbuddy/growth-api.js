import { compatFetch, timeoutSignal } from "../../compat.js";
// WorkBuddy growth 域（/activity/growth/* 与 /v2/activity/growth/*）底层请求。
// 双域容灾与签到同款；业务失败结构化返回（ok:false + code/msg），不抛异常。
//
// 域名口径（本机 2026-10-20 实测）：
//   - 任务列表与领奖只在 www.workbuddy.cn 命中（web 成长中心口径）；probe 时
//     copilot.tencent.com / www.codebuddy.cn 这两个端点均未返回 code 0。
//   - 猫猫旅行等 buddy 端点在 copilot.tencent.com 命中。
//   所以 bases 是「候选集」，按顺序试到第一个成功为止，不按业务分类硬编码。

export const GROWTH_BASES = [
  "https://www.workbuddy.cn",
  "https://copilot.tencent.com",
  "https://www.codebuddy.cn",
];

// WEB_BASES 领奖专用：web 成长中心形态（x-client-platform: web）。
export const WEB_BASES = ["https://www.workbuddy.cn"];

export function growthHeaders({ at, uid, domain, enterpriseId }) {
  return {
    Authorization: `Bearer ${at}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-User-Id": uid,
    "X-Domain": domain || "www.codebuddy.cn",
    "X-Product": "SaaS",
    "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
    Origin: "https://www.codebuddy.cn",
    Referer: "https://www.codebuddy.cn/",
    ...(enterpriseId ? { "X-Enterprise-Id": enterpriseId } : {}),
  };
}

// webHeaders 浏览器成长中心形态：部分端点（任务列表 / 领奖）只认这套头。
export function webHeaders({ at, uid, domain, enterpriseId }) {
  return {
    Authorization: `Bearer ${at}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-User-Id": uid,
    "X-Domain": domain || "www.codebuddy.cn",
    "X-Product": "SaaS",
    "x-client-platform": "web",
    Origin: "https://www.workbuddy.cn",
    Referer: "https://www.workbuddy.cn/profile/growth-center",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    ...(enterpriseId ? { "X-Enterprise-Id": enterpriseId, "X-Tenant-Id": enterpriseId } : {}),
  };
}

async function requestOn(base, headers, { method, path, body, fetchImpl, timeoutMs }) {
  let res;
  try {
    res = await fetchImpl(base + path, {
      method,
      headers,
      ...(method.toUpperCase() === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    return { ok: false, status: 0, code: null, msg: `网络失败: ${String(e?.message || e).slice(0, 200)}`, data: {}, url: base + path };
  }
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!payload || typeof payload !== "object") {
    const out = { ok: false, status: res.status, code: null, msg: `非 JSON 响应 HTTP ${res.status}`, data: {}, url: base + path };
    return res.status === 401 || res.status === 403 ? { ...out, needRefresh: true } : out;
  }
  const out = {
    ok: res.status === 200 && payload.code === 0,
    status: res.status,
    code: payload.code,
    msg: payload.msg || "",
    data: payload.data || {},
    url: base + path,
  };
  return res.status === 401 || res.status === 403 ? { ...out, needRefresh: true } : out;
}

export async function growthRequest({
  uid, at, domain, enterpriseId,
  method = "GET", path, body,
  fetchImpl = compatFetch, timeoutMs = 15000,
  bases = GROWTH_BASES, headers: headersFn = growthHeaders,
} = {}) {
  const headers = headersFn({ at, uid, domain, enterpriseId });
  let last = null;
  for (const base of bases) {
    const out = await requestOn(base, headers, { method, path, body, fetchImpl, timeoutMs });
    if (out.ok) return out;
    if (out.needRefresh) return out;
    last = out;
  }
  return last || { ok: false, status: 0, code: null, msg: "无可用域", data: {} };
}

// Web 成长中心口径（任务列表 / 领奖）。
export function webRequest(opts = {}) {
  return growthRequest({ ...opts, bases: WEB_BASES, headers: webHeaders });
}
