import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requestDeviceState, pollDeviceToken, fetchDeviceAccount } from "../src/cli/commands/provider/workbuddy-login.js";

function mockJson(obj, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(obj), headers: { get: () => "application/json" } };
}

describe("workbuddy device login", () => {
  it("requestDeviceState 返回 state+authUrl", async () => {
    const fetchImpl = async () => mockJson({ code: 0, data: { state: "s1", authUrl: "https://copilot.tencent.com/login?state=s1" } });
    const r = await requestDeviceState(fetchImpl);
    assert.equal(r.state, "s1");
    assert.match(r.authUrl, /state=s1/);
  });

  it("requestDeviceState 业务失败抛错", async () => {
    const fetchImpl = async () => mockJson({ code: 500, msg: "busy" });
    await assert.rejects(() => requestDeviceState(fetchImpl), /500/);
  });

  it("pollDeviceToken pending 返回 null，成功返回 bundle", async () => {
    let n = 0;
    const fetchImpl = async () => (++n === 1
      ? mockJson({ code: 40001, msg: "login ing" })
      : mockJson({ code: 0, data: { accessToken: "at", refreshToken: "rt", expiresIn: 100, domain: "www.codebuddy.cn" } }));
    assert.equal(await pollDeviceToken(fetchImpl, "s1"), null);
    const b = await pollDeviceToken(fetchImpl, "s1");
    assert.equal(b.accessToken, "at");
    assert.equal(b.refreshToken, "rt");
  });

  it("pollDeviceToken 5xx 抛错（真故障不吞）", async () => {
    const fetchImpl = async () => mockJson({ code: 1, msg: "boom" }, 500);
    await assert.rejects(() => pollDeviceToken(fetchImpl, "s1"), /500/);
  });

  it("fetchDeviceAccount 带 Bearer 拿 uid", async () => {
    let authed = "";
    const fetchImpl = async (url, init) => {
      authed = init?.headers?.Authorization || "";
      return mockJson({ code: 0, data: { uid: "u9", enterpriseId: "e1", nickname: "n" } });
    };
    const a = await fetchDeviceAccount(fetchImpl, "s1", "at");
    assert.equal(a.uid, "u9");
    assert.equal(authed, "Bearer at");
  });

  it("handleWorkbuddyLogin 非 login 子命令返回 false", async () => {
    const { handleWorkbuddyLogin } = await import("../src/cli/commands/provider/workbuddy-login.js");
    assert.equal(await handleWorkbuddyLogin("workbuddy", "bench"), false);
    assert.equal(await handleWorkbuddyLogin("bai", "login"), false);
  });
});

describe("importDesktopAccount", () => {
  it("读桌面 .info 导入新号", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wbdesk-"));
    const authDir = path.join(dir, "CodeBuddyExtension", "Data", "Public", "auth");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, "workbuddy-desktop.info"), JSON.stringify({
      account: { uid: "u-desktop", nickname: "nick" },
      auth: { accessToken: "at-d", refreshToken: "rt-d", expiresAt: 9999999999, domain: "www.codebuddy.cn" },
    }));
    const { importDesktopAccount } = await import("../src/cli/commands/provider/workbuddy-login.js");
    let savedArg = null;
    const saved = await importDesktopAccount({ roots: [dir], save: async (a) => { savedArg = a; return { accounts: 2 }; } });
    assert.equal(saved.accounts, 2);
    assert.equal(savedArg.uid, "u-desktop");
    assert.equal(savedArg.refreshToken, "rt-d");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("桌面未登录时人话报错并给 env 逃生口", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wbdesk-empty-"));
    try {
      const { importDesktopAccount } = await import("../src/cli/commands/provider/workbuddy-login.js");
      await assert.rejects(() => importDesktopAccount({ roots: [dir], save: async () => ({}) }), /MSLXDFF_WORKBUDDY_DESKTOP_INFO/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("--file 显式指定优先", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wbdesk-file-"));
    const fp = path.join(dir, "custom.info");
    await fs.writeFile(fp, JSON.stringify({ account: { uid: "u-f" }, auth: { accessToken: "at-f" } }));
    try {
      const { importDesktopAccount } = await import("../src/cli/commands/provider/workbuddy-login.js");
      let savedArg = null;
      await importDesktopAccount({ file: fp, roots: [dir], save: async (a) => { savedArg = a; return { accounts: 1 }; } });
      assert.equal(savedArg.uid, "u-f");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe("saveWorkbuddyAccount", () => {
  it("新 uid 追加，旧 uid 去重更新", async () => {
    const fs = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const tmp = (await import("node:path")).join(tmpdir(), `state-wbacc-${Date.now()}.json`);
    const authDir = (await import("node:path")).join(tmpdir(), `wbacc-auths-${Date.now()}`);
    await fs.writeFile(tmp, JSON.stringify({}));
    const origEnv = process.env.MSLXDFF_STATE_FILE;
    const origAuthDir = process.env.WORKBUDDY_AUTH_DIR;
    process.env.MSLXDFF_STATE_FILE = tmp;
    process.env.WORKBUDDY_AUTH_DIR = authDir;
    const { clearStateCache } = await import("../src/state/store.js");
    clearStateCache();
    try {
      const { saveWorkbuddyAccount } = await import("../src/providers/workbuddy/account-store.js");
      const r1 = await saveWorkbuddyAccount({ uid: "u1", accessToken: "at1", refreshToken: "rt1", file: tmp });
      assert.equal(r1.accounts, 1);
      assert.equal(r1.updated, false);
      const r2 = await saveWorkbuddyAccount({ uid: "u2", accessToken: "at2", refreshToken: "rt2", file: tmp });
      assert.equal(r2.accounts, 2);
      const r3 = await saveWorkbuddyAccount({ uid: "u1", accessToken: "at1b", refreshToken: "rt1", file: tmp });
      assert.equal(r3.accounts, 2);
      assert.equal(r3.updated, true);
      const { loadProviderConfigs } = await import("../src/state.js");
      const cfg = loadProviderConfigs({ file: tmp }).workbuddy;
      assert.deepEqual(cfg.keys, ["at1b", "at2"]);
      assert.deepEqual(cfg.auths.map((a) => a.uid), ["u1", "u2"]);
    } finally {
      process.env.MSLXDFF_STATE_FILE = origEnv;
      if (origAuthDir === undefined) delete process.env.WORKBUDDY_AUTH_DIR;
      else process.env.WORKBUDDY_AUTH_DIR = origAuthDir;
      clearStateCache();
      try { await fs.unlink(tmp); } catch {}
      try { await fs.rm(authDir, { recursive: true, force: true }); } catch {}
    }
  });
});
