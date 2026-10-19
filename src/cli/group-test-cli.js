// `-group test` 的 CLI 适配层：把 -group list 的序号解析成 target，并把链路测试结果渲染成四态人话。
import { loadPeers, loadGroupsJoined, loadToken } from "../state.js";
import { refreshGroupMembers } from "../groups.js";
import { compatFetch, timeoutSignal } from "../compat.js";
import { resolveLeader } from "./group-test.js";

/**
 * 把用户给的 target 归一：数字 = -group list 里的序号；否则原样（url / relay://id）。
 * 与 -group list 的编号口径一致（跳过 leader、broadband/static 都算）。
 */
export async function resolveTargetArg(a, rest = []) {
  const raw = String(a ?? "").trim();
  if (!raw) return "";
  if (!/^\d+$/.test(raw)) return raw; // url 或 relay://id
  const seq = Number(raw);
  const joined = loadGroupsJoined();
  const g = joined.find((x) => x?.leaderUrl) || joined[0];
  if (!g) return "";
  let members;
  if (g.leaderUrl) {
    try {
      const { token } = await loadToken();
      members = await refreshGroupMembers(g.name, {
        leaderUrl: g.leaderUrl, memberName: g.memberName, url: g.myUrl, token,
        fetchImpl: (url, opts) => compatFetch(url, { ...opts, signal: timeoutSignal(4000) }),
      });
    } catch { return ""; }
  } else {
    return ""; // 本机是组长时，序号口径见 -group list（此处不展开）
  }
  const entries = Object.entries(members || {}).filter(([id]) => id !== "leader");
  const hit = entries[seq - 1];
  return hit ? (hit[1]?.url || hit[0]) : "";
}

/** 结果 → 人话。`json` 时直接吐结构化结果（脚本用）。 */
export function renderGroupTest(r, { json = false } = {}) {
  if (json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log("=".repeat(62));
  console.log(`  组员链路测试：本机 → 组长 → ${r.target}`);
  console.log("=".repeat(62));
  console.log(`  组长 ${r.leaderUrl || "?"}｜组 ${r.group || "?"}${r.ms !== undefined ? `｜耗时 ${r.ms}ms` : ""}`);
  console.log("");
  if (r.status === "ok") {
    console.log(`  ✅ 通了！经组长转发到该组员，上游返回：`);
    console.log(`     "${String(r.content || "").slice(0, 200) || "(空正文)"}"`);
    process.exitCode = 0;
    return;
  }
  const stageZh = {
    usage: "参数错误",
    "resolve-leader": "定位组长失败",
    "resolve-group": "确定组名失败",
    "forward-fetch": "连不上组长",
    auth: "鉴权被拒",
    "target-missing": "目标不在组内",
    "max-hops": "转发跳数超限",
    "relay-timeout": "组长入了队但成员没回",
    "forward-failed": "组长转发失败",
    upstream: "成员打上游失败",
  }[r.stage] || r.stage;
  console.log(`  ❌ 没通 — 断在：**${stageZh}**${r.httpStatus ? `（HTTP ${r.httpStatus}）` : ""}`);
  if (r.error) console.log(`     原因：${String(r.error).slice(0, 300)}`);
  if (r.hint) console.log(`     下一步：${r.hint}`);
  process.exitCode = 1;
}
