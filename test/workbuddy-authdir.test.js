// P0-2 回归：WorkBuddy 凭据目录必须「跟着 state 文件（账本）走」，不得再用 cwd 兜底。
// 旧实现末端 `join(process.cwd(), "auths")` 会把企业长效 refreshToken 写进
// 「你当时所在的那个目录」，而 .gitignore 只管自己所在的仓库 → 凭据落到不受保护的目录。
// （真实事故：本机两个账号因此分居 `~/.config/mslxdff/auths` 与 `项目根/auths` 两处。）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authDirFor, authDirCandidates, listAccountDocs } from "../src/providers/workbuddy/account-store.js";

const doc = (uid) => ({
  account: { uid, enterpriseId: "e-" + uid, nickname: "" },
  auth: { accessToken: "at-" + uid, refreshToken: "rt-" + uid, expiresAt: 9999999999, domain: "www.codebuddy.cn" },
});

test("写入目录：跟着 state 文件同目录，而不是 cwd/auths", () => {
  const stateFile = join("some", "home", ".config", "mslxdff", "state.json");
  const got = authDirFor({ stateFile });
  assert.equal(got, join("some", "home", ".config", "mslxdff", "auths"));
  assert.notEqual(got, join(process.cwd(), "auths"), "绝不能再用 cwd 兜底");
});

test("写入目录：显式 WORKBUDDY_AUTH_DIR 优先；测试环境落临时目录（都不受 cwd 影响）", () => {
  assert.equal(authDirFor({ explicit: join("x", "custom-auths"), stateFile: join("a", "state.json") }), join("x", "custom-auths"));
  const t = authDirFor({ testEnv: true, stateFile: join("a", "state.json") });
  assert.equal(t, join(tmpdir(), "mslxdff-test-auths"));
  assert.notEqual(t, join(process.cwd(), "auths"));
});

test("读取候选：主位置优先，旧 cwd/auths 只读兜底", () => {
  const primary = join("home", ".config", "mslxdff", "auths");
  const cwdDir = join("another", "repo", "auths");
  assert.deepEqual(authDirCandidates({ primary, cwdDir }), [primary, cwdDir]);
});

test("读取候选：显式指定或测试环境不兜底；cwd 恰好等于主位置时去重", () => {
  const primary = join("home", ".config", "mslxdff", "auths");
  const cwdDir = join("another", "repo", "auths");
  assert.deepEqual(authDirCandidates({ primary, explicit: primary, cwdDir }), [primary]);
  assert.deepEqual(authDirCandidates({ primary, testEnv: true, cwdDir }), [primary]);
  assert.deepEqual(authDirCandidates({ primary, cwdDir: primary }), [primary]);
});

test("listAccountDocs：主位置先扫，同 uid 以主位置为准；旧位置补主位置没有的 uid", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-authdir-docs-"));
  const primary = join(root, "primary");
  const legacy = join(root, "legacy");
  mkdirSync(primary, { recursive: true });
  mkdirSync(legacy, { recursive: true });
  const write = (dir, uid, at) => writeFileSync(join(dir, `workbuddy-${uid}.json`), JSON.stringify({ ...doc(uid), auth: { ...doc(uid).auth, accessToken: at } }));
  try {
    write(primary, "u1", "new-u1");   // 两处都有 u1 → 应取主位置
    write(legacy, "u1", "old-u1");
    write(legacy, "u2", "at-u2");     // 只有旧位置有 u2 → 兜底读到
    const got = listAccountDocs({ dirs: [primary, legacy] });
    assert.deepEqual(got.map((d) => d.uid).sort(), ["u1", "u2"]);
    assert.equal(got.find((d) => d.uid === "u1").doc.auth.accessToken, "new-u1");
    assert.equal(got.find((d) => d.uid === "u2").dir, legacy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listAccountDocs：非 workbuddy-*.json 与坏 JSON 一律跳过，不抛错", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-authdir-skip-"));
  try {
    writeFileSync(join(root, "workbuddy-good.json"), JSON.stringify(doc("ok")));
    writeFileSync(join(root, "workbuddy-bad.json"), "{ not json");
    writeFileSync(join(root, "other-account.json"), JSON.stringify(doc("nope")));
    writeFileSync(join(root, "workbuddy-noauth.json"), JSON.stringify({ account: { uid: "x" } }));
    const got = listAccountDocs({ dirs: [root] });
    assert.deepEqual(got.map((d) => d.uid), ["ok"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
