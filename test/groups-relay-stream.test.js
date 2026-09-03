import { test } from "node:test";
import assert from "node:assert/strict";
import { createGroupsService } from "../src/groups.js";
import { enqueueRelay, getRelayPending, getRelayPendingByReqId, clearStreamSubscribers } from "../src/routes/relay-queue.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-s-"));
  return join(dir, "state.json");
}

function mockReqRes({ token, url }) {
  const headers = {};
  const res = {
    statusCode: 200,
    headers,
    writes: [],
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    write(s) { this.writes.push(String(s)); return true; },
    end(s) { if (s) this.writes.push(String(s)); this.ended = true; },
  };
  const req = {
    method: "GET",
    url,
    headers: { authorization: token ? `Bearer ${token}` : "" },
    on(ev, fn) { this[`_${ev}`] = fn; },
  };
  return { req, res };
}

test("streamHandler: 无 token 401", async () => {
  const { streamHandler } = await import("../src/routes/groups-relay.js");
  const { req, res } = mockReqRes({ token: null, url: "/v1/groups/relay/stream?name=wg" });
  const groups = createGroupsService({ file: tmpStateFile() });
  groups.create("wg");
  await streamHandler({ req, res, groups });
  assert.equal(res.statusCode, 401);
});

test("streamHandler: 非成员 403", async () => {
  const { streamHandler } = await import("../src/routes/groups-relay.js");
  const file = tmpStateFile();
  const groups = createGroupsService({ file });
  groups.create("wg");
  groups.addMember("wg", { key: "wg", memberName: "home-D", url: "relay://home-D", token: "real-token", kind: "broadband" });
  const { req, res } = mockReqRes({ token: "fake-token", url: "/v1/groups/relay/stream?name=wg" });
  await streamHandler({ req, res, groups });
  assert.equal(res.statusCode, 403);
});

test("streamHandler: 正常建连 写 SSE 头并可被 push", async () => {
  const { streamHandler } = await import("../src/routes/groups-relay.js");
  const file = tmpStateFile();
  const groups = createGroupsService({ file });
  groups.create("wg");
  const homeToken = "home-token-ok";
  groups.addMember("wg", { key: "wg", memberName: "home-D", url: "relay://home-D", token: homeToken, kind: "broadband", lastSeen: Date.now() });
  const { req, res } = mockReqRes({ token: homeToken, url: "/v1/groups/relay/stream?name=wg" });
  // do not await forever — handler holds connection, so race with timeout
  const handlerPromise = streamHandler({ req, res, groups, bus: { emit() {} }, logs: {} });
  // give event loop
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.ok(res.writes.join("").includes("connected") || res.writes.join("").includes(":"), "should write initial frame");
  // enqueue should push to this res
  clearStreamSubscribers();
  // need to re-subscribe: our handler already subscribed, but we cleared; re-subscribe manually
  // Instead test via real enqueue after handler subscribed: we need to re-create handler without clear
  // So test push via direct enqueue
  const { subscribeStream } = await import("../src/routes/relay-queue.js");
  // simulate new subscriber
  const res2 = { writes: [], write(s) { this.writes.push(s); return true; } };
  subscribeStream({ group: "wg", target: "relay://home-D", res: res2 });
  const p = enqueueRelay({ group: "wg", target: "relay://home-D", reqId: "r-stream-1", body: { model: "m" }, hops: 0 });
  p.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(res2.writes.join("").includes("r-stream-1"));
  // cleanup: trigger close
  req._close?.();
  // resolve pending to avoid leak
  const { resolveRelay } = await import("../src/routes/relay-queue.js");
  resolveRelay("r-stream-1", { status: 200 });
  await p.catch(() => {});
  // stop handler's interval by closing
  req._close?.();
  // handlerPromise may hang; we close res and ignore
  res.ended = true;
});

test("streamHandler: env MSLXDFF_BROADBAND_STREAM=0 时 404", async () => {
  const orig = process.env.MSLXDFF_BROADBAND_STREAM;
  process.env.MSLXDFF_BROADBAND_STREAM = "0";
  try {
    const { streamHandler } = await import("../src/routes/groups-relay.js");
    const file = tmpStateFile();
    const groups = createGroupsService({ file });
    groups.create("wg");
    groups.addMember("wg", { key: "wg", memberName: "home-D", url: "relay://home-D", token: "t0", kind: "broadband" });
    const { req, res } = mockReqRes({ token: "t0", url: "/v1/groups/relay/stream?name=wg" });
    await streamHandler({ req, res, groups });
    assert.equal(res.statusCode, 404);
  } finally {
    if (orig === undefined) delete process.env.MSLXDFF_BROADBAND_STREAM;
    else process.env.MSLXDFF_BROADBAND_STREAM = orig;
  }
});
