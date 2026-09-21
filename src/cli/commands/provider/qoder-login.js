// mslxdff -provider qoder login — Qoder 设备授权（PKCE + poll），对齐 cline-login/traework-login。
// 授权后落盘 auths/qoder-<uid>.json + state.json，完成后进程退出。
import { compatFetch, timeoutSignal } from "../../../compat.js";
import { normalizeProviderId } from "../../../providers/model-id.js";
import { pkce, hex16, buildLoginUrl, waitForAuth, fetchUserInfo } from "../../../providers/qoder/oauth.js";

const REGIONS = ["global", "cn"];

export async function handleQoderLogin(id, sub, rest = [], deps = {}) {
  if (normalizeProviderId(id) !== "qoder") return false;
  if (sub !== "login" && sub !== "auth" && sub !== "oauth") return false;
  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));

  // 可选参数：--region cn 或 --region global（默认 global）
  const regionIdx = rest.indexOf("--region") >= 0 ? rest.indexOf("--region") : rest.indexOf("-r");
  const region = regionIdx >= 0 ? String(rest[regionIdx + 1] || "global").trim() : "global";
  const normRegion = region === "cn" ? "cn" : "global";

  const { verifier, challenge } = pkce();
  const nonce = hex16();
  const loginUrl = buildLoginUrl({ region: normRegion, nonce, challenge });

  log("=".repeat(60));
  log("  Qoder 登录");
  log(`  Region: ${normRegion === "cn" ? "中国站 (qoder.com.cn)" : "国际站 (qoder.com)"}`);
  log("=".repeat(60));
  log("");
  log("  1. 在浏览器打开下面链接，用 Qoder 账号登录（OAuth 授权）");
  log("  2. 登录成功后会自动完成授权，请等待回显");
  log("");
  log(`  ${loginUrl}`);
  log("");
  log("🔄 等待你授权（自动轮询，每 3 秒，最多 10 分钟）...");

  let bundle;
  try {
    bundle = await waitForAuth({ region: normRegion, nonce, verifier, fetchImpl, log });
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  }
  if (!bundle || !bundle.deviceToken) {
    console.error("\n❌ 未获取到 device token");
    process.exit(1);
  }

  log(`\n✅ 授权成功！deviceToken=${bundle.deviceToken.slice(0, 12)}...`);
  if (bundle.refreshToken) log(`    refreshToken=${bundle.refreshToken.slice(0, 12)}...`);

  // 取 userinfo
  let user = { uid: "", name: "", email: "", userType: "personal_standard", organizationId: "", organizationName: "" };
  try {
    user = await fetchUserInfo({ region: normRegion, deviceToken: bundle.deviceToken, fetchImpl });
    log(`    UID: ${user.uid}  昵称: ${user.name || "(空)"}  邮箱: ${user.email || "(空)"}`);
  } catch (e) {
    log(`    ⚠️ userinfo 失败: ${e.message}（使用 device token 前 8 位兜底 uid）`);
    user.uid = bundle.deviceToken.slice(0, 8);
  }
  if (!user.uid) {
    console.error("❌ 无法获取用户标识");
    process.exit(1);
  }

  // 落盘
  const { saveQoderAccount } = await import("../../../providers/qoder/account-store.js");
  const save = deps.saveAccount || saveQoderAccount;
  const saved = await save({
    uid: user.uid,
    deviceToken: bundle.deviceToken,
    refreshToken: bundle.refreshToken || "",
    region: normRegion,
    name: user.name,
    email: user.email,
    userType: user.userType,
    organizationId: user.organizationId,
    organizationName: user.organizationName,
  });

  log("");
  log("=".repeat(60));
  log(`✅ 登录完成！`);
  log(`   UID: ${user.uid}`);
  log(`   账号数: ${saved.accounts}${saved.updated ? "（旧号凭证已更新）" : ""}`);
  log(`   数据文件: ${saved.file}`);
  log("=".repeat(60));
  // 默认 allowAny on（免费福利供应商，对齐 codearts 惯例）
  try {
    const { saveProviderAllowAnyModels } = await import("../../../state.js");
    saveProviderAllowAnyModels("qoder", true);
    log("   allowAnyModels=on（免费福利供应商默认放行；收紧：mslxdff -provider qoder allowAny off）");
  } catch {}

  log("下一步：");
  log("  mslxdff -provider qoder models                  列模型列表");
  log("  mslxdff -restart（用户终端跑）                   重启网关使新账号生效");
  log("  然后 curl http://localhost:8989/v1/chat/completions -d '{\"model\":\"qoder/auto\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'");
  log("");
  log("多账号：重复 `mslxdff -provider qoder login` 追加，每号独立 uid，对话自动轮换");

  if (!deps.noExit) process.exit(0);
  return true;
}