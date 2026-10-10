// mslxdff -provider raccoon login — 扫码登录（终端二维码 + 轮询）。
// 实测该链路匿名可达且**不需要验证码**；成功后落盘 auths/raccoon-<uid>.json（0600）
// 并把兜底目录只增不减补齐进 allowlist（避免「登录成功却处处 403」）。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch } from "../../../compat.js";
import {
  buildQrUrl,
  createQrCode,
  fetchRaccoonUserInfo,
  pollQrLogin,
} from "../../../providers/raccoon/login.js";
import { encodeQr, renderTerminal } from "../../../providers/raccoon/qr.js";
import { ensureRaccoonDeviceId, saveRaccoonAccount } from "../../../providers/raccoon/account-store.js";
import { seedRaccoonAllowlist } from "../../../providers/raccoon/models.js";
import { raccoonTokenFingerprint, resolveRaccoonUid } from "../../../providers/raccoon/auth.js";
import { claimRaccoonLoginReward, raccoonClaimStatus } from "../../../providers/raccoon/credits.js";

const LOGIN_SUBS = new Set(["login", "auth", "oauth"]);

export async function handleRaccoonLogin(id, sub, rest = [], deps = {}) {
  const pid = normalizeProviderId(id) || String(id || "").toLowerCase();
  if (pid !== "raccoon") return false;
  if (!LOGIN_SUBS.has(sub)) return false;

  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));

  const code = deps.qrCode || createQrCode();
  const url = buildQrUrl(code);

  log("=".repeat(60));
  log("  Raccoon 登录（商汤小浣熊 · 积分制模型池）");
  log("=".repeat(60));
  log("");
  log("  1. 用微信「扫一扫」扫描下方二维码，并在微信里点确认（浏览器直接打开会 404）");
  log("  2. 确认后本机自动继续（CLI 轮询，无需回调）");
  log("");

  const art = renderTerminal(encodeQr(url));
  if (art) {
    log(art);
    log("");
  }
  log(`  登录链接：${url}`);
  log("");
  log("🔄 等待扫码确认…");

  let out;
  try {
    out = await pollQrLogin(code, {
      fetchImpl,
      sleepFn: deps.sleepFn,
      intervalMs: deps.intervalMs,
      timeoutMs: deps.timeoutMs,
      onTick: deps.onTick,
    });
  } catch (error) {
    log("");
    log(`❌ 登录失败：${error?.message ?? error}`);
    log("   （可重试：mslxdff -provider raccoon login）");
    exit(1);
    return true;
  }

  if (out.status === "canceled") {
    log("");
    log("❌ 已在手机端取消登录（未写入任何凭据）");
    exit(1);
    return true;
  }
  if (out.status !== "success") {
    log("");
    log("❌ 登录已超时，请重新运行 login");
    log("   （可重试：mslxdff -provider raccoon login）");
    exit(1);
    return true;
  }

  const credential = out.credential;
  const info = await fetchRaccoonUserInfo(credential, { fetchImpl });
  const uid = resolveRaccoonUid({
    userId: info.userId,
    officeIdentity: info.officeIdentity || credential.office_identity,
    token: credential.access_token,
  });
  const deviceId = deps.deviceId || ensureRaccoonDeviceId({ uid, dir: deps.dir });
  const save = deps.saveAccount || saveRaccoonAccount;
  const saved = await save({
    uid,
    accessToken: credential.access_token,
    refreshToken: credential.refresh_token || "",
    expiresAt: credential.expires_at || "",
    officeIdentity: info.officeIdentity || credential.office_identity || "",
    deviceId,
    name: info.name || "",
    phone: info.phone || "",
    dir: deps.dir,
    file: deps.file,
  });
  const allow = seedRaccoonAllowlist({ file: deps.file });

  // 一次性新手礼包只能在这儿领：此刻 access_token 刚签发（寿命约 3 小时），是全程唯一稳的窗口。
  // 刻意不交给 daemon 定时去做 —— 那时 token 多半已过期，要续期就得和网关请求抢同一条一次性 refresh_token。
  let reward;
  if (!deps.skipReward) {
    const claim = deps.claimReward || claimRaccoonLoginReward;
    try {
      reward = await claim({ credential, fetchImpl, env: deps.env });
    } catch (e) {
      reward = { status: "error", msg: String(e?.message || e).slice(0, 120) };
    }
  }

  log("");
  log(`✅ 登录成功！uid=${uid}  昵称=${info.name || "(空)"}  token=${raccoonTokenFingerprint(credential.access_token)}…`);
  log(`   凭据: ${saved.file}`);
  if (allow.added.length) log(`   allowlist 已补齐 ${allow.added.length} 个模型：${allow.added.join(", ")}`);
  if (reward) {
    const line = {
      claimed: `🎁 已领取登录奖励 +${reward.points} 分（每号仅此一次，账单已确认入账）`,
      already: `   登录奖励此前已领过 —— 这家每号只有一次，不是每日签到`,
      phantom: `   ⚠ 上游回执「成功」但账单里没有这笔 —— 实为未到账，可稍后用 -provider raccoon checkin 复核`,
      unverified: `   已提交领取，但账单暂时查不到，稍后用 -provider raccoon quota 核对`,
      error: `   领取登录奖励失败：${reward.msg || "未知原因"}`,
    }[reward.status || raccoonClaimStatus(reward)];
    if (line) log(line);
  }
  log("   下一步: mslxdff -provider raccoon quota 查看积分 · mslxdff -provider raccoon models 查看模型（含积分倍率）");
  return true;
}
