// traework 签到/积分判据 + keys 覆盖闸门的回归测试。
// 铁律：全程注入假 fetch，**一次都不许碰真上游**（claim 会真领积分，且跑在用户账号上）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-traework-checkin-")), "state.json");
// hour=23：让启动补签在测试时段内恒不触发；定时器都 unref，进程退出即散，不会漏真请求
process.env.MSLXDFF_TRAEWORK_CHECKIN_HOUR = "23";

const { checkinClaim, checkinClaimVerified, entUsage } = await import("../src/providers/traework/checkin.js");
const { keysWriteDenial, RESERVED_PROVIDER_SUBS } = await import("../src/cli/commands/provider/keys-guard.js");
const { handleTraeworkQuota } = await import("../src/cli/commands/provider/traework-checkin.js");
const stateMod = await import("../src/state.js");

const ST = "checkin_credits/status", CL = "checkin_credits/claim", EU = "ide_user_ent_usage";

// routes: 端点片段 → 对象 或 (第几次调用) => 对象；calls 记录命中次序供断言
function fakeUpstream(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    const hit = Object.entries(routes).find(([frag]) => u.includes(frag));
    if (!hit) return { status: 404, text: async () => "{}" };
    const [frag, maker] = hit;
    const n = calls.filter((c) => c === frag).length;
    calls.push(frag);
    const out = typeof maker === "function" ? maker(n) : maker;
    return { status: out?.__status || 200, text: async () => JSON.stringify(out?.__body ?? out) };
  };
  return { calls, fetchImpl };
}
const NOT_YET = { checked_in: false, enable: true, credits: 100 };
const DONE = { checked_in: true, enable: true, credits: 100 };

test("checkinClaim：回执 code 才判失败，缺 code 不臆造契约", async () => {
  const a = fakeUpstream({ [CL]: { code: 0, message: "success" } });
  assert.equal((await checkinClaim({ cred: {}, fetchImpl: a.fetchImpl })).ok, true);
  const b = fakeUpstream({ [CL]: { code: 4008, message: "quota" } });
  const rb = await checkinClaim({ cred: {}, fetchImpl: b.fetchImpl });
  assert.equal(rb.ok, false); assert.equal(rb.code, 4008); assert.equal(rb.message, "quota");
  const c = fakeUpstream({ [CL]: { message: "no code field here" } });
  assert.equal((await checkinClaim({ cred: {}, fetchImpl: c.fetchImpl })).ok, true, "无 code 字段 → 不判失败");
});

test("checkinClaimVerified：已签过就不再 claim（省写操作）", async () => {
  const f = fakeUpstream({ [ST]: DONE });
  const r = await checkinClaimVerified({ cred: {}, fetchImpl: f.fetchImpl });
  assert.equal(r.already, true); assert.equal(r.claimed, false);
  assert.deepEqual(f.calls, [ST], "checked_in=true 时不许打 claim");
});

test("checkinClaimVerified：未开放签到不硬打", async () => {
  const f = fakeUpstream({ [ST]: { checked_in: false, enable: false, credits: 0 } });
  const r = await checkinClaimVerified({ cred: {}, fetchImpl: f.fetchImpl });
  assert.match(r.msg, /not enabled/); assert.deepEqual(f.calls, [ST]);
});

test("checkinClaimVerified：真到账 = 复查 checked_in 翻 true", async () => {
  const f = fakeUpstream({ [ST]: (n) => (n === 0 ? NOT_YET : DONE), [CL]: { code: 0 } });
  const r = await checkinClaimVerified({ cred: {}, fetchImpl: f.fetchImpl });
  assert.equal(r.claimed, true); assert.equal(r.phantom, false); assert.equal(r.credits, 100);
  assert.deepEqual(f.calls, [ST, CL, ST], "判据必须是 前置状态→领取→复查");
});

test("回归·谎报：回执 code:0 但复查仍 false → 判未到账（旧写法在这里会记 ok:true）", async () => {
  const f = fakeUpstream({ [ST]: NOT_YET, [CL]: { code: 0, message: "success" } });
  const r = await checkinClaimVerified({ cred: {}, fetchImpl: f.fetchImpl });
  assert.equal(r.claimed, false, "上游回执再漂亮，复查没到账就不算签");
  assert.equal(r.phantom, true);
  assert.match(r.msg, /checked_in/);
});

test("checkinClaimVerified：claim 抛 HTTP 错 → 不算 phantom（回执本身就没成功）", async () => {
  const f = fakeUpstream({ [ST]: NOT_YET, [CL]: { __status: 500, __body: { e: 1 } } });
  const r = await checkinClaimVerified({ cred: {}, fetchImpl: f.fetchImpl });
  assert.equal(r.claimed, false); assert.equal(r.phantom, false); assert.match(r.msg, /claim http/);
});

