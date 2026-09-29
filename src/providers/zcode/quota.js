// zcode 额度：GET /api/v1/zcode-plan/billing/balance?app_version= 解析（plans/balances 分组）+ CLI 渲染。
// 契约来自 zcode-switch quota.rs（unwrap data/result → plans[].plan_id/name/status/expire、balances[].*_units）。
import { timeoutSignal } from "../../compat.js";
import { ZCODE_MODEL_CATALOG, zcodeAppVersion, zcodeBalanceUrl, zcodeErrorKind } from "./const.js";
import { buildZcodeHeaders } from "./headers.js";

const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const firstStr = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};
const firstNum = (obj, keys) => {
  for (const k of keys) {
    const n = num(obj?.[k]);
    if (n != null) return n;
  }
  return null;
};
const fmtNum = (n) => {
  if (n == null) return "—";
  return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

// 上游可能把业务体包在 data/result 里（最多下钻 4 层，与 zcode-switch unwrap 同语义）
export function unwrapZcodeData(payload) {
  let cur = payload;
  for (let i = 0; i < 4; i++) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) break;
    if (cur.data && typeof cur.data === "object" && !Array.isArray(cur.data)) { cur = cur.data; continue; }
    if (cur.result && typeof cur.result === "object" && !Array.isArray(cur.result)) { cur = cur.result; continue; }
    break;
  }
  return cur || {};
}

export function parseZcodeBalance(payload) {
  const data = unwrapZcodeData(payload);
  const rawPlans = Array.isArray(data.plans) ? data.plans : [];
  const rawBalances = Array.isArray(data.balances) ? data.balances : [];

  const plans = rawPlans.map((p) => ({
    id: firstStr(p, ["plan_id", "planId", "id"]),
    name: firstStr(p, ["name", "show_name", "plan_name"]) || firstStr(p, ["plan_id", "planId"]) || "套餐",
    status: firstStr(p, ["status"]) || "UNKNOWN",
    expire: firstStr(p, ["ends_at", "end_at", "expires_at", "expire", "period_end"]),
    items: [],
  }));
  const loose = [];

  for (const b of rawBalances) {
    const item = {
      name: firstStr(b, ["show_name", "name", "entitlement_id", "plan_id"]) || "Unknown",
      total: firstNum(b, ["total_units", "total"]),
      used: firstNum(b, ["used_units", "used"]),
      remaining: firstNum(b, ["remaining_units", "available_units", "remaining"]),
      unit: firstStr(b, ["unit_type", "meter", "unit"]) || "quota",
      periodEnd: firstStr(b, ["period_end", "expires_at", "end_at"]),
      planId: firstStr(b, ["plan_id", "planId", "entitlement_id"]),
    };
    item.percentUsed = item.total > 0 && item.used != null ? Math.min(100, Math.round((item.used / item.total) * 1000) / 10) : null;
    const slot = item.planId ? plans.find((s) => s.id === item.planId) : plans.length === 1 ? plans[0] : null;
    if (slot) slot.items.push(item);
    else loose.push(item);
  }
  for (const s of plans) if (!s.expire) s.expire = s.items.map((i) => i.periodEnd).find(Boolean) || "";

  const all = [...plans.flatMap((s) => s.items), ...loose];
  const sum = (k) => (all.some((i) => i[k] != null) ? all.reduce((a, i) => a + (i[k] || 0), 0) : null);
  return {
    isEmpty: plans.length === 0 && loose.length === 0,
    plans,
    loose,
    totals: { total: sum("total"), used: sum("used"), remaining: sum("remaining") },
    itemCount: all.length,
  };
}

