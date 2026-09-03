import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { candidateRoots, resolveDesktopInfoPath, readDesktopAccount } from "../src/providers/workbuddy/desktop-info.js";

function mkTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbdesk-"));
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
  }
  return dir;
}
const INFO = JSON.stringify({
  account: { uid: "u-1", nickname: "nick" },
  auth: { accessToken: "at", refreshToken: "rt", expiresAt: 9999999999000, domain: "www.codebuddy.cn" },
});

describe("candidateRoots", () => {
  test("win32 用 LOCALAPPDATA/APPDATA，不写死盘符", () => {
    const roots = candidateRoots({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", APPDATA: "C:\\R" }, homedir: "/h" });
    assert.deepEqual(roots, ["C:\\L", "C:\\R"]);
  });
  test("darwin 走 Library，linux 走 .config", () => {
    assert.deepEqual(candidateRoots({ platform: "darwin", env: {}, homedir: "/h" }), [path.join("/h", "Library", "Application Support")]);
    assert.deepEqual(candidateRoots({ platform: "linux", env: {}, homedir: "/h" }), [path.join("/h", ".config"), path.join("/h", ".local", "share")]);
  });
});

describe("resolveDesktopInfoPath", () => {
  test("显式 file 优先（不存在直接报错）", () => {
    const dir = mkTree({ "y.info": INFO });
    try {
      const fp = path.join(dir, "y.info");
      const r = resolveDesktopInfoPath({ file: fp, env: {}, platform: "win32", homedir: "/h" });
      assert.equal(r.path, fp);
      assert.equal(r.via, "file");
      assert.throws(() => resolveDesktopInfoPath({ file: path.join(dir, "nope.info"), env: {} }), /不存在/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("env MSLXDFF_WORKBUDDY_DESKTOP_INFO 次之", () => {
    const dir = mkTree({ "z.info": INFO });
    try {
      const fp = path.join(dir, "z.info");
      const r = resolveDesktopInfoPath({ env: { MSLXDFF_WORKBUDDY_DESKTOP_INFO: fp }, platform: "linux", homedir: "/h" });
      assert.equal(r.path, fp);
      assert.equal(r.via, "env");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("不猜厂商目录名：按文件名搜到深层 fixture", () => {
    const dir = mkTree({ "SomeVendor/Data/auth/workbuddy-desktop.info": INFO });
    try {
      const r = resolveDesktopInfoPath({ env: {}, platform: "linux", homedir: dir, extraRoots: [dir] });
      assert.equal(r.path, path.join(dir, "SomeVendor/Data/auth/workbuddy-desktop.info"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("多命中取 mtime 最新", () => {
    const dir = mkTree({ "a/workbuddy-desktop.info": INFO, "b/workbuddy-desktop.info": INFO });
    try {
      const old = new Date("2020-01-01"), now = new Date("2026-01-01");
      fs.utimesSync(path.join(dir, "a/workbuddy-desktop.info"), old, old);
      fs.utimesSync(path.join(dir, "b/workbuddy-desktop.info"), now, now);
      const r = resolveDesktopInfoPath({ env: {}, platform: "linux", homedir: dir, extraRoots: [dir] });
      assert.equal(r.path, path.join(dir, "b/workbuddy-desktop.info"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("找不到时报错给 env 逃生口", () => {
    const dir = mkTree({ "nothing/here.txt": "x" });
    try {
      assert.throws(() => resolveDesktopInfoPath({ env: {}, platform: "linux", homedir: dir, extraRoots: [dir] }), /MSLXDFF_WORKBUDDY_DESKTOP_INFO/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("readDesktopAccount", () => {
  test("毫秒 expiresAt 归一化为秒", () => {
    const dir = mkTree({ "workbuddy-desktop.info": INFO });
    try {
      const a = readDesktopAccount(path.join(dir, "workbuddy-desktop.info"));
      assert.equal(a.uid, "u-1");
      assert.equal(a.expiresAt, 9999999999);
      assert.equal(a.refreshToken, "rt");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("缺 uid/accessToken 人话报错", () => {
    const dir = mkTree({ "workbuddy-desktop.info": JSON.stringify({ account: {}, auth: {} }) });
    try {
      assert.throws(() => readDesktopAccount(path.join(dir, "workbuddy-desktop.info")), /不完整/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
