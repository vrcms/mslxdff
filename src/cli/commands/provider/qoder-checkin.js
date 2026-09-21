// mslxdff -provider qoder checkin [--json] [--region cn|global] [--any] [--dry]
// 四态反馈：空（无账号→引导 login）→ 执行中（逐号打印）→ 成功 ✅ / 失败 ❌ + 下一步。
// 账号单一源 = auths/qoder-<uid>.json（含每号 region）；device token 直接取该文件。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { normalizeRegion } from "../../../providers/qoder/constants.js";
import { compatFetch } from "../../../compat.js";

function parseFlags(rest) {
  const has = (...names) => names.some((n) => rest.includes(n));
  const regionArg = (() => {
    const i = rest.findIndex((x) => x === "--region");
    return i >= 0 ? String(rest[i + 1] || "") : "";
  })();
  return {
    json: has("--json"),
    dry: has("--dry", "--dry-run"),
    any: has("--any", "--promo"),
    region: regionArg ? normalizeRegion(regionArg) : "",
    badRegion: Boolean(regionArg) && !["cn", "global"].includes(String(regionArg).trim().toLowerCase()),
  };
}

export async function handleQoderCheckin(id, sub, rest = [], deps = {}) {
  if (normalizeProviderId(id) !== "qoder") return false;
  if (sub !== "checkin" && sub !== "check-in" && sub !== "signin") return false;
  const log = deps.log || ((m) => console.log(m));
  const err = deps.err || ((m) => console.error(m));
  const fetchImpl = deps.fetchImpl || compatFetch;
  const flags = parseFlags(rest.slice(1));
  if (flags.badRegion) { err("usage: mslxdff -provider qoder checkin [--json] [--region cn|global] [--any] [--dry]"); if (!deps.noExit) process.exit(1); return true; }

  const accounts = deps.accounts
    || (await import("../../../providers/qoder/account-store.js")).listAccountDocs()
      .map((d) => ({ uid: d.uid, deviceToken: d.doc?.auth?.deviceToken || "", region: d.doc?.auth?.region || "global", name: d.doc?.account?.name || "" }));
  const picked = flags.region ? accounts.filter((a) => normalizeRegion(a.region) === flags.region) : accounts;

  // 空状态：不留白
  if (!picked.length) {
    log(accounts.length
      ? `qoder 签到：没有 ${flags.region} 区账号（现有 ${accounts.length} 个：${accounts.map((a) => normalizeRegion(a.region)).join("/")}）`
      : "qoder 签到：还没有账号");
    log("  下一步：mslxdff -provider qoder login [--region cn|global]");
    if (!deps.noExit) process.exit(accounts.length ? 0 : 1);
    return true;
  }

  const { runCheckin, fetchQuota } = await import("../../../providers/qoder/checkin.js");
  log(`Qoder 签到 · ${picked.length} 个账号（cn ${picked.filter((a) => normalizeRegion(a.region) === "cn").length} / global ${picked.filter((a) => normalizeRegion(a.region) === "global").length}）${flags.dry ? " · 干跑（只查不领）" : ""}`);
  const results = [];
  for (let i = 0; i < picked.length; i++) {
    const a = picked[i];
    const tag = `${String(a.uid).slice(0, 8)}…（${normalizeRegion(a.region)}）`;
    if (!a.deviceToken) {
      results.push({ uid: a.uid, region: normalizeRegion(a.region), ok: false, status: "no_token", message: "无 device token" });
      log(`  ❌ [${i + 1}/${picked.length}] ${tag} 无 device token → 重新 login`);
      continue;
    }
    log(`  ⏳ [${i + 1}/${picked.length}] ${tag} 签到中…`);
    const r = flags.dry
      ? { ...(await runCheckin({ deviceToken: a.deviceToken, region: a.region, fetchImpl: deps.fetchImpl, allowPromo: flags.any, probeOnly: true })), dry: true }
      : await runCheckin({ deviceToken: a.deviceToken, region: a.region, fetchImpl: deps.fetchImpl, allowPromo: flags.any });
    const quota = await fetchQuota({ deviceToken: a.deviceToken, region: a.region, fetchImpl: deps.fetchImpl }).catch(() => ({ ok: false }));
    r.quota = quota.ok ? `${quota.remaining}/${quota.total} ${quota.unit}${quota.exhausted ? "（已耗尽）" : ""}` : "余额不可用";
    r.name = a.name;
    results.push(r);
    const icon = r.ok ? (r.status === "claimed" ? "✅" : "⚠️") : "❌";
    const stats = r.streak || r.totalDays ? ` · 连续 ${r.streak} 天 · 累计 ${r.totalDays} 天 · 共 ${r.totalCredits} 积分` : "";
    log(`  ${icon} [${i + 1}/${picked.length}] ${tag} ${r.message}${stats} · 余额 ${r.quota}`);
  }

  const okCount = results.filter((r) => r.ok).length;
  const claimed = results.filter((r) => r.status === "claimed").length;
  if (flags.json) {
    log(JSON.stringify({ ok: okCount, total: results.length, claimed, results }, null, 2));
  } else {
    log(`\n结果：${okCount}/${results.length} 正常${claimed ? ` · 新领取 ${claimed} 个` : ""}`);
    if (claimed) log("  积分到账可能有延迟（上游记账异步），可用 -provider qoder checkin 复查余额");
  }
  if (!deps.noExit) process.exit(results.some((r) => r.status === "error" || r.status === "no_token") ? 1 : 0);
  return true;
}
