// codearts 每日签到领积分：纯函数 / 协议层 / 调度器 / CLI 的回归测试。
// 铁律（照 test/traework-checkin.test.js）：全程注入假 fetch，**一次都不许碰真上游** ——
// claim 是真领积分且跑在用户账号上。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-codearts-checkin-")), "state.json");

const { parseCreditCampaigns, planCreditActions } = await import("../src/providers/codearts/checkin.js");

// 独立事实源：2026-10-24 现网 `GET /v1/ops/delivery?channel=IDE` 的真实响应（逐字，未手工改口径）。
// 三个坑都在里面：campaignId 是数字、积分字段叫 benefitAmount、不可领取时 status 是 null。
const LIVE_DELIVERY = {
  code: 0,
  message: "ok",
  data: {
    channel: "IDE",
    serverTime: 1792891532476,
    items: [
      {
        campaignId: 4, title: "新用户注册送 4000 积分", type: "NEW_USER_REGISTER",
        benefitAmount: 4000, benefitUnit: "CREDIT", claimable: false, status: "CONFIRMED",
        extra: { triggerMode: "AUTO_GRANT", triggerEvent: "user.register" },
      },
      {
        campaignId: 3, title: "推荐码上有礼", type: "INVITE_USER",
        benefitAmount: 1000, benefitUnit: "CREDIT", claimable: false, status: null,
        extra: { triggerMode: "MANUAL_CLAIM", triggerEvent: "invite.success" },
      },
      {
        campaignId: 2, title: "学生认证领积分", type: "STUDENT_CERTIFIED",
        benefitAmount: 4000, benefitUnit: "CREDIT", claimable: false, status: null,
      },
      {
        campaignId: 1, title: "每日签到领积分", type: "USER_LOGIN",
        benefitAmount: 1000, benefitUnit: "CREDIT", claimable: true, status: "ELIGIBLE",
        extra: { triggerMode: "MANUAL_CLAIM" },
      },
    ],
  },
};

test("parseCreditCampaigns：campaignId 转数字、取 benefitAmount、status=null 归一为空串", () => {
  const list = parseCreditCampaigns(LIVE_DELIVERY);
  assert.equal(list.length, 4);

  const daily = list.find((c) => c.id === 1);
  assert.deepEqual(daily, {
    id: 1, type: "USER_LOGIN", title: "每日签到领积分",
    credit: 1000, unit: "CREDIT", claimable: true, status: "ELIGIBLE",
  });
  assert.equal(typeof daily.id, "number", "campaignId 是数字（不是字符串），发回上游必须原样");

  const invite = list.find((c) => c.id === 3);
  assert.equal(invite.status, "", "不可领取时上游给 status:null → 归一为空串，便于判据");
  assert.equal(invite.credit, 1000, "积分取自 benefitAmount（坑：不是 amount）");
});

test("planCreditActions：只 claim 可领的 USER_LOGIN —— CONFIRMED 跳过、非每日类型不碰", () => {
  const actions = planCreditActions(parseCreditCampaigns(LIVE_DELIVERY));
  assert.deepEqual(actions, [{ kind: "claim", id: 1, credit: 1000, title: "每日签到领积分" }]);
  const ids = actions.map((a) => a.id);
  assert.ok(!ids.includes(4), "status=CONFIRMED（已到账）绝不再 claim");
  assert.ok(!ids.includes(3) && !ids.includes(2), "INVITE_USER / STUDENT_CERTIFIED 不是每日任务，不碰");
});

test("planCreditActions：status=CLAIMED 只补 confirm（claim 过了但没到账）", () => {
  const items = [{ campaignId: 1, title: "每日签到领积分", type: "USER_LOGIN", benefitAmount: 1000, benefitUnit: "CREDIT", claimable: false, status: "CLAIMED" }];
  assert.deepEqual(planCreditActions(parseCreditCampaigns({ code: 0, data: { items } })), [{ kind: "confirm", id: 1, credit: 1000, title: "每日签到领积分" }]);
});

