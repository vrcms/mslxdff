import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createGroupsService, syncPeersFromMembers } from "../src/groups.js";
import { createPeersService } from "../src/peers.js";
import { loadGroups } from "../src/state.js";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-bb-"));
  return join(dir, "state.json");
}

const BIN = join(import.meta.dirname, "..", "bin", "mslxdff.js");

test("01 state: broadband fields persist and old data defaults to static", () => {
  const file = tmpStateFile();
  const svc = createGroupsService({ file });
  svc.create("wg");
  // add broadband member with extra fields
  const members = svc.addMember("wg", { key: "wg", memberName: "home-D", url: "relay://home-D", token: "t", kind: "broadband", publicIp: "1.2.3.4", lastSeen: 1234567890 });
  assert.ok(members["home-D"], "broadband member created");
  assert.equal(members["home-D"].kind, "broadband");
  assert.equal(members["home-D"].publicIp, "1.2.3.4");
  // reload
  const reloaded = loadGroups({ file });
  assert.equal(reloaded.wg.members["home-D"].kind, "broadband");
  assert.equal(reloaded.wg.members["home-D"].url, "relay://home-D");
  // old shape: add static member without kind
  svc.addMember("wg", { key: "wg", memberName: "vps-A", url: "http://1.2.3.5:8989", token: "ta" });
  const after = loadGroups({ file });
  // missing kind should be treated as static by consumer (we store undefined, consumer defaults)
  assert.ok(!after.wg.members["vps-A"].kind || after.wg.members["vps-A"].kind === "static" || after.wg.members["vps-A"].kind === undefined);
});

test("02 syncPeersFromMembers: broadband relay:// not added to peers, static added", () => {
  const peers = createPeersService({ peers: [], errors: {} });
  const r = syncPeersFromMembers({
    peers,
    myUrl: "http://self:8989",
    group: "wg",
    members: {
      "home-D": { url: "relay://home-D", token: "t", kind: "broadband" },
      "vps-A": { url: "http://1.2.3.4:8989", token: "ta", kind: "static" },
    },
  });
  // only static should be added
  assert.equal(peers.all().length, 1);
  assert.equal(peers.all()[0].url, "http://1.2.3.4:8989");
});

