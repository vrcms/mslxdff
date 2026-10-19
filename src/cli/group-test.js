// 组员链路测试：验证「本机 → 组长 → 某组员（含 relay 宽带成员）→ 上游 → 回数据」整条路。
//
// 为什么需要它：这条链路跨 3 台机器 + 1 道鉴权，坏了只会看到一句 `502 fetch failed`，
// 完全无法定位是哪一跳断的。本模块**按阶段**记录，把断点直接指出来：
//   ① 定位本机组/组长 → ② 取组长 token（调组长 forward 要**组长的** token，见下）→
//   ③ POST 组长 /v1/groups/relay/forward → ④ 判读回包（200 拿内容 / 401 鉴权 / 404 成员不存在 / 502·504 转发失败）
//
// ⚠ 鉴权事实（2026-10-19 实测）：`authorized()` 比的是**接收方自己的 token**，
//   而 `/v1/groups/relay/forward` 在路由层 requiresAuth=true ⇒ 要**组长 token**。
//   普通组员只有自己的 token ⇒ 调不动组长 forward（这就是"组员经组长"从没通的原因）。
//   本命令调用时用组长 token；若拿不到组长 token（如你只是组员且未持有），会明确报出这一步。
import { loadPeers, loadGroupsJoined, loadToken } from "../state.js";
import { compatFetch, timeoutSignal } from "../compat.js";

/** 默认探测模型与提示词。 */
export const DEFAULT_TEST_MODEL = "deepseek-v4.1-flash-free";
export const DEFAULT_TEST_PROMPT = "hi";

/**
 * 找一个可用的组长 token：优先 state.peers 里名为 leader 的记录，其次 groupsJoined 里非本机 url 的 peer。
 * @returns {{ leaderUrl: string, leaderToken: string, group: string, source: string } | null}
 */
export function resolveLeader({ peers = [], joined = [] } = {}) {
  const byName = (peers || []).find((p) => String(p?.name || "") === "leader" && p?.url);
  if (byName) {
    const g = joined.find((x) => x?.leaderUrl === byName.url);
    return { leaderUrl: byName.url, leaderToken: String(byName.token || ""), group: g?.name || "", source: "peers[leader]" };
  }
  // 兜底：用 groupsJoined 的 leaderUrl 去 peers 里找同 url 的记录取 token
  const g = (joined || []).find((x) => x?.leaderUrl);
  if (g) {
    const p = (peers || []).find((x) => x?.url === g.leaderUrl);
    return { leaderUrl: g.leaderUrl, leaderToken: String(p?.token || ""), group: g.name, source: "groupsJoined.leaderUrl" };
  }
  return null;
}

/**
 * 跑一次链路测试。返回结构化结果（不打印，由 CLI 渲染）。
 *
 * @param {{ group?: string, target: string, model?: string, prompt?: string, timeoutMs?: number,
 *           deps?: { peers?, joined?, myToken?, fetchImpl? } }} opts
 * @returns {Promise<{ status: "ok"|"error", stage: string, httpStatus?: number, content?: string,
 *                      reply?: any, leaderUrl?: string, group?: string, target: string, ms?: number,
 *                      error?: string, hint?: string }>}
 */