test("planCreditActions：已 CONFIRMED/CONSUMED 幂等零动作；claimable=false 也不硬打", () => {
  const mk = (status, claimable = false) => parseCreditCampaigns({ code: 0, data: { items: [{ campaignId: 1, title: "每日签到领积分", type: "USER_LOGIN", benefitAmount: 1000, benefitUnit: "CREDIT", claimable, status }] } });
  assert.deepEqual(planCreditActions(mk("CONFIRMED")), []);
  assert.deepEqual(planCreditActions(mk("CONSUMED")), []);
  assert.deepEqual(planCreditActions(mk("ELIGIBLE", false)), [], "上游说不可领就不打（只有 claimable=true 才 claim）");
});

test("planCreditActions：非 CREDIT 账本（benefitUnit 不是 CREDIT）不碰", () => {
  const items = [{ campaignId: 1, title: "某非积分福利", type: "USER_LOGIN", benefitAmount: 1, benefitUnit: "COUPON", claimable: true, status: "ELIGIBLE" }];
  assert.deepEqual(planCreditActions(parseCreditCampaigns({ code: 0, data: { items } })), []);
});

test("parseCreditCampaigns：业务码非 0 / 缺 data.items 视为空表（不臆造）", () => {
  assert.deepEqual(parseCreditCampaigns({ code: 4000, message: "invalid channel, group not found", data: null }), []);
  assert.deepEqual(parseCreditCampaigns({ code: 0, data: {} }), []);
  assert.deepEqual(parseCreditCampaigns(null), []);
});

// ─────────────────────────── 第二片：协议层（注入假 fetch，绝不碰真上游） ───────────────────────────

const { fetchCreditCampaigns, claimCreditCampaign, confirmCreditCampaign, runCheckin, fetchCreditBalance } =
  await import("../src/providers/codearts/checkin.js");

const FAKE_ACCOUNT = { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST", userId: "u1" };
// 端点片段（基址真实，但 fetchImpl 全假 —— 一个字节都不出网）
const F_DELIVERY = "/v1/ops/delivery";
const F_CLAIM = "/v1/ops/claim";
const F_CONFIRM = "/v1/ops/confirm";
const F_PKG = "/snap-manager/v1/statistics/plugin";

// routes: 端点片段 → 对象 或 (第几次调用) => 对象；hits 记录 url/method/headers/body 供断言
function fakeUpstream(routes) {
  const hits = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    hits.push({
      url: u,
      method: String(init.method || "GET").toUpperCase(),
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    });
    const hit = Object.entries(routes).find(([frag]) => u.includes(frag));
    if (!hit) return { status: 404, text: async () => "{}" };
    const [frag, maker] = hit;
    const n = hits.filter((h) => h.url.includes(frag)).length; // 1 起（第几次打这个端点）
    const out = typeof maker === "function" ? maker(n) : maker;
    return { status: out?.__status || 200, text: async () => JSON.stringify(out?.__body ?? out) };
  };
  return { hits, fetchImpl };
}

const signedHeadersOf = (auth) => /SignedHeaders=([^,]+)/.exec(String(auth || ""))?.[1] || "";
const deliveryWith = (status, { claimable = false } = {}) => ({
  code: 0,
  data: { items: [{ campaignId: 1, title: "每日签到领积分", type: "USER_LOGIN", benefitAmount: 1000, benefitUnit: "CREDIT", claimable, status }] },
});

