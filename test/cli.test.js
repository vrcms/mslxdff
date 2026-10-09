import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "..", "bin", "mslxdff.js");

function runCli(args, env) {
  const dir = tmpState();
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: join(dir, "state.json"), ...env },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

let tmpCounter = 0;
function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), `mslxdff-cli-${tmpCounter++}-`));
  return dir;
}

// Async form of runCli — spawnSync deadlocks child-process networking on this
// Windows host (undici sockets never wake), while execFile is fine.
function runCliAsync(args, env) {
  const dir = tmpState();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: join(dir, "state.json"), ...env },
      },
      (err, stdout, stderr) => resolve({ stdout, stderr, status: err ? err.code || 1 : 0 })
    );
  });
}

test("-help prints usage and exits 0", () => {
  const { stdout, status } = runCli(["-help"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("Usage:"));
  assert.ok(stdout.includes("-update"));
  assert.ok(stdout.includes("-status"));
  assert.ok(stdout.includes("mslxdff v"));
});

test("-status shows daemon/model/log sections even with no data", () => {
  const { stdout, status } = runCli(["-status"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("daemon:"));
  assert.ok(stdout.includes("models:"));
  assert.ok(stdout.includes("recent calls:"));
  assert.ok(stdout.includes("last error:"));
  assert.ok(stdout.includes("not running"));
});

test("-status shows cached models and recent calls when present", () => {
  const dir = tmpState();
  const modelsFile = join(dir, "models.json");
  writeFileSync(
    modelsFile,
    JSON.stringify({
      object: "list",
      cachedAt: Date.now(),
      data: [
        { id: "deepseek-v4-flash-free", object: "model" },
        { id: "big-pickle", object: "model" },
      ],
    })
  );
  const res = spawnSync(process.execPath, [BIN, "-status"], {
    encoding: "utf8",
    env: { ...process.env, MSLXDFF_DAEMON_DIR: dir },
  });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("deepseek-v4-flash-free"));
  assert.ok(res.stdout.includes("big-pickle"));
  assert.ok(res.stdout.includes("2 free"));
});

test("-showtoken works", () => {
  const { stdout, status } = runCli(["-showtoken"]);
  assert.equal(status, 0);
  assert.match(stdout.trim(), /^[0-9a-f]{64}$/);
});

test("-refresh-token rotates the token", () => {
  const dir = tmpState();
  const sf = join(dir, "state.json");
  const a = spawnSync(process.execPath, [BIN, "-showtoken"], { encoding: "utf8", env: { ...process.env, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: sf } });
  const b = spawnSync(process.execPath, [BIN, "-refresh-token"], { encoding: "utf8", env: { ...process.env, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: sf } });
  const c = spawnSync(process.execPath, [BIN, "-showtoken"], { encoding: "utf8", env: { ...process.env, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: sf } });
  assert.match(a.stdout.trim(), /^[0-9a-f]{64}$/);
  assert.match(b.stdout.trim(), /^[0-9a-f]{64}$/);
  assert.equal(c.stdout.trim(), b.stdout.trim());
  assert.notEqual(a.stdout.trim(), b.stdout.trim());
});

test("-model list shows cached models without touching the network", () => {
  const dir = tmpState();
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      object: "list",
      cachedAt: Date.now(),
      data: [
        { id: "deepseek-v4-flash-free", object: "model" },
        { id: "kimi-v3-free", object: "model" },
      ],
    })
  );
  const res = spawnSync(process.execPath, [BIN, "-model", "list"], {
    encoding: "utf8",
    env: { ...process.env, MSLXDFF_DAEMON_DIR: dir, UPSTREAM_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /2 free model\(s\)/);
  assert.match(res.stdout, /deepseek-v4-flash-free/);
  assert.match(res.stdout, /kimi-v3-free/);
  assert.match(res.stdout, /cached/);
});

test("-model list without cache and an unreachable upstream exits 1", () => {
  const { stdout, stderr, status } = runCli(["-model", "list"], {
    UPSTREAM_BASE_URL: "http://127.0.0.1:1",
  });
  assert.equal(status, 1);
  assert.match(stderr, /could not fetch models/);
  assert.equal(stdout.trim(), "");
});

