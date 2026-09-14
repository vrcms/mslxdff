// WorkBuddy 成长任务 + 猫猫旅行：mock 上游全链路（无真实网络）。
// 覆盖：双域容灾 / 状态机（accept→fire→claim）/ claim 路径形态 / 幂等 / MANUAL 跳过 /
//       策略表分级 / 事件包形状 / 失败隔离 / 猫猫旅行四分支。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { growthRequest, GROWTH_BASES } from "../src/providers/workbuddy/growth-api.js";
import {
  planFor, classifyTask, runGrowthAccount, runGrowthAll, PLAN_LEVELS, MAX_TIMES,
} from "../src/providers/workbuddy/growth.js";
import { runCatTravel } from "../src/providers/workbuddy/cat-travel.js";
import { isGrowthEnabled, getGrowthHour, nextGrowthDelayMs, shouldGrowthCatchUp } from "../src/runtime/workbuddy-growth.js";

function jsonRes(obj, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj, body: null };
}

function sseRes() {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: new TextEncoder().encode("data: {\"id\":1}\n") }),
        cancel: async () => {},
      }),
    },
    text: async () => "data: {\"id\":1}\n",
  };
}

// 假上游：内存状态 + 调用记录。settlePolls 控制 accept 落库延迟（GET tasks 次数）。
function makeUpstream({ tasks = [], buddy = null, travel = { state: "idle", record_id: 0 }, settlePolls = 0, fireFail = false, gateBlocked = false } = {}) {
  const calls = [];
  const state = {
    tasks: tasks.map((t) => ({
      task_code: t.task_code,
      title: t.title || t.task_code,
      accept_status: t.accept_status || "not_accepted",
      progress: t.progress || { current: 0, target: 1 },
      reward_credit: t.reward_credit ?? 100,
    })),
    buddy,
    travel: { ...travel },
    gateBlocked,
    claimed: [],
    acceptedPending: {},
    fireBodies: [],
  };
  const pending = { ...state.acceptedPending };
  async function fetchImpl(url, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const u = new URL(String(url));
    const path = u.pathname;
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url: String(url), path, body });

    if (method === "GET" && path === "/v2/activity/growth/tasks") {
      for (const code of Object.keys(pending)) {
        if (pending[code] <= 0) {
          const t = state.tasks.find((x) => x.task_code === code);
          if (t && t.accept_status === "not_accepted") t.accept_status = "accepted";
          delete pending[code];
        } else pending[code] -= 1;
      }
      return jsonRes({ code: 0, data: { tasks: state.tasks.map((t) => ({ ...t, progress: { ...t.progress } })) } });
    }
    if (method === "POST" && path === "/v2/activity/growth/tasks/accept") {
      for (const code of body?.task_codes || []) {
        const t = state.tasks.find((x) => x.task_code === code);
        if (t && t.accept_status === "not_accepted") {
          if (settlePolls > 0) pending[code] = settlePolls;
          else t.accept_status = "accepted";
        }
      }
      return jsonRes({ code: 0, data: { results: (body?.task_codes || []).map((c) => ({ task_code: c, status: "accepted" })) } });
    }
    const mClaim = path.match(/^\/activity\/growth\/tasks\/([^/]+)\/claim$/);
    if (method === "POST" && mClaim) {
      const t = state.tasks.find((x) => x.task_code === mClaim[1]);
      if (t && t.accept_status === "completed") {
        t.accept_status = "claimed";
        state.claimed.push({ task_code: t.task_code, credit: t.reward_credit, energy: 5 });
        return jsonRes({ code: 0, data: { credit: t.reward_credit, energy: 5 } });
      }
      return jsonRes({ code: 1, msg: "task not completed" }, 400);
    }
    if (method === "POST" && path === "/v2/chat/completions") {
      state.fireBodies.push(body);
      if (fireFail) return jsonRes({ code: 500, msg: "boom" }, 500);
      const evts = JSON.parse(body?.extra_vars?.growthEvent || "[]");
      for (const e of evts) {
        if (e.eventCode === "chat_request_send") {
          state.gateBlocked = false;
          const t = state.tasks.find((x) => x.task_code === "chat_5");
          if (t && t.accept_status === "accepted") {
            t.progress.current = Math.min(t.progress.target, t.progress.current + 1);
            if (t.progress.current >= t.progress.target) t.accept_status = "completed";
          }
          // 模型体验任务按请求体 model 判定（上游机制：发事件包无效，须真实调用指定模型）
          const mt = state.tasks.find((x) => x.task_code === "Model_chat_GLM5.2");
          if (mt && mt.accept_status === "accepted" && body?.model === "glm-5.2") mt.accept_status = "completed";
        }
        if (e.eventCode === "skill_info") {
          const t = state.tasks.find((x) => x.task_code === "skill_1");
          if (t && t.accept_status === "accepted") t.accept_status = "completed";
        }
        if (e.eventCode === "automated_task_create_suc") {
          const t = state.tasks.find((x) => x.task_code === "automation_1");
          if (t && t.accept_status === "accepted") t.accept_status = "completed";
        }
      }
      return sseRes();
    }
    if (method === "GET" && path === "/activity/growth/buddy/info") {
      return jsonRes({ code: 0, data: { buddy: state.buddy } });
    }
    if (method === "POST" && path === "/activity/growth/buddy/agreement") {
      return jsonRes({ code: 0, data: {} });
    }
    if (method === "POST" && path === "/activity/growth/buddy/first") {
      if (state.gateBlocked) return jsonRes({ code: 400, msg: "first_buddy task not completed yet (need at least one conversation)" }, 400);
      state.buddy = { id: 1, name: "喵" };
      return jsonRes({ code: 0, data: { credit: 300, energy: 10, badge: { name: "领养徽章" } } });
    }
    if (method === "GET" && path === "/activity/growth/buddy/travel/status") {
      return jsonRes({ code: 0, data: { ...state.travel } });
    }
    if (method === "POST" && path === "/activity/growth/buddy/travel/depart") {
      state.travel = { state: "traveling", record_id: 7 };
      return jsonRes({ code: 0, data: {} });
    }
    if (method === "POST" && path === "/activity/growth/buddy/travel/claim") {
      const reward = 88;
      state.travel = { state: "idle", record_id: 0 };
      return jsonRes({ code: 0, data: { reward_credit: reward } });
    }
    return jsonRes({ code: 404, msg: `unhandled ${method} ${path}` }, 404);
  }
  return { fetchImpl, calls, state };
}

