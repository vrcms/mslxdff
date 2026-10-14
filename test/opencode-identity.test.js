import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  genId,
  opencodeIdTail,
  digestIdTail,
  identifierTimeHex,
  counterFromTimeHex,
  opencodeClientIdentity,
} from "../src/opencode-identity.js";

// 现网取证（2026-10-13）：zen 免费层把 x-opencode-session 时间段（12 位 hex）的**低 12 位反解回
// per-ms counter**，只接受 [0,63]；形状过正则但反解越界 → 403 FreeTierError。这些测试锁的就是
// "反解合法"，而不是"形状像"——后者曾长期是唯一判据，也是这次全线 403 的成因。

const TAIL_RE = /^[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const WINDOW = 63;
const timeHexOf = (id) => String(id).slice(4, 16);

test("identifierTimeHex ↔ counterFromTimeHex 在 [1,63] 全域互逆", () => {
  const now = Date.now();
  for (let c = 1; c <= WINDOW; c++) {
    assert.equal(counterFromTimeHex(identifierTimeHex(now, c)), c, `counter=${c} 必须原值反解回来`);
  }
});

test("opencodeIdTail：形状合规且反解 counter 恒在窗口内（含同毫秒连发）", () => {
  const seenCounters = new Set();
  for (let i = 0; i < 500; i++) {
    const tail = opencodeIdTail();
    assert.match(tail, TAIL_RE, "必须是 12 位小写 hex + 14 位 base62");
    const c = counterFromTimeHex(tail.slice(0, 12));
    assert.ok(c >= 0 && c <= WINDOW, `第 ${i} 个 id 反解 counter=${c} 越界（上游会 403）`);
    seenCounters.add(c);
  }
  assert.ok(seenCounters.size > 1, "500 连发应看到 counter 在窗口内轮转，不是恒等值");
  assert.ok(Math.max(...seenCounters) <= WINDOW, "counter 绝不越出接受窗口");
});

test("digestIdTail：同种子恒同 id（会话亲和），且低 12 位被强制成合法 counter", () => {
  const digest = crypto.createHash("sha1").update("system-prompt|第一问").digest();
  const once = digestIdTail(digest);
  const twice = digestIdTail(digest);
  assert.equal(once, twice, "摘要派生必须确定性——上游按 session 归组免费额度与 prompt cache");
  assert.match(once, TAIL_RE);
  assert.equal(counterFromTimeHex(once.slice(0, 12)), 1, "会话 id 的 counter 固定 1，恒在窗口内");
  // 时间段不等于摘要前 6 字节原样：证明 counter 位是被改写进去的，而不是碰运气落进窗口
  assert.notEqual(once.slice(0, 12), digest.subarray(0, 6).toString("hex"));
  // 不同会话仍要分散
  const other = digestIdTail(crypto.createHash("sha1").update("system-prompt|另一问").digest());
  assert.notEqual(once, other);
});

test("genId 产出完整合规 id；opencodeClientIdentity 三件套形状一致", () => {
  const ses = genId("ses_");
  assert.equal(ses.length, 4 + 26);
  assert.match(ses, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(counterFromTimeHex(timeHexOf(ses)) <= WINDOW, "ses_ id 的 counter 必须在窗口内");
  const ident = opencodeClientIdentity();
  assert.match(ident["x-opencode-session"], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(ident["x-opencode-request"], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(/^opencode\/\d+\.\d+\.\d+$/.test(ident["User-Agent"]), "UA 必须 opencode/<semver>");
  assert.ok(counterFromTimeHex(timeHexOf(ident["x-opencode-session"])) >= 1);
});

test("回归画像：正序时钟（旧实现）形状过正则，但反解 counter 越界 = 当年 403 的那一型", () => {
  const MASK48 = (1n << 48n) - 1n;
  const ascending = ((BigInt(Date.now()) * 0x1000n + 1n) & MASK48).toString(16).padStart(12, "0");
  assert.match(ascending, /^[0-9a-f]{12}$/, "形状照样过正则");
  assert.ok(counterFromTimeHex(ascending) > WINDOW, "正序 id 反解必须越界——否则这条闸门判据就没被测到");
});

test("counterFromTimeHex：值域与形状边界（绝不抛，非 12 位 hex 一律 NaN）", () => {
  assert.equal(counterFromTimeHex("ffffffffffff"), 0, "全 1 时间段反解必须落在 0，不能 NaN——它是合法 counter");
  assert.equal(counterFromTimeHex("000000000000"), 4095, "全 0 时间段反解越界（4095>63），正是旧实现的形状");
  assert.equal(counterFromTimeHex("FFFFFFFFFFFF"), 0, "大写 hex 可解");
  for (const bad of ["", undefined, null, 123, "abcdefghijkl", "fff", "fffffffffff"]) {
    assert.ok(Number.isNaN(counterFromTimeHex(bad)), `非合规输入 ${String(bad)} 必须 NaN 而非抛异常`);
  }
});

test("genId 连发 2000 个 ses_：counter 全部落在 [0,63]，无一被闸门丢", () => {
  for (let i = 0; i < 2000; i++) {
    const c = counterFromTimeHex(timeHexOf(genId("ses_")));
    assert.ok(Number.isInteger(c) && c >= 0 && c <= WINDOW, `第 ${i} 个 counter=${c} 越界`);
  }
});

test("digestIdTail 造的会话 id 恒不被闸门丢：1000 个随机种子 counter 全 =1", () => {
  // 免费层按 session 归组额度与缓存，所以会话 id 只能确定性派生；确定性派生又最容易
  // 把随机字节填进时间段而反解越界——这条锁的就是"确定性 ⟂ 合法 counter"同时成立。
  for (let i = 0; i < 1000; i++) {
    const d = crypto.createHash("sha1").update(`seed-${i}`).digest();
    const tail = digestIdTail(d);
    assert.match(tail, TAIL_RE);
    const c = counterFromTimeHex(tail.slice(0, 12));
    assert.equal(c, 1, `种子 ${i} 的会话 id 反解 counter=${c}，会被免费层 403`);
  }
});

test("同一种子的会话 id 跨进程恒等（真起子进程比，不靠'纯函数'断言）", () => {
  const seed = "system-prompt|跨进程验收种子";
  const local = `ses_${digestIdTail(crypto.createHash("sha1").update(seed).digest())}`;
  const modUrl = new URL("../src/opencode-identity.js", import.meta.url).href;
  const child = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import crypto from "node:crypto";import {digestIdTail} from ${JSON.stringify(modUrl)};` +
        `process.stdout.write("ses_"+digestIdTail(crypto.createHash("sha1").update(${JSON.stringify(seed)}).digest()));`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(child, local, "同一种子必须铸出同一个 session id（否则上游按 session 归组的额度/缓存会被打散）");
  assert.ok(counterFromTimeHex(local.slice(4, 16)) <= WINDOW, "跨进程那个 id 也必须在闸门窗口内");
});
