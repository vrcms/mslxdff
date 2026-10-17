// BUG-32：rotation-log 的裁剪是 `st.size`（字节）配 `slice(-512*1024)`（字符），量纲不匹配。
// 两个实测后果：①中文（3 字节/字符）下保留的字节数浮动，阈值语义失真；
// ②slice 按字符切会**切在半行**上（实测开头 `"el=workbuddy/deepseek totalMs="`），
// 下一行接上去就把日志结构毁了。与 logs.js/model-trace.js 的 BUG-10/BUG-31 同族。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRotationLog } from "../src/providers/workbuddy/rotation-log.js";

test("rotation-log: 超限裁剪按字节留 3/4，且不切半行", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-rot-"));
  const file = join(dir, "workbuddy-rotation.log");
  const maxBytes = 64 * 1024;
  try {
    // 中文行（3 字节/字符）—— 正是字符数与字节数偏离最大的场景
    const line = "2026-10-17 22:00:00 uid=用户123 model=workbuddy/m totalMs=5000 balanceHit=0 error=上游错误\n";
    const rows = Array.from({ length: 3000 }, () => line);
    writeFileSync(file, rows.join(""), "utf8");
    assert.ok(Buffer.byteLength(readFileSync(file, "utf8")) > maxBytes, "构造体量需超阈值");

    appendRotationLog({ uid: "u1", model: "workbuddy/m", totalMs: 1, balanceHit: false, dirs: [dir], maxBytes, clock: () => Date.now() });

    const text = readFileSync(file, "utf8");
    // ① 必须真的落到阈值内（按字节判，不是按字符）
    assert.ok(Buffer.byteLength(text) <= maxBytes + 512, `裁剪后仍须在阈值内，实际 ${Buffer.byteLength(text)}`);
    // ② 必须保留大部分（3/4），不能断崖
    assert.ok(Buffer.byteLength(text) > maxBytes * 0.5, `应保留约 3/4，实际 ${Buffer.byteLength(text)}`);
    // ③ 每一行都必须完整（以时间戳开头、以换行结尾）——切半行是本缺陷最阴的部分
    for (const ln of text.split("\n").filter(Boolean)) {
      assert.match(ln, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} uid=/, `发现半截行：${JSON.stringify(ln.slice(0, 40))}`);
    }
    // ④ 新写入的那条在
    assert.ok(text.includes("uid=u1"), "新写入的行不得丢失");
    assert.ok(text.endsWith("\n"), "须以换行收尾");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
