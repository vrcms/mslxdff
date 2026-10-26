// mslxdff -provider todaycn login — Today AI 多号接入：
//   默认：解密本机桌面登录态（Windows/DPAPI）导入这一枚 refreshCredential（一机一号）；
//   --refresh <串>：手填另一台机/另一个账号的 refreshCredential —— 多号轮换的唯一途径。
// 落盘 auths/todaycn-<uid>.json（0600）+ state.providerConfigs.todaycn.keys，并按账号目录播种 allowlist。
// 全部动作都在控制面（refresh / pricing-status 均不消耗额度），登录不烧配额。

import { createHash } from "node:crypto";
import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch } from "../../../compat.js";
import { readTodaycnDesktopSession } from "../../../providers/todaycn/session.js";
import { listTodaycnAccountDocs, saveTodaycnAccount } from "../../../providers/todaycn/account-store.js";
import { createTokenStore } from "../../../providers/todaycn/token.js";
import { parseModelStatus, seedTodaycnAllowlist } from "../../../providers/todaycn/models.js";
import { buildHeaders } from "../../../providers/todaycn/chat.js";
import { TODAYCN_API_BASE, toGatewayModelId } from "../../../providers/todaycn/const.js";

const LOGIN_SUBS = new Set(["login", "auth"]);

/** 凭据指纹（uid 取不到时的兜底账号 id）：同一枚凭据稳定，不泄露原文。 */
export function credentialFingerprint(credential = "") {
  return createHash("sha1").update(String(credential)).digest("hex").slice(0, 12);
}

/** 从 accessToken（JWT）payload 里认 uid；认不到给空串（调用方兜底指纹）。 */
export function uidFromToken(token = "") {
  try {
    const part = String(token).split(".")[1];
    if (!part) return "";
    const p = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return String(p?.sub || p?.uid || p?.userId || p?.user?.id || "");
  } catch {
    return "";
  }
}

/** 该号当前可选模型位（pricing/status 的 modelOptions；失败给空数组，登录照旧成功）。 */
async function loadOptionIds(token, { fetchImpl, apiBase }) {
  try {
    const res = await fetchImpl(`${apiBase}/v1/pricing/status`, { headers: buildHeaders(token, "") });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    return parseModelStatus(json).options.map((o) => o.optionId).filter(Boolean);
  } catch {
    return [];
  }
}

export async function handleTodaycnLogin(id, sub, rest = [], deps = {}) {
  if (normalizeProviderId(id) !== "todaycn") return false;
  if (!LOGIN_SUBS.has(sub)) return false;

  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const apiBase = deps.apiBase || TODAYCN_API_BASE;
  const save = deps.saveAccount || saveTodaycnAccount;

  const at = rest.findIndex((x) => x === "--refresh" || x === "--refresh-credential" || x === "--credential");
  const manual = at >= 0 ? String(rest[at + 1] || "").trim() : "";

  log("=".repeat(60));
  log("  Today AI 登录（今日工作助手 · api.todayai.cn）");
  log("=".repeat(60));

  let credential = manual;
  let uid = "";
  let name = "";
  let email = "";

  if (manual) {
    log("  来源: --refresh 手填凭据");
  } else {
    const s = readTodaycnDesktopSession(deps.dir ? { dir: deps.dir } : {});
    if (!s.ok) {
      log("");
      log(`❌ 本机登录态导入失败：${s.reason}`);
      log("   另一条路（多号 / 其它机器）：mslxdff -provider todaycn login --refresh <refreshCredential>");
      exit(1);
      return true;
    }
    credential = s.refreshCredential;
    uid = s.uid;
    name = s.name;
    email = s.email;
    log(`  来源: 本机桌面登录态（${s.dir}）`);
  }

  const store = createTokenStore({ fetchImpl });
  const tok = await store.getToken(credential, { force: true });
  if (!tok.ok) {
    log("");
    log(`❌ 这枚凭据换不到令牌：${tok.reason}`);
    log("   检查：复制是否漏字符 / 该号是否已在别处登出 / 是否把 accessToken 当成了 refreshCredential");
    log("   本机重新导入：先在桌面客户端登录一次，再跑 mslxdff -provider todaycn login");
    exit(1);
    return true;
  }
  if (!uid) uid = uidFromToken(tok.token) || `cred-${credentialFingerprint(credential)}`;

  const saved = await save({ uid, refreshCredential: credential, name, email, dir: deps.dir, file: deps.file });
  const optionIds = await loadOptionIds(tok.token, { fetchImpl, apiBase });
  const allow = seedTodaycnAllowlist({ ids: optionIds, file: deps.file });
  const total = (() => {
    try { return listTodaycnAccountDocs().length; } catch { return 0; }
  })();

  log("");
  log(`✅ 已接入：uid=${uid}${name ? `  昵称=${name}` : ""}  token=${tok.token.slice(0, 12)}…`);
  log(`   凭据: ${saved.file}${saved.updated ? "（更新既有号）" : "（新号）"}`);
  log(`   账号总数: ${total} 个（轮换顺序 = 落盘顺序）`);
  if (allow.allowed.length) {
    log(`   allowlist: ${allow.allowed.map((m) => toGatewayModelId(m)).join(", ")}${allow.added.length ? `（本次新增 ${allow.added.length}）` : ""}`);
  } else {
    log("   allowlist: 暂空 —— 目录要等 provider 装配后拉取；先跑 mslxdff -provider todaycn models 看看");
  }
  log("");
  log(`   下一步: mslxdff -provider todaycn models          列出可选模型位（含消耗倍率）`);
  log(`           加第二号（多号轮换）: mslxdff -provider todaycn login --refresh <另一枚 refreshCredential>`);
  log(`           生效: mslxdff -provider todaycn models 后如常使用（模型 id: todaycn/<模型名>）`);
  return true;
}