export async function runGroupLinkTest({
  group = "",
  target = "",
  model = DEFAULT_TEST_MODEL,
  prompt = DEFAULT_TEST_PROMPT,
  timeoutMs = 45_000,
  deps = {},
} = {}) {
  if (!target) return { status: "error", stage: "usage", target, error: "必须给目标组员（url、relay://id 或 -group list 里的序号对应项）" };

  const peers = deps.peers ?? loadPeers();
  const joined = deps.joined ?? loadGroupsJoined();
  const myToken = deps.myToken ?? (await loadToken()).token;
  const fetchImpl = deps.fetchImpl ?? compatFetch;

  const lead = resolveLeader({ peers, joined });
  if (!lead) return { status: "error", stage: "resolve-leader", target, error: "本机没有可用的组长记录（未加入任何组？）", hint: "先 mslxdff -addtogroup <组长host> <组名>" };
  const groupName = group || lead.group;
  if (!groupName) return { status: "error", stage: "resolve-group", target, error: "无法确定组名（state 里 peers/groupsJoined 缺 group）", hint: "用 -group 显式指定组名" };

  const reqId = `gt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const body = { group: groupName, target, reqId, body: { model, messages: [{ role: "user", content: prompt }], stream: false } };

  const t0 = Date.now();
  let res;
  try {
    res = await fetchImpl(`${lead.leaderUrl}/v1/groups/relay/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${lead.leaderToken}` },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    const msg = String(e?.message || e);
    return { status: "error", stage: "forward-fetch", target, leaderUrl: lead.leaderUrl, group: groupName, ms: Date.now() - t0,
      error: `连组长都打不通：${msg}`, hint: "组长地址/网络不通；先 mslxdff -group list 看组长健康" };
  }
  const ms = Date.now() - t0;
  const txt = await res.text().catch(() => "");

  // 按阶段归类失败 —— 这是本命令存在的意义：一眼看出断在哪一跳
  if (res.status === 401) {
    return { status: "error", stage: "auth", httpStatus: 401, target, leaderUrl: lead.leaderUrl, group: groupName, ms,
      error: "组长拒了鉴权（401）：调 /v1/groups/relay/forward 需要**组长的** token，本机没有",
      hint: "这是已知缺陷：组员中继链路的鉴权断了。修复 = 组长侧 forward 应接受成员 token（见 -group test 的 PR）" };
  }
  if (res.status === 404) {
    return { status: "error", stage: "target-missing", httpStatus: 404, target, leaderUrl: lead.leaderUrl, group: groupName, ms, error: txt.slice(0, 200), hint: "该目标不在组内（名称/url 对不上）；用 -group list 核对" };
  }
  if (res.status === 429) {
    return { status: "error", stage: "max-hops", httpStatus: 429, target, leaderUrl: lead.leaderUrl, group: groupName, ms, error: txt.slice(0, 200), hint: "转发跳数超限（有环）" };
  }
  if (res.status === 504) {
    return { status: "error", stage: "relay-timeout", httpStatus: 504, target, leaderUrl: lead.leaderUrl, group: groupName, ms, error: txt.slice(0, 200), hint: "组长入了队但目标成员没在 30s 内回结果（成员不在线/不通）" };
  }
  if (res.status !== 200) {
    const isFetchFail = /fetch failed/i.test(txt);
    const isRelay = String(target).startsWith("relay://");
    return { status: "error", stage: "forward-failed", httpStatus: res.status, target, leaderUrl: lead.leaderUrl, group: groupName, ms, error: txt.slice(0, 300),
      hint: isFetchFail && isRelay
        ? "对 relay 成员，502 fetch failed 通常是**该成员自己的上游**打不通（组长只负责转发，不碰上游）。判据：同组其他 relay 成员若正常，即证是这一台的网络/上游问题，不是组长。也可能是该成员离线。"
        : isFetchFail ? "组长直连该静态成员失败（它离线或端口不通）" : "" };
  }

  let reply = null;
  try { reply = JSON.parse(txt); } catch { reply = null; }
  const content = reply?.choices?.[0]?.message?.content ?? reply?.content ?? "";
  if (reply && (reply.error || reply.object === "error")) {
    return { status: "error", stage: "upstream", httpStatus: 200, target, leaderUrl: lead.leaderUrl, group: groupName, ms, reply, error: String(reply.error?.message || reply.error || "").slice(0, 300), hint: "组长转到了成员，但成员打上游失败（该成员自己的上游/额度问题）" };
  }
  return { status: "ok", stage: "done", httpStatus: 200, target, leaderUrl: lead.leaderUrl, group: groupName, ms, content: String(content || ""), reply };
}
