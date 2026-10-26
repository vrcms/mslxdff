// mslxdff -provider todaycn persona [show|apply|rollback] —— 把「工具契约」写进 / 摘出 agent 人设。
//
// 为什么需要它：Today 没有 system prompt 通道，也没有逐请求 tools 参数，工具只能靠文本契约模拟。
// 只按轮在消息里写契约时，任务型请求会被平台自带工具通道劫走（原话「已经派出去抓了」，零 tool_calls）；
// 把同一份契约定格进 agent 人设（`PATCH /v1/agents/default` 的 agentCharacter，控制面免费、
// 是产品允许用户自己改的设置项）后，实测同一句请求稳定回单行 JSON。详见 persona.js 顶部注释。
// 代价：人设是账号级、全局生效（桌面端聊天同样受影响），故契约只对「我在写一个小脚本」开头的
// 机器请求生效，普通聊天不受影响；随时 `rollback` 幂等摘除。

import { normalizeProviderId } from "../../../providers/model-id.js";
import { compatFetch } from "../../../compat.js";
import { listTodaycnAccountDocs } from "../../../providers/todaycn/account-store.js";
import { createTokenStore } from "../../../providers/todaycn/token.js";
import {
  TODAYCN_PERSONA_CONTRACT,
  applyTodaycnPersona,
  hasPersonaContract,
  readTodaycnPersona,
  removeTodaycnPersona,
} from "../../../providers/todaycn/persona.js";
import { TODAYCN_API_BASE } from "../../../providers/todaycn/const.js";

const SUBS = new Set(["persona", "contract", "persona-contract"]);
const ACTIONS = new Set(["show", "apply", "rollback"]);

function normalizeAction(sub = "", rest = []) {
  const hit = rest.find((x) => ACTIONS.has(x));
  if (hit) return hit;
  if (["off", "remove", "revert", "rollback"].includes(String(rest[0] || sub || ""))) return "rollback";
  if (["on", "add", "enable", "apply"].includes(String(rest[0] || sub || ""))) return "apply";
  return "show";
}

export async function handleTodaycnPersona(id, sub, rest = [], deps = {}) {
  if (normalizeProviderId(id) !== "todaycn") return false;
  if (!SUBS.has(sub)) return false;

  const action = normalizeAction(sub, rest);
  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));
  const apiBase = deps.apiBase || TODAYCN_API_BASE;

  log("=".repeat(60));
  log("  Today AI · agent 人设契约（工具调用的格式约定）");
  log("=".repeat(60));

  const uidArg = (() => {
    const i = rest.findIndex((x) => x === "--uid");
    return i >= 0 ? String(rest[i + 1] || "").trim() : "";
  })();
  let accounts = Array.isArray(deps.accounts) ? deps.accounts : [];
  if (!Array.isArray(deps.accounts)) { try { accounts = listTodaycnAccountDocs(); } catch {} }
  const acct = uidArg ? accounts.find((a) => String(a.uid) === uidArg) : accounts[0];
  if (!acct) {
    log("");
    log(uidArg ? `❌ 找不到 uid=${uidArg} 的落盘账号` : "❌ 没有落盘账号");
    log("   先接入账号: mslxdff -provider todaycn login");
    exit(1);
    return true;
  }

  const store = createTokenStore({ fetchImpl });
  const tok = await store.getToken(acct.refreshCredential);
  if (!tok.ok) {
    log("");
    log(`❌ 该号换不到令牌：${tok.reason}`);
    log("   检查凭据是否失效；必要时重新跑 mslxdff -provider todaycn login");
    exit(1);
    return true;
  }
  const call = { token: tok.token, fetchImpl, apiBase, deviceId: acct.deviceId };

  log("");
  log(`  账号: uid=${acct.uid}${acct.name ? `  昵称=${acct.name}` : ""}  动作=${action}`);
  log("");

  if (action === "show") {
    const r = await readTodaycnPersona(call);
    if (!r.ok) {
      log(`❌ 读人设失败（HTTP ${r.status}）${String(r.text || "").slice(0, 160)}`);
      exit(1);
      return true;
    }
    const has = hasPersonaContract(r.agentCharacter);
    log(`  agentName: ${r.agentName || "(空)"}`);
    log(`  agentCharacter: ${r.agentCharacter.length} 字`);
    log(`  契约段是否已写入: ${has ? "是" : "否"}`);
    log("");
    log(`  人设预览（末 300 字）：\n${r.agentCharacter.slice(-300) || "(空)"}`);
    log("");
    log(has
      ? "  下一步: 要摘掉就 mslxdff -provider todaycn persona rollback"
      : "  下一步: 要写入就 mslxdff -provider todaycn persona apply");
    return true;
  }

  const r = action === "apply" ? await applyTodaycnPersona(call) : await removeTodaycnPersona(call);
  if (!r.ok) {
    log(`❌ ${action === "apply" ? "写入" : "摘除"}失败（HTTP ${r.status}）：${r.reason || ""}`);
    exit(1);
    return true;
  }
  log(`  ${action === "apply" ? "写入" : "摘除"}${r.changed ? "完成" : "跳过（幂等）"}：agentCharacter ${String(r.before || "").length} 字 → ${String(r.after || "").length} 字`);
  if (r.reason) log(`  说明: ${r.reason}`);
  if (action === "apply") {
    log("");
    log(`  契约已进人设（${TODAYCN_PERSONA_CONTRACT.length} 字）。它只对「我在写一个小脚本」开头的机器请求生效，`);
    log("  普通聊天照旧 —— 桌面端对话不受影响。");
    log("  下一步: mslxdff -provider todaycn persona show 复核 · 不满意就 persona rollback");
  } else {
    log("");
    log("  人设里的契约段已摘除（其余文字一字未动）。");
    log("  下一步: mslxdff -provider todaycn persona show 复核");
  }
  return true;
}