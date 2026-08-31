const BALANCE_TTL_MS = 5 * 60 * 1000;

export function createBalanceCache({ ttlMs = BALANCE_TTL_MS, now = Date.now } = {}) {
  const map = new Map(); // uid -> { total, dailyPacks, activeCount, nextExpire, fetchedAt, totalStr? }
  function getCachedBalance(uid) {
    const v = map.get(String(uid));
    if (!v) return null;
    if (now() - v.fetchedAt > ttlMs) {
      map.delete(String(uid));
      return null;
    }
    return v;
  }
  function setCachedBalance(uid, data) {
    const v = { ...data, fetchedAt: now() };
    map.set(String(uid), v);
    return v;
  }
  function getBalanceCache() { return map; }
  function clearBalanceCache() { map.clear(); }

  async function fetchBalance({ uid, key, auth, domain, baseUrl = "https://www.codebuddy.cn", fetchImpl } = {}) {
    const at = key || auth?.accessToken || "";
    const u = uid || auth?.uid || "";
    const d = domain || auth?.domain || "www.codebuddy.cn";
    if (!u || !at) return null;
    const fetcher = fetchImpl || fetch;
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
        fetchedAt: now(),
      };
      data.totalStr = total.toFixed(2);
      setCachedBalance(u, data);
      return data;
    } catch {
      return null;
    }
  }

  async function getBalanceWithCache({ uid, key, auth, domain, baseUrl, fetchImpl } = {}) {
    const cached = getCachedBalance(uid || auth?.uid);
    if (cached) return cached;
    return fetchBalance({ uid, key, auth, domain, baseUrl, fetchImpl });
  }

  return { getCachedBalance, setCachedBalance, getBalanceCache, clearBalanceCache, fetchBalance, getBalanceWithCache, _map: map, _ttlMs: ttlMs };
}

// 默认单例（保持与 src/providers/workbuddy-balance.js 兼容，供未注入场景使用）
const defaultCache = createBalanceCache();
export const getCachedBalance = defaultCache.getCachedBalance;
export const setCachedBalance = defaultCache.setCachedBalance;
export const getBalanceCache = defaultCache.getBalanceCache;
export const clearBalanceCache = defaultCache.clearBalanceCache;
export const fetchBalance = defaultCache.fetchBalance;
export const getBalanceWithCache = defaultCache.getBalanceWithCache;