const NO_GAPS = { eventMs: 0, accountMs: 0, pollMs: 0, acceptTimeoutMs: 300, verifyTimeoutMs: 300 };
const sleepFn = async () => {};

describe("growth-api 底层请求", () => {
  it("首域失败自动切第二域", async () => {
    const seen = [];
    const r = await growthRequest({
      uid: "u1", at: "t", method: "GET", path: "/v2/activity/growth/tasks",
      fetchImpl: async (url) => {
        seen.push(String(url));
        return String(url).includes(GROWTH_BASES[0]) ? jsonRes({ code: 500 }, 500) : jsonRes({ code: 0, data: { tasks: [] } });
      },
    });
    assert.equal(r.ok, true);
    assert.match(r.url, /codebuddy\.cn/);
    assert.equal(seen.length, 2);
  });

  it("401 标记 needRefresh 且不浪费第二域", async () => {
    const seen = [];
    const r = await growthRequest({
      uid: "u1", at: "t", method: "POST", path: "/v2/activity/growth/tasks/accept", body: { task_codes: [] },
      fetchImpl: async (url) => { seen.push(String(url)); return jsonRes({ code: 401 }, 401); },
    });
    assert.equal(r.needRefresh, true);
    assert.equal(seen.length, 1);
  });

  it("非 JSON 响应结构化失败", async () => {
    const r = await growthRequest({
      uid: "u1", at: "t", method: "GET", path: "/v2/activity/growth/tasks",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>", json: async () => { throw new Error("bad json"); }, body: null }),
    });
    assert.equal(r.ok, false);
    assert.match(r.msg, /非 JSON/);
  });
});

describe("growth 策略表", () => {
  it("已登记任务分级正确", () => {
    assert.equal(planFor("chat_5").level, PLAN_LEVELS.MULTI);
    assert.equal(planFor("automation_1").level, PLAN_LEVELS.AUTO);
    assert.equal(planFor("Model_chat_GLM5.2").model, "glm-5.2");
    assert.equal(planFor("expert_5").actionable, false);
  });

  it("未登记任务默认 MANUAL 不盲发", () => {
    const p = planFor("some_new_task");
    assert.equal(p.level, PLAN_LEVELS.MANUAL);
    assert.equal(p.actionable, false);
  });

  it("classifyTask：reward<=0 降级 SKIP，need_times 按 target-current", () => {
    const c1 = classifyTask({ task_code: "chat_5", reward_credit: 0, progress: { current: 0, target: 5 } });
    assert.equal(c1.level, PLAN_LEVELS.SKIP);
    const c2 = classifyTask({ task_code: "chat_5", reward_credit: 100, progress: { current: 2, target: 5 } });
    assert.equal(c2.need_times, 3);
    assert.equal(c2.actionable, true);
  });
});