// entitlement 名 → 内置目录里的 canonical id（同名词取最长命中的目录项，避免 GLM-5.3-Flash 误配 GLM-5.3）
export function balanceModelIds(parsed) {
  const names = [
    ...(parsed?.plans || []).flatMap((s) => s.items.map((i) => i.name)),
    ...(parsed?.loose || []).map((i) => i.name),
  ]
    .filter(Boolean)
    .map((n) => String(n).toLowerCase().replace(/\s+/g, "-"));
  const out = [];
  for (const n of names) {
    const hit = ZCODE_MODEL_CATALOG.filter((m) => n.includes(m.toLowerCase())).sort((a, b) => b.length - a.length)[0];
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

export async function fetchZcodeBalance({ token, deviceMid = "", fetchImpl, version = zcodeAppVersion(), timeoutMs = 15_000 } = {}) {
  const url = zcodeBalanceUrl(version);
  const headers = { ...buildZcodeHeaders({ token, deviceMid, version }), Accept: "application/json" };
  let res;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal: timeoutSignal(timeoutMs) });
  } catch (e) {
    return { ok: false, kind: "network", status: 0, code: 0, message: String(e?.message || e).slice(0, 160), modelIds: [] };
  }
  const payload = await res.json().catch(() => null);
  const code = Number(payload?.code) || 0;
  const bizOk = Boolean(payload) && payload.success !== false && (!code || code === 200);
  if (!res.ok || !bizOk) {
    let kind = zcodeErrorKind(code);
    if (kind === "unknown") {
      if (res.status === 401) kind = "auth";
      else if (res.status === 429) kind = "rate_limit";
      else if (res.status >= 500) kind = "server";
      else if (!bizOk) kind = "server";
    }
    const message = String(payload?.msg || payload?.message || `HTTP ${res.status}`).trim();
    return { ok: false, kind, status: res.status, code, message, modelIds: [] };
  }
  const parsed = parseZcodeBalance(payload);
  return { ok: true, status: res.status, code, parsed, modelIds: balanceModelIds(parsed) };
}

export function formatZcodeQuota(result = {}, { account = "" } = {}) {
  const head = `zcode quota${account ? ` · ${account}` : ""}`;
  if (!result.ok) {
    const kind = result.kind || "unknown";
    if (kind === "auth") {
      return [head, `登录已失效（code ${result.code || 1006}）。请重新登录：`, "  mslxdff -provider zcode login"].join("\n");
    }
    const detail = `${kind}${result.code ? ` code ${result.code}` : ""}${result.status ? ` HTTP ${result.status}` : ""}`;
    return [
      head,
      `查询失败（${detail}）${result.message ? `：${result.message}` : ""}`,
      "稍后重试；若反复失败：mslxdff -provider zcode login 重新登录",
    ].join("\n");
  }
  const parsed = result.parsed || {};
  if (parsed.isEmpty) {
    return [
      head,
      "当前账号无套餐（未领取体验额度）。",
      "可在官方 ZCode 客户端 / zcode-switch 领取 Start Plan 体验额度后重试：",
      "  mslxdff -provider zcode quota",
    ].join("\n");
  }
  const lines = [head];
  if (parsed.totals?.remaining != null) {
    lines.push(`总余量 ${fmtNum(parsed.totals.remaining)}（已用 ${fmtNum(parsed.totals.used ?? 0)} / 总 ${fmtNum(parsed.totals.total ?? 0)}）`);
  }
  for (const p of parsed.plans || []) {
    lines.push("");
    lines.push(`[${p.name || p.id || "套餐"}] ${p.status}${p.expire ? `  有效期至 ${p.expire}` : ""}`);
    const w = Math.max(6, ...p.items.map((i) => String(i.name).length));
    for (const i of p.items) {
      const used = i.percentUsed != null ? `  已用 ${i.percentUsed}%` : "";
      lines.push(`  * ${String(i.name).padEnd(w)}  余 ${fmtNum(i.remaining ?? 0)} ${i.unit} / 总 ${fmtNum(i.total ?? 0)}${used}`);
    }
    if (!p.items.length) lines.push("  （该套餐无 entitlement 明细）");
  }
  if ((parsed.loose || []).length) {
    lines.push("");
    lines.push("[未归属套餐的额度]");
    for (const i of parsed.loose) lines.push(`  * ${i.name}  余 ${fmtNum(i.remaining ?? 0)} ${i.unit} / 总 ${fmtNum(i.total ?? 0)}`);
  }
  lines.push("");
  lines.push("提示: mslxdff -provider zcode models 查看可用模型 · 额度按官方计费周期重置");
  return lines.join("\n");
}
