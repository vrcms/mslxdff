import { compatFetch } from "../compat.js";

const BALANCE_TTL_MS = 5 * 60 * 1000;

const balanceCache = new Map(); // uid -> { total, dailyPacks, activeCount, nextExpire, fetchedAt }

export function getBalanceCache() { return balanceCache; }
export function clearBalanceCache() { balanceCache.clear(); }

export function getCachedBalance(uid) {
  const v = balanceCache.get(String(uid));
  if (!v) return null;
  if (Date.now() - v.fetchedAt > BALANCE_TTL_MS) {
    balanceCache.delete(String(uid));
    return null;
  }
  return v;
}

export function setCachedBalance(uid, data) {
  const v = { ...data, fetchedAt: Date.now() };
  balanceCache.set(String(uid), v);
  return v;
}

export async function fetchBalance({ uid, key, auth, domain, baseUrl = "https://www.codebuddy.cn", fetchImpl } = {}) {
  const at = key || auth?.accessToken || "";
  const u = uid || auth?.uid || "";
  const d = domain || auth?.domain || "www.codebuddy.cn";
  if (!u || !at) return null;
  const fetcher = fetchImpl || compatFetch;
  const body = JSON.stringify({
    PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3],
    PackageEndTimeRangeBegin: "2026-08-01 00:00:00",
    PackageEndTimeRangeEnd: "2030-01-01 00:00:00",
  });
  try {
    const res = await fetcher(`${baseUrl.replace(/\/+$/, "")}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${at}`,
        "Content-Type": "application/json",
        "X-User-Id": u,
        "X-Domain": d,
      },
      body,
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const accs = j?.data?.Response?.Data?.Accounts || j?.data?.Response?.data?.Accounts || [];
    // fallback for stub shape
    const accounts = Array.isArray(accs) ? accs : [];
    const active = accounts.filter(a => a.Status === 0);
    const total = active.reduce((s, a) => s + Number(a.CycleCapacityRemainPrecise || a.CycleCapacityRemain || 0), 0);
    const dailyPacks = active.filter(a => a.PackageName?.includes("裂变包") && String(a.CycleCapacitySizePrecise) === "100");
    const sorted = [...active].sort((a,b)=> new Date(a.CycleEndTime) - new Date(b.CycleEndTime));
    const nextExpire = sorted[0]?.CycleEndTime || null;
    const data = {
      total: Number(total.toFixed(2)),
      dailyPacks: dailyPacks.length,
      activeCount: active.length,
      nextExpire,
      fetchedAt: Date.now(),
    };
    // string total for CLI compatibility
    data.totalStr = total.toFixed(2);
    setCachedBalance(u, data);
    return data;
  } catch {
    return null;
  }
}

export async function getBalanceWithCache({ uid, key, auth, domain, baseUrl, fetchImpl } = {}) {
  const cached = getCachedBalance(uid || auth?.uid);
  if (cached) return cached;
  return fetchBalance({ uid, key, auth, domain, baseUrl, fetchImpl });
}