describe("runGrowthAccount 状态机", () => {
  it("完整闭环：accept → fire → claim，claim 路径无 /v2", async () => {
    const up = makeUpstream({ tasks: [{ task_code: "chat_5", progress: { current: 0, target: 2 }, reward_credit: 200 }] });
    const res = await runGrowthAccount({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.ok, true);
    assert.equal(res.credit, 200);
    const item = res.tasks.find((t) => t.task_code === "chat_5");
    assert.equal(item.status, "claimed");
    assert.equal(up.state.fireBodies.length, 2);
    const acceptIdx = up.calls.findIndex((c) => c.path.endsWith("/tasks/accept"));
    const fireIdx = up.calls.findIndex((c) => c.path === "/v2/chat/completions");
    assert.ok(acceptIdx >= 0 && acceptIdx < fireIdx, "accept 必须先于触发");
    const claimCall = up.calls.find((c) => c.path.includes("/claim"));
    assert.equal(claimCall.path, "/activity/growth/tasks/chat_5/claim");
  });

  it("accept 落库延迟：轮询等待后才触发", async () => {
    const up = makeUpstream({ tasks: [{ task_code: "skill_1", reward_credit: 100 }], settlePolls: 2 });
    const res = await runGrowthAccount({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.tasks.find((t) => t.task_code === "skill_1").status, "claimed");
    assert.ok(up.state.fireBodies.length >= 1);
  });

  it("已 claimed 任务幂等跳过（零网络请求）", async () => {
    const up = makeUpstream({ tasks: [{ task_code: "chat_5", accept_status: "claimed", reward_credit: 100 }] });
    const res = await runGrowthAccount({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(up.state.fireBodies.length, 0);
    assert.equal(up.calls.filter((c) => c.path.includes("/claim")).length, 0);
    assert.equal(res.tasks[0].skipped, "已领取");
  });

  it("MANUAL 任务不发请求，其余任务照做", async () => {
    const up = makeUpstream({ tasks: [
      { task_code: "expert_5", reward_credit: 100 },
      { task_code: "skill_1", reward_credit: 100 },
    ] });
    const res = await runGrowthAccount({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(up.state.fireBodies.length, 1);
    assert.equal(res.tasks.find((t) => t.task_code === "expert_5").ok, false);
    assert.equal(res.tasks.find((t) => t.task_code === "skill_1").status, "claimed");
  });

  it("事件包形状：growthEvent 为 JSON 字符串且 id 每次唯一", async () => {
    const up = makeUpstream({ tasks: [{ task_code: "chat_5", progress: { current: 0, target: 2 }, reward_credit: 100 }] });
    await runGrowthAccount({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(up.state.fireBodies.length, 2);
    const [b1, b2] = up.state.fireBodies;
    assert.equal(typeof b1.extra_vars.growthEvent, "string");
    assert.equal(b1.max_tokens, 1);
    assert.equal(b1.stream, true);
    const e1 = JSON.parse(b1.extra_vars.growthEvent);
    const e2 = JSON.parse(b2.extra_vars.growthEvent);
    assert.equal(e1[0].eventCode, "chat_request_send");
    assert.notEqual(e1[0].id, e2[0].id, "每次触发的事件 id 必须不同");
  });

  it("模型体验任务真实调用指定模型", async () => {
    const up = makeUpstream({ tasks: [{ task_code: "Model_chat_GLM5.2", reward_credit: 100 }] });
    const res = await runGrowthAccount({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.tasks[0].status, "claimed");
    assert.equal(up.state.fireBodies[0].model, "glm-5.2");
  });

  it("单任务失败不拖累其他任务", async () => {
    const up = makeUpstream({ tasks: [{ task_code: "skill_1", reward_credit: 100 }], fireFail: true });
    const res = await runGrowthAccount({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.ok, false);
    assert.equal(res.tasks[0].ok, false);
  });

  it("触发次数受 MAX_TIMES 上限保护", async () => {
    const up = makeUpstream({ tasks: [{ task_code: "chat_5", progress: { current: 0, target: 50 }, reward_credit: 100 }] });
    await runGrowthAccount({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(up.state.fireBodies.length, MAX_TIMES);
  });
});

describe("runGrowthAll 多账号串行", () => {
  it("逐账号执行，单账号失败不挡后续", async () => {
    const up = makeUpstream({ tasks: [{ task_code: "skill_1", reward_credit: 100 }] });
    const accounts = [{ uid: "u1", at: "t1" }, { uid: "u2", at: "t2" }];
    const order = [];
    const res = await runGrowthAll({ accounts, fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS, onAccount: (r) => order.push(r.uid) });
    assert.equal(res.results.length, 2);
    assert.ok(res.creditTotal > 0);
    assert.deepEqual(order.sort(), ["u1", "u2"]);
  });
});

describe("runCatTravel 猫猫旅行", () => {
  it("无猫：同意协议 → 领养 +300", async () => {
    const up = makeUpstream({});
    const res = await runCatTravel({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.ok, true);
    assert.equal(res.outcome, "adopted");
    assert.equal(res.credits, 300);
    assert.ok(up.calls.some((c) => c.path === "/activity/growth/buddy/agreement"));
    assert.ok(up.calls.some((c) => c.path === "/activity/growth/buddy/first"));
  });

  it("门槛未达标：自动补一次对话后领养成功", async () => {
    const up = makeUpstream({ gateBlocked: true });
    const res = await runCatTravel({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.outcome, "adopted");
    assert.equal(res.credits, 300);
    assert.equal(up.state.fireBodies.length, 1);
  });

  it("已有猫且空闲：派出旅行", async () => {
    const up = makeUpstream({ buddy: { id: 1, name: "喵" }, travel: { state: "idle", record_id: 0 } });
    const res = await runCatTravel({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.ok, true);
    assert.equal(res.outcome, "departed");
    const dp = up.calls.find((c) => c.path.endsWith("/travel/depart"));
    assert.ok(dp, "应调用 depart");
    assert.equal(dp.body.location_id, 4);
  });

  it("到站：用服务端 record_id 领奖", async () => {
    const up = makeUpstream({ buddy: { id: 1, name: "喵" }, travel: { state: "arrived", record_id: 7 } });
    const res = await runCatTravel({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.outcome, "travel_claimed");
    assert.equal(res.credits, 88);
    const cl = up.calls.find((c) => c.path.endsWith("/travel/claim"));
    assert.equal(cl.body.record_id, 7);
  });

  it("旅行中：不重复派出", async () => {
    const up = makeUpstream({ buddy: { id: 1 }, travel: { state: "traveling", record_id: 9 } });
    const res = await runCatTravel({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.outcome, "traveling");
    assert.equal(up.calls.filter((c) => c.path.endsWith("/travel/depart")).length, 0);
    assert.equal(up.calls.filter((c) => c.path.endsWith("/travel/claim")).length, 0);
  });

  it("今日已派出：跳过不重复派", async () => {
    const up = makeUpstream({ buddy: { id: 1 }, travel: { state: "idle", record_id: 0, daily_limit_reached: true } });
    const res = await runCatTravel({ uid: "u1", at: "t", fetchImpl: up.fetchImpl, sleepFn, gaps: NO_GAPS });
    assert.equal(res.outcome, "travel_none");
    assert.equal(up.calls.filter((c) => c.path.endsWith("/travel/depart")).length, 0);
  });
});

describe("workbuddy growth 调度", () => {
  it("默认开启，显式 0 关闭", () => {
    assert.equal(isGrowthEnabled({}), true);
    assert.equal(isGrowthEnabled({ MSLXDFF_WORKBUDDY_GROWTH: "0" }), false);
    assert.equal(isGrowthEnabled({ MSLXDFF_WORKBUDDY_GROWTH: "1" }), true);
  });

  it("小时默认 9，非法回退 9", () => {
    assert.equal(getGrowthHour({}), 9);
    assert.equal(getGrowthHour({ MSLXDFF_WORKBUDDY_GROWTH_HOUR: "15" }), 15);
    assert.equal(getGrowthHour({ MSLXDFF_WORKBUDDY_GROWTH_HOUR: "xx" }), 9);
    assert.equal(getGrowthHour({ MSLXDFF_WORKBUDDY_GROWTH_HOUR: "25" }), 9);
  });

  it("09:30 计划点：未到返回到点延迟，已过返回明天", () => {
    const before = new Date(2026, 8, 4, 8, 0, 0);
    assert.equal(nextGrowthDelayMs(before, 9), 90 * 60_000);
    const after = new Date(2026, 8, 4, 10, 0, 0);
    assert.equal(nextGrowthDelayMs(after, 9), (23 * 60 + 30) * 60_000);
  });

  it("启动补跑：过期且已过点才补", () => {
    const now = new Date(2026, 8, 4, 10, 0, 0);
    assert.equal(shouldGrowthCatchUp({ lastDate: "2026-09-03", now }), true);
    assert.equal(shouldGrowthCatchUp({ lastDate: "2026-09-04", now }), false);
    assert.equal(shouldGrowthCatchUp({ lastDate: "", now: new Date(2026, 8, 4, 9, 0, 0) }), false);
    assert.equal(shouldGrowthCatchUp({ lastDate: "", now }), true);
  });
});
