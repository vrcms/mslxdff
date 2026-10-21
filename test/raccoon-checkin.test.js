// raccoon 登录奖励的 daemon 兜底扫描：开关/时段/幂等/无号/落盘/事件/过期号保护。
// 全程注入 fetchImpl + 隔离 state 与 auth 目录，不碰真实上游。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-raccoon-checkin-")), "state.json");

const { setupRaccoonCheckin, isCheckinEnabled, getCheckinHour, credentialFromAccountDoc } = await import("../src/runtime/raccoon-checkin.js");
const { writeRaccoonAccountFile } = await import("../src/providers/raccoon/account-store.js");
const { isRaccoonExpired } = await import("../src/providers/raccoon/auth.js");

const jsonRes = (obj, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

// hour=23 让「启动补签」在测试时段内恒不触发（避免 unref 定时器在长测试里发真请求）
const TEST_ENV = { MSLXDFF_RACCOON_CHECKIN_HOUR: "23" };

// expiresAt 默认给一个远期值（2100 年），让常规用例都算「登录态新鲜」；
// 要测过期号保护时显式传远古值。
function authDirWith(uid, token, { expiresAt = "4102444800000" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-raccoon-auth-"));
  writeRaccoonAccountFile({ uid, accessToken: token, refreshToken: "ref", expiresAt, deviceId: "dev" }, { dir });
  return dir;
}

const readState = () => JSON.parse(readFileSync(process.env.MSLXDFF_STATE_FILE, "utf8"));

const TODAY = () => new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

/**
 * 有状态的上游模拟：真实上游是「惰性结算」——账单里的记录在对应的写端点被调用之后才出现。
 * 用无状态 fake 拼「第几次查账单」会让两个任务的调用次数互相干扰，测出来的东西跟线上不是一回事。
 */
function fakeUpstream({ settingFails = false } = {}) {
  const state = { dailyGranted: false, rewardGranted: false };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("setting_info")) {
      if (settingFails) return jsonRes({ code: 500, message: "boom" }, 500);
      state.dailyGranted = true;
      return jsonRes({ code: 0, message: "success", data: {} });
    }
    if (u.includes("login/points/grant")) {
      const already = state.rewardGranted;
      state.rewardGranted = true;
      return jsonRes({ code: 0, message: "success", data: { granted: !already, popup: already ? null : { points: 3000 } } });
    }
    if (u.includes("/bills")) {
      const items = [];
      if (state.dailyGranted) items.push({ biz_type: "daily_grant", event_name: "每日积分发放", points: 500, grant_at: TODAY(), created_at: TODAY() });
      if (state.rewardGranted) items.push({ biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000, created_at: TODAY() });
      return jsonRes({ code: 0, data: { items } });
    }
    return jsonRes({ code: 0, data: {} });
  };
  return { state, fetchImpl };
}

test("开关：默认开；0/false/off/no 关", () => {
  assert.equal(isCheckinEnabled({}), true);
  assert.equal(isCheckinEnabled({ MSLXDFF_RACCOON_CHECKIN: "1" }), true);
  for (const v of ["0", "false", "off", "no", "OFF"]) assert.equal(isCheckinEnabled({ MSLXDFF_RACCOON_CHECKIN: v }), false, v);
});

test("时段：默认 9 点；合法值生效；越界回落 9", () => {
  assert.equal(getCheckinHour({}), 9);
  assert.equal(getCheckinHour({ MSLXDFF_RACCOON_CHECKIN_HOUR: "7" }), 7);
  assert.equal(getCheckinHour({ MSLXDFF_RACCOON_CHECKIN_HOUR: "0" }), 0);
  assert.equal(getCheckinHour({ MSLXDFF_RACCOON_CHECKIN_HOUR: "99" }), 9);
  assert.equal(getCheckinHour({ MSLXDFF_RACCOON_CHECKIN_HOUR: "abc" }), 9);
});

test("账号文档 → credential 形状（字段映射 + 缺字段不炸）", () => {
  assert.deepEqual(credentialFromAccountDoc({ uid: "u1", accessToken: "at", refreshToken: "rt", expiresAt: "123", officeIdentity: "of", deviceId: "dv" }), {
    access_token: "at",
    refresh_token: "rt",
    expires_at: "123",
    office_identity: "of",
    device_id: "dv",
    uid: "u1",
  });
  // expires_at 漏映射时，过期/临期判定会全部静默失效（回落解 JWT，假 token 解不出就当作没过期）
  assert.equal(credentialFromAccountDoc({ expiresAt: "9" }).expires_at, "9");
  assert.ok(isRaccoonExpired(credentialFromAccountDoc({ accessToken: "not-a-jwt", expiresAt: "9" })), "带上 expires_at 后过期号必须判得出来");
  assert.deepEqual(credentialFromAccountDoc(null), { access_token: "", refresh_token: "", expires_at: "", office_identity: "", device_id: "", uid: "" });
});

test("关闭开关 → 不排程、返回 enabled:false", async () => {
  const out = await setupRaccoonCheckin({ env: { MSLXDFF_RACCOON_CHECKIN: "0" } });
  assert.equal(out.enabled, false);
});

