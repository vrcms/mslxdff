import { compatFetch, timeoutSignal, uuid } from "../../compat.js";
import { GROWTH_BASES, growthHeaders, growthRequest, webRequest } from "./growth-api.js";
import { PLAN_LEVELS, MAX_TIMES, planFor, classifyTask } from "./growth-plans.js";
import { runDesktopTask } from "./desktop-report.js";
import { runExpertTask } from "./expert-tasks.js";
// WorkBuddy 成长计划任务：拉列表 → 参与(accept) → 触发(按任务类型分派) → 领奖(claim)。
// 机制（上游实测）：进度由请求体 extra_vars.growthEvent 驱动；未 accept 不累计；
// completed ≠ claimed（要另调领奖）。串行 + 节流是硬要求，同账号禁并行。
// 策略表（哪些任务可自动 / 用什么事件）见 growth-plans.js。
//
// 三种触发通道（按 growth-plans 的 level 分派）：
//   growthEvent  → 带 extra_vars.growthEvent 的真实对话（本文件 fireGrowthEvent）
//   DESKTOP      → 桌面指纹事件链（desktop-report.js）
//   EXPERT       → 专家市场真实 id + 真实对话回执（expert-tasks.js）

export { PLAN_LEVELS, MAX_TIMES, TASK_PLANS, planFor, classifyTask } from "./growth-plans.js";

// 注意：sleep 必须保活事件循环（不能 unref）——CLI 场景下 unref 的定时器
// 会让 Node 在等待期间判定 event loop 空而提前退出（exit 13 unsettled await）。
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 8000, intervalMs = 500, sleepFn = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = false;
    try { v = await fn(); } catch {}
    if (v) return true;
    if (Date.now() >= deadline) return false;
    await sleepFn(intervalMs);
  }
}

export async function growthTasks(api = {}) {
  // 任务列表只认 web 成长中心口径（www.workbuddy.cn + x-client-platform: web）。
  const r = await webRequest({ ...api, method: "GET", path: "/v2/activity/growth/tasks" });
  return { ...r, tasks: r.ok ? (r.data?.tasks || []) : [] };
}

export async function growthAccept(api = {}, codes = []) {
  return webRequest({ ...api, method: "POST", path: "/v2/activity/growth/tasks/accept", body: { task_codes: [...codes] } });
}

export async function growthClaim(api = {}, code) {
  // 领奖走 web 域：/activity/growth/tasks/<code>/claim（任务码在路径里，无 body，无 /v2 前缀）。
  return webRequest({ ...api, method: "POST", path: `/activity/growth/tasks/${encodeURIComponent(code)}/claim` });
}

// 通过带 growthEvent 的模型请求触发进度：正常 200 + 免费模型 + max_tokens=1（成本 0）。
// 读首块即主动断开，不等待全文。
export async function fireGrowthEvent(api = {}, { eventCodes = [], model, eventId, timeoutMs = 60000 } = {}) {
  const { uid, at, domain, enterpriseId, fetchImpl = compatFetch } = api;
  const id = eventId || uuid();
  const body = {
    model: model || process.env.MSLXDFF_WORKBUDDY_GROWTH_MODEL || "hy3",
    stream: true,
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
    extra_vars: { growthEvent: JSON.stringify(eventCodes.map((c) => ({ eventCode: c, id }))) },
  };
  let last = { ok: false, status: 0 };
  for (const base of GROWTH_BASES) {
    let res;
    try {
      res = await fetchImpl(`${base}/v2/chat/completions`, {
        method: "POST",
        headers: growthHeaders({ at, uid, domain, enterpriseId }),
        body: JSON.stringify(body),
        signal: timeoutSignal(timeoutMs),
      });
    } catch (e) {
      last = { ok: false, status: 0, msg: String(e?.message || e).slice(0, 200) };
      continue;
    }
    try {
      const reader = res.body?.getReader?.();
      if (reader) { await reader.read(); await reader.cancel?.(); }
    } catch {}
    if (res.status === 200) return { ok: true, status: 200 };
    last = { ok: false, status: res.status, msg: `HTTP ${res.status}` };
  }
  return last;
}

