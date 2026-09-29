// mslxdff -provider qwenwork login — 千问办公设备授权（PKCE + poll），对齐 qoder-login。
// 授权后落盘 auths/qwenwork-<uid>.json + state 双写，默认 allowAny=false 并种 3 个实测模型（ADR-0037）。
import { compatFetch } from "../../../compat.js";
import { normalizeProviderId } from "../../../providers/model-id.js";
import { newDeviceFlow, pollGrant, userInfo, accountContext, expiryUnix } from "../../../providers/qwenwork/upstream.js";

const POLL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export async function handleQwenworkLogin(id, sub, rest = [], deps = {}) {
  if (normalizeProviderId(id) !== "qwenwork") return false;
  if (sub !== "login" && sub !== "auth" && sub !== "oauth") return false;
  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));

  const flow = await newDeviceFlow();
  log("=".repeat(60));
  log("  千问办公（QwenWork）登录");
  log("=".repeat(60));
  log("");
  log("  1. 在浏览器打开下面链接，用已登录千问办公的账号确认授权");
  log("  2. 授权成功后会自动完成，不要关闭本终端");
  log("");
  log(`  ${flow.url}`);
  log("");
  log("🔄 等待你授权（自动轮询，每 3 秒，最多 10 分钟）...");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let grant = null;
  for (;;) {
    if (Date.now() > deadline) {
      console.error("\n❌ 授权超时（10 分钟），请重新运行 mslxdff -provider qwenwork login");
      process.exit(1);
    }
    let outcome;
    try {
      outcome = await pollGrant(flow.nonce, flow.verifier, fetchImpl);
    } catch (e) {
      console.error(`\n❌ 轮询失败: ${e.message}`);
      process.exit(1);
    }
    if (!outcome.pending) { grant = outcome.grant; break; }
    try { process.stdout.write("."); } catch {}
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const accessToken = grant.token || grant.device_token;
  const refreshToken = grant.refresh_token || "";
  if (!accessToken) {
    console.error("\n❌ 未获取到 token");
    process.exit(1);
  }
  log(`\n✅ 授权成功！token=${String(accessToken).slice(0, 12)}...`);
  if (refreshToken) log(`    refreshToken=${String(refreshToken).slice(0, 12)}...`);

  let uid = String(grant.user_id || "");
  let name = String(grant.user_name || "");
  let email = "";
  try {
    const info = await userInfo(accessToken, fetchImpl);
    if (info?.id) uid = String(info.id);
    if (info?.name) name = String(info.name);
    if (info?.email) email = String(info.email);
    log(`    UID: ${uid}  昵称: ${name || "(空)"}  邮箱: ${email || "(空)"}`);
  } catch (e) {
    log(`    ⚠️ userinfo 失败: ${e.message}（用 grant 兜底）`);
    if (!uid) uid = String(accessToken).slice(0, 8);
  }
  if (!uid) {
    console.error("❌ 无法获取用户标识");
    process.exit(1);
  }

  const { saveQwenworkAccount } = await import("../../../providers/qwenwork/account-store.js");
  const save = deps.saveAccount || saveQwenworkAccount;
  const saved = await save({
    uid,
    accessToken,
    refreshToken,
    expiresAt: expiryUnix(grant),
    name,
    email,
  });

  log("");
  log("=".repeat(60));
  log("✅ 登录完成！");
  log(`   UID: ${uid}`);
  log(`   账号数: ${saved.accounts}${saved.updated ? "（旧号凭证已更新）" : ""}`);
  log(`   数据文件: ${saved.file}`);
  log("=".repeat(60));
  // 安全默认：allowAny 关 + 只放 3 个实测模型（与 qoder 惯例故意不同，见 ADR-0037）
  try {
    const { saveProviderAllowAnyModels, saveProviderAllowedModels } = await import("../../../state.js");
    saveProviderAllowAnyModels("qwenwork", false);
    saveProviderAllowedModels("qwenwork", ["flash", "pro", "qwen3.8-max-preview"]);
    log("   allowAnyModels=off + allowlist 已种 flash/pro/qwen3.8-max-preview（额度池供应商，防 auto 烧分）");
  } catch {}
  // 额度展示
  try {
    const ctx = await accountContext(accessToken, fetchImpl);
    const plan = ctx?.plan || {};
    const quota = ctx?.quota || {};
    if (plan?.name || quota?.remaining !== undefined) {
      log(`   套餐: ${plan?.name || "-"}  积分剩余: ${quota?.remaining ?? "-"}`);
    }
  } catch {
    log("   额度查询失败，不影响使用");
  }

  log("下一步：");
  log("  mslxdff -provider qwenwork models                  列模型列表");
  log("  mslxdff -restart（用户终端跑）                       重启网关使新账号生效");
  log("  然后 curl http://localhost:8989/v1/chat/completions -d '{\"model\":\"qwenwork/flash\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'");
  log("");
  log("多账号：重复 `mslxdff -provider qwenwork login` 追加，每号独立 uid，对话自动轮换");

  if (!deps.noExit) process.exit(0);
  return true;
}
