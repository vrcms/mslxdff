// mslxdff -provider globalqwenwork login — 千问办公**国际站**设备授权（PKCE + poll），对齐 qwenwork-login。
// 与 cn 站的三处实质差异（2026-10-01 现网取证）：
//  ① auth 域名 gateway.qwenwork.ai ② client_id cc65e5fc…（用 cn 的会整串 query 被判 not_allowed）
//  ③ 深链 redirect_uri=qwenwork://；三处全部来自 constants.js，本文件不重复硬编码。
// 授权后落盘 auths/globalqwenwork-<uid>.json + state 双写，默认 allowAny=false 并种 2 个实测模型（ADR-0041）。
import { compatFetch } from "../../../compat.js";
import { normalizeProviderId } from "../../../providers/model-id.js";
import { newDeviceFlow, pollGrant, userInfo, accountContext, expiryUnix } from "../../../providers/globalqwenwork/upstream.js";

const POLL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
// 国际站实测 qwork 切片恒为这 2 个（价因子 0，仍是额度池供应商 → 保持 allowAny=false 防 auto 烧分）
const SEED_MODELS = ["qwork-auto", "qwork-advanced"];

export async function handleGlobalQwenworkLogin(id, sub, rest = [], deps = {}) {
  if (normalizeProviderId(id) !== "globalqwenwork") return false;
  if (sub !== "login" && sub !== "auth" && sub !== "oauth") return false;
  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));

  const flow = await newDeviceFlow();
  log("=".repeat(60));
  log("  千问办公 · 国际站（QwenWork Global）登录");
  log("=".repeat(60));
  log("");
  log("  1. 在浏览器打开下面链接，用已登录**国际版**千问办公的账号确认授权");
  log("     （cn 站账号无效：实测 cn token 打 .ai userinfo → 401 INVALID_TOKEN）");
  log("  2. 授权成功后会自动完成，不要关闭本终端");
  log("");
  log(`  ${flow.url}`);
  log("");
  log("🔄 等待你授权（自动轮询，每 3 秒，最多 10 分钟）...");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let grant = null;
  for (;;) {
    if (Date.now() > deadline) {
      console.error("\n❌ 授权超时（10 分钟），请重新运行 mslxdff -provider globalqwenwork login");
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

  const { saveGlobalQwenworkAccount } = await import("../../../providers/globalqwenwork/account-store.js");
  const save = deps.saveAccount || saveGlobalQwenworkAccount;
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
  // 安全默认：allowAny 关 + 只放 2 个实测模型（额度池供应商，与 qwenwork/qoder 惯例一致，见 ADR-0041）
  try {
    const { saveProviderAllowAnyModels, saveProviderAllowedModels } = await import("../../../state.js");
    saveProviderAllowAnyModels("globalqwenwork", false);
    saveProviderAllowedModels("globalqwenwork", SEED_MODELS);
    log(`   allowAnyModels=off + allowlist 已种 ${SEED_MODELS.join("/")}（额度池供应商，防 auto 烧分）`);
  } catch {}
  // 额度展示：国际站免费档 pid 实测为 subscription-sgp-free（新加坡池，与 cn 积分池独立）
  try {
    const ctx = await accountContext(accessToken, fetchImpl);
    const plan = ctx?.plan || {};
    const quota = ctx?.quota || {};
    if (plan?.name || quota?.remaining !== undefined) {
      log(`   套餐: ${plan?.name || "-"} (${plan?.pid || "-"})  积分剩余: ${quota?.remaining ?? "-"}`);
    }
  } catch {
    log("   额度查询失败，不影响使用");
  }

  log("下一步：");
  log("  mslxdff -provider globalqwenwork models                  列模型列表");
  log("  mslxdff -restart（用户终端跑）                             重启网关使新账号生效");
  log(`  然后 curl http://localhost:8989/v1/chat/completions -d '{"model":"globalqwenwork/qwork-auto","messages":[{"role":"user","content":"hi"}]}'`);
  log("");
  log("多账号：重复 `mslxdff -provider globalqwenwork login` 追加，每号独立 uid，对话自动轮换");
  log("（与 cn 站 qwenwork 凭证不互通，两站可在同一 state.json 共存，账号文件前缀互不吞）");

  if (!deps.noExit) process.exit(0);
  return true;
}
