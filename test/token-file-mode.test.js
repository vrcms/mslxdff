// P0-1 回归：主 Bearer token 镜像必须 0600 落盘。
// 关键点：writeFileSync 的 mode 只在“新建文件”时生效，已存在的文件权限不会被它改，
// 所以 syncTokenFile 必须再补一次 chmodSync —— 否则升级前生成的老文件永远停在 0644。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadToken, refreshToken, tokenFile } from "../src/state/schemas/token.js";

const isPosix = process.platform !== "win32";
const perm = (p) => statSync(p).mode & 0o777;

function withTmp({ preCreateMode } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-token-mode-"));
  const file = join(dir, "state.json");
  const tf = join(dir, "token");
  const prev = process.env.MSLXDFF_TOKEN_FILE;
  delete process.env.MSLXDFF_TOKEN_FILE; // 否则 tokenFile() 会走 env 分支
  if (preCreateMode !== undefined) {
    writeFileSync(tf, "old-token\n", "utf8");
    chmodSync(tf, preCreateMode);
  }
  return {
    dir,
    file,
    tf,
    cleanup: () => {
      if (prev === undefined) delete process.env.MSLXDFF_TOKEN_FILE;
      else process.env.MSLXDFF_TOKEN_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("token 文件名固定为 state 同目录下的 `token`（.gitignore 按基名拦截，与层级无关）", () => {
  const c = withTmp();
  try {
    assert.equal(basename(tokenFile(c.file)), "token");
    assert.equal(tokenFile(c.file), c.tf);
  } finally {
    c.cleanup();
  }
});

test("loadToken 首次生成：token 落盘且权限 0600", async () => {
  const c = withTmp();
  try {
    const { token, created } = await loadToken({ file: c.file });
    assert.equal(created, true);
    assert.ok(token && token.length >= 32);
    assert.equal(readFileSync(c.tf, "utf8").trim(), token, "token 文件内容与返回值一致");
    if (isPosix) assert.equal(perm(c.tf), 0o600, "新建的 token 文件必须是 0600");
  } finally {
    c.cleanup();
  }
});

test("已存在的 0644 老文件会被收紧到 0600（mode 参数救不了存量文件）", async () => {
  const c = withTmp({ preCreateMode: 0o644 });
  try {
    if (isPosix) assert.equal(perm(c.tf), 0o644, "前置条件：老文件确实是 0644");
    await loadToken({ file: c.file });
    if (isPosix) assert.equal(perm(c.tf), 0o600, "loadToken 后必须被 chmod 收紧");
    assert.equal(existsSync(c.tf), true);
  } finally {
    c.cleanup();
  }
});

test("refreshToken 轮换后 token 文件同步且权限仍为 0600", async () => {
  const c = withTmp();
  try {
    const first = (await loadToken({ file: c.file })).token;
    const next = await refreshToken({ file: c.file });
    assert.notEqual(next, first, "轮换必须换新值");
    assert.equal(readFileSync(c.tf, "utf8").trim(), next);
    if (isPosix) assert.equal(perm(c.tf), 0o600);
  } finally {
    c.cleanup();
  }
});
