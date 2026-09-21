import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderChooser, renderChooserHelp, parseKey } from "../src/chooser.js";

describe("chooser", () => {
  const items = [
    { id: "big-pickle", current: true },
    { id: "deepseek-v4-flash-free", ms: 320 },
    { id: "hy3-free", status: "limit" },
    { id: "broken-free", fail: "HTTP 502" },
  ];

  test("renderChooser marks cursor with arrow and current with check", () => {
    const lines = renderChooser(items, 0);
    assert.match(lines[0], /^❯ big-pickle ✓ \(current\)$/);
    assert.match(lines[1], /^  deepseek-v4-flash-free  \[320ms\]$/);
    assert.match(lines[2], /^  hy3-free  \[limit\]$/);
    assert.match(lines[3], /^  broken-free  \[fail: HTTP 502\]$/);
  });

  test("renderChooser moves arrow with cursor", () => {
    const lines = renderChooser(items, 2);
    assert.equal(lines[0].startsWith(" "), true);
    assert.equal(lines[2].startsWith("❯"), true);
  });

  test("help line explains keys", () => {
    const [blank, help] = renderChooserHelp();
    assert.equal(blank, "");
    assert.match(help, /↑\/↓/);
    assert.match(help, /Enter/);
    assert.match(help, /q\/Esc/);
  });

  test("parseKey maps arrows/enter/cancel and ignores others", () => {
    assert.equal(parseKey("\x1b[A"), "up");
    assert.equal(parseKey("k"), "up");
    assert.equal(parseKey("\x1b[B"), "down");
    assert.equal(parseKey("j"), "down");
    assert.equal(parseKey("\r"), "enter");
    assert.equal(parseKey("\n"), "enter");
    assert.equal(parseKey("\x1b"), "cancel");
    assert.equal(parseKey("q"), "cancel");
    assert.equal(parseKey("\x03"), "cancel");
    assert.equal(parseKey("x"), null);
    assert.equal(parseKey(""), null);
  });

  test("parseKey maps space for multi-select toggle", () => {
    assert.equal(parseKey(" "), "space");
  });

  test("renderChooser multi mode: 勾选框在名字前，[✓]选中 [ ]未选", () => {
    const multiItems = [
      { id: "big-pickle", current: true, picked: true },
      { id: "mimo-v2.5-free", picked: false },
      { id: "hy3-free", picked: true, status: "limit" },
    ];
    const lines = renderChooser(multiItems, 0, { multi: true });
    assert.match(lines[0], /^❯ \[✓\] big-pickle$/);
    assert.match(lines[1], /^  \[ \] mimo-v2.5-free$/);
    assert.match(lines[2], /^  \[✓\] hy3-free  \[limit\]$/);
  });

  test("single-select rendering is unchanged by picked flag without multi mode", () => {
    const items = [{ id: "big-pickle", current: true, picked: true }];
    const lines = renderChooser(items, 0);
    assert.match(lines[0], /^❯ big-pickle ✓ \(current\)$/);
  });

  test("multi help mentions Space", () => {
    const [_blank, help] = renderChooserHelp(true);
    assert.match(help, /Space/);
    assert.match(help, /picks/);
  });
});

describe("chooser 翻页", () => {
  const items = Array.from({ length: 46 }, (_, i) => ({ id: `m${String(i).padStart(2, "0")}` }));

  test("分页渲染：只画当页 + 页头，页头含进度与翻页提示", () => {
    const lines = renderChooser(items, 0, { index: 0, size: 18 });
    assert.equal(lines.length, 19); // 页头 1 + 18 行
    assert.match(lines[0], /第 1\/3 页 · 共 46 项/);
    assert.match(lines[0], /←\/→ 翻页/);
    assert.match(lines[1], /^❯ m00$/);
    assert.ok(lines[18].includes("m17"));
    assert.ok(!lines.some((l) => l.includes("m45")), "第 1 页不应出现末页条目");
  });

  test("翻到第 2/3 页：窗口偏移正确，全局 cursor 高亮", () => {
    const lines = renderChooser(items, 19, { index: 1, size: 18 });
    assert.match(lines[0], /第 2\/3 页/);
    assert.match(lines[1], /^  m18$/, "start=18 → 行2=m18（非高亮）");
    assert.ok(lines[18].includes("m35"), "行19（下标18）是本页最后一项 m35");
  });
  test("末页不足页高：只画剩余行，cursor 越界请求被钳制", () => {
    const lines = renderChooser(items, 45, { index: 2, size: 18 });
    assert.match(lines[0], /第 3\/3 页/);
    assert.equal(lines.length, 1 + 10); // 46 = 18+18+10
    assert.match(lines[10], /^❯ m45$/);
  });

  test("不传 page → 全量渲染（兼容旧行为）", () => {
    const lines = renderChooser(items.slice(0, 3), 0);
    assert.equal(lines.length, 3);
  });

  test("parseKey 映射 ←/→/PgUp/PgDn", () => {
    assert.equal(parseKey("\x1b[D"), "pageup");
    assert.equal(parseKey("h"), "pageup");
    assert.equal(parseKey("\x1b[5~"), "pageup");
    assert.equal(parseKey("\x1b[C"), "pagedown");
    assert.equal(parseKey("l"), "pagedown");
    assert.equal(parseKey("\x1b[6~"), "pagedown");
  });

  test("help 带 hasPages 时提示翻页键", () => {
    const [, help] = renderChooserHelp(true, true);
    assert.match(help, /←\/→ page/);
    const [, plain] = renderChooserHelp(true, false);
    assert.doesNotMatch(plain, /←\/→ page/);
  });
});
