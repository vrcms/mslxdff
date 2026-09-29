// mslxdff -provider zcode login — ZCode CLI 轮询授权（zai/bigmodel 双入口）。
// 授权后落盘 auths/zcode-<uid>.json（0600）+ state keys，并把内置目录补齐进 allowlist（开箱可用）。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch, uuid } from "../../../compat.js";
import { zcodeAppVersion } from "../../../providers/zcode/const.js";
import { tokenFingerprint } from "../../../providers/zcode/auth.js";
import { initZcodeFlow, waitForZcodeLogin } from "../../../providers/zcode/oauth.js";
import { listZcodeAccountDocs, saveZcodeAccount } from "../../../providers/zcode/account-store.js";
import { seedZcodeAllowlist } from "../../../providers/zcode/models.js";

const LOGIN_SUBS = new Set(["login", "auth", "oauth"]);

export async function handleZcodeLogin(id, sub, rest = [], deps = {}) {
  if (normalizeProviderId(id) !== "zcode") return false;
  if (!LOGIN_SUBS.has(sub)) return false;

  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const provider = rest.includes("--bigmodel") || rest.includes("--bm") ? "bigmodel" : "zai";

  // deviceMid：显式 > 既有 zcode 账号复用（设备身份跟账号走）> 临时生成（登录成功随账号落盘）。
  const existingMid = (() => {
    try {
      const docs = listZcodeAccountDocs(deps.dir ? { dirs: [deps.dir] } : {});
      return docs.map((d) => d.deviceMid).find(Boolean) || "";
    } catch {
      return "";
    }
  })();
  const deviceMid = deps.deviceMid || existingMid || uuid();

  log("=".repeat(60));
  log("  ZCode 登录（智谱免费额度）");
  log(`  入口: ${provider === "bigmodel" ? "BigModel（bigmodel.cn）" : "Z.ai（chat.z.ai）"}`);
  log("=".repeat(60));

  let out;
  try {
    const flow = await initZcodeFlow({ provider, fetchImpl, deviceMid, version: zcodeAppVersion() });
    log("");
    log("  1. 在浏览器打开下面链接，用智谱账号登录并完成授权");
    log("  2. 授权完成后本机自动继续（CLI 轮询，无需回调）");
    log("");
    log(`  ${flow.authorizeUrl}`);
    log("");
    log(`🔄 等待授权（每 ${Math.round(flow.pollIntervalMs / 1000)}s 轮询，最长 ${Math.max(1, Math.round((flow.expiresAtMs - Date.now()) / 1000))}s）...`);
    out = await waitForZcodeLogin({ flow, fetchImpl, log, sleepFn: deps.sleepFn });
  } catch (e) {
    log("");
    log(`❌ ${e?.message || e}`);
    log(`   （可重试：mslxdff -provider zcode login${provider === "bigmodel" ? " --bigmodel" : ""}）`);
    exit(1);
    return true;
  }

  const uid = out.user.userId;
  const save = deps.saveAccount || saveZcodeAccount;
  const saved = await save({
    uid,
    jwt: out.jwt,
    name: out.user.name,
    email: out.user.email,
    provider,
    deviceMid,
    dir: deps.dir,
    file: deps.file,
  });
  const allow = seedZcodeAllowlist({ file: deps.file });

  log("");
  log(`✅ 授权成功！uid=${uid}  昵称=${out.user.name || "(空)"}  token=${tokenFingerprint(out.jwt)}…`);
  log(`   凭据: ${saved.file}`);
  if (allow.added.length) log(`   allowlist 已补齐 ${allow.added.length} 个免费模型：${allow.added.join(", ")}`);
  log("   下一步: mslxdff -provider zcode quota 查看额度 · mslxdff -provider zcode models 查看模型");
  return true;
}
