// mslxdff -provider zcode quota — 查询 ZCode 免费/订阅额度（billing/balance）。
// 未登录 → login 指引 + 非零退出；401 → 重登指引；空套餐 → 领取指引（全人话，不出堆栈）。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch } from "../../../compat.js";
import { loadProviderKeys } from "../../../state.js";
import { listZcodeAccountDocs } from "../../../providers/zcode/account-store.js";
import { zcodeAppVersion } from "../../../providers/zcode/const.js";
import { fetchZcodeBalance, formatZcodeQuota } from "../../../providers/zcode/quota.js";

export async function handleZcodeQuota(id, sub, rest = [], deps = {}) {
  if (normalizeProviderId(id) !== "zcode") return false;
  if (String(sub || "").toLowerCase() !== "quota") return false;

  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const wantsJson = rest.includes("--json") || rest.includes("-json");

  let keys = [];
  try {
    keys = loadProviderKeys("zcode", deps.file ? { file: deps.file } : {});
  } catch {
    keys = [];
  }
  if (!keys.length) {
    log("zcode quota：尚未登录。先运行：");
    log("  mslxdff -provider zcode login");
    log("（授权后即可查看 Start/Coding Plan 额度，全程无需验证码）");
    exit(1);
    return true;
  }

  const token = keys[0];
  const deviceMid = deps.deviceMid || (() => {
    try {
      return listZcodeAccountDocs(deps.dir ? { dirs: [deps.dir] } : {}).map((d) => d.deviceMid).find(Boolean) || "";
    } catch {
      return "";
    }
  })();
  const result = await fetchZcodeBalance({ token, deviceMid, fetchImpl, version: deps.version || zcodeAppVersion() });

  if (wantsJson) {
    const payload = result.ok
      ? { provider: "zcode", keys: keys.length, ok: true, parsed: result.parsed }
      : { provider: "zcode", keys: keys.length, ok: false, kind: result.kind, code: result.code, message: result.message };
    log(JSON.stringify(payload, null, 2));
    exit(result.ok ? 0 : 1);
    return true;
  }
  log(formatZcodeQuota(result));
  if (!result.ok) log(`  （已登录账号 ${keys.length} 个；换号/重登：mslxdff -provider zcode login）`);
  exit(result.ok ? 0 : 1);
  return true;
}