test("checkinClaimVerified：传 before 省一次前置往返", async () => {
  const f = fakeUpstream({ [ST]: (n) => (n === 0 ? DONE : DONE), [CL]: { code: 0 } });
  await checkinClaimVerified({ cred: {}, fetchImpl: f.fetchImpl, before: { checkedIn: true, credits: 7, enable: true } });
  assert.deepEqual(f.calls, [], "before 已说明已签，一个请求都不该发");
});

test("entUsage：求和的是额度上限，且 remain 这个误导名不许回潮", async () => {
  const packs = [
    { entitlement_base_info: { quota: { credits_limit: 2000 } } },
    { entitlement_base_info: { quota: { credits_limit: 2000 } } },
    { entitlement_base_info: { quota: { enable_solo_lite: true } } },
    { entitlement_base_info: { quota: { credits_limit: 500 } } },
  ];
  const f = fakeUpstream({ [EU]: { user_entitlement_pack_list: packs, is_credits_billing: true } });
  const r = await entUsage({ cred: {}, fetchImpl: f.fetchImpl });
  assert.equal(r.totalCredits, 4500); assert.equal(r.packCount, 4); assert.equal(r.isCreditsBilling, true);
  assert.equal(r.remain, undefined, "实测上游无已用/剩余字段，不得再叫 remain");
  const e = fakeUpstream({ [EU]: { user_entitlement_pack_list: null } });
  assert.equal((await entUsage({ cred: {}, fetchImpl: e.fetchImpl })).totalCredits, 0);
});

test("keysWriteDenial 闸1：verb 一律不当 key（事故原型 traework quota）", () => {
  const d = keysWriteDenial("traework", "quota", ["quota"]);
  assert.ok(d, "必须拦"); assert.match(d.join("\n"), /没有这个子命令/);
  assert.ok(keysWriteDenial("openrouter", "quota", ["quota"]), "verb 拦截与 provider 无关");
  assert.ok(keysWriteDenial("traework", "checkin", ["checkin"]), "checkin 也不许当 key");
});

test("keysWriteDenial 闸2：auth 号型 keys 只读，--force 才放行", () => {
  const tok = "eyJhbGciOiJSUzI1NiJ9." + "x".repeat(40);
  const d = keysWriteDenial("traework", tok, [tok]);
  assert.ok(d); assert.match(d.join("\n"), /auth 号型/);
  assert.ok(keysWriteDenial("raccoon", "abc", ["abc"]), "六家 auth 号型全覆盖");
  assert.equal(keysWriteDenial("traework", tok, [tok, "--force"]), null, "--force 留逃生阀");
  assert.equal(keysWriteDenial("openrouter", "sk-real-key-1", ["sk-real-key-1"]), null, "普通供应商手填 key 照常");
});

test("RESERVED_PROVIDER_SUBS 覆盖签到/额度三件套（漏一个就是废号入口）", () => {
  for (const s of ["quota", "credits", "balance", "checkin", "signin", "login"]) assert.ok(RESERVED_PROVIDER_SUBS.has(s), s);
});

const goodToken = "eyJhbGciOiJSUzI1NiJ9." + "y".repeat(48);
const deps = (over) => ({ keys: [goodToken], auths: [{ uid: "2508405578", deviceId: "" }], config: {}, ...over });

test("handleTraeworkQuota：只读 —— 绝不触发 claim", async () => {
  const f = fakeUpstream({ [ST]: NOT_YET, [EU]: { user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 4500 } } }] } });
  const out = [];
  let code = null;
  const ok = await handleTraeworkQuota("traework", "quota", [], { ...deps(), fetchImpl: f.fetchImpl, log: (m) => out.push(m), exit: (c) => { code = c; } });
  const text = out.join("\n");
  assert.equal(ok, true); assert.equal(code, 0);
  assert.ok(f.calls.includes(ST) && f.calls.includes(EU), "状态接口要有");
  assert.ok(!f.calls.includes(CL), "quota 是只读视图，不许领积分");
  assert.match(text, /额度上限 4500/); assert.match(text, /今日未签到/); assert.match(text, /不是剩余可用/);
  assert.ok(!text.includes(goodToken), "凭据纪律：不许把 token 打到终端");
});

