import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueRelay,
  dequeueRelayForPoll,
  resolveRelay,
  subscribeStream,
  unsubscribeStream,
  pushToStream,
  getRelayPending,
  getRelayPendingByReqId,
  clearStreamSubscribers,
  getStreamSubscribers,
} from "../src/routes/relay-queue.js";

function mkRes() {
  const writes = [];
  return {
    writes,
    write(s) { writes.push(String(s)); return true; },
    closed: false,
  };
}

test("01 queue:无订阅者 enqueue 走队列 poll 可取", async () => {
  clearStreamSubscribers?.();
  getRelayPending().clear();
  getRelayPendingByReqId().clear();
  const p = enqueueRelay({ group: "wg", target: "relay://a", reqId: "r1", body: { m: 1 }, hops: 0 });
  p.catch(() => {});
  const batch = dequeueRelayForPoll({ group: "wg", target: "relay://a" });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].reqId, "r1");
  // cleanup
  resolveRelay("r1", { status: 200, headers: {}, body: "{}" });
  await p.catch(() => {});
});

test("01 queue:有订阅者 enqueue 直接 push 不进 poll 队列", async () => {
  clearStreamSubscribers();
  getRelayPending().clear();
  getRelayPendingByReqId().clear();
  const res = mkRes();
  subscribeStream({ group: "wg", target: "relay://a", res });
  const p = enqueueRelay({ group: "wg", target: "relay://a", reqId: "r2", body: { model: "m" }, hops: 1 });
  p.catch(() => {});
  // poll should get 0 because already pushed
  const batch = dequeueRelayForPoll({ group: "wg", target: "relay://a" });
  assert.equal(batch.length, 0, "pushed to stream should not be in poll queue");
  // but res should have received SSE
  assert.ok(res.writes.length > 0, "stream should have been written");
  assert.ok(res.writes.join("").includes("r2"), "SSE data should contain reqId");
  // resolve should work even though not in queue
  const ok = resolveRelay("r2", { status: 200, headers: {}, body: "hi" });
  assert.equal(ok, true);
  const val = await p;
  assert.equal(val.status, 200);
  unsubscribeStream({ group: "wg", target: "relay://a", res });
});

test("01 queue:断开订阅后 enqueue 回落到 poll", async () => {
  clearStreamSubscribers();
  getRelayPending().clear();
  getRelayPendingByReqId().clear();
  const res = mkRes();
  subscribeStream({ group: "wg", target: "relay://b", res });
  unsubscribeStream({ group: "wg", target: "relay://b", res });
  const p = enqueueRelay({ group: "wg", target: "relay://b", reqId: "r3", body: {}, hops: 0 });
  p.catch(() => {});
  const batch = dequeueRelayForPoll({ group: "wg", target: "relay://b" });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].reqId, "r3");
  resolveRelay("r3", { status: 200 });
  await p.catch(() => {});
});

test("01 queue:pushToStream 返回是否推成功", () => {
  clearStreamSubscribers();
  const res = mkRes();
  assert.equal(pushToStream({ group: "wg", target: "relay://x", entry: { reqId: "rx", body: {}, hops: 0 } }), false);
  subscribeStream({ group: "wg", target: "relay://x", res });
  assert.equal(pushToStream({ group: "wg", target: "relay://x", entry: { reqId: "rx2", body: { hi: 1 }, hops: 0 } }), true);
  assert.ok(res.writes.join("").includes("rx2"));
  unsubscribeStream({ group: "wg", target: "relay://x", res });
});

test("01 queue:resolve 清理 pendingByReqId 且超时清理", async () => {
  clearStreamSubscribers();
  getRelayPending().clear();
  getRelayPendingByReqId().clear();
  const p = enqueueRelay({ group: "wg", target: "relay://c", reqId: "r4", body: {}, hops: 0 });
  assert.ok(getRelayPendingByReqId().has("r4"));
  resolveRelay("r4", { status: 200 });
  assert.ok(!getRelayPendingByReqId().has("r4"));
  await p;
});