// 单账号闭环：拉列表 → 逐任务(accept→等落库→触发×N→等复查) → 统一领奖。
export async function runGrowthAccount({
  uid, at, domain, enterpriseId,
  codes, model,
  fetchImpl = compatFetch, sleepFn = defaultSleep,
  gaps = {}, onStep = null,
} = {}) {
  const g = { eventMs: 1200, accountMs: 1000, pollMs: 500, acceptTimeoutMs: 8000, verifyTimeoutMs: 8000, ...gaps };
  const api = { uid, at, domain, enterpriseId, fetchImpl };
  const step = (e) => { try { onStep?.(e); } catch {} };
  const out = { uid, ok: true, tasks: [], credit: 0, energy: 0 };

  const listed = await growthTasks(api);
  if (!listed.ok) { out.ok = false; out.error = listed.msg || "拉取任务列表失败"; return out; }
  const byCode = new Map(listed.tasks.map((t) => [t.task_code, t]));
  const wanted = Array.isArray(codes) && codes.length ? codes : listed.tasks.map((t) => t.task_code);

  const latestOf = async (code) => {
    const r = await growthTasks(api);
    return r.ok ? r.tasks.find((t) => t.task_code === code) : undefined;
  };

  for (const code of wanted) {
    const raw = byCode.get(code);
    if (!raw) { out.tasks.push({ task_code: code, ok: false, skipped: "任务不存在" }); continue; }
    const info = classifyTask(raw);
    if (info.accept_status === "claimed") {
      out.tasks.push({ task_code: code, title: info.title, ok: true, skipped: "已领取", status: "claimed" });
      step({ phase: "task", task_code: code, skipped: "已领取" });
      continue;
    }
    if (!info.actionable) {
      out.tasks.push({ task_code: code, title: info.title, ok: false, skipped: info.strategy || "需人工完成", level: info.level });
      step({ phase: "task", task_code: code, skipped: info.strategy });
      continue;
    }
    // 进度已达标但还没领奖：直接进领奖环节，别再打一次（会白耗一次对话）。
    const cur = Number(info.progress?.current ?? 0);
    const tgt = Number(info.progress?.target ?? 0);
    if (info.accept_status === "completed" || (tgt > 0 && cur >= tgt)) {
      out.tasks.push({
        task_code: code, title: info.title, ok: true, fired: 0,
        status: "completed", progress: `${cur}/${tgt}`, note: "进度已达标，待领奖",
      });
      step({ phase: "task", ...out.tasks[out.tasks.length - 1] });
      continue;
    }
    let needTimes = info.need_times;
    if (info.accept_status === "not_accepted") {
      const ar = await growthAccept(api, [code]);
      step({ phase: "accept", task_code: code, ok: ar.ok, msg: ar.msg });
      if (ar.ok) {
        await waitFor(async () => {
          const t = await latestOf(code);
          return !!t && !!t.accept_status && t.accept_status !== "not_accepted";
        }, { timeoutMs: g.acceptTimeoutMs, intervalMs: g.pollMs, sleepFn });
      }
      // accept 之前上游不下发真实 target（progress 恒 0/0），必须 accept 后重读，
      // 否则「召唤 5 次专家」这类会被当成 1 次，永远停在 1/5。
      const fresh = await latestOf(code);
      if (fresh) {
        const re = classifyTask(fresh);
        if (re.need_times > needTimes) needTimes = re.need_times;
      }
    }
    // 需要重复的任务：每打一次就重读真实进度，边打边补差额。
    // （accept 前 target 恒 0/0；且上一次运行可能已经推进了一部分，
    //  只按开跑时的快照算次数会永远差一口气。）
    const remaining = async () => {
      const t = await latestOf(code);
      if (!t) return 0;
      if (t.accept_status === "completed" || t.accept_status === "claimed") return 0;
      const cur = Number(t.progress?.current ?? 0);
      const tgt = Number(t.progress?.target ?? 0);
      return tgt > cur ? tgt - cur : 0;
    };
    // 封顶 MAX_TIMES 次（单任务最多打 10 次，防任务 target 异常时打爆上游）。
    // 循环条件走 remaining()：每次重读真实进度，用完差额即停。
    let fired = 0;
    const level = info.level || planFor(code).level;
    const fireOnce = async (round = 0) => {
      if (level === PLAN_LEVELS.DESKTOP) return runDesktopTask(api, { code, needTimes: 1, round, sleepFn, onStep: step });
      if (level === PLAN_LEVELS.EXPERT) return runExpertTask(api, { code, needTimes: 1, round, sleepFn, onStep: step });
      const r = await fireGrowthEvent(api, { eventCodes: info.eventCodes || planFor(code).eventCodes, model: info.model || model });
      step({ phase: "fire", task_code: code, i: fired + 1, ok: r.ok, msg: r.msg });
      return { ok: r.ok, msg: r.msg };
    };

    for (let i = 0; i < MAX_TIMES; i++) {
      const left = await remaining();
      if (!left) break;
      const r = await fireOnce(i);
      if (!r.ok) break;
      fired += 1;
      // 上游按「对象 + 天」去重：同一个模板/专家打第二次不加进度。
      // 事件是异步计分的，多等一轮再判「没涨」，避免把慢计分误判成去重。
      let after = left;
      for (let w = 0; w < 3; w++) {
        await sleepFn(Math.max(g.eventMs, 1500));
        after = await remaining();
        if (after < left) break;
      }
      if (after >= left) break; // 进度没动：大概率是按对象去重，别再空打
    }
    const final = await latestOf(code);
    const base = info.progress?.current ?? 0;
    if (final && final.accept_status !== "completed") {
      await waitFor(async () => {
        const t = await latestOf(code);
        if (!t) return false;
        if (t.accept_status === "completed" || t.accept_status === "claimed") return true;
        return Number(t.progress?.current ?? 0) > Number(base);
      }, { timeoutMs: g.verifyTimeoutMs, intervalMs: g.pollMs, sleepFn });
    }
    const latest = (await latestOf(code)) || info;
    const doneNow = ["completed", "claimed"].includes(String(latest.accept_status || ""));
    const item = {
      task_code: code,
      title: latest.title || info.title || code,
      // 上报成功 ≠ 计分成功：进度没动就别报 ok（面板会显示"已完成"，等于谎报）。
      ok: doneNow || fired > 0,
      fired,
      times: latest.progress?.target ?? info.need_times,
      status: latest.accept_status,
      progress: `${latest.progress?.current ?? 0}/${latest.progress?.target ?? "?"}`,
      ...(fired > 0 && !doneNow ? { note: "事件已上报但进度未走（该任务判据可能只认客户端真实行为）" } : {}),
    };
    out.tasks.push(item);
    step({ phase: "task", ...item });
  }

  const done = (await growthTasks(api)).tasks.filter((t) => t.accept_status === "completed");
  for (const t of done) {
    const cr = await growthClaim(api, t.task_code);
    const credit = Number(cr.data?.credit || 0);
    const energy = Number(cr.data?.energy || 0);
    if (cr.ok) {
      out.credit += credit;
      out.energy += energy;
      const item = out.tasks.find((x) => x.task_code === t.task_code);
      if (item) { item.status = "claimed"; item.credit = credit; item.energy = energy; item.ok = true; }
    }
    step({ phase: "claim", task_code: t.task_code, ok: cr.ok, credit, energy, msg: cr.msg });
    await sleepFn(g.eventMs);
  }
  if (out.tasks.length && out.tasks.every((t) => !t.ok)) out.ok = false;
  return out;
}

// 多账号串行（账号间 1s 节流；单账号异常不挡后续）。
export async function runGrowthAll({ accounts = [], onAccount, ...opts } = {}) {
  const results = [];
  let creditTotal = 0;
  for (const a of accounts) {
    let row;
    try { row = await runGrowthAccount({ ...opts, ...a }); }
    catch (e) { row = { uid: a.uid, ok: false, tasks: [], credit: 0, energy: 0, error: String(e?.message || e).slice(0, 200) }; }
    results.push(row);
    creditTotal += row.credit || 0;
    try { onAccount?.(row); } catch {}
    await (opts.sleepFn || defaultSleep)(opts.gaps?.accountMs ?? 1000);
  }
  return { ok: results.some((r) => r.ok), results, creditTotal };
}
