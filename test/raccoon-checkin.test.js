// raccoon daemon 每日自动签到：开关/时段/幂等/无号/落盘/事件。
// 全程注入 fetchImpl + 隔离 state 与 auth 目录，不碰真实上游。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-raccoon-checkin-")), "state.json");

const { setupRaccoonCheckin, isCheckinEnabled, getCheckinHour, credentialFromAccountDoc } = await import("../src/runtime/raccoon-checkin.js");
const { writeRaccoonAccountFile } = await import("../src/providers/raccoon/account-store.js");

const jsonRes = (obj, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

// hour=23 让「启动补签」在测试时段内恒不触发（避免 unref 定时器在长测试里发真请求）
const TEST_ENV = { MSLXDFF_RACCOON_CHECKIN_HOUR: "23" };

function authDirWith(uid, token) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-raccoon-auth-"));
  writeRaccoonAccountFile({ uid, accessToken: token, refreshToken: "ref", expiresAt: "9", deviceId: "dev" }, { dir });
  return dir;
}

const readState = () => JSON.parse(readFileSync(process.env.MSLXDFF_STATE_FILE, "utf8"));

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
  assert.deepEqual(credentialFromAccountDoc({ uid: "u1", accessToken: "at", refreshToken: "rt", officeIdentity: "of", deviceId: "dv" }), {
    access_token: "at",
    refresh_token: "rt",
    office_identity: "of",
    device_id: "dv",
    uid: "u1",
  });
  assert.deepEqual(credentialFromAccountDoc(null), { access_token: "", refresh_token: "", office_identity: "", device_id: "", uid: "" });
});

test("关闭开关 → 不排程、返回 enabled:false", async () => {
  const out = await setupRaccoonCheckin({ env: { MSLXDFF_RACCOON_CHECKIN: "0" } });
  assert.equal(out.enabled, false);
});

test("签到：有账号 + 上游发放 → claimed:true，落盘 raccoonCheckin，事件齐全", async () => {
  const dir = authDirWith("u-ok", "tok-ok");
  const events = [];
  const { runOnce } = await setupRaccoonCheckin({
    env: TEST_ENV,
    dirs: [dir],
    bus: { emit: (e) => events.push(e) },
    fetchImpl: async () => jsonRes({ code: 0, data: { points: 3000 } }),
  });
  const out = await runOnce("test");
  assert.equal(out.ok, true);
  assert.equal(out.total, 1);
  const st = readState();
  assert.equal(st.raccoonCheckin.total, 1);
  assert.equal(st.raccoonCheckin.ok, 1);
  assert.equal(st.raccoonCheckin.accounts[0].claimed, true);
  assert.equal(st.raccoonCheckin.accounts[0].points, 3000);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("raccoon-checkin-enabled"));
  assert.ok(types.includes("raccoon-checkin-account"));
  assert.ok(types.includes("raccoon-checkin-done"));
});

test("幂等：上游把「今日已领」当业务错误 → claimed:false 但 ok:true（不是失败）", async () => {
  const dir = authDirWith("u-already", "tok-already");
  const { runOnce } = await setupRaccoonCheckin({
    env: TEST_ENV,
    dirs: [dir],
    fetchImpl: async (url) => {
      if (String(url).includes("login/points/grant")) return jsonRes({ code: 400009, message: "今日已领取" });
      return jsonRes({ code: 0, data: { list: [{ biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000, created_at: new Date().toISOString() }] } });
    },
  });
  const out = await runOnce("test");
  assert.equal(out.ok, true, "「今日已领」是常态不是失败");
  assert.equal(out.results[0].claimed, false);
  assert.equal(out.results[0].points, 3000);
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

test("上游硬失败 → 该号 ok:false 并带原因，不抛（其余号照跑）", async () => {
  const bad = authDirWith("u-bad", "tok-bad");
  const good = authDirWith("u-good2", "tok-good2");
  const { runOnce } = await setupRaccoonCheckin({
    env: TEST_ENV,
    dirs: [bad, good],
    fetchImpl: async (url, init) => {
      const tok = String(init?.headers?.Authorization || "").replace(/^Bearer /, "");
      if (tok === "tok-bad") return jsonRes({ code: 500, message: "上游炸了" }, 500);
      return jsonRes({ code: 0, data: { points: 3000 } });
    },
  });
  const out = await runOnce("test");
  assert.equal(out.total, 2);
  assert.equal(out.okCount, 1);
  const failed = out.results.find((r) => r.uid === "u-bad");
  assert.equal(failed.ok, false);
  assert.ok(String(failed.msg).length > 0);
});
