// qoder 同请求粘号：空转/换路重试不得换号；只有 401/403/429/5xx 冷却后才换。
// 背景：两个号分属 cn/global 两区（region 决定 URL），此前每调用一次 ring.next() 就换号，
// 空转重试因此把"URL 在切"写进日志——切号只该由冷却（401/403/429/5xx）触发。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyRing } from "../src/providers/keyring.js";
import { createStickyPicker } from "../src/providers/qoder/sticky.js";

function mk({ ttlMs = 600_000 } = {}) {
  const now = { t: 0 };
  // 冷却是 keyring 内部时钟、粘号 TTL 是选择器时钟：两处都要注入同一个假时钟，否则断言随机失败
  const ring = createKeyRing(["A", "B"], { now: () => now.t });
  const pick = createStickyPicker({
    pick: () => ring.next(),
    isCooling: (k) => ring.isCooling(k),
    ttlMs,
    now: () => now.t,
  });
  return { ring, pick, now };
}

test("同一请求（同 scope）内复用同一个号，不因重试换号", () => {
  const { pick } = mk();
  assert.equal(pick("req:1"), "A");
  assert.equal(pick("req:1"), "A", "重试必须复用同一个号");
  assert.equal(pick("req:1"), "A");
  assert.equal(pick("req:2"), "B", "新请求才推进轮转（负载仍分摊）");
});

test("无 scope 时退化为原 round-robin（兼容旧行为）", () => {
  const { pick } = mk();
  assert.equal(pick(null), "A");
  assert.equal(pick(null), "B");
  assert.equal(pick(null), "A");
});

test("只有 401/403/429/5xx 冷却才换号，且换后继续粘住", () => {
  const { ring, pick, now } = mk();
  assert.equal(pick("req:1"), "A");
  ring.onError("A"); // 401/403/429/5xx 走这条；空转不走
  assert.equal(pick("req:1"), "B", "号已冷却 → 必须切到下一个可用号");
  assert.equal(pick("req:1"), "B", "切换后仍粘住，不再乱跳");
  now.t += 60_000; // 超过 30s 冷却
  assert.equal(ring.isCooling("A"), false);
  assert.equal(pick("req:1"), "B", "冷却过期不会把请求甩回原号");
});

test("scope 过期后重新轮转（表不会无限增长）", () => {
  const { pick, now } = mk({ ttlMs: 1000 });
  assert.equal(pick("req:1"), "A");
  now.t += 5000;
  assert.equal(pick("req:1"), "B", "超过 TTL 视为新请求，重新轮转");
});

test("选号决定可观测：new/sticky/switch/rr 各自上报（\"为什么是它\"必须留痕）", () => {
  const { ring, pick } = mk();
  const seen = [];
  const d = (x) => seen.push(x);
  pick("req:1", d);        // 首次遇到该请求 → 轮转选中
  pick("req:1", d);        // 同请求复用 → sticky
  pick(null, d);           // 无 scope（如 models 探活）→ 退回轮转
  ring.onError("A");       // 401/403/429/5xx 冷却
  pick("req:1", d);        // 上次的号已冷却 → 必须换
  assert.deepEqual(seen, ["new", "sticky", "rr", "switch"]);
});