test("ops 请求：带 agent-type/x-language 但**不进 SignedHeaders**（进 canonical 会 401）", async () => {
  const f = fakeUpstream({ [F_DELIVERY]: deliveryWith("ELIGIBLE", { claimable: true }) });
  const r = await fetchCreditCampaigns({ account: FAKE_ACCOUNT, fetchImpl: f.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.campaigns.length, 1);
  const h = f.hits[0];
  assert.equal(h.method, "GET");
  assert.match(h.url, /\/v1\/ops\/delivery\?channel=IDE$/, "渠道必须是 IDE");
  assert.equal(h.headers["agent-type"], "PromptCenter");
  assert.equal(h.headers["x-language"], "zh-cn");
  assert.match(h.headers.authorization, /^SDK-HMAC-SHA256 Access=AK, /);
  const signed = signedHeadersOf(h.headers.authorization);
  assert.ok(!signed.split(";").includes("agent-type"), "agent-type 必须签名后追加（参考实现口径）");
  assert.ok(!signed.split(";").includes("x-language"), "x-language 同理");
  assert.ok(signed.split(";").includes("host"), "host 进签名（对齐 Go 的 Set(Host)）");
});

test("claim 报文：campaignId 原样（数字）+ channel:IDE + idempotentKey=claim_<id>_<ms>", async () => {
  const f = fakeUpstream({ [F_CLAIM]: { code: 0, data: { status: "CLAIMED" } } });
  const r = await claimCreditCampaign({ account: FAKE_ACCOUNT, campaignId: 1, fetchImpl: f.fetchImpl, now: () => 1750000000123 });
  assert.equal(r.ok, true);
  const h = f.hits[0];
  assert.equal(h.method, "POST");
  assert.match(h.url, /\/v1\/ops\/claim$/);
  assert.deepEqual(h.body, { campaignId: 1, channel: "IDE", idempotentKey: "claim_1_1750000000123" });
  assert.equal(typeof h.body.campaignId, "number", "campaignId 必须是数字");
});

test("confirm 报文：{campaignId}", async () => {
  const f = fakeUpstream({ [F_CONFIRM]: { code: 0 } });
  await confirmCreditCampaign({ account: FAKE_ACCOUNT, campaignId: 1, fetchImpl: f.fetchImpl });
  assert.deepEqual(f.hits[0].body, { campaignId: 1 });
});

test("runCheckin：可领 → claim → **重读列表复查** 到账才算成", async () => {
  // 第 1 次列表：可领；第 2 次列表（复查）：已到账
  const f = fakeUpstream({ [F_DELIVERY]: (n) => deliveryWith(n === 1 ? "ELIGIBLE" : "CONFIRMED", { claimable: n === 1 }), [F_CLAIM]: { code: 0 }, [F_CONFIRM]: { code: 0 } });
  const r = await runCheckin({ account: FAKE_ACCOUNT, fetchImpl: f.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, "claimed");
  assert.equal(r.claimed, 1);
  assert.equal(r.credits, 1000);
  // 参考实现（HITZY2002 checkin.go）：claim 后**无条件**补 confirm —— 少了它状态停在 CLAIMED，不算到账
  assert.deepEqual(f.hits.map((h) => (h.url.includes(F_CLAIM) ? "claim" : h.url.includes(F_CONFIRM) ? "confirm" : "delivery")), ["delivery", "claim", "confirm", "delivery"], "顺序必须是 列表→领取→确认→复查");
});

test("runCheckin：只信回执会谎报 —— 复查仍 ELIGIBLE 就必须报未到账", async () => {
  const f = fakeUpstream({ [F_DELIVERY]: deliveryWith("ELIGIBLE", { claimable: true }), [F_CLAIM]: { code: 0 }, [F_CONFIRM]: { code: 0 } });
  const r = await runCheckin({ account: FAKE_ACCOUNT, fetchImpl: f.fetchImpl });
  assert.equal(r.claimed, 0, "回执说成功也没用");
  assert.equal(r.ok, false);
  assert.equal(r.status, "not-landed");
  assert.match(r.message, /未到账|复查/);
});

test("runCheckin：今日已到账 → 零写操作（幂等只靠列表预检）", async () => {
  const f = fakeUpstream({ [F_DELIVERY]: deliveryWith("CONFIRMED") });
  const r = await runCheckin({ account: FAKE_ACCOUNT, fetchImpl: f.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, "already");
  assert.deepEqual(f.hits.map((h) => h.url.includes(F_DELIVERY) ? "delivery" : "other"), ["delivery"], "已到账不许打 claim/confirm");
});

test("runCheckin：status=CLAIMED（领了没到账）→ 只补 confirm，再复查", async () => {
  const f = fakeUpstream({ [F_DELIVERY]: (n) => deliveryWith(n === 1 ? "CLAIMED" : "CONFIRMED"), [F_CONFIRM]: { code: 0 } });
  const r = await runCheckin({ account: FAKE_ACCOUNT, fetchImpl: f.fetchImpl });
  assert.equal(r.status, "claimed");
  assert.equal(r.claimed, 1);
  assert.deepEqual(f.hits.map((h) => (h.url.includes(F_CONFIRM) ? "confirm" : "delivery")), ["delivery", "confirm", "delivery"]);
});

test("runCheckin：dry 干跑只读列表，一个写操作都不发", async () => {
  const f = fakeUpstream({ [F_DELIVERY]: deliveryWith("ELIGIBLE", { claimable: true }), [F_CLAIM]: { code: 0 } });
  const r = await runCheckin({ account: FAKE_ACCOUNT, fetchImpl: f.fetchImpl, dry: true });
  assert.equal(r.dry, true);
  assert.deepEqual(r.actions, [{ kind: "claim", id: 1, credit: 1000, title: "每日签到领积分" }]);
  assert.equal(f.hits.length, 1, "干跑只打列表");
});

test("fetchCreditBalance：取 usageTotalPackageCredit 的 package_credit_*（不累加分类）", async () => {
  const f = fakeUpstream({ [F_PKG]: { metrics: [
    { name: "usageTokenChatMessages", usage_token_num: 4842436, package_token_amount: 1 },
    { name: "usageTotalPackageCredit", package_credit_amount: 8500.0, package_credit_used: 56.8, package_credit_remain: 8443.2 },
    { name: "usageBasicPackageCredit", package_credit_amount: 500.0, package_credit_used: 0.0, package_credit_remain: 500.0 },
  ] } });
  const r = await fetchCreditBalance({ account: FAKE_ACCOUNT, fetchImpl: f.fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual({ total: r.total, used: r.used, remain: r.remain }, { total: 8500, used: 56.8, remain: 8443.2 });
  assert.equal(r.tokenUsage, 4842436);
});

test("planCreditActions：status 为 null（空）即便 claimable=true 也不 claim —— 对齐参考实现的「未获得活动资格」", () => {
  const items = [{ campaignId: 1, title: "每日签到领积分", type: "USER_LOGIN", benefitAmount: 1000, benefitUnit: "CREDIT", claimable: true, status: null }];
  assert.deepEqual(planCreditActions(parseCreditCampaigns({ code: 0, data: { items } })), []);
});

// ─────────────────────────── 第三片：daemon 调度器（deps 注入，测试零网络） ───────────────────────────

const { isCheckinEnabled, getCheckinHour, setupCodeartsCheckin } = await import("../src/runtime/codearts-checkin.js");

const okJson = (obj) => ({ status: 200, text: async () => JSON.stringify(obj) });
const dailyBody = (status, claimable) => ({
  code: 0,
  data: { items: [{ campaignId: 1, title: "每日签到领积分", type: "USER_LOGIN", benefitAmount: 1000, benefitUnit: "CREDIT", claimable, status }] },
});

test("codearts 签到开关/时刻：默认开、默认 9 点；=0 关；越界回 9", () => {
  assert.equal(isCheckinEnabled({}), true);
  assert.equal(isCheckinEnabled({ MSLXDFF_CODEARTS_CHECKIN: "0" }), false);
  assert.equal(isCheckinEnabled({ MSLXDFF_CODEARTS_CHECKIN: "off" }), false);
  assert.equal(getCheckinHour({}), 9);
  assert.equal(getCheckinHour({ MSLXDFF_CODEARTS_CHECKIN_HOUR: "7" }), 7);
  assert.equal(getCheckinHour({ MSLXDFF_CODEARTS_CHECKIN_HOUR: "99" }), 9);
});

test("setupCodeartsCheckin：逐号串行签到 + 落 state.codeartsCheckin + 发事件（全程假 fetch）", async () => {
  const A = { userId: "ua", accessKeyId: "AKA", secretAccessKey: "SKA", securityToken: "ST-A" };
  const B = { userId: "ub", accessKeyId: "AKB", secretAccessKey: "SKB", securityToken: "ST-B" };
  const hits = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const st = init.headers?.["x-security-token"];
    hits.push({ u, st, method: init.method || "GET" });
    if (u.includes(F_DELIVERY)) {
      if (st === "ST-A") {
        const n = hits.filter((h) => h.st === "ST-A" && h.u.includes(F_DELIVERY)).length; // 1 起
        return okJson(dailyBody(n === 1 ? "ELIGIBLE" : "CONFIRMED", n === 1)); // A 号可领 → 领完复查到账
      }
      return okJson(dailyBody("CONFIRMED", false)); // B 号今天已到账 → 零写操作
    }
    if (u.includes(F_CLAIM) || u.includes(F_CONFIRM)) return okJson({ code: 0 });
    return { status: 404, text: async () => "{}" };
  };
  const events = [];
  const setup = await setupCodeartsCheckin({ bus: { emit: (e) => events.push(e) }, logs: null, deps: { accounts: [A, B], fetchImpl, env: { MSLXDFF_CODEARTS_CHECKIN_HOUR: "23" } } });
  const out = await setup.runOnce("test");

  assert.equal(out.ok, true);
  assert.equal(out.total, 2);
  assert.equal(out.okCount, 2);
  // 逐号串行：A 的全部请求（列表/领取/确认/复查）都排在 B 的第一个请求之前
  const firstB = hits.findIndex((h) => h.st === "ST-B");
  assert.ok(firstB > 0 && hits.slice(0, firstB).every((h) => h.st === "ST-A"), "必须逐号串行，不许交叉");

  const st = JSON.parse(readFileSync(process.env.MSLXDFF_STATE_FILE, "utf8"));
  assert.equal(st.codeartsCheckin.ok, 2);
  assert.equal(st.codeartsCheckin.total, 2);
  assert.equal(st.codeartsCheckin.accounts.length, 2);
  assert.equal(st.codeartsCheckin.accounts[0].credits, 1000, "A 号领到 1000");
  assert.equal(st.codeartsCheckin.accounts[1].status, "already", "B 号如实记「今日已领」");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(st.codeartsCheckin.date), "要有日期桶（防重复）");
  assert.ok(events.some((e) => e.type === "codearts-checkin-done"), "要有 done 事件（别再静默）");
  assert.ok(events.some((e) => e.type === "codearts-checkin-account"), "逐号也要有事件");
});

test("setupCodeartsCheckin：无账号 → 明确报 no-accounts（不静默）", async () => {
  const events = [];
  const setup = await setupCodeartsCheckin({ bus: { emit: (e) => events.push(e) }, logs: null, deps: { accounts: [], env: { MSLXDFF_CODEARTS_CHECKIN_HOUR: "23" } } });
  const out = await setup.runOnce("test");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "no-accounts");
  assert.ok(events.some((e) => e.type === "codearts-checkin-no-accounts"));
});

test("setupCodeartsCheckin：=0 时整个调度器关掉（不挂定时器）", async () => {
  const setup = await setupCodeartsCheckin({ logs: null, deps: { env: { MSLXDFF_CODEARTS_CHECKIN: "0" } } });
  assert.equal(setup.enabled, false);
  assert.equal(typeof setup.runOnce, "undefined", "关掉时不该暴露 runOnce（没定时器可挂）");
});

// ─────────────────────────── 第四片：CLI（-provider codearts checkin|quota） ───────────────────────────

const { handleCodeartsCheckin, handleCodeartsQuota } = await import("../src/cli/commands/provider/codearts-checkin.js");
const { spawnSync } = await import("node:child_process");

test("CLI 分发：非 codearts / 非签到子命令 → 立刻让位（返回 false）", async () => {
  assert.equal(await handleCodeartsCheckin("cline", "checkin", [], {}), false);
  assert.equal(await handleCodeartsCheckin("codearts", "models", [], {}), false);
  assert.equal(await handleCodeartsQuota("codearts", "clear", [], {}), false);
});

test("CLI checkin：逐号签到、打印到账、退出码 0（全程假 fetch）", async () => {
  const A = { userId: "ua", accessKeyId: "AKA", secretAccessKey: "SKA", securityToken: "ST-A" };
  const f = fakeUpstream({ [F_DELIVERY]: (n) => deliveryWith(n === 1 ? "ELIGIBLE" : "CONFIRMED", { claimable: n === 1 }), [F_CLAIM]: { code: 0 }, [F_CONFIRM]: { code: 0 } });
  const logs = [];
  const codes = [];
  const handled = await handleCodeartsCheckin("codearts", "checkin", [], { accounts: [A], fetchImpl: f.fetchImpl, log: (m) => logs.push(String(m)), exit: (c) => codes.push(c) });
  assert.equal(handled, true);
  assert.match(logs.join("\n"), /\+1000/, "要打印领到多少积分");
  assert.deepEqual(codes, [0]);
});

test("CLI checkin --json：给脚本可解析的一行 JSON", async () => {
  const B = { userId: "ub", accessKeyId: "AKB", secretAccessKey: "SKB", securityToken: "ST-B" };
  const f = fakeUpstream({ [F_DELIVERY]: deliveryWith("CONFIRMED") });
  const logs = [];
  const codes = [];
  await handleCodeartsCheckin("codearts", "checkin", ["--json"], { accounts: [B], fetchImpl: f.fetchImpl, log: (m) => logs.push(String(m)), exit: (c) => codes.push(c) });
  const parsed = JSON.parse(logs.at(-1));
  assert.equal(parsed.provider, "codearts");
  assert.equal(parsed.total, 1);
  assert.equal(parsed.accounts[0].status, "already");
  assert.deepEqual(codes, [0]);
});

test("CLI checkin --dry：干跑一个写请求都不发", async () => {
  const f = fakeUpstream({ [F_DELIVERY]: deliveryWith("ELIGIBLE", { claimable: true }), [F_CLAIM]: { code: 0 } });
  const logs = [];
  const codes = [];
  await handleCodeartsCheckin("codearts", "checkin", ["--dry"], { accounts: [FAKE_ACCOUNT], fetchImpl: f.fetchImpl, log: (m) => logs.push(String(m)), exit: (c) => codes.push(c) });
  assert.match(logs.join("\n"), /干跑/);
  assert.equal(f.hits.filter((h) => h.method === "POST").length, 0, "干跑不许发写请求");
});

test("CLI checkin：全失败 → 退出码 1（不许谎报成功）", async () => {
  const f = fakeUpstream({ [F_DELIVERY]: { __status: 500, error_code: "TM.00000000", error_msg: "服务异常" } });
  const logs = [];
  const codes = [];
  await handleCodeartsCheckin("codearts", "checkin", [], { accounts: [FAKE_ACCOUNT], fetchImpl: f.fetchImpl, log: (m) => logs.push(String(m)), exit: (c) => codes.push(c) });
  assert.deepEqual(codes, [1]);
  assert.match(logs.join("\n"), /查询活动失败/);
});

test("CLI quota：只读积分余额，全程无写请求", async () => {
  const f = fakeUpstream({ [F_PKG]: { metrics: [{ name: "usageTotalPackageCredit", package_credit_amount: 8500, package_credit_used: 56.8, package_credit_remain: 8443.2 }] } });
  const logs = [];
  const codes = [];
  const handled = await handleCodeartsQuota("codearts", "quota", [], { accounts: [FAKE_ACCOUNT], fetchImpl: f.fetchImpl, log: (m) => logs.push(String(m)), exit: (c) => codes.push(c) });
  assert.equal(handled, true);
  assert.match(logs.join("\n"), /8443\.2/, "要打印剩余积分");
  assert.ok(f.hits.every((h) => h.method === "GET"), "quota 全程只读");
  assert.deepEqual(codes, [0]);
});

test("CLI 端到端（真 bin）：没账号时给人话提示、退出码 1、零网络", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-codearts-cli-"));
  const r = spawnSync(process.execPath, ["bin/mslxdff.js", "-provider", "codearts", "checkin"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, MSLXDFF_STATE_FILE: join(dir, "state.json"), MSLXDFF_CODEARTS_CHECKIN_HOUR: "23" },
  });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /-provider codearts login/);
});