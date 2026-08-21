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
});
