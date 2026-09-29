// zcode OAuth CLI 轮询登录单测（oauth / login 命令 / allowlist 补齐）— TDD 先行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initZcodeFlow, waitForZcodeLogin, pollZcodeFlowOnce } from "../src/providers/zcode/oauth.js";
import { seedZcodeAllowlist } from "../src/providers/zcode/models.js";
import { handleZcodeLogin } from "../src/cli/commands/provider/zcode-login.js";
import { saveProviderAllowedModels, loadProviderAllowedModels } from "../src/state.js";

const mkJwt = (exp = Math.floor(Date.now() / 1000) + 3600) =>
  `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.${"s".repeat(40)}`;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

test("oauth: init 解析 authorize_url/poll 信息，自带 poll_token 鉴权", async () => {
  let seenUrl = null, seenBody = null, seenHeaders = null;
  const fetchImpl = async (url, opts = {}) => {
    seenUrl = String(url);
    seenBody = JSON.parse(opts.body || "{}");
    seenHeaders = opts.headers || {};
    return json({ code: 0, data: { flow_id: "f/1", authorize_url: "https://chat.z.ai/api/oauth/authorize?client_id=abc&state=st-1", poll_token: "pt-server", expires_at: Math.floor(Date.now() / 1000) + 600, poll_interval_sec: 2 } });
  };
  const flow = await initZcodeFlow({ provider: "zai", fetchImpl, deviceMid: "mid-x" });
  assert.ok(seenUrl.includes("/api/v1/oauth/cli/init"));
  assert.equal(seenBody.provider, "zai");
  assert.match(seenHeaders.Authorization, /^Bearer [0-9a-f]{64}$/, "init 需自带 poll_token 鉴权");
  assert.equal(seenHeaders["X-Device-Mid"], "mid-x");
  assert.equal(seenHeaders["User-Agent"], "ZCode/3.11.2");
  assert.equal(flow.state, "st-1");
  assert.equal(flow.pollToken, "pt-server", "服务端 poll_token 优先");
  assert.ok(flow.pollUrl.includes("f%2F1"), "flow_id 须 urlencode");
  assert.ok(flow.expiresAtMs > Date.now());
});

test("oauth: init 非 0 code 报人话错误", async () => {
  const fetchImpl = async () => json({ code: 500, msg: "boom" });
  await assert.rejects(() => initZcodeFlow({ fetchImpl }), /boom/);
});

test("oauth: wait pending→ready 返回 jwt/access/user", async () => {
  const token = mkJwt();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) return json({ code: 0, data: { status: "pending" } });
    return json({ code: 0, data: { status: "ready", token, zai: { access_token: "at-1" }, user: { user_id: "u9", name: "小明" } } });
  };
  const flow = { provider: "zai", pollUrl: "https://zcode.z.ai/api/v1/oauth/cli/poll/x", pollToken: "pt", expiresAtMs: Date.now() + 60_000, pollIntervalMs: 5 };
  const out = await waitForZcodeLogin({ flow, fetchImpl, sleepFn: async () => {}, log: () => {} });
  assert.equal(out.jwt, token);
  assert.equal(out.accessToken, "at-1");
  assert.equal(out.user.userId, "u9");
  assert.equal(out.user.name, "小明");
  assert.equal(out.provider, "zai");
});

test("oauth: poll 3004 报过期；failed 报失败；网络抖动按 pending", async () => {
  const pollUrl = "https://zcode.z.ai/api/v1/oauth/cli/poll/x";
  await assert.rejects(
    () => pollZcodeFlowOnce({ pollUrl, pollToken: "pt", fetchImpl: async () => json({ code: 3004, msg: "expired" }, 400) }),
    /过期/,
  );
  await assert.rejects(
    () => pollZcodeFlowOnce({ pollUrl, pollToken: "pt", fetchImpl: async () => json({ code: 0, data: { status: "failed" } }) }),
    /失败|重试/,
  );
  const pending = await pollZcodeFlowOnce({ pollUrl, pollToken: "pt", fetchImpl: async () => { throw new Error("network down"); } });
  assert.equal(pending.status, "pending", "网络错误不判死");
});

