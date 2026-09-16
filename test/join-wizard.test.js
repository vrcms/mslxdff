import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLeaderUrl } from "../src/cli/join-core.js";
import { runJoinWizard, isTermux } from "../src/cli/join-wizard.js";

// ---------- normalizeLeaderUrl ----------
test("01 normalize: 纯主机补 http 与默认端口", () => {
  assert.deepEqual(normalizeLeaderUrl("149.13.91.10"), { ok: true, url: "http://149.13.91.10:8989" });
});

test("02 normalize: host:port 原样保留", () => {
  assert.deepEqual(normalizeLeaderUrl("149.13.91.10:9000"), { ok: true, url: "http://149.13.91.10:9000" });
});

test("03 normalize: 带 scheme 去尾斜杠、不补默认端口", () => {
  assert.deepEqual(normalizeLeaderUrl("http://1.2.3.4:8989/"), { ok: true, url: "http://1.2.3.4:8989" });
  assert.deepEqual(normalizeLeaderUrl("https://oc.example.com"), { ok: true, url: "https://oc.example.com" });
});

test("04 normalize: 非法输入给人话 reason", () => {
  const cases = ["", "   ", "a b", "1.2.3.4:abc", "1.2.3.4:70000", "ftp://x", "http://", "http://h/path"];
  for (const bad of cases) {
    const r = normalizeLeaderUrl(bad);
    assert.equal(r.ok, false, `should reject: ${JSON.stringify(bad)}`);
    assert.ok(r.reason && r.reason.length > 2, `reason for ${JSON.stringify(bad)}`);
  }
});

test("05 normalize: IPv6 方括号形态可用", () => {
  assert.deepEqual(normalizeLeaderUrl("[::1]:8989"), { ok: true, url: "http://[::1]:8989" });
});

// ---------- isTermux ----------
test("06 isTermux 识别 Termux 环境", () => {
  assert.equal(isTermux({ TERMUX_VERSION: "0.118" }), true);
  assert.equal(isTermux({ PREFIX: "/data/data/com.termux/files/usr" }), true);
  assert.equal(isTermux({}), false);
});

// ---------- runJoinWizard ----------
function fakeSession(inputs) {
  const asked = [];
  let i = 0;
  return { asked, session: { ask: async (q) => { asked.push(q); return inputs[i++] ?? ""; }, close() {} } };
}

test("07 向导：0 参数问两次，宽带入组 + 出口 IP + 服务已启动 + Termux 提示", async () => {
  const { asked, session } = fakeSession(["149.13.91.10:8989", "my@mslxd"]);
  const out = [];
  const joins = [];
  const r = await runJoinWizard({
    session,
    out: (l) => out.push(l),
    env: { TERMUX_VERSION: "0.118" },
    join: async (o) => { joins.push(o); return { ok: true, leaderUrl: "http://149.13.91.10:8989", myUrl: "relay://abc12345", token: "t" }; },
    probeIp: async () => "203.0.113.7",
    ensureService: async () => ({ pid: 1234, started: true }),
  });
  assert.equal(r.ok, true);
  assert.equal(asked.length, 2);
  assert.equal(joins.length, 1);
  assert.equal(joins[0].isBroadband, true);
  assert.equal(joins[0].name, "my@mslxd");
  assert.equal(joins[0].leaderHost, "http://149.13.91.10:8989");
  const text = out.join("\n");
  assert.match(text, /已加入组「my@mslxd」/);
  assert.match(text, /宽带/);
  assert.match(text, /203\.0\.113\.7/);
  assert.match(text, /1234/);
  assert.match(text, /termux-wake-lock/);
});

test("08 向导：给定 leader 只问组名；非 Termux 不打 wake-lock；已在跑与待确认降级", async () => {
  const { asked, session } = fakeSession(["my@mslxd"]);
  const out = [];
  const r = await runJoinWizard({
    leaderInput: "1.2.3.4",
    session,
    out: (l) => out.push(l),
    env: {},
    join: async () => ({ ok: true, leaderUrl: "http://1.2.3.4:8989", myUrl: "relay://x", token: "t" }),
    probeIp: async () => null,
    ensureService: async () => ({ pid: 9, started: false }),
  });
  assert.equal(r.ok, true);
  assert.equal(asked.length, 1);
  const text = out.join("\n");
  assert.ok(!text.includes("termux-wake-lock"));
  assert.match(text, /已在运行/);
  assert.match(text, /待确认/);
});

test("09 向导：地址非法重试 3 次后退出且不调 join", async () => {
  const { session } = fakeSession(["bad host", "1.2.3.4:xx", "http://", "my@mslxd"]);
  const out = [];
  let joined = 0;
  const r = await runJoinWizard({
    session,
    out: (l) => out.push(l),
    env: {},
    join: async () => { joined++; return { ok: true }; },
    probeIp: async () => null,
    ensureService: async () => ({ pid: 1, started: false }),
  });
  assert.equal(r.ok, false);
  assert.equal(joined, 0);
  assert.match(out.join("\n"), /重试/);
});

test("10 向导：组名为空重试后成功", async () => {
  const { session } = fakeSession(["1.2.3.4", "", "  ", "g1"]);
  const out = [];
  const r = await runJoinWizard({
    session,
    out: (l) => out.push(l),
    env: {},
    join: async (o) => ({ ok: true, leaderUrl: o.leaderHost, myUrl: "relay://y", token: "t" }),
    probeIp: async () => "1.1.1.1",
    ensureService: async () => ({ pid: 2, started: true }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.name, "g1");
});

test("11 向导：join 失败给人话与排障指引，不启动服务", async () => {
  const { session } = fakeSession(["1.2.3.4", "g1"]);
  const out = [];
  let svcCalled = 0;
  const r = await runJoinWizard({
    session,
    out: (l) => out.push(l),
    env: {},
    join: async () => ({ ok: false, error: "HTTP 503 leader down" }),
    probeIp: async () => null,
    ensureService: async () => { svcCalled++; return { pid: 1, started: false }; },
  });
  assert.equal(r.ok, false);
  assert.equal(svcCalled, 0);
  const text = out.join("\n");
  assert.match(text, /加入失败/);
  assert.match(text, /检查/);
  assert.match(text, /重试/);
});

test("12 向导：给定非法 leaderInput 直接失败（不进交互）", async () => {
  const { asked, session } = fakeSession(["x"]);
  const out = [];
  const r = await runJoinWizard({
    leaderInput: "a b",
    session,
    out: (l) => out.push(l),
    env: {},
    join: async () => ({ ok: true }),
    probeIp: async () => null,
    ensureService: async () => ({ pid: 1, started: false }),
  });
  assert.equal(r.ok, false);
  assert.equal(asked.length, 0);
});

test("13 向导：输入结束（EOF → ask 返回 null）体面取消，不重试不挂起", async () => {
  const asked = [];
  const session = { ask: async (q) => { asked.push(q); return null; }, close() {} };
  const out = [];
  const r = await runJoinWizard({
    session,
    out: (l) => out.push(l),
    env: {},
    join: async () => ({ ok: true }),
    probeIp: async () => null,
    ensureService: async () => ({ pid: 1, started: false }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "cancelled");
  assert.equal(asked.length, 1);
  assert.match(out.join("\n"), /取消/);
});
