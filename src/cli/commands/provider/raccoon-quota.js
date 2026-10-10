// mslxdff -provider raccoon quota  — 查积分余额（五分项）
// mslxdff -provider raccoon checkin — 领每日登录积分（默认 3000，重复领取显示「今日已领取」而非报错）
import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch } from "../../../compat.js";
import { listRaccoonAccountDocs } from "../../../providers/raccoon/account-store.js";
import { claimRaccoonLoginReward, fetchRaccoonBalance } from "../../../providers/raccoon/credits.js";
import { raccoonTokenFingerprint } from "../../../providers/raccoon/auth.js";

const SUBS = new Set(["quota", "credits", "balance", "checkin", "signin"]);

function firstCredential(deps) {
  const docs = listRaccoonAccountDocs(deps.dir ? { dirs: [deps.dir] } : {});
  const doc = docs[0];
  if (!doc) return null;
  return {
    access_token: doc.accessToken,
    refresh_token: doc.refreshToken,
    office_identity: doc.officeIdentity,
    device_id: doc.deviceId,
    uid: doc.uid,
    name: doc.name,
  };
}

export async function handleRaccoonQuota(id, sub, rest = [], deps = {}) {
  const pid = normalizeProviderId(id) || String(id || "").toLowerCase();
  if (pid !== "raccoon") return false;
  if (!SUBS.has(sub)) return false;

  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const json = rest.includes("--json");
  const credential = deps.credential || firstCredential(deps);

  if (!credential) {
    if (json) log(JSON.stringify({ error: "not_logged_in", hint: "mslxdff -provider raccoon login" }));
    else {
      log("未登录：还没有可用的 raccoon 账号");
      log("  先运行: mslxdff -provider raccoon login");
    }
    exit(1);
    return true;
  }

  const isCheckin = sub === "checkin" || sub === "signin";

  try {
    if (isCheckin) {
      const r = await claimRaccoonLoginReward({ credential, fetchImpl, env: deps.env, now: deps.now });
      if (json) {
        log(JSON.stringify({ account: raccoonTokenFingerprint(credential.access_token), claimed: r.claimed, points: r.points }));
      } else if (r.claimed) {
        log(`✅ 已领取每日登录积分：+${r.points}`);
        log("   查看余额: mslxdff -provider raccoon quota");
      } else {
        log(`今日已领取（+${r.points}）—— 明天再来`);
        log("   查看余额: mslxdff -provider raccoon quota");
      }
      exit(0);
      return true;
    }

    const balance = await fetchRaccoonBalance({ credential, fetchImpl, env: deps.env });
    if (json) {
      log(JSON.stringify({ account: raccoonTokenFingerprint(credential.access_token), total: balance.total, items: balance.items }));
      exit(0);
      return true;
    }
    log(`raccoon 账号 ${raccoonTokenFingerprint(credential.access_token)}…  可用积分 ${balance.total}`);
    if (balance.items.length === 0) {
      log("  （上游未返回分项明细）");
    } else {
      for (const it of balance.items) log(`  ${it.label.padEnd(10, " ")} ${it.value}`);
    }
    log("");
    log("  积分制：每次调用按模型倍率扣分（见 mslxdff -provider raccoon models 的倍率列）");
    log("  回血: mslxdff -provider raccoon checkin（每日登录积分）");
    exit(0);
    return true;
  } catch (error) {
    const authExpired = error?.authExpired || error?.status === 401 || error?.code === 200001 || error?.code === 200003;
    if (json) {
      log(JSON.stringify({ error: authExpired ? "auth_expired" : "failed", message: String(error?.message ?? error) }));
    } else {
      log(`❌ ${error?.message ?? error}`);
      log(authExpired
        ? "   登录态已失效，请重新登录: mslxdff -provider raccoon login"
        : "   可稍后重试；若持续失败用 mslxdff -provider raccoon login 重新登录");
    }
    exit(1);
    return true;
  }
}
