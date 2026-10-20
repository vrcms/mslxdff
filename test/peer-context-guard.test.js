// 转发前上下文预检 —— 真正的出站闸门（peers.forwardToPeer）。
//
// 为什么必须在这里测：组员转发有三条独立出口（via-route 自己 fetch、peer 的 forwardToPeer、broadband），
// 闸门必须落在**每一条实际发请求的地方**，否则漏掉哪条，那条路照样会把大上下文白烧给对方。
// 现网实证（errors.log 2026-10-19～20）：376 条 `context_length_exceeded`，其中 274 条是组员执行撞的。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { forwardToPeer } from "../src/routes/peers.js";

const ENV = "MSLXDFF_FORWARD_MAX_CONTEXT_TOKENS";
function withEnv(v, fn) {
  const saved = process.env[ENV];
  if (v === undefined) delete process.env[ENV];
  else process.env[ENV] = v;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }
}

// 不可达的组员地址：闸门若放行，这里会抛 ECONNREFUSED；
// 闸门若拦下，会直接返回带 contextGuard 的 Error —— 两者可区分，不必真起服务。
const PEER = { url: "http://127.0.0.1:1", token: "t" };

const bigBody = () => ({ messages: [{ role: "user", content: "x".repeat(900_000) }] }); // ≈250k tokens
const smallBody = () => ({ messages: [{ role: "user", content: "hi" }] });

describe("forwardToPeer：上下文闸门", () => {
  test("超限 → 不出站，返回带 contextGuard 的 Error", async () => {
    await withEnvAsync("200000", async () => {
      const r = await forwardToPeer(PEER, bigBody(), "m1", 0, new AbortController(), 300);
      assert.ok(r instanceof Error, "必须是 Error（调用方按失败处理）");
      assert.ok(r.contextGuard, "必须带 contextGuard 标记，供编排层识别并停止换路");
      assert.match(r.message, /context_length_exceeded/);
      assert.equal(r.contextGuard.limit, 200000);
      assert.ok(r.contextGuard.estimated > 200000);
    });
  });

  test("未超限 → 照常出站（这里表现为连不上，而不是闸门拦下）", async () => {
    await withEnvAsync("200000", async () => {
      const r = await forwardToPeer(PEER, smallBody(), "m1", 0, new AbortController(), 300);
      // 放行后真的去连了 127.0.0.1:1 → 连接失败。关键是**没有** contextGuard 标记。
      assert.ok(!r.contextGuard, "放行时不得带 contextGuard");
    });
  });

  test("闸门关闭（env=0）→ 大上下文照常出站", async () => {
    await withEnvAsync("0", async () => {
      const r = await forwardToPeer(PEER, bigBody(), "m1", 0, new AbortController(), 300);
      assert.ok(!r.contextGuard, "关掉闸门后行为必须回到旧样");
    });
  });

  test("估算按对象身份缓存：同一 body 反复判不重复扫", async () => {
    await withEnvAsync("200000", async () => {
      const body = bigBody();
      const t0 = process.hrtime.bigint();
      const r1 = await forwardToPeer(PEER, body, "m1", 0, new AbortController(), 300);
      const t1 = process.hrtime.bigint();
      const r2 = await forwardToPeer(PEER, body, "m1", 0, new AbortController(), 300);
      const t2 = process.hrtime.bigint();
      assert.ok(r1.contextGuard && r2.contextGuard);
      // 第一次要扫 90 万字符，第二次走缓存；第二次不该比第一次更慢（给 3 倍余量容忍噪声）
      const first = Number(t1 - t0);
      const second = Number(t2 - t1);
      assert.ok(second < first * 3, `第二次判应走缓存，first=${first}ns second=${second}ns`);
    });
  });
});

// 异步版 withEnv：forwardToPeer 是 async，环境变量必须在 await 期间保持生效
async function withEnvAsync(v, fn) {
  const saved = process.env[ENV];
  if (v === undefined) delete process.env[ENV];
  else process.env[ENV] = v;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }
}
