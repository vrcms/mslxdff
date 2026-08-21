import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPreferredModel, savePreferredModel } from "../src/state.js";
import { readFileSync } from "node:fs";
import { getPreferredModel, DEFAULT_PREFERRED_MODEL } from "../src/auto.js";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-pref-"));
  return join(dir, "state.json");
}

describe("preferred model persistence", () => {
  let file;
  beforeEach(() => { file = tmpStateFile(); });
  afterEach(() => { try { rmSync(file, { force: true }); } catch {} });

  test("save/load roundtrip", () => {
    assert.equal(loadPreferredModel({ file }), null);
    savePreferredModel("mimo-v2.5-free", { file });
    assert.equal(loadPreferredModel({ file }), "mimo-v2.5-free");
    savePreferredModel("big-pickle", { file });
    assert.equal(loadPreferredModel({ file }), "big-pickle", "overwrite works");
  });

  test("save preserves other state keys", () => {
    writeFileSync(file, JSON.stringify({ token: "abc", port: 8989 }));
    savePreferredModel("hy3-free", { file });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.token, "abc");
    assert.equal(raw.port, 8989);
    assert.equal(raw.preferredModel, "hy3-free");
  });

  test("getPreferredModel priority: state > env > default", async () => {
    // no state, no env -> default
    delete process.env.MSLXDFF_PREFERRED_MODEL;
    assert.equal(getPreferredModel({ file }), DEFAULT_PREFERRED_MODEL);

    // env set, no state -> env
    process.env.MSLXDFF_PREFERRED_MODEL = "env-model";
    assert.equal(getPreferredModel({ file }), "env-model");

    // state set -> state wins over env
    savePreferredModel("state-model", { file });
    assert.equal(getPreferredModel({ file }), "state-model");

    delete process.env.MSLXDFF_PREFERRED_MODEL;
  });

  test("getPreferredModel hot-reloads when state file changes (mtime cache)", async () => {
    delete process.env.MSLXDFF_PREFERRED_MODEL;
    savePreferredModel("first-model", { file });
    assert.equal(getPreferredModel({ file }), "first-model");
    // bump mtime explicitly (same-second writes may have identical ms on some FS)
    savePreferredModel("second-model", { file });
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);
    assert.equal(getPreferredModel({ file }), "second-model", "picks up change without restart");
  });
});