test("-models alias behaves like -model list", () => {
  const dir = tmpState();
  writeFileSync(join(dir, "models.json"), JSON.stringify({ object: "list", cachedAt: Date.now(), data: [{ id: "big-pickle", object: "model" }] }));
  const res = spawnSync(process.execPath, [BIN, "-models"], { encoding: "utf8", env: { ...process.env, MSLXDFF_DAEMON_DIR: dir, UPSTREAM_BASE_URL: "http://127.0.0.1:1" } });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /big-pickle/);
});

test("-model refresh fetches from the upstream and updates the cache", async () => {
  const dir = tmpState();
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({ object: "list", cachedAt: 0, data: [{ id: "stale-free", object: "model" }] })
  );
  const srv = createServer((req, res) => {
    if (req.url === "/zen/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "fresh-1-free" }, { id: "fresh-2-free" }] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const res = await runCliAsync(["-model", "refresh"], {
      MSLXDFF_DAEMON_DIR: dir,
      UPSTREAM_BASE_URL: `http://127.0.0.1:${port}`,
      UPSTREAM_CONNECT_TIMEOUT_MS: "5000",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /refreshed: 2 free model\(s\)/);
    assert.match(res.stdout, /fresh-1-free/);
    assert.match(res.stdout, /fresh-2-free/);
    const cached = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    assert.ok(cached.cachedAt > 0, "cache timestamp updated");
    assert.deepEqual(cached.data.map((m) => m.id).sort(), ["fresh-1-free", "fresh-2-free"]);
  } finally {
    srv.close();
  }
});

// ---------- -setto claude：入口校验必须先于任何写盘（评审 P1-5） ----------

test("-setto claude auto → 退出 1，不碰 ~/.claude/settings.json", () => {
  const home = tmpState();
  const res = runCli(["-setto", "claude", "auto"], { HOME: home, USERPROFILE: home });
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /auto/);
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false, "校验没过就不许写用户配置");
});

test("-setto claude 真写隔离 HOME：键面正确、token 不外泄、二次运行零字节改动", () => {
  const home = tmpState();
  const dir = tmpState(); // 两次运行共用同一 daemon 目录 → token 稳定，才测得出幂等
  const env = { HOME: home, USERPROFILE: home, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: join(dir, "state.json") };
  const one = runCli(["-setto", "claude", "qwenwork/test-model"], env);
  assert.equal(one.status, 0, `stdout=${one.stdout} stderr=${one.stderr}`);
  const p = join(home, ".claude", "settings.json");
  const s = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(s.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8989", "BASE_URL 不带 /v1（客户端自拼）");
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN.length > 32, true, "token 应已写入");
  assert.ok(!one.stdout.includes(s.env.ANTHROPIC_AUTH_TOKEN), "CLI 输出不得回显 token");
  assert.equal(s.env.ANTHROPIC_MODEL, undefined, "env.ANTHROPIC_MODEL 必须让位给 modelPicker");
  assert.equal(s.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
  assert.equal(s.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
  assert.equal(s.model, "qwenwork/test-model");
  assert.equal(s.modelPicker.options[0].model, "qwenwork/test-model");
  assert.equal(s.modelPicker.options[0].behavesAs, "claude-sonnet-5");
  assert.equal(existsSync(join(home, ".claude", "settings.pre-mslxdff.json")), false, "首次接管前无可备份原文，不该凭空造备份");
  const two = runCli(["-setto", "claude", "qwenwork/test-model"], env);
  assert.equal(two.status, 0, two.stderr);
  assert.match(two.stdout, /已是目标状态/);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), s, "幂等：二次运行字节不变");
});

test("-setto claude 未知 target 仍被白名单挡住", () => {
  const home = tmpState();
  const res = runCli(["-setto", "claude-not"], { HOME: home, USERPROFILE: home });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: mslxdff -setto/);
});

test("-setto claude --behaves-as 缺值 → 退出 1，且不碰 settings.json 也不先写 preferredModel", () => {
  const home = tmpState();
  const dir = tmpState();
  const env = { HOME: home, USERPROFILE: home, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: join(dir, "state.json") };
  const res = runCli(["-setto", "claude", "qwenwork/test-model", "--behaves-as"], env);
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /--behaves-as 需要取值/);
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false, "参数没验过就不许写用户配置");
  assert.ok(!/default model set to:/.test(res.stdout), "校验必须先于 savePreferredModel，不得先改默认模型再报错");
});

// ---------- -setto claude 默认语义：不带参数 = 写入全部勾选模型（picks 驱动） ----------
// 踩坑来历：无参兜底曾直接取 preferredModel，而它可能是一个已从池子消失的 id
// （生产实况 preferredModel=mimo-v2.5-free，写入后 Claude Code 每次请求只得到 502）。

