import { createGroupsService } from "../groups.js";
import { createPeersService } from "../peers.js";
import { loadToken } from "../state.js";
import { markJoined, syncAllJoinedGroups } from "./group-helpers.js";
import { compatFetch, timeoutSignal } from "../compat.js";
import { errMsg } from "./util.js";

const DEFAULT_PORT = 8989;
const JOIN_TIMEOUT_MS = 8000;

/** 组长地址归一化 + 人话校验（ADR-0006 术语 leader-host）：`1.2.3.4` → `http://1.2.3.4:8989`。 */
export function normalizeLeaderUrl(raw, { defaultPort = DEFAULT_PORT } = {}) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, reason: "请填写组长地址（如 1.2.3.4:8989）" };
  if (/\s/.test(s)) return { ok: false, reason: "地址不能包含空格" };
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) {
    return { ok: false, reason: "只支持 http:// 或 https:// 开头的地址" };
  }
  const withScheme = Boolean(schemeMatch);
  let body = withScheme ? s.slice(schemeMatch[0].length) : s;
  if (body.endsWith("/")) body = body.replace(/\/+$/, "");
  if (body.includes("/")) return { ok: false, reason: "暂不支持带路径的地址（只填 ip:端口）" };
  if (!body) return { ok: false, reason: "地址缺少主机名" };
  let host = body;
  let port = null;
  const v6End = body.lastIndexOf("]");
  const ci = body.lastIndexOf(":");
  if (!(v6End >= 0 && v6End === body.length - 1 && ci < v6End)) {
    if (ci >= 0) {
      host = body.slice(0, ci);
      const p = body.slice(ci + 1);
      if (!/^\d{1,5}$/.test(p)) return { ok: false, reason: "端口必须是数字（1-65535）" };
      port = Number(p);
      if (port < 1 || port > 65535) return { ok: false, reason: "端口超出范围（1-65535）" };
    }
  }
  if (!host) return { ok: false, reason: "地址缺少主机名" };
  const isV6 = /^\[[0-9a-fA-F:.]+\]$/.test(host);
  if (!isV6 && !/^[\w.-]+$/.test(host)) return { ok: false, reason: "主机名含非法字符（支持 ip、域名或 [ipv6]）" };
  const url = withScheme
    ? `${schemeMatch[1].toLowerCase()}://${host}${port ? `:${port}` : ""}`
    : `http://${host}:${port ?? defaultPort}`;
  return { ok: true, url };
}

/**
 * 加入远端组（宽带/静态共用核心）：归一化 → POST /v1/groups/join → markJoined → 同步 peers。
 * 只返回结果对象，不打印、不 exit——由 CLI 命令与交互式向导各自决定展示与退出码。
 */
export async function joinGroupCore({ leaderHost, name, isBroadband = false, args = [] }) {
  const norm = normalizeLeaderUrl(leaderHost);
  if (!norm.ok) return { ok: false, error: norm.reason, reason: norm.reason };
  const leaderUrl = norm.url;
  const groupName = String(name ?? "").trim();
  if (!groupName) return { ok: false, leaderUrl, error: "组名不能为空" };
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const myToken = (await loadToken()).token;
  const kind = isBroadband ? "broadband" : "static";
  let joinBody;
  if (isBroadband) {
    const relayId = `relay://${myToken.slice(0, 8)}`;
    joinBody = { name: groupName, key: groupName, leaderUrl, url: relayId, token: myToken, kind };
  } else {
    const { effectivePort } = await import("./policy.js");
    joinBody = { name: groupName, key: groupName, leaderUrl, myPort: effectivePort(args), token: myToken, kind };
  }
  try {
    const res = await compatFetch(`${leaderUrl}/v1/groups/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(joinBody),
      signal: timeoutSignal(JOIN_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, leaderUrl, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => ({}));
    const myUrl = data.you?.url || joinBody.url || "";
    markJoined({ name: groupName, leaderUrl, myUrl, memberName: myUrl, kind });
    const synced = await syncAllJoinedGroups({ peers, groups });
    const s = synced.find((x) => x.name === groupName);
    return {
      ok: true,
      leaderUrl,
      name: groupName,
      myUrl,
      memberName: myUrl,
      kind,
      added: s?.added ?? 0,
      syncError: s?.error || null,
      token: myToken,
    };
  } catch (err) {
    return { ok: false, leaderUrl, error: errMsg(err) };
  }
}