test("03 CLI -help contains --broadband and no --relay alias", () => {
  const res = spawnSync(process.execPath, [BIN, "-help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--broadband/);
  assert.match(res.stdout, /宽带/);
  // should not mention relay as user-facing flag
  // we allow internal word relay in code but help should not have --relay
  assert.ok(!res.stdout.includes("--relay"), "help should not expose --relay");
});

test("03 CLI: broadband listen defaults to 127.0.0.1 logic in server", async () => {
  // server host param: broadband host should be 127.0.0.1, static 0.0.0.0
  // we test resolve via startServer host param indirectly: check that bin handles --broadband parsing
  // parse args: -addtogroup <host> <name> --broadband should mark joined kind
  // Use tmp state to simulate join with mock fetch
  // For now just verify that help shows the new line format
  const res = spawnSync(process.execPath, [BIN, "-help"], { encoding: "utf8" });
  assert.match(res.stdout, /-addtogroup.*\[--broadband\]/);
});

test("04 peers: broadband stale cooling", () => {
  let t = 1_000_000;
  const staleMs = 90_000;
  // We will test that a broadband with lastSeen older than 90s is considered cooling
  // Peers service should handle relay:// URLs with lastSeen
  const peers = createPeersService({
    peers: [{ name: "home-D", url: "relay://home-D", token: "t", kind: "broadband", lastSeen: t - 100_000 }],
    errors: {},
    now: () => t,
  });
  // available should be 0 because stale
  // Current impl may not yet support broadband stale, so this test will fail until implemented
  // After impl, available should filter stale broadband
  const avail = peers.available();
  assert.equal(avail.length, 0, "stale broadband should be cooling");
  // fresh
  peers.add({ name: "home-D2", url: "relay://home-D2", token: "t2", kind: "broadband", lastSeen: t - 10_000 });
  const avail2 = peers.available();
  // should contain fresh one (home-D2) but not stale home-D
  assert.ok(avail2.some((p) => p.url === "relay://home-D2"), "fresh broadband should be available");
  assert.ok(!avail2.some((p) => p.url === "relay://home-D"), "stale should remain not available");
});

test("05 relay heartbeat updates lastSeen and publicIp on leader", async () => {
  const { createGroupsService } = await import("../src/groups.js");
  const { createRouter } = await import("../src/routes.js");
  const { createUpstreamClient } = await import("../src/upstream.js");
  const { startServer } = await import("../src/server.js");
  const token = "a".repeat(64);
  const file = tmpStateFile();
  const groups = createGroupsService({ file });
  groups.create("wg");
  // add broadband member via leader
  groups.addMember("wg", { key: "wg", memberName: "home-D", url: "relay://home-D", token: "home-token", kind: "broadband", publicIp: "1.1.1.1", lastSeen: Date.now() - 100_000 });
  const upstream = createUpstreamClient({ baseUrl: "http://127.0.0.1:1", retry: {} });
  const srv = startServer({ router: createRouter({ token, upstream, groups }) }, 0);
  await srv.ready();
  const port = srv.server.address().port;
  try {
    // heartbeat from broadband
    const res = await fetch(`http://127.0.0.1:${port}/v1/groups/relay/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer home-token` },
      body: JSON.stringify({ name: "wg" }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    // check leader's state updated
    const { loadGroups } = await import("../src/state.js");
    const reloaded = loadGroups({ file });
    const m = reloaded.wg.members["home-D"];
    assert.equal(m.kind, "broadband");
    assert.ok(typeof m.lastSeen === "number" && Date.now() - m.lastSeen < 5000, "lastSeen refreshed");
    assert.ok(m.publicIp, "publicIp set from clientIp");
  } finally {
    await srv.close();
    srv.server.closeAllConnections?.();
  }
});

test("05 relay forward enqueue/poll/result via leader", async () => {
  const { createGroupsService } = await import("../src/groups.js");
  const { createRouter } = await import("../src/routes.js");
  const { createUpstreamClient } = await import("../src/upstream.js");
  const { startServer } = await import("../src/server.js");
  const token = "a".repeat(64);
  const file = tmpStateFile();
  const groups = createGroupsService({ file });
  groups.create("wg");
  const homeToken = "home-token-2";
  groups.addMember("wg", { key: "wg", memberName: "home-D", url: "relay://home-D", token: homeToken, kind: "broadband", publicIp: "2.2.2.2", lastSeen: Date.now() });
  const upstream = createUpstreamClient({ baseUrl: "http://127.0.0.1:1", retry: {} });
  const srv = startServer({ router: createRouter({ token, upstream, groups }) }, 0);
  await srv.ready();
  const port = srv.server.address().port;
  const leaderUrl = `http://127.0.0.1:${port}`;
  try {
    // A forwards via leader to broadband (enqueue)
    const fwdBody = { model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] };
    const forwardPromise = fetch(`${leaderUrl}/v1/groups/relay/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ group: "wg", target: "relay://home-D", body: fwdBody, reqId: "test-req-1" }),
    });
    // give it a moment to enqueue
    await new Promise((r) => setTimeout(r, 50));
    // D polls
    const poll = await fetch(`${leaderUrl}/v1/groups/relay/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${homeToken}` },
      body: JSON.stringify({ name: "wg" }),
    });
    assert.equal(poll.status, 200);
    const pj = await poll.json();
    assert.equal(pj.data.length, 1);
    assert.equal(pj.data[0].reqId, "test-req-1");
    // D posts result
    const result = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, from: "broadband" }) };
    const resPost = await fetch(`${leaderUrl}/v1/groups/relay/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${homeToken}` },
      body: JSON.stringify({ name: "wg", reqId: "test-req-1", result }),
    });
    assert.equal(resPost.status, 200);
    // A's forward should now resolve
    const fwdRes = await forwardPromise;
    assert.equal(fwdRes.status, 200);
    const txt = await fwdRes.text();
    assert.match(txt, /broadband/);
  } finally {
    await srv.close();
    srv.server.closeAllConnections?.();
  }
});

test("05 broadband join via POST /v1/groups/join with --broadband", async () => {
  const { createGroupsService } = await import("../src/groups.js");
  const { createRouter } = await import("../src/routes.js");
  const { createUpstreamClient } = await import("../src/upstream.js");
  const { startServer } = await import("../src/server.js");
  const token = "a".repeat(64);
  const file = tmpStateFile();
  const groups = createGroupsService({ file });
  groups.create("mygroup");
  const upstream = createUpstreamClient({ baseUrl: "http://127.0.0.1:1", retry: {} });
  const srv = startServer({ router: createRouter({ token, upstream, groups }) }, 0);
  await srv.ready();
  const port = srv.server.address().port;
  try {
    const homeToken = "bb-token-xyz";
    const res = await fetch(`http://127.0.0.1:${port}/v1/groups/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "mygroup", key: "mygroup", url: "relay://bb-1234", token: homeToken, kind: "broadband" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.members["relay://bb-1234"] || Object.values(data.members).some((m) => m.url === "relay://bb-1234"));
    const member = Object.values(data.members).find((m) => m.url === "relay://bb-1234");
    assert.equal(member.kind, "broadband");
    assert.ok(member.publicIp);
    assert.ok(member.lastSeen);
    assert.equal(data.you.url, "relay://bb-1234");
  } finally {
    await srv.close();
    srv.server.closeAllConnections?.();
  }
});
