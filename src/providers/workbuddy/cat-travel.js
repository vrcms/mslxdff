import { compatFetch } from "../../compat.js";
import { growthRequest } from "./growth-api.js";
import { fireGrowthEvent } from "./growth.js";
// WorkBuddy 猫猫旅行（/activity/growth/buddy/*，无 /v2 前缀）：
// 同意协议 → 首次领养（+300）→ 派出 → 到站领奖。
// 领养门槛「first_buddy task not completed yet」= 需至少一次对话，
// 用一次 chat_request_send 事件（免费模型、成本 0）即可解锁。

const BUDDY_GATE_MARKER = "first_buddy task not completed yet";
const DEFAULT_LOCATION_ID = 4;

// sleep 必须保活事件循环（CLI 场景 unref 会让 Node 提前退出，见 growth.js 同注）。
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runCatTravel({
  uid, at, domain, enterpriseId,
  locationId = DEFAULT_LOCATION_ID,
  fetchImpl = compatFetch, sleepFn = defaultSleep,
  gaps = {}, onStep = null,
} = {}) {
  const g = { pollMs: 1500, ...gaps };
  const api = { uid, at, domain, enterpriseId, fetchImpl };
  const steps = [];
  let credits = 0;
  const add = (step, ok, message, reward = 0, skipped = false) => {
    credits += reward;
    const s = { step, ok, skipped, reward, message };
    steps.push(s);
    try { onStep?.(s); } catch {}
  };
  const done = (ok, outcome, summary) => ({ ok, outcome, credits, steps, summary });

  // 1) 猫档案：data.buddy 为 null 即未领养
  const info = await growthRequest({ ...api, method: "GET", path: "/activity/growth/buddy/info" });
  if (!info.ok) {
    add("info", false, `查询猫档案失败：${info.msg || info.status}`);
    return done(false, "error", "查询猫档案失败");
  }
  const buddy = info.data?.buddy || null;

  // 2) 无猫：协议 → 领养（门槛未达标时自动补一次对话再试）
  if (!buddy) {
    const agr = await growthRequest({ ...api, method: "POST", path: "/activity/growth/buddy/agreement", body: { agree: true } });
    if (!agr.ok) {
      add("agreement", false, `同意协议失败：${agr.msg || agr.status}`);
      return done(false, "error", "同意协议失败");
    }
    add("agreement", true, "已同意活动协议");

    let first = await growthRequest({ ...api, method: "POST", path: "/activity/growth/buddy/first" });
    if (!first.ok && first.status === 400 && String(first.msg || "").toLowerCase().includes(BUDDY_GATE_MARKER)) {
      const fr = await fireGrowthEvent(api, { eventCodes: ["chat_request_send"] });
      if (fr.ok) {
        add("gate", true, "领养门槛未达标，已补一次对话解锁");
        await sleepFn(g.pollMs);
        first = await growthRequest({ ...api, method: "POST", path: "/activity/growth/buddy/first" });
      } else {
        add("gate", false, `门槛补齐失败：${fr.msg || fr.status}`, 0, true);
      }
    }
    if (first.ok) {
      const data = first.data || {};
      const got = Number(data.credit || 0);
      const reward = got > 0 ? got : 300;
      const energy = Number(data.energy || 0);
      let msg = `领养成功，已发放 ${reward} 积分`;
      if (energy) msg += ` + ${energy} 能量`;
      const badge = data.badge?.name;
      if (badge) msg += `，解锁徽章「${badge}」`;
      add("adopt", true, msg, reward);
      return done(true, "adopted", msg);
    }
    if (first.status === 400 && String(first.msg || "").toLowerCase().includes(BUDDY_GATE_MARKER)) {
      add("adopt", true, "本次无法领养：对话门槛未达标", 0, true);
      return done(true, "gate_blocked", "本次无法领养（对话门槛未达标）");
    }
    add("adopt", false, `领养失败：${first.msg || first.status}`);
    return done(false, "error", "领养失败");
  }
  add("adopt", true, `已有猫：${buddy.name || buddy.id}`, 0, true);

  // 3) 旅行状态
  const st = await growthRequest({ ...api, method: "GET", path: "/activity/growth/buddy/travel/status" });
  if (!st.ok) {
    add("status", false, `查询旅行状态失败：${st.msg || st.status}`);
    return done(false, "error", "查询旅行状态失败");
  }
  const state = String(st.data?.state || "");
  const recordId = Number(st.data?.record_id || 0);

  // 4) 到站领奖 / 空闲派出
  if (state === "arrived") {
    if (recordId <= 0) {
      add("claim", false, "已到站但缺少 record_id，无法领奖");
      return done(false, "error", "领奖失败（缺少 record_id）");
    }
    const cl = await growthRequest({ ...api, method: "POST", path: "/activity/growth/buddy/travel/claim", body: { record_id: recordId } });
    if (!cl.ok) {
      add("claim", false, `领奖失败：${cl.msg || cl.status}`);
      return done(false, "error", "领奖失败");
    }
    const reward = Number(cl.data?.reward_credit || 0);
    add("claim", true, `领奖成功，获得 ${reward} 积分`, reward);
    return done(true, reward > 0 ? "travel_claimed" : "travel_none", reward > 0 ? `完成，共获得 ${reward} 积分` : "完成，本次无新增积分");
  }
  if (state === "idle") {
    if (st.data?.daily_limit_reached) {
      add("depart", true, "今日已派出过，明日可再次派出", 0, true);
      return done(true, "travel_none", "今日已派出过");
    }
    const dp = await growthRequest({ ...api, method: "POST", path: "/activity/growth/buddy/travel/depart", body: { location_id: locationId } });
    if (!dp.ok) {
      add("depart", false, `派出失败：${dp.msg || dp.status}`);
      return done(false, "error", "派出失败");
    }
    add("depart", true, "已派出猫咪旅行，到站后可领奖");
    return done(true, "departed", "已派出猫咪旅行，到站后可领奖");
  }
  if (state === "traveling") {
    add("depart", true, `猫咪正在旅行中（record=${recordId}）`, 0, true);
    return done(true, "traveling", "猫咪正在旅行中，到站后可领奖");
  }
  add("status", true, `未知旅行状态 ${state}，未执行动作`, 0, true);
  return done(true, "unknown", `未知旅行状态 ${state}`);
}