test("每日任务：有账号 + 今日结算入账 → daily:claimed，落盘 raccoonCheckin，事件齐全", async () => {
  const dir = authDirWith("u-ok", "tok-ok");
  const events = [];
  const { fetchImpl } = fakeUpstream();
  const { runOnce } = await setupRaccoonCheckin({
    env: TEST_ENV,
    dirs: [dir],
    bus: { emit: (e) => events.push(e) },
    fetchImpl,
  });
  const out = await runOnce("test");
  assert.equal(out.ok, true);
  assert.equal(out.dailyClaimed, 1, "每日积分该入账");
  assert.equal(out.claimed, 1, "一次性登录奖励该领到");
  assert.equal(out.total, 1);
  const st = readState();
  assert.equal(st.raccoonCheckin.total, 1);
  assert.equal(st.raccoonCheckin.dailyClaimed, 1);
  assert.equal(st.raccoonCheckin.dailyDone, 1);
  assert.equal(st.raccoonCheckin.accounts[0].daily, "claimed");
  assert.equal(st.raccoonCheckin.accounts[0].dailyPoints, 500);
  assert.equal(st.raccoonCheckin.accounts[0].reward, "claimed");
  assert.equal(st.raccoonCheckin.accounts[0].rewardPoints, 3000);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("raccoon-checkin-enabled"));
  assert.ok(types.includes("raccoon-checkin-account"));
  assert.ok(types.includes("raccoon-checkin-done"));
});

test("每日任务：今天已结算过 → daily:already，仍算 ok（正常态不是失败）", async () => {
  const dir = authDirWith("u-daily-already", "tok-da");
  const { fetchImpl, state } = fakeUpstream();
  state.dailyGranted = true; // 今天早些时候已结算过
  const { runOnce } = await setupRaccoonCheckin({ env: TEST_ENV, dirs: [dir], fetchImpl });
  const out = await runOnce("test");
  assert.equal(out.results[0].daily, "already");
  assert.equal(out.results[0].dailyPoints, 500);
  assert.equal(out.ok, true, "今天已结算是常态，不该判失败");
});

test("每日积分结算失败不拖累一次性补领（两件事互不依赖）", async () => {
  const dir = authDirWith("u-daily-fail", "tok-df");
  const { fetchImpl } = fakeUpstream({ settingFails: true });
  const { runOnce } = await setupRaccoonCheckin({ env: TEST_ENV, dirs: [dir], fetchImpl });
  const out = await runOnce("test");
  assert.equal(out.results[0].daily, "error", "结算炸了如实报 error");
  assert.equal(out.results[0].reward, "claimed", "补领照样跑完，不被邻居拖累");
  assert.equal(out.claimed, 1);
});

test("幂等：上游把「今日已领」当业务错误 → reward:already，仍算 ok（不是失败）", async () => {
  const dir = authDirWith("u-already", "tok-already");
  const today = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const { runOnce } = await setupRaccoonCheckin({
    env: TEST_ENV,
    dirs: [dir],
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("login/points/grant")) return jsonRes({ code: 400009, message: "今日已领取" });
      return jsonRes({
        code: 0,
        data: {
          items: [
            { biz_type: "daily_grant", event_name: "每日积分发放", points: 500, grant_at: today },
            { biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000, created_at: today },
          ],
        },
      });
    },
  });
  const out = await runOnce("test");
  assert.equal(out.ok, true, "「今日已领」是常态不是失败");
  assert.equal(out.results[0].reward, "already");
  assert.equal(out.results[0].rewardPoints, 3000);
});

test("无账号 → no-accounts，不报错", async () => {
  const empty = mkdtempSync(join(tmpdir(), "mslxdff-raccoon-empty-"));
  const events = [];
  const { runOnce } = await setupRaccoonCheckin({ env: TEST_ENV, dirs: [empty], bus: { emit: (e) => events.push(e) } });
  const out = await runOnce("test");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "no-accounts");
  assert.ok(events.some((e) => e.type === "raccoon-checkin-no-accounts"));
});

test("上游硬失败 → 该号 reward:error 并带原因，不抛（其余号照跑）", async () => {
  const bad = authDirWith("u-bad", "tok-bad");
  const good = authDirWith("u-good2", "tok-good2");
  const { state, fetchImpl: base } = fakeUpstream();
  const { runOnce } = await setupRaccoonCheckin({
    env: TEST_ENV,
    dirs: [bad, good],
    fetchImpl: async (url, init) => {
      const tok = String(init?.headers?.Authorization || "").replace(/^Bearer /, "");
      // 坏号：账单查得动、grant 硬失败。每日结算端点也一起打成 500，免得把好号的状态带过来。
      if (tok === "tok-bad") {
        if (String(url).includes("/bills")) return jsonRes({ code: 0, data: { items: [] } });
        return jsonRes({ code: 500, message: "上游炸了" }, 500);
      }
      return base(url, init);
    },
  });
  const out = await runOnce("test");
  assert.equal(out.total, 2);
  assert.equal(out.claimed, 1, "好的那个号该照常领到，不被邻居失败拖累");
  assert.equal(state.rewardGranted, true);
  const failed = out.results.find((r) => r.uid === "u-bad");
  assert.equal(failed.ok, false);
  assert.equal(failed.reward, "error", "账单查得动却没有这笔 = 真失败，不能含糊成 unverified");
  assert.ok(String(failed.msg).length > 0);
});

test("access_token 已过期的号：跳过且绝不去碰 refresh（防与网关并发烧号）", async () => {
  const dir = authDirWith("u-stale", "tok-stale", { expiresAt: "1000" }); // 刻意设为远古
  const urls = [];
  const { runOnce } = await setupRaccoonCheckin({
    env: TEST_ENV,
    dirs: [dir],
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonRes({ code: 0, data: { list: [] } });
    },
  });
  const out = await runOnce("test");
  assert.equal(out.results[0].status, "auth_stale");
  assert.equal(out.results[0].ok, false);
  assert.equal(urls.length, 0, "过期号一个上游请求都不该发：既不 grant，也绝不 refresh");
});
