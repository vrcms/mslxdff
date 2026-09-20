// `-provider codearts login`：浏览器 PKCE 登录华为云 → 凭证 blob 落盘 providerConfigs.codearts。
// 约定（对齐 cline-login/workbuddy-login）：不匹配返 false 交给下一个 handler；匹配即处理并退出。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { defaultStateFile, loadProviderKeys, saveProviderConfig, saveProviderAllowAnyModels, loadProviderBaseUrl } from "../../../state.js";
import { SNAP_BASE } from "../../../providers/codearts/const.js";
import { runCodeartsLogin, accountToBlob } from "../../../providers/codearts/login.js";
import { accountFromBlob } from "../../../providers/codearts/auth-pool.js";

export async function handleCodeartsLogin(id, sub, rest = [], deps = {}) {
  if (normalizeProviderId(id) !== "codearts") return false;
  if (!(sub === "login" || sub === "auth" || sub === "oauth")) return false;
  const noAllowAny = (rest || []).includes("--no-allow-any");
  const file = deps.file || defaultStateFile();
  const fetchImpl = deps.fetchImpl;
  const log = deps.log || ((m) => console.log(m));

  try {
    const { account, state } = await runCodeartsLogin({ fetchImpl, log });
    const blob = accountToBlob(account, { codeVerifier: state.codeVerifier, dpopJwk: state.dpopJwk, clientId: state.clientId });
    // 同一账号重复登录：替换旧 blob；新账号：追加（多账号 keyring 轮转）。
    // 去重键：userId 非空才可信；双方任一为空时退化为 refreshToken 比较
    // （空 userId==空 userId 的误判会把第二个不同账号当同一账号替换，真机实测恒剩 1 key）
    const cur = loadProviderKeys("codearts", { file }).filter((k) => {
      const parsed = accountFromBlob(k);
      if (!parsed) return false;
      if (parsed.userId && account.userId) return parsed.userId !== account.userId;
      return parsed.refreshToken !== account.refreshToken;
    });
    const baseUrl = loadProviderBaseUrl("codearts", { file }) || SNAP_BASE;
    saveProviderConfig("codearts", { baseUrl, keys: [...cur, blob] }, { file });
    if (!noAllowAny) saveProviderAllowAnyModels("codearts", true, { file });

    log("");
    log(`✅ codearts 登录成功：${account.userName || account.userId || "(user)"}（剩余账号数：${cur.length + 1}）`);
    log(`   baseUrl: ${baseUrl}`);
    log(`   凭证已写入 providerConfigs.codearts.keys（state.json，0600 权限目录，绝不入库）`);
    if (!noAllowAny) log("   allowAnyModels=on（免费福利供应商默认放行全部模型；收紧：mslxdff -provider codearts allowAny off）");
    log("   生效：mslxdff -restart（用户终端跑），然后 mslxdff -provider codearts models 验证");
    process.exit(0);
  } catch (err) {
    console.error(`❌ codearts 登录失败：${String(err?.message || err)}`);
    process.exit(1);
  }
  return true;
}
