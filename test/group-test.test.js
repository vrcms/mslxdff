// `-group test` 链路测试单测：定位组长、阶段归因、成功回内容。全程注入，不碰真机。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runGroupLinkTest, resolveLeader, DEFAULT_TEST_MODEL } from "../src/cli/group-test.js";

const okRes = (obj, status = 200) => ({ status, ok: status < 400, text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)) });

const baseDeps = (extra = {}) => ({
  peers: [{ name: "leader", url: "http://leader:8989", token: "LEADERTOK" }],
  joined: [{ name: "my@mslxd", leaderUrl: "http://leader:8989" }],
  myToken: "MYTOK",
  ...extra,
});

test("resolveLeader: 优先取 peers 里名为 leader 的记录（含组长 token）", () => {
  const r = resolveLeader(baseDeps());
  assert.equal(r.leaderUrl, "http://leader:8989");
  assert.equal(r.leaderToken, "LEADERTOK");
  assert.equal(r.group, "my@mslxd");
});

test("resolveLeader: 无 leader 记录时用 groupsJoined.leaderUrl 回落取 token", () => {
  const r = resolveLeader({ peers: [{ url: "http://leader:8989", token: "T2" }], joined: [{ name: "g", leaderUrl: "http://leader:8989" }] });
  assert.equal(r.leaderToken, "T2");
  assert.equal(r.group, "g");
});

test("resolveLeader: 都没记录 → null", () => {
  assert.equal(resolveLeader({ peers: [], joined: [] }), null);
});

test("runGroupLinkTest: 成功 → status=ok，回内容，用**组长 token** 调 forward", async () => {
  let seenAuth = "";
  let seenUrl = "";
  let seenBody = null;
  const r = await runGroupLinkTest({
    target: "http://peer-b:8989",
    deps: baseDeps({
      fetchImpl: async (url, init) => {
        seenUrl = String(url); seenAuth = init.headers.Authorization; seenBody = JSON.parse(init.body);
        return okRes({ choices: [{ message: { content: "hello from peer-b" } }] });
      },
    }),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.content, "hello from peer-b");
  assert.equal(seenUrl, "http://leader:8989/v1/groups/relay/forward");
  assert.equal(seenAuth, "Bearer LEADERTOK", "必须用组长 token（本机 token 会被 401）");
  assert.equal(seenBody.group, "my@mslxd");
  assert.equal(seenBody.target, "http://peer-b:8989");
  assert.equal(seenBody.body.model, DEFAULT_TEST_MODEL);
  assert.equal(seenBody.body.messages[0].content, "hi");
});

test("runGroupLinkTest: 401 → stage=auth（并点明缺组长 token）", async () => {
  const r = await runGroupLinkTest({ target: "relay://x", deps: baseDeps({ fetchImpl: async () => okRes({ error: "Unauthorized" }, 401) }) });
  assert.equal(r.status, "error");
  assert.equal(r.stage, "auth");
  assert.match(r.hint, /组长/);
});

test("runGroupLinkTest: 404 → stage=target-missing", async () => {
  const r = await runGroupLinkTest({ target: "relay://nope", deps: baseDeps({ fetchImpl: async () => okRes({ error: "target relay://nope not found in group my@mslxd" }, 404) }) });
  assert.equal(r.stage, "target-missing");
});

test("runGroupLinkTest: 504 → stage=relay-timeout（成员没回）", async () => {
  const r = await runGroupLinkTest({ target: "relay://x", deps: baseDeps({ fetchImpl: async () => okRes({ error: "relay timeout" }, 504) }) });
  assert.equal(r.stage, "relay-timeout");
});

test("runGroupLinkTest: 502 fetch failed 对 relay 成员 → 归因「该成员自己打不通上游」，不甩锅组长", async () => {
  const r = await runGroupLinkTest({ target: "relay://0b295c55", deps: baseDeps({ fetchImpl: async () => okRes({ error: "fetch failed" }, 502) }) });
  assert.equal(r.stage, "forward-failed");
  assert.match(r.hint, /该成员自己的上游|成员离线|该成员自己/);
  assert.ok(!/把它当静态/.test(r.hint), "不能把 relay 成员失败误判成组长分类错（同组其他 relay 成员可用即证）");
});

test("runGroupLinkTest: 502 + x-mslxdff-relay-via=broadband → 归因「组长中继正常，断在成员那一跳」", async () => {
  const res = {
    status: 502, ok: false,
    text: async () => JSON.stringify({ error: "fetch failed" }),
    headers: { get: (k) => ({ "x-mslxdff-relay-via": "broadband", "x-mslxdff-relay-member-status": "502" }[k] || null) },
  };
  const r = await runGroupLinkTest({ target: "relay://0b295c55", deps: baseDeps({ fetchImpl: async () => res }) });
  assert.equal(r.stage, "forward-failed");
  assert.equal(r.relayVia, "broadband");
  assert.equal(r.memberStatus, "502");
  assert.match(r.hint, /宽带中继正常|成员那一跳/);
});

test("runGroupLinkTest: 502 + x-mslxdff-relay-via=direct → 归因「组长直连成员失败」", async () => {
  const res = {
    status: 502, ok: false,
    text: async () => JSON.stringify({ error: "fetch failed" }),
    headers: { get: (k) => (k === "x-mslxdff-relay-via" ? "direct" : null) },
  };
  const r = await runGroupLinkTest({ target: "http://peer-b:8989", deps: baseDeps({ fetchImpl: async () => res }) });
  assert.equal(r.relayVia, "direct");
  assert.match(r.hint, /直连/);
});

test("runGroupLinkTest: 200 但 body 是 error 对象 → stage=upstream（成员打上游失败）", async () => {
  const r = await runGroupLinkTest({ target: "relay://x", deps: baseDeps({ fetchImpl: async () => okRes({ error: { message: "upstream 500" } }) }) });
  assert.equal(r.stage, "upstream");
});

test("runGroupLinkTest: 连不上组长 → stage=forward-fetch", async () => {
  const r = await runGroupLinkTest({ target: "relay://x", deps: baseDeps({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }) });
  assert.equal(r.stage, "forward-fetch");
});

test("runGroupLinkTest: 没有组长记录 → stage=resolve-leader", async () => {
  const r = await runGroupLinkTest({ target: "relay://x", deps: { peers: [], joined: [], myToken: "t" } });
  assert.equal(r.stage, "resolve-leader");
});

test("runGroupLinkTest: 缺 target → stage=usage", async () => {
  const r = await runGroupLinkTest({ target: "" });
  assert.equal(r.stage, "usage");
});

test("runGroupLinkTest: --group 可覆盖组名", async () => {
  let seenBody = null;
  await runGroupLinkTest({ group: "other", target: "relay://x", deps: baseDeps({ fetchImpl: async (u, i) => { seenBody = JSON.parse(i.body); return okRes({ choices: [{ message: { content: "y" } }] }); } }) });
  assert.equal(seenBody.group, "other");
});
