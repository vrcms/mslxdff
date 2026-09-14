import { compatFetch, timeoutSignal } from "../../compat.js";
// WorkBuddy growth 域（/activity/growth/* 与 /v2/activity/growth/*）底层请求。
// 双域容灾与签到同款；业务失败结构化返回（ok:false + code/msg），不抛异常。
// 注意：领奖路径 /activity/growth/tasks/{code}/claim 无 /v2 前缀（上游实测形态）。

export const GROWTH_BASES = [
  "https://copilot.tencent.com",
  "https://www.codebuddy.cn",
];

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

export async function growthRequest({
  uid, at, domain, enterpriseId,
  method = "GET", path, body,
  fetchImpl = compatFetch, timeoutMs = 15000,
} = {}) {
  const headers = growthHeaders({ at, uid, domain, enterpriseId });
  let last = null;
  for (const base of GROWTH_BASES) {
    const url = base + path;
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        ...(method.toUpperCase() === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
        signal: timeoutSignal(timeoutMs),
      });
    } catch (e) {
      last = { ok: false, status: 0, code: null, msg: `网络失败: ${String(e?.message || e).slice(0, 200)}`, data: {}, url };
      continue;
    }
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    if (!payload || typeof payload !== "object") {
      last = { ok: false, status: res.status, code: null, msg: `非 JSON 响应 HTTP ${res.status}`, data: {}, url };
      if (res.status === 401 || res.status === 403) return { ...last, needRefresh: true };
      continue;
    }
    const out = {
      ok: res.status === 200 && payload.code === 0,
      status: res.status,
      code: payload.code,
      msg: payload.msg || "",
      data: payload.data || {},
      url,
    };
    if (out.ok) return out;
    if (res.status === 401 || res.status === 403) return { ...out, needRefresh: true };
    last = out;
  }
  return last || { ok: false, status: 0, code: null, msg: "无可用域", data: {} };
}