test("handleTraeworkQuota：keys 槽位是垃圾串时不发任何上游请求，直接指路", async () => {
  const f = fakeUpstream({});
  const out = [];
  let code = null;
  await handleTraeworkQuota("traework", "quota", [], { ...deps({ keys: ["quota"] }), fetchImpl: f.fetchImpl, log: (m) => out.push(m), exit: (c) => { code = c; } });
  assert.deepEqual(f.calls, [], "拿垃圾串打上游只会拿鉴权失败糊弄排查");
  assert.match(out.join("\n"), /不像 accessToken/); assert.match(out.join("\n"), /login 重登回填/);
  assert.equal(code, 1, "全号都坏 → 退出码 1");
});

test("handleTraeworkQuota：--json 可解析且带口径提示", async () => {
  const f = fakeUpstream({ [ST]: DONE, [EU]: { user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 500 } } }] } });
  const out = [];
  await handleTraeworkQuota("traework", "quota", ["--json"], { ...deps(), fetchImpl: f.fetchImpl, log: (m) => out.push(m), exit: () => {} });
  const j = JSON.parse(out.join(""));
  assert.equal(j.accounts[0].totalCredits, 500);
  assert.equal(j.accounts[0].checkedIn, true);
  assert.match(j.note, /上限非剩余/);
});

test("handleTraeworkQuota：非 traework 与未知 sub 一律不认领（交回责任链）", async () => {
  assert.equal(await handleTraeworkQuota("cline", "quota", [], deps({ log: () => {}, exit: () => {} })), false);
  assert.equal(await handleTraeworkQuota("traework", "list", [], deps({ log: () => {}, exit: () => {} })), false);
});

// ---- daemon 侧：state 落盘不许谎报（这次那 100 分丢在这） ----
async function seedTraeworkState() {
  stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
    providerConfigs: { traework: { baseUrl: "https://trae-api-cn.mchost.guru", keys: [goodToken], auths: [{ uid: "2508405578", deviceId: "" }], allowedModels: [] } },
  });
}
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("daemon 自动签到：到账才把 date 盖成今天", async () => {
  await seedTraeworkState();
  stateMod.writeStateImmediate(stateMod.defaultStateFile(), { traeworkCheckin: { date: "2026-01-01" } });
  const f = fakeUpstream({ [ST]: (n) => (n === 0 ? NOT_YET : DONE), [CL]: { code: 0 } });
  const { setupTraeworkCheckin } = await import("../src/runtime/traework-checkin.js");
  const s = await setupTraeworkCheckin({ deps: { fetchImpl: f.fetchImpl } });
  const r = await s.runOnce("test");
  assert.equal(r.okCount, 1);
  const rec = stateMod.readState(stateMod.defaultStateFile()).traeworkCheckin;
  assert.equal(rec.date, todayKey(), "真到账才配盖今天的戳");
  assert.equal(rec.ok, 1); assert.equal(rec.phantom, 0);
});

test("回归·daemon 谎报：回执成功但没到账 → date 不许盖今天（否则当日补签被掐）", async () => {
  await seedTraeworkState();
  stateMod.writeStateImmediate(stateMod.defaultStateFile(), { traeworkCheckin: { date: "2026-01-01" } });
  const f = fakeUpstream({ [ST]: NOT_YET, [CL]: { code: 0, message: "success" } });
  const { setupTraeworkCheckin } = await import("../src/runtime/traework-checkin.js");
  const s = await setupTraeworkCheckin({ deps: { fetchImpl: f.fetchImpl } });
  const r = await s.runOnce("test");
  assert.equal(r.okCount, 0, "没到账就是没到账");
  const rec = stateMod.readState(stateMod.defaultStateFile()).traeworkCheckin;
  assert.equal(rec.date, "2026-01-01", "date 保持原值，shouldCatchUp 明天今天都还会再补签");
  assert.equal(rec.lastAttempt, todayKey(), "但要留最后一次尝试痕迹");
  assert.equal(rec.phantom, 1);
  assert.equal(rec.ok, 0);
});

test("daemon：keys 被写成垃圾串时不去打上游，直接给人话", async () => {
  stateMod.writeStateImmediate(stateMod.defaultStateFile(), {
    providerConfigs: { traework: { baseUrl: "x", keys: ["quota"], auths: [{ uid: "2508405578" }] } },
  });
  const f = fakeUpstream({});
  const { setupTraeworkCheckin } = await import("../src/runtime/traework-checkin.js");
  const s = await setupTraeworkCheckin({ deps: { fetchImpl: f.fetchImpl } });
  const r = await s.runOnce("test");
  assert.equal(r.okCount, 0);
  assert.deepEqual(f.calls, [], "垃圾 token 打上去只会拿到鉴权失败污染排查");
});
