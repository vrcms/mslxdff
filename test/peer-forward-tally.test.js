// 各节点「成功转发次数」统计（用户 2026-10-23）：只增不减的 wins + 按天分桶，
// 用来回答「除了本机，其他节点的次数是不是不对劲」。全程隔离 state、注入 now。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPeersService } from "../src/peers.js";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-peer-tally-"));
  return join(dir, "state.json");
}

function svc(over = {}) {
  return createPeersService({
    file: tmpStateFile(),
    peers: [{ name: "a", url: "http://a", token: "t" }, { name: "b", url: "http://b", token: "t" }],
    errors: {},
    stats: {},
    now: over.now,
  });
}

test("成功转发计数：每次真成功 wins+1（provisional 不计）", async () => {
  const s = svc();
  await s.recordResult("http://a", { ok: true, latencyMs: 100, model: "m" });
  assert.equal(s.stat("http://a").wins, 1, "真成功记 1");
  await s.recordResult("http://a", { ok: true, latencyMs: 100, model: "m" });
  assert.equal(s.stat("http://a").wins, 2, "再成功记 2");
  // provisional（只拿到响应头）暖缓存但不进成功计数
  await s.recordResult("http://a", { ok: true, latencyMs: 100, model: "m", provisional: true });
  assert.equal(s.stat("http://a").wins, 2, "provisional 不加强成功次数");
  assert.ok(s.stat("http://a").okAt > 0, "provisional 仍更新热缓存");
});

test("⚠ 回归：成功分支重建条目不得抹掉累计计数（历史 bug：每次成功 wins 归零）", async () => {
  const s = svc();
  await s.recordResult("http://a", { ok: true, latencyMs: 100, model: "m" });
  await s.recordResult("http://a", { ok: false });
  await s.recordResult("http://a", { ok: true, latencyMs: 120, model: "m" });
  const st = s.stat("http://a");
  assert.equal(st.wins, 2, "失败穿插后，成功累计仍在");
  assert.equal(st.failTotal, 1, "失败累计也在");
  assert.equal(st.fails, 0, "瞬时 fails 被最后一次成功清零（与累计 failTotal 不同源）");
});

test("失败计数：failTotal 只增不减，瞬时 fails 成功即清", async () => {
  const s = svc();
  await s.recordResult("http://b", { ok: false });
  await s.recordResult("http://b", { ok: false });
  assert.equal(s.stat("http://b").failTotal, 2);
  assert.equal(s.stat("http://b").fails, 2);
  await s.recordResult("http://b", { ok: true, latencyMs: 50, model: "m" });
  const st = s.stat("http://b");
  assert.equal(st.failTotal, 2, "成功后累计失败数不清（它是历史读数）");
  assert.equal(st.fails, 0, "瞬时失败数被成功清零");
});

test("按天分桶：ok/fail 各自累加，todayKey 命中当天", async () => {
  const fixed = new Date(2026, 9, 23, 12, 0, 0).getTime(); // 2026-10-23 本地
  const s = svc({ now: () => fixed });
  await s.recordResult("http://a", { ok: true, latencyMs: 10, model: "m" });
  await s.recordResult("http://a", { ok: true, latencyMs: 10, model: "m" });
  await s.recordResult("http://a", { ok: false });
  const k = s.todayKey();
  assert.equal(k, "2026-10-23", "todayKey 用注入的 now");
  const d = s.stat("http://a").days[k];
  assert.equal(d.ok, 2);
  assert.equal(d.fail, 1);
});

test("跨天：新一天从 0 计，旧桶保留在 days 里", async () => {
  let t = new Date(2026, 9, 23, 12, 0, 0).getTime();
  const s = svc({ now: () => t });
  await s.recordResult("http://a", { ok: true, latencyMs: 10, model: "m" });
  assert.equal(s.stat("http://a").days["2026-10-23"].ok, 1);
  t += 86_400_000; // 过一天
  await s.recordResult("http://a", { ok: true, latencyMs: 10, model: "m" });
  const st = s.stat("http://a");
  assert.equal(st.days["2026-10-23"].ok, 1, "昨天的桶不动");
  assert.equal(st.days["2026-10-24"].ok, 1, "今天另起一桶");
  assert.equal(st.wins, 2, "总成功跨天累加");
});

test("计数不参与选路打分：wins 高的节点不会因此排到前面", async () => {
  const t = 1_000_000;
  const s = createPeersService({
    file: tmpStateFile(),
    peers: [{ name: "a", url: "http://a", token: "t" }, { name: "b", url: "http://b", token: "t" }],
    errors: {},
    stats: { "http://a": { latencyMs: 9999, wins: 999 }, "http://b": { latencyMs: 10, wins: 1 } },
    now: () => t,
  });
  const ord = s.ordered().map((p) => p.url);
  assert.deepEqual(ord, ["http://b", "http://a"], "仍按延迟升序，wins 不参与排序");
});
