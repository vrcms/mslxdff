import { compatFetch, timeoutSignal } from "../../compat.js";
// WorkBuddy 每日签到 core：纯逻辑 + fetch 注入，被 daemon scheduler 与 CLI 共用。
// 接口：双域 POST /v2/billing/meter/daily-checkin，code 0=新签成功，10001=已签（幂等成功）。

export const CHECKIN_ENDPOINTS = [
  "https://www.codebuddy.cn/v2/billing/meter/daily-checkin",
  "https://copilot.tencent.com/v2/billing/meter/daily-checkin",
];

function checkinHeaders({ at, uid, domain, enterpriseId }) {
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

export async function checkinOne({ uid, at, domain, enterpriseId, fetchImpl = compatFetch, timeoutMs = 15000 } = {}) {
  const headers = checkinHeaders({ at, uid, domain, enterpriseId });
  let last = null;
  for (const url of CHECKIN_ENDPOINTS) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: "{}",
        signal: timeoutSignal(timeoutMs),
      });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { j = { code: res.status, msg: text.slice(0, 200) }; }
      last = { url, status: res.status, body: j };
      if (j.code === 0 || j.code === 10001 || String(j.msg || "").includes("已签到")) {
        return { ok: true, already: j.code === 10001, ...last };
      }
      // 401/403 = token 过期：标记给上层 refresh，不浪费第二域
      if (res.status === 401 || res.status === 403) return { ok: false, needRefresh: true, ...last };
    } catch (e) {
      last = { url, error: String(e?.message || e).slice(0, 200) };
    }
  }
  return { ok: false, ...last };
}

// 多账号签到：逐个独立，失败不挡别人；返回按 uid 排序的 rows。
export async function checkinAll({ accounts = [], fetchImpl = compatFetch, concurrency = 3, onAccount } = {}) {
  const list = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.uid && a.at);
  const results = new Array(list.length);
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const i = idx++;
      const a = list[i];
      let row;
      try {
        const r = await checkinOne({ uid: a.uid, at: a.at, domain: a.domain, enterpriseId: a.enterpriseId, fetchImpl });
        row = { uid: a.uid, ok: r.ok, already: !!r.already, needRefresh: !!r.needRefresh, code: r.body?.code, msg: r.body?.msg || r.error || "", url: r.url };
      } catch (e) {
        row = { uid: a.uid, ok: false, msg: String(e?.message || e).slice(0, 200) };
      }
      if (typeof onAccount === "function") { try { await onAccount(row, a); } catch {} }
      results[i] = row;
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), Math.max(list.length, 1)) }, () => worker()));
  results.sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
  return results;
}
