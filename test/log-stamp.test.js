// daemon.log 行归因（时间 + pid）的离线测试：不碰真实流，全部注入。
// 背景（2026-10-17 组长 VPS）：一份 daemon.log 里混着两个 daemon、两个版本的行，
// 没有时间与 pid 就分不清「谁写的、哪一轮的」——「日志什么都没看出来」的真因。
import { test } from "node:test";
import assert from "node:assert/strict";
import { installLogStamp, stampPrefix, stampText } from "../src/runtime/log-stamp.js";

const at = (h, m, s) => () => new Date(2026, 9, 17, h, m, s).getTime();

test("log-stamp：前缀是 [HH:MM:SS pid]，个位数要补零", () => {
  assert.equal(stampPrefix({ now: at(9, 5, 7), pid: 2550934 }), "[09:05:07 2550934] ");
});

test("log-stamp：每行都加前缀；半行写入不重复打标", () => {
  const p = { prefix: "[T 1] " };
  assert.deepEqual(stampText("a\nb\n", p), { text: "[T 1] a\n[T 1] b\n", atLineStart: true });
  const half = stampText("半句", p);
  assert.equal(half.text, "[T 1] 半句");
  assert.equal(half.atLineStart, false, "行没写完 ⇒ 不是行首");
  assert.deepEqual(
    stampText("收尾\n", { prefix: "[T 1] ", atLineStart: half.atLineStart }),
    { text: "收尾\n", atLineStart: true },
    "续写同一行只许有一次前缀",
  );
  assert.deepEqual(stampText("", p), { text: "", atLineStart: true }, "空写入不改状态");
});

test("log-stamp：装上后所有写入都被打标，且幂等（不会套两层）", () => {
  const writes = [];
  const s = { write: (c) => { writes.push(String(c)); return true; } };
  installLogStamp({ streams: [s], now: at(1, 2, 3), pid: 42 });
  s.write("hello\n");
  installLogStamp({ streams: [s], now: at(1, 2, 3), pid: 42 });
  s.write("world\n");
  assert.deepEqual(writes, ["[01:02:03 42] hello\n", "[01:02:03 42] world\n"]);
});

test("log-stamp：write 的 (chunk, cb) 与 (chunk, enc, cb) 两种签名都要原样透传", () => {
  const seen = [];
  const s = { write: (...a) => { seen.push(a); return true; } };
  installLogStamp({ streams: [s], now: at(0, 0, 0), pid: 1 });
  const cb = () => {};
  s.write("a\n", cb);
  assert.equal(seen[0][0], "[00:00:00 1] a\n");
  assert.equal(seen[0][1], undefined);
  assert.equal(seen[0][2], cb);
  s.write("b\n", "utf8", cb);
  assert.equal(seen[1][0], "[00:00:00 1] b\n");
  assert.equal(seen[1][1], "utf8");
  assert.equal(seen[1][2], cb);
});

test("log-stamp：没有 write 的流 / 空流一律跳过，不抛", () => {
  assert.deepEqual(installLogStamp({ streams: [null, {}, undefined] }), []);
});
