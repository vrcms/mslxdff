import { randomUUID } from "node:crypto";
import { compatFetch, timeoutSignal } from "../../compat.js";
import { growthRequest } from "./growth-api.js";
// WorkBuddy 每日活跃上报 + 连登管家（兑换档位 + 抽奖）。
//
// 为什么不靠签到：实测（2026-10-20，本机三号）签到每天成功（code 0）但
// GET /activity/growth/streak 的 days 恒为 0 —— 连登只认 /v2/report 的
// chat_request_send 事件，签到不点亮。连登档位 7/14/28 天的积分、补签卡、
// 抽奖次数全部拿不到，属于「不报错但持续漏领」。
//
// 上报形状照抄客户端（字段宁全勿简，防上游加严）；userId 必填，缺失服务端
// 200 但静默丢弃。每号每天 1 次即可（按天去重，重复上报无额外收益）。

const REPORT_BASES = ["https://www.codebuddy.cn", "https://copilot.tencent.com"];

function reportHeaders({ at, uid, domain, enterpriseId }) {
  return {
    Authorization: `Bearer ${at}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-User-Id": uid,
    "X-Domain": domain || "www.codebuddy.cn",
    "X-Product": "SaaS",
    "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
    Origin: "https://www.codebuddy.cn",
    Referer: "https://www.codebuddy.cn/",
    ...(enterpriseId ? { "X-Enterprise-Id": enterpriseId } : {}),
  };
}

export function chatActivityEvent({ uid, conversationId, requestId, model = "deepseek-v4-flash", modelName = "DeepSeek V4 Flash" }) {
  const now = Date.now();
  return {
    eventCode: "chat_request_send",
    timestamp: now,
    reportDelay: 0,
    mode: "craft",
    conversationId,
    requestId,
    inputLength: 12,
    requestModelId: model,
    requestModelName: modelName,
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: "",
    mentionContextCount: 0,
    command: "",
    expertId: "",
    recommendId: "",
    skillId: "",
    skillCount: 0,
    totalCount: 0,
    fileUri: "",
    presentAt: now,
    traceId: "",
    rootRequestId: requestId,
    parentConversationId: conversationId,
    agentName: "default",
    agentType: "conversation",
    userId: uid,
  };
}

// 一条对话活跃上报：点亮当日连登 + 解锁 first_buddy（领养前置）。双域容灾，不抛异常。
export async function reportChatActivity({ uid, at, domain, enterpriseId, conversationId, requestId, model, modelName, fetchImpl = compatFetch, timeoutMs = 15000 } = {}) {
  if (!uid || !at) return { ok: false, msg: "缺少 uid / accessToken" };
  const conv = conversationId || `mslxdff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const req = requestId || conv;
  const body = JSON.stringify([chatActivityEvent({ uid, conversationId: conv, requestId: req, model, modelName })]);
  let last = { ok: false, msg: "无可用域" };
  for (const base of REPORT_BASES) {
    let res;
    try {
      res = await fetchImpl(`${base}/v2/report`, {
        method: "POST",
        headers: reportHeaders({ at, uid, domain, enterpriseId }),
        body,
        signal: timeoutSignal(timeoutMs),
      });
    } catch (e) {
      last = { ok: false, status: 0, msg: `网络失败: ${String(e?.message || e).slice(0, 160)}` };
      continue;
    }
    let j = null;
    try { j = await res.json(); } catch {}
    const out = { ok: res.status === 200 && j?.code === 0, status: res.status, code: j?.code, msg: j?.msg || "", base };
    if (out.ok) return out;
    // 401/403 是登录态问题，换域也没用
    if (res.status === 401 || res.status === 403) return { ...out, needRefresh: true };
    last = out;
  }
  return last;
}

const TIER_KEYS = ["tier_7d", "tier_14d", "tier_28d"];

// 连登完整状态（days / 档位 / 补签卡）。
export async function growthStreak(api = {}) {
  const r = await growthRequest({ ...api, method: "GET", path: "/activity/growth/streak" });
  if (!r.ok) return { ok: false, msg: r.msg || `HTTP ${r.status}`, days: 0, tiers: [], cards: 0 };
  const data = r.data || {};
  const rs = data.redemption_status || {};
  const tiers = TIER_KEYS
    .map((k) => ({ tier: k.slice(5), status: rs[`${k}_status`] || "", days: Number(rs[`${k}_count`] || 0) }))
    .filter((t) => t.status);
  return {
    ok: true,
    days: Number(data.streak?.days || 0),
    monthTotalDays: Number(data.streak?.month_total_days || 0),
    nextTier: data.streak?.next_tier || "",
    nextTierRemaining: Number(data.streak?.next_tier_remaining || 0),
    tiers,
    cards: Number(data.makeup_cards?.balance || 0),
    rewards: Array.isArray(rs.tiers) ? rs.tiers : [],
  };
}

// 兑换一个已解锁档位（tier: "7d"|"14d"|"28d"）；未解锁上游 403，调用方按 status 跳过即可。
export async function redeemStreakTier(api = {}, tier) {
  const r = await growthRequest({
    ...api,
    method: "POST",
    path: "/activity/growth/redeem",
    body: { tier, client_token: randomUUID() },
  });
  return { ok: r.ok, status: r.status, code: r.code, msg: r.msg || "", data: r.data || {} };
}

export async function lotteryChances(api = {}) {
  const r = await growthRequest({ ...api, method: "GET", path: "/activity/growth/lottery/summary" });
  if (!r.ok) return { ok: false, chances: 0, enabled: false, msg: r.msg || `HTTP ${r.status}` };
  return { ok: true, chances: Number(r.data?.chances || 0), enabled: r.data?.module?.enabled !== false };
}

export async function lotteryDraw(api = {}) {
  const r = await growthRequest({
    ...api,
    method: "POST",
    path: "/activity/growth/lottery/draw",
    body: { client_token: randomUUID() },
  });
  return { ok: r.ok, status: r.status, msg: r.msg || "", prize: r.data || null };
}

// 连登管家闭环：兑换所有已解锁未领取的档位 → 抽完全部次数。幂等，未解锁静默跳过。
export async function runStreakBonus({ uid, at, domain, enterpriseId, fetchImpl = compatFetch, onStep = null, maxDraws = 20 } = {}) {
  const api = { uid, at, domain, enterpriseId, fetchImpl };
  const step = (e) => { try { onStep?.(e); } catch {} };
  const out = { uid, redeemed: [], drawn: 0, credit: 0, energy: 0, prizes: [], errors: [] };

  const st = await growthStreak(api);
  if (!st.ok) {
    out.errors.push(`读连登状态失败：${st.msg}`);
    return out;
  }
  out.days = st.days;

  for (const t of st.tiers) {
    // locked = 天数不够；claimed = 已领过。其余状态视为可兑换。
    if (!["locked", "claimed"].includes(String(t.status))) {
      const r = await redeemStreakTier(api, t.tier);
      if (r.ok) {
        const credit = Number(r.data?.credit || 0);
        const energy = Number(r.data?.energy || 0);
        out.credit += credit;
        out.energy += energy;
        out.redeemed.push({ tier: t.tier, credit, energy });
        step({ phase: "redeem", ok: true, tier: t.tier, credit, energy });
      } else {
        out.errors.push(`兑换 ${t.tier} 失败：${r.msg || `HTTP ${r.status}`}`);
        step({ phase: "redeem", ok: false, tier: t.tier, msg: r.msg });
      }
    }
  }

  // 每轮重读次数（兑换与抽奖都可能再发次数），抽到 0 或达上限为止。
  for (;;) {
    if (out.drawn >= maxDraws) break;
    const left = (await lotteryChances(api)).chances;
    if (left <= 0) break;
    const r = await lotteryDraw(api);
    if (!r.ok) {
      out.errors.push(`抽奖失败：${r.msg || `HTTP ${r.status}`}`);
      step({ phase: "draw", ok: false, msg: r.msg });
      break;
    }
    out.drawn += 1;
    const name = r.prize?.prize_name || r.prize?.name || r.prize?.title || "";
    const credit = Number(r.prize?.credit || 0);
    out.credit += credit;
    out.prizes.push({ name, credit });
    step({ phase: "draw", ok: true, remaining: left - 1, prize: name, credit });
  }
  return out;
}
