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

  log("");
  log(`✅ 登录成功！uid=${uid}  昵称=${info.name || "(空)"}  token=${raccoonTokenFingerprint(credential.access_token)}…`);
  log(`   凭据: ${saved.file}`);
  if (allow.added.length) log(`   allowlist 已补齐 ${allow.added.length} 个模型：${allow.added.join(", ")}`);
  log("   下一步: mslxdff -provider raccoon quota 查看积分 · mslxdff -provider raccoon models 查看模型（含积分倍率）");
  return true;
}
