// BUG-34：hedge.js 的私有 cancelBody 写成 `await x.cancel().catch(()=>{})`。
// 自定义/AI SDK 流的 cancel() 可能返回 undefined（非 Promise）—— 那种写法会抛
// TypeError 并被外层 catch 吞掉，于是**后面的 handle.cancel() 根本不执行**
// ⇒ 落败方的上游流没被真正取消（读写继续，白烧额度/连接）。
// 对照：stream-body.js 的 cancelBody 早已按 `typeof p.catch === "function"` 防御，
// 且注释明写「cancel() 可能返回非 Promise」—— 说明这个坑踩过，但 hedge.js 的私有副本没跟上。
import { test } from "node:test";
import assert from "node:assert/strict";
import { hedgedFirstChunkRace } from "../src/routes/hedge.js";

/** 造一个「首块迟迟不来」的 local body，cancel() 返回 undefined（模拟 AI SDK 流）。 */
function slowBodyReturningNonPromise({ onCancel }) {
  return {
    getReader() {
      return {
        read: () => new Promise(() => {}),        // 永不 resolve ⇒ local 先超时
        cancel: () => { onCancel("handle"); return undefined; },
        releaseLock: () => {},
      };
    },
    cancel: () => { onCancel("body"); return undefined; },  // ← 关键：非 Promise
  };
}

/** 造一个「立刻给首块」的 peer body。 */
function fastBody() {
  return {
    getReader() {
      let i = 0;
      return {
        read: async () => (i++ === 0 ? { done: false, value: Buffer.from("data: ok\n\n") } : new Promise(() => {})),
        cancel: async () => {},
        releaseLock: () => {},
      };
    },
    cancel: async () => {},
  };
}

test("hedge: local 落败时，cancel() 返回非 Promise 也不得阻止 handle 被取消", async () => {
  const cancelled = [];
  const localUpRes = { status: 200, headers: new Headers(), body: slowBodyReturningNonPromise({ onCancel: (w) => cancelled.push(w) }) };

  // peers 只暴露 ordered()，racePeerCandidates 由真实模块驱动——这里用最小替身：
  // racePeerCandidates 走的是 ./peers.js 的真实实现，故直接给 peers 一个能返回候选的服务过高。
  // 改为：让 hedgeDelay 极短 + peers 为空 ⇒ 走「peer-miss 后 local 兜底」的路径，
  // 该路径同样会调用 cancelBody（见 hedge.js 的 local 失败分支）。
  const peers = {
    ordered: () => [],
    orderedByLastError: () => [],
    coolingByLastError: () => [],
  };

  const r = await hedgedFirstChunkRace({
    localUpRes,
    peers,
    handlerCtx: { peers },
    hedgeDelayMs: 30,
    evt: () => {},
  }).catch(() => null);

  // 这条路径下 local 是唯一候选且它超时 ⇒ 必然走 cancelBody
  assert.equal(r, null, "local 超时且无 peer ⇒ 返回 null");
  assert.ok(cancelled.includes("body"), "body.cancel 应被调用");
  assert.ok(
    cancelled.includes("handle"),
    "handle.cancel 必须也被调用 —— 非 Promise 返回值不得阻断后续取消（BUG-34）",
  );
});
