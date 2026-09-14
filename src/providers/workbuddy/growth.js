import { compatFetch, timeoutSignal, uuid } from "../../compat.js";
import { GROWTH_BASES, growthHeaders, growthRequest } from "./growth-api.js";
import { PLAN_LEVELS, MAX_TIMES, planFor, classifyTask } from "./growth-plans.js";
// WorkBuddy 成长计划任务：拉列表 → 参与(accept) → 触发(growthEvent) → 领奖(claim)。
// 机制（上游实测）：进度由请求体 extra_vars.growthEvent 驱动；未 accept 不累计；
// completed ≠ claimed（要另调领奖）。串行 + 节流是硬要求，同账号禁并行。
// 策略表（哪些任务可自动 / 用什么事件）见 growth-plans.js。

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
  const r = await growthRequest({ ...api, method: "GET", path: "/v2/activity/growth/tasks" });
  return { ...r, tasks: r.ok ? (r.data?.tasks || []) : [] };
}

export async function growthAccept(api = {}, codes = []) {
  return growthRequest({ ...api, method: "POST", path: "/v2/activity/growth/tasks/accept", body: { task_codes: [...codes] } });
}

export async function growthClaim(api = {}, code) {
  return growthRequest({ ...api, method: "POST", path: `/activity/growth/tasks/${code}/claim` });
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
    if (info.accept_status === "not_accepted") {
      const ar = await growthAccept(api, [code]);
      step({ phase: "accept", task_code: code, ok: ar.ok, msg: ar.msg });
      if (ar.ok) {
        await waitFor(async () => {
          const t = await latestOf(code);
          return !!t && !!t.accept_status && t.accept_status !== "not_accepted";
        }, { timeoutMs: g.acceptTimeoutMs, intervalMs: g.pollMs, sleepFn });
      }
    }
    let fired = 0;
    for (let i = 0; i < info.need_times; i++) {
      const r = await fireGrowthEvent(api, { eventCodes: info.eventCodes || planFor(code).eventCodes, model: info.model || model });
      if (r.ok) fired += 1;
      step({ phase: "fire", task_code: code, i: i + 1, times: info.need_times, ok: r.ok, msg: r.msg });
      if (i + 1 < info.need_times) await sleepFn(g.eventMs);
    }
    const base = info.progress?.current ?? 0;
    await waitFor(async () => {
      const t = await latestOf(code);
      if (!t) return false;
      if (t.accept_status === "completed" || t.accept_status === "claimed") return true;
      return Number(t.progress?.current ?? 0) > Number(base);
    }, { timeoutMs: g.verifyTimeoutMs, intervalMs: g.pollMs, sleepFn });
    const latest = (await latestOf(code)) || info;
    const item = {
      task_code: code,
      title: latest.title || info.title || code,
      ok: fired > 0,
      fired,
      times: info.need_times,
      status: latest.accept_status,
      progress: `${latest.progress?.current ?? 0}/${latest.progress?.target ?? "?"}`,
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
