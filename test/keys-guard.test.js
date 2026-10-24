// keys-guard 回归锁：覆盖式写 provider keys 的三道闸。
// 事故原型两起同类：2026-10-15 `-provider traework quota`（闸 1 因此而生）、
// 2026-10-24 `-provider codearts help` —— `help` 不在闸 1 名单、codearts 不属 auth 号型六家，
// 于是裸词一路掉进 keys.js「未知即当 key」兜底，把 2 条真凭据整组覆盖成字符串 "help"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const { keysWriteDenial, RESERVED_PROVIDER_SUBS, MIN_KEY_CHARS } = await import("../src/cli/commands/provider/keys-guard.js");

const REAL_KEY = "sk-or-v1-" + "a".repeat(70); // 真 key 形状（远超阈值）
const REAL_BLOB = JSON.stringify({ userId: "u", refreshToken: "r".repeat(1200), codeVerifier: "c", dpopJwk: {} }); // codearts 真凭据 blob

test("闸 1：help/usage 这类 verb 一律不许当 key（2026-10-24 事故补名单）", () => {
  for (const v of ["help", "usage", "usage-all"]) {
    const d = keysWriteDenial("codearts", v, [v]);
    assert.ok(d, `${v} 必须拦`);
    assert.match(d.join("\n"), /没有这个子命令/);
    assert.ok(RESERVED_PROVIDER_SUBS.has(v), `${v} 应在保留子命令名单里`);
  }
});

test("闸 3：短于阈值的裸词不当 key（闸 1 漏收的 verb/模型名由它兜底）", () => {
  for (const tok of ["glm-5.2", "mykey", "abc", "status2"]) {
    assert.equal(MIN_KEY_CHARS, 11, "阈值 = 超过 10 字符");
    const d = keysWriteDenial("bai", tok, [tok]);
    assert.ok(d, `${tok}(${tok.length} 字符) 必须拦`);
    assert.match(d.join("\n"), /长度不足 11 字符/);
    assert.match(d.join("\n"), /配置未改动/);
  }
});

test("闸 3 边界：正好 MIN_KEY_CHARS 放行，短一个拒", () => {
  assert.equal(keysWriteDenial("bai", "k".repeat(MIN_KEY_CHARS), ["k".repeat(MIN_KEY_CHARS)]), null, "11 字符放行");
  assert.ok(keysWriteDenial("bai", "k".repeat(MIN_KEY_CHARS - 1), ["k".repeat(MIN_KEY_CHARS - 1)]), "10 字符拒");
});

test("真 key / codearts 凭据 blob 不受闸 3 影响（别把正常配置拦死）", () => {
  assert.equal(keysWriteDenial("openrouter", REAL_KEY, [REAL_KEY]), null);
  assert.equal(keysWriteDenial("codearts", REAL_BLOB, [REAL_BLOB]), null, "blob 上千字符，必须放行");
  assert.equal(keysWriteDenial("bai", `${REAL_KEY} ${REAL_KEY.slice(0, 20)}`, [REAL_KEY, REAL_KEY.slice(0, 20)]), null, "多条真 key 一起设也放行");
});

test("逃生阀：--force 放行，且 flag 本身不参与长度判定", () => {
  assert.equal(keysWriteDenial("bai", "abc", ["abc", "--force"]), null, "--force 留路");
  const d = keysWriteDenial("bai", "abc", ["abc", "--verbose"]);
  assert.ok(d, "其它 flag 不算 key 但短 key 仍拦");
  assert.match(d.join("\n"), /「abc」/);
});

test("端到端：真跑 CLI `-provider codearts help` ⇒ exit 1 且 state 里的 keys 一字未动", () => {
  const dir = join(os.tmpdir(), `mslxdff-keysguard-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const st = join(dir, "state.json");
  const keep = "x".repeat(1200);
  try {
    writeFileSync(st, JSON.stringify({ providerConfigs: { codearts: { baseUrl: "", keys: [keep, REAL_BLOB] } } }), { mode: 0o600 });
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "bin", "mslxdff.js"), "-provider", "codearts", "help"], {
      encoding: "utf8",
      env: { ...process.env, MSLXDFF_STATE_FILE: st, MSLXDFF_NO_AUTOSTART: "1" },
      timeout: 60_000,
    });
    assert.equal(r.status, 1, `应拒写并 exit 1，实际 status=${r.status} out=${r.stdout}`);
    assert.match((r.stderr || "") + (r.stdout || ""), /已拒绝/);
    const after = JSON.parse(readFileSync(st, "utf8")).providerConfigs.codearts.keys;
    assert.deepEqual(after, [keep, REAL_BLOB], "凭据必须原样保留（这就是 2026-10-24 被覆盖掉的那件事）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
