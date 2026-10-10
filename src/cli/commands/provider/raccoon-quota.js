// mslxdff -provider raccoon quota    — 逐号查积分余额（五分项）
// mslxdff -provider raccoon checkin  — 领「桌面端登录奖励」
// ⚠ 纠偏（2026-10-10 账单实测）：这家**没有每日签到**。三种积分来源里只有登录奖励 3000 需要领，
//   且**每号一次性**；每日 300 与注册礼包 3000 都由服务端自动发（无端点），每日 300 当天 23:59:59 清零。
//   判据一律走账单：上游对重复领取照样回 code:0，只信回执就会谎报到账。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch } from "../../../compat.js";
import { listRaccoonAccountDocs, raccoonCredentialFromDoc } from "../../../providers/raccoon/account-store.js";
import { claimRaccoonLoginReward, fetchRaccoonBalance, raccoonClaimStatus } from "../../../providers/raccoon/credits.js";
import { raccoonTokenFingerprint } from "../../../providers/raccoon/auth.js";

const SUBS = new Set(["quota", "credits", "balance", "checkin", "signin"]);

/** 逐号列出（旧实现只取 docs[0]，多号时会漏看余额、漏领一次性礼包）。 */
function targets(deps) {
  if (deps.credential) return [{ name: "", credential: deps.credential }];
  return listRaccoonAccountDocs(deps.dir ? { dirs: [deps.dir] } : {})
    .filter((d) => d.accessToken)
    .map((d) => ({ name: d.name || "", credential: raccoonCredentialFromDoc(d) }));
}

const STATUS_LINE = {
  claimed: (r) => `🎁 已领取 +${r.points} 分 —— 账单已确认入账（每号仅此一次）`,
  already: () => `已领过 —— 每号只有一次，没有"明天再来"这回事`,
  phantom: () => `⚠ 上游回执「成功」但账单里查不到这笔 → 判定未到账，别当领过`,
  unverified: () => `已提交，但账单暂时查不到 → 未确认，稍后用 quota 核对`,
  error: (r) => `❌ 领取失败：${r.msg || "未知原因"}`,
};

// row.account 在构造时已换成 token 指纹（凭据纪律：CLI 只打指纹，绝不打完整 token）
const label = (row) => `[${row.account}${row.uid ? " · " + row.uid : ""}]`;

function expiredHint(error) {
  return error?.authExpired || error?.status === 401 || error?.code === 200001 || error?.code === 200003
    ? "登录态已失效（access_token 只有约 3 小时寿命），重新扫码: mslxdff -provider raccoon login"
    : "";
}

export async function handleRaccoonQuota(id, sub, rest = [], deps = {}) {
  const pid = normalizeProviderId(id) || String(id || "").toLowerCase();
  if (pid !== "raccoon") return false;
  if (!SUBS.has(sub)) return false;

  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const json = rest.includes("--json");
  const isCheckin = sub === "checkin" || sub === "signin";
  const list = targets(deps);

  if (!list.length) {
    if (json) log(JSON.stringify({ error: "not_logged_in", hint: "mslxdff -provider raccoon login" }));
    else {
      log("未登录：还没有可用的 raccoon 账号");
      log("  先运行: mslxdff -provider raccoon login（登录时会自动领一次性登录奖励）");
    }
    exit(1);
    return true;
  }

  const rows = [];
  for (const t of list) {
    const base = { account: raccoonTokenFingerprint(t.credential.access_token), uid: t.credential.uid, name: t.name };
    try {
      if (isCheckin) {
        const r = await claimRaccoonLoginReward({ credential: t.credential, fetchImpl, env: deps.env });
        const status = raccoonClaimStatus(r);
        rows.push({ ...base, ok: status === "claimed" || status === "already", status, points: r.points });
      } else {
        const b = await fetchRaccoonBalance({ credential: t.credential, fetchImpl, env: deps.env });
        rows.push({ ...base, ok: true, total: b.total, items: b.items });
      }
    } catch (e) {
      rows.push({ ...base, ok: false, status: "error", msg: String(e?.message ?? e).slice(0, 160), relogin: expiredHint(e) });
    }
  }
  const failed = rows.filter((r) => !r.ok).length;

  if (json) {
    log(JSON.stringify({ accounts: rows, ok: rows.length - failed, total: rows.length }));
    exit(failed === rows.length ? 1 : 0);
    return true;
  }

  if (isCheckin) {
    log(`raccoon 登录奖励（每号一次性）· 共 ${rows.length} 个号`);
    for (const r of rows) log(`  ${label(r)} ${STATUS_LINE[r.status]?.(r) || r.status}`);
    if (rows.some((r) => r.status === "claimed")) log(`  查看余额: mslxdff -provider raccoon quota`);
    exit(failed === rows.length ? 1 : 0);
    return true;
  }

  log(`raccoon 积分 · 共 ${rows.length} 个号`);
  for (const r of rows) {
    if (!r.ok) {
      log(`  ${label(r)} ❌ ${r.msg}`);
      if (r.relogin) log(`      → ${r.relogin}`);
      continue;
    }
    const detail = r.items.length ? r.items.map((i) => `${i.label} ${i.value}`).join(" · ") : "（上游未返回分项明细）";
    log(`  ${label(r)} 可用 ${r.total}　${detail}`);
  }
  log("");
  log("  ⚠ 「每日积分」当天 23:59:59 清零，当天不花就作废；奖励/充值积分不过期。上游按倍率自动先扣当日池。");
  log("  ⚠ 倍率 0 的模型不扣积分（`mslxdff -provider raccoon models` 看倍率列），想省积分优先用它们。");
  log("  登录奖励每号只有一次，登录时已自动领；本命令的 checkin 只是补领兜底。");
  exit(failed === rows.length ? 1 : 0);
  return true;
}
