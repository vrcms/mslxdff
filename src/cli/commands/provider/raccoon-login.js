// mslxdff -provider raccoon login — 扫码登录（终端二维码 + 轮询）。
// ⚠ 2026-10 上游改版：二维码必须**先由服务端签发**（POST /api/iam/v1/auth/mp/qrcode），
//   拿到 qrcode_code + scan_path 才能渲染。旧的「本地自造 code」在新通道下没有服务端会话，
//   微信扫码后查不到该码 → 手机端报「二维码已过期或已被使用」。详见 src/providers/raccoon/login.js。
// 该链路匿名可达且**不需要验证码**；成功后落盘 auths/raccoon-<uid>.json（0600）
// 并把兜底目录只增不减补齐进 allowlist（避免「登录成功却处处 403」）。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch } from "../../../compat.js";
import {
  buildQrUrl,
  cancelQrSession,
  confirmRaccoonSession,
  createQrSession,
  fetchRaccoonUserInfo,
  pollQrLogin,
} from "../../../providers/raccoon/login.js";
import { encodeQr, renderTerminal } from "../../../providers/raccoon/qr.js";
import { ensureRaccoonDeviceId, saveRaccoonAccount } from "../../../providers/raccoon/account-store.js";
import { seedRaccoonAllowlist } from "../../../providers/raccoon/models.js";
import { raccoonTokenFingerprint, resolveRaccoonUid } from "../../../providers/raccoon/auth.js";
import { claimRaccoonLoginReward, raccoonClaimStatus } from "../../../providers/raccoon/credits.js";

const LOGIN_SUBS = new Set(["login", "auth", "oauth"]);

const RELOGIN_HINT = "   （可重试：mslxdff -provider raccoon login）";

export async function handleRaccoonLogin(id, sub, rest = [], deps = {}) {
  const pid = normalizeProviderId(id) || String(id || "").toLowerCase();
  if (pid !== "raccoon") return false;
  // `login --password` 走手机号+密码（多账号免扫码）；无该旗标仍是扫码。分派必须在
  // LOGIN_SUBS 判定之前，且只在此处转交 —— 扫码路径本身零改动。
  if (LOGIN_SUBS.has(sub) && rest.some((x) => {
    const s = String(x);
    return s === "--password" || s.startsWith("--password=") || s === "-p" || s === "--phone" || s.startsWith("--phone=");
  })) {
    const { handleRaccoonPasswordLogin } = await import("./raccoon-password.js");
    return handleRaccoonPasswordLogin(id, sub, rest, deps);
  }
  if (!LOGIN_SUBS.has(sub)) return false;

  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));

  log("=".repeat(60));
  log("  Raccoon 登录（商汤小浣熊 · 积分制模型池）");
  log("=".repeat(60));
  log("");
  log("  1. 用微信「扫一扫」扫描下方二维码，并在微信里点确认（浏览器直接打开会 404）");
  log("  2. 确认后本机自动继续（CLI 轮询，无需回调）");
  log("");

  // 签发二维码：这一步失败就没有可扫的码，必须当场说清楚，不能拿一个假码糊过去
  let session;
  try {
    session = deps.qrSession || await createQrSession({ fetchImpl });
  } catch (error) {
    log(`❌ 无法获取二维码：${error?.message ?? error}`);
    log("   （多为网络不通或上游改版；可重试：mslxdff -provider raccoon login）");
    exit(1);
    return true;
  }
  const code = deps.qrCode || session.qrcodeCode;
  const url = deps.qrUrl || buildQrUrl(code, session.scanPath);

  const art = renderTerminal(encodeQr(url));
  if (art) {
    log(art);
    log("");
  }
  log(`  登录链接：${url}`);
  log(`  有效期：${Math.round(session.expiresInMs / 1000)} 秒（过期请重跑本命令）`);
  log("");
  log("🔄 等待扫码确认…");

  let out;
  try {
    out = await pollQrLogin(code, {
      fetchImpl,
      sleepFn: deps.sleepFn,
      intervalMs: deps.intervalMs ?? session.pollIntervalMs,
      timeoutMs: deps.timeoutMs ?? session.expiresInMs,
      onTick: deps.onTick,
    });
  } catch (error) {
    log("");
    log(`❌ 登录失败：${error?.message ?? error}`);
    log(RELOGIN_HINT);
    exit(1);
    return true;
  }

  if (out.status !== "success") {
    // 非终态失败：回收服务端会话（失败也不打断），并对每种结局给一句人话
    await cancelQrSession(code, { fetchImpl });
    log("");
    if (out.status === "canceled") log("❌ 已在手机端取消登录（未写入任何凭据）");
    else if (out.status === "expired") log("❌ 二维码已过期（上游作废了本次会话）");
    else log("❌ 登录已超时");
    log(RELOGIN_HINT);
    exit(1);
    return true;
  }

  return await finishRaccoonLogin({ credential: out.credential, fetchImpl, deps, log });
}

/**
 * 登录成功后的收尾四步（**扫码与密码两条路共用，单一源**）：
 * confirm 会话 → 取用户信息 → 落盘 + 补 allowlist → 领一次性登录奖励 → 打印回执。
 *
 * 抽出来的理由不只是省行数：这四步的顺序有硬约束（必须先 confirm 才能用 token；领奖必须在
 * access_token 刚签发的窗口内），任何一条路径自己重写一遍都会漏掉其中一步且难以察觉。
 *
 * @param {object} a
 * @param {object} a.credential 已签发的凭据（两种登录方式同形）
 * @param {Function} a.fetchImpl
 * @param {object} a.deps 与原 CLI 依赖注入同形（dir/file/deviceId/saveAccount/claimReward/skipReward/env）
 * @param {Function} a.log
 * @param {string} [a.methodNote] 登录方式说明行（如密码登录标注手机号），纯展示
 * @returns {Promise<boolean>} 恒 true（表示「已处理」，交还 CLI 派发链）
 */
export async function finishRaccoonLogin({ credential, fetchImpl, deps = {}, log, methodNote = "" }) {
  // 新登录的会话是「未确认」状态：不先 POST /iam/confirm，此后所有业务端点（含下面的领奖励、
  // 以及 daemon 的 chat）都会撞 `400 code 200901 iam_confirm_required`。登录时当场确认一次，
  // 让落盘的凭据从一开始就是可用的；确认失败不阻断（chat.js 有懒重试兜底），只在末尾如实提示。
  const confirmed = await confirmRaccoonSession(credential, { fetchImpl });
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
  if (methodNote) log(methodNote);
  log(`   凭据: ${saved.file}`);
  if (!confirmed) log("   ⚠ 会话确认（iam/confirm）暂未成功 —— 不影响使用（调用时会自动重试确认），若持续报错请重跑 login");
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