test("oauth: wait 本地过期即报错（不无限轮询）", async () => {
  const flow = { pollUrl: "https://x/y", pollToken: "pt", expiresAtMs: Date.now() - 1, pollIntervalMs: 5 };
  let called = 0;
  await assert.rejects(
    () => waitForZcodeLogin({ flow, fetchImpl: async () => { called += 1; return json({ code: 0, data: { status: "pending" } }); }, sleepFn: async () => {} }),
    /过期/,
  );
  assert.equal(called, 0, "过期后不得再打上游");
});

test("login 命令：端到端落盘 + allowlist 补齐 + 回执脱敏", async () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-login-"));
  const dir = join(root, "auths");
  const file = join(root, "state.json");
  const token = mkJwt();
  const logs = [];
  try {
    const fetchImpl = async (url) => {
      if (String(url).includes("/oauth/cli/init")) {
        return json({ code: 0, data: { flow_id: "f1", authorize_url: "https://chat.z.ai/api/oauth/authorize?state=s1", poll_token: "pt1", expires_at: Math.floor(Date.now() / 1000) + 300, poll_interval_sec: 1 } });
      }
      return json({ code: 0, data: { status: "ready", token, zai: { access_token: "at" }, user: { user_id: "u9", name: "小明", email: "a@b.c" } } });
    };
    const handled = await handleZcodeLogin("zcode", "login", [], {
      fetchImpl, log: (m) => logs.push(String(m)), exit: () => {}, dir, file, deviceMid: "mid-login-1", sleepFn: async () => {},
    });
    assert.equal(handled, true);
    const out = logs.join("\n");
    assert.ok(out.includes("https://chat.z.ai/api/oauth/authorize?state=s1"), "打印登录 URL");
    assert.ok(out.includes("授权成功"), "成功回执");
    assert.ok(out.includes(token.slice(0, 8)), "只出指纹");
    assert.ok(!out.includes(token), "日志不得含完整 JWT");
    assert.ok(existsSync(join(dir, "zcode-u9.json")), "账号文件落盘");
    const doc = JSON.parse(readFileSync(join(dir, "zcode-u9.json"), "utf8"));
    assert.equal(doc.auth.jwt, token);
    assert.equal(doc.auth.deviceMid, "mid-login-1");
    const st = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(st.providerConfigs.zcode.keys, [token]);
    assert.deepEqual(st.providerConfigs.zcode.allowedModels, ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"], "allowlist 补齐为目录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("login 命令：--bigmodel 换入口；非 zcode/非 login 返回 false", async () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-login2-"));
  const seen = [];
  try {
    const fetchImpl = async (url, opts) => {
      seen.push(JSON.parse(opts?.body || "{}").provider);
      if (String(url).includes("/oauth/cli/init")) {
        return json({ code: 0, data: { flow_id: "f1", authorize_url: "https://bigmodel.cn/login?state=s1", poll_token: "pt1", expires_at: Math.floor(Date.now() / 1000) + 300, poll_interval_sec: 1 } });
      }
      return json({ code: 0, data: { status: "ready", token: mkJwt(), bigmodel: { access_token: "at" }, user: { user_id: "u1", name: "A" } } });
    };
    await handleZcodeLogin("zcode", "login", ["--bigmodel"], { fetchImpl, log: () => {}, exit: () => {}, dir: join(root, "auths"), file: join(root, "state.json"), sleepFn: async () => {} });
    assert.equal(seen[0], "bigmodel");
    assert.equal(await handleZcodeLogin("qoder", "login", [], {}), false);
    assert.equal(await handleZcodeLogin("zcode", "models", [], {}), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allowlist seed：只增不减", () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-allow-"));
  const file = join(root, "state.json");
  try {
    const first = seedZcodeAllowlist({ file });
    assert.deepEqual(first.added, ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]);
    saveProviderAllowedModels("zcode", [...loadProviderAllowedModels("zcode", { file }), "CUSTOM-1"], { file });
    const second = seedZcodeAllowlist({ file });
    assert.deepEqual(second.added, [], "无新增不重写");
    assert.ok(loadProviderAllowedModels("zcode", { file }).includes("CUSTOM-1"), "既有项不丢");
    assert.ok(loadProviderAllowedModels("zcode", { file }).includes("GLM-5.3"), "目录项仍在");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