test("-setto claude 不带参数 → options 写勾选集全集，顶层 model 取勾选集内的首选模型", async () => {
  const home = tmpState();
  const dir = tmpState();
  const stateFile = join(dir, "state.json");
  const env = { HOME: home, USERPROFILE: home, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: stateFile };
  const { saveModelPicks } = await import("../src/state/schemas/model.js");
  runCli(["-setto", "claude", "qwenwork/kept-model"], env); // 先落 state（含 token 与 preferredModel）
  saveModelPicks(["qwenwork/kept-model", "qwenwork/second-model", "claude-opus-9"], { file: stateFile });
  const res = runCli(["-setto", "claude"], env);
  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.modelPicker.options.map((o) => o.model), ["qwenwork/kept-model", "qwenwork/second-model", "claude-opus-9"], "默认应写入勾选集全集，顺序保持");
  assert.equal(s.model, "qwenwork/kept-model", "首选模型在勾选集内 → 顶层 model 用它");
  assert.ok(!("behavesAs" in s.modelPicker.options[2]), "claude-* 前缀客户端本就认识，不该再被标成 sonnet 的能力口径");
  assert.match(res.stdout, /modelPicker: 3 行（勾选集全集）/);
  const again = runCli(["-setto", "claude"], env);
  assert.match(again.stdout, /已是目标状态/, "默认批量同样幂等");
});

test("-setto claude 不带参数 + 首选模型已失效（不在勾选集）→ 警告并改用勾选集首个", async () => {
  const home = tmpState();
  const dir = tmpState();
  const stateFile = join(dir, "state.json");
  const env = { HOME: home, USERPROFILE: home, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: stateFile };
  const { saveModelPicks } = await import("../src/state/schemas/model.js");
  runCli(["-setto", "claude", "qwenwork/dead-model"], env);
  saveModelPicks(["qwenwork/alive-a", "qwenwork/alive-b"], { file: stateFile });
  const res = runCli(["-setto", "claude"], env);
  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, /不在勾选集内（可能已失效）/);
  const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(s.model, "qwenwork/alive-a", "失效的 preferredModel 绝不能再写进 Claude Code 顶层 model");
  assert.deepEqual(s.modelPicker.options.map((o) => o.model), ["qwenwork/alive-a", "qwenwork/alive-b"]);
});

test("-setto claude 不带参数 + 勾选集为空 → 退出 1，不写用户配置", () => {
  const home = tmpState();
  const dir = tmpState();
  const env = { HOME: home, USERPROFILE: home, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: join(dir, "state.json") };
  const res = runCli(["-setto", "claude"], env);
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /modelPicks 勾选集为空/);
  assert.match(res.stderr, /-model pick/);
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false, "无模型可写时不得凭空造配置");
});

test("-setto claude --all 与不带参数同义（勾选集全集）", async () => {
  const home = tmpState();
  const dir = tmpState();
  const stateFile = join(dir, "state.json");
  const env = { HOME: home, USERPROFILE: home, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: stateFile };
  const { saveModelPicks } = await import("../src/state/schemas/model.js");
  runCli(["-setto", "claude", "qwenwork/kept-model"], env);
  saveModelPicks(["qwenwork/kept-model", "qwenwork/another"], { file: stateFile });
  const all = runCli(["-setto", "claude", "--all"], env);
  assert.equal(all.status, 0, `stdout=${all.stdout} stderr=${all.stderr}`);
  const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.modelPicker.options.map((o) => o.model), ["qwenwork/kept-model", "qwenwork/another"]);
});

test("-setto claude 显式指定未勾选的模型 → 警告但仍按用户意图写单条", async () => {
  const home = tmpState();
  const dir = tmpState();
  const stateFile = join(dir, "state.json");
  const env = { HOME: home, USERPROFILE: home, MSLXDFF_DAEMON_DIR: dir, MSLXDFF_STATE_FILE: stateFile };
  const { saveModelPicks } = await import("../src/state/schemas/model.js");
  saveModelPicks(["qwenwork/picked"], { file: stateFile });
  const res = runCli(["-setto", "claude", "qwenwork/unpicked"], env);
  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, /不在勾选集 modelPicks 内/);
  const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(s.modelPicker.options.length, 1, "显式单模型：options 只留这一条");
  assert.equal(s.model, "qwenwork/unpicked");
});
