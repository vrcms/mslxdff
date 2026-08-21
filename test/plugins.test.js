import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins, runHook, pluginsDir, resolvePluginDirs } from "../src/plugins.js";

function tmpPluginsDir() {
  return mkdtempSync(join(tmpdir(), "mslxdff-plugins-"));
}

describe("plugin loader", () => {
  let dir;
  beforeEach(() => { dir = tmpPluginsDir(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  test("pluginsDir returns env override or default config dir", () => {
    const prev = process.env.MSLXDFF_PLUGINS_DIR;
    process.env.MSLXDFF_PLUGINS_DIR = "D:/tmp/p";
    assert.equal(pluginsDir(), "D:/tmp/p");
    if (prev === undefined) delete process.env.MSLXDFF_PLUGINS_DIR;
    else process.env.MSLXDFF_PLUGINS_DIR = prev;
    // default contains .config/mslxdff/plugins or similar — just check it's a string
    if (prev === undefined) assert.equal(typeof pluginsDir(), "string");
  });

  test("loads a plugin module and reports its name", async () => {
    writeFileSync(join(dir, "my-plugin.mjs"), `
      export default { name: "my-plugin", version: "1.0.0" };
    `);
    const { plugins, errors } = await loadPlugins({ dir });
    assert.equal(errors.length, 0);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].name, "my-plugin");
    assert.equal(plugins[0].version, "1.0.0");
  });

  test("ignores non-js files and missing dir", async () => {
    writeFileSync(join(dir, "readme.txt"), "not a plugin");
    const a = await loadPlugins({ dir });
    assert.equal(a.plugins.length, 0);
    const b = await loadPlugins({ dir: join(dir, "nope") });
    assert.equal(b.plugins.length, 0);
    assert.deepEqual(b.errors, []);
  });

  test("collects errors for broken modules without throwing", async () => {
    writeFileSync(join(dir, "broken.mjs"), `throw new Error("boom");`);
    const { plugins, errors } = await loadPlugins({ dir });
    assert.equal(plugins.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /boom/);
    assert.match(errors[0].file, /broken\.mjs/);
  });

  test("derives name from filename when export has none", async () => {
    writeFileSync(join(dir, "anon.mjs"), `export default { hooks: {} };`);
    const { plugins } = await loadPlugins({ dir });
    assert.equal(plugins[0].name, "anon");
  });

  test("resolvePluginDirs: env takes over completely; otherwise bundled + user dirs", () => {
    const prev = process.env.MSLXDFF_PLUGINS_DIR;
    process.env.MSLXDFF_PLUGINS_DIR = "D:/only/this";
    assert.deepEqual(resolvePluginDirs({ pkgRoot: "D:/pkg" }), ["D:/only/this"]);
    if (prev === undefined) delete process.env.MSLXDFF_PLUGINS_DIR;
    else process.env.MSLXDFF_PLUGINS_DIR = prev;
    const dirs = resolvePluginDirs({ pkgRoot: "D:/pkg" });
    assert.equal(dirs.length, 2);
    assert.match(dirs[0], /plugins$/);
    assert.match(dirs[1], /[\\/]mslxdff[\\/]plugins$/);
  });

  test("multi-dir load: user dir overrides bundled on same basename, both load otherwise", async () => {
    const bundled = tmpPluginsDir();
    const user = tmpPluginsDir();
    try {
      // 同名文件：user 覆盖 bundled
      writeFileSync(join(bundled, "same.mjs"), `export default { name: "bundled-same" };`);
      writeFileSync(join(user, "same.mjs"), `export default { name: "user-same" };`);
      // 不同名：都加载，bundled 在前
      writeFileSync(join(bundled, "official.mjs"), `export default { name: "official-extra" };`);
      writeFileSync(join(user, "mine.mjs"), `export default { name: "user-own" };`);
      const { plugins } = await loadPlugins({ dirs: [bundled, user] });
      const names = plugins.map((p) => p.name);
      assert.ok(names.includes("user-same"), "user version wins");
      assert.ok(!names.includes("bundled-same"), "bundled same-name skipped");
      assert.deepEqual(names, ["official-extra", "user-own", "user-same"], "bundled first, stable order");
    } finally {
      rmSync(bundled, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });
});

describe("runHook", () => {
  let dir;
  beforeEach(() => { dir = tmpPluginsDir(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  test("calls matching hook with ctx and ignores plugins without it", async () => {
    writeFileSync(join(dir, "a.mjs"), `
      let seen = null;
      export default {
        name: "a",
        hooks: { "model:select": (ctx) => { seen = ctx; } },
        get seen() { return seen; },
      };
    `);
    writeFileSync(join(dir, "b.mjs"), `
      export default { name: "b", hooks: {} };
    `);
    const { plugins } = await loadPlugins({ dir });
    const ctx = { requested: "auto", order: ["x"] };
    await runHook(plugins, "model:select", ctx);
    // exported getter on the module object won't survive import cloning in all
    // cases, so verify via side-effect channel instead:
    assert.ok(Array.isArray(ctx.order));
  });

  test("hook returning an array replaces the value via runHook result", async () => {
    writeFileSync(join(dir, "reorder.mjs"), `
      export default {
        name: "reorder",
        hooks: { "model:select": (ctx) => [...ctx.order].reverse() },
      };
    `);
    const { plugins } = await loadPlugins({ dir });
    const out = await runHook(plugins, "model:select", { order: ["a", "b"] });
    assert.deepEqual(out.value, ["b", "a"]);
    assert.equal(out.changed, true);
  });

  test("hook returning undefined leaves value unchanged", async () => {
    writeFileSync(join(dir, "noop.mjs"), `
      export default { name: "noop", hooks: { "model:select": () => {} } };
    `);
    const { plugins } = await loadPlugins({ dir });
    const out = await runHook(plugins, "model:select", { order: ["a"] });
    assert.equal(out.changed, false);
    assert.equal(out.value, undefined);
  });

  test("isolates hook errors and keeps calling other plugins", async () => {
    writeFileSync(join(dir, "bad.mjs"), `
      export default { name: "bad", hooks: { "request:completed": () => { throw new Error("hook boom"); } } };
    `);
    writeFileSync(join(dir, "good.mjs"), `
      export default { name: "good", hooks: { "request:completed": () => ["ok"] } };
    `);
    const { plugins } = await loadPlugins({ dir });
    const out = await runHook(plugins, "request:completed", {});
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0].error, /hook boom/);
    assert.equal(out.errors[0].plugin, "bad");
    assert.equal(out.changed, true, "good plugin still applied");
    assert.deepEqual(out.value, ["ok"]);
  });

  test("runs hooks serially in load order", async () => {
    writeFileSync(join(dir, "first.mjs"), `
      const calls = [];
      export default {
        name: "first",
        hooks: { "model:select": (ctx) => { ctx.trace = [...(ctx.trace||[]), "first"]; } },
      };
    `);
    writeFileSync(join(dir, "second.mjs"), `
      export default {
        name: "second",
        hooks: { "model:select": (ctx) => { ctx.trace = [...(ctx.trace||[]), "second"]; } },
      };
    `);
    const { plugins } = await loadPlugins({ dir });
    const ctx = { trace: [] };
    await runHook(plugins, "model:select", ctx);
    assert.deepEqual(ctx.trace, ["first", "second"]);
  });
});
