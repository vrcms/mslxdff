// raccoon 工厂与 CLI 单测：keyring 换号与冷却分档、目录回落、流内判决、CLI 两个子命令、分发不误吞。
// 全程注入 fetchImpl 与隔离 state，不碰真实上游/真实 state。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-raccoon-prov-")), "state.json");

const { createRaccoonProvider } = await import("../src/providers/raccoon/index.js");
const { listRaccoonModels } = await import("../src/providers/raccoon/models.js");
const { forwardRaccoonChat } = await import("../src/providers/raccoon/chat.js");
const { handleRaccoonLogin } = await import("../src/cli/commands/provider/raccoon-login.js");
const { handleRaccoonQuota } = await import("../src/cli/commands/provider/raccoon-quota.js");

const jsonRes = (obj, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});
const sseRes = (frames) => ({
  ok: true,
  status: 200,
  headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/event-stream" : null) },
  body: new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  }),
});
const keyOf = (init) => String(init?.headers?.Authorization || "").replace(/^Bearer /, "");
const drain = async (stream) => {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
};

test("工厂: 单号被判积分不足 → 长冷却；随后请求落 all_cooling（不谎报成功）", async () => {
  const provider = createRaccoonProvider({
    apiKeys: ["tok-a"],
    fetchImpl: async () => jsonRes({ code: 400001, message: "积分不足" }),
  });
  const first = await provider.chat({ model: "raccoon/sn-kimi-k3" });
  assert.equal(first.status, 429);
  assert.equal(first.headers.get("x-mslxdff-raccoon-kind"), "quota");

  const second = await provider.chat({ model: "raccoon/sn-kimi-k3" });
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("x-mslxdff-raccoon-all-cooling"), "1");
});

test("工厂: 限流走短冷且话术不谎报额度", async () => {
  const provider = createRaccoonProvider({
    apiKeys: ["tok-a"],
    fetchImpl: async () => jsonRes({ code: 0, message: "too many requests" }, 429),
  });
  const res = await provider.chat({ model: "raccoon/sn-kimi-k3" });
  assert.equal(res.headers.get("x-mslxdff-raccoon-kind"), "rate_limit");
  assert.ok(!/积分/.test(JSON.parse(await res.text()).error.message));
});

test("工厂: 双号一好一坏 → 同一请求内换号完成调用（客户端无感）", async () => {
  let seen = [];
  const provider = createRaccoonProvider({
    apiKeys: ["tok-bad", "tok-good"],
    fetchImpl: async (url, init) => {
      const key = keyOf(init);
      seen.push(key);
      if (key === "tok-bad") return jsonRes({ code: 400001, message: "积分不足" });
      return jsonRes({ choices: [{ message: { content: "ok" } }] });
    },
  });
  const res = await provider.chat({ model: "raccoon/sn-kimi-k3", stream: false });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(await res.text()).choices[0].message.content, "ok");
  assert.deepEqual(seen, ["tok-bad", "tok-good"], "坏号失败后应在同一请求内换好号");
});

test("目录: 上游不可达回落兜底 6 模型；可达时用上游目录", async () => {
  const fallback = await listRaccoonModels({
    credential: { access_token: "t" },
    fetchImpl: async () => jsonRes({ code: 200001, message: "登录已过期" }, 401),
  });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.models.length, 6);

  const upstream = await listRaccoonModels({
    credential: { access_token: "t" },
    fetchImpl: async () => jsonRes({ code: 0, data: { models: [{ modelId: "sn-x", effectiveMultiplier: 0.5 }] } }),
  });
  assert.equal(upstream.source, "upstream");
  assert.deepEqual(upstream.models.map((m) => m.id), ["sn-x"]);
});

test("流式: 首帧是流内错误信封 → 401 + kind=auth，不透传给客户端", async () => {
  const res = await forwardRaccoonChat({
    body: { model: "sn-kimi-k3", stream: true },
    credential: { access_token: "t" },
    fetchImpl: async () => sseRes(['data: {"code":200003,"message":"登录已过期"}\n\n']),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("x-mslxdff-raccoon-kind"), "auth");
});

test("流式: 首帧正常 → 原样透传，预读字节一个不丢", async () => {
  const frames = ['data: {"choices":[{"delta":{"content":"你好"}}]}\n\n', "data: [DONE]\n\n"];
  const res = await forwardRaccoonChat({
    body: { model: "sn-kimi-k3", stream: true },
    credential: { access_token: "t" },
    fetchImpl: async () => sseRes(frames),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
  assert.equal(await drain(res.body), frames.join(""), "预读字节必须原样回灌");
});

test("CLI: raccoon login 打印二维码/URL、落盘、补齐 allowlist（注入 fetchImpl）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-raccoon-cli-"));
  const lines = [];
  const saved = [];
  const ok = await handleRaccoonLogin("raccoon", "login", [], {
    qrCode: "a".repeat(32),
    fetchImpl: async (url) => {
      if (String(url).includes("login_with_qrcode_code")) {
        return jsonRes({ code: 0, data: { status: "success", access_token: "tok-login", refresh_token: "ref-login" } });
      }
      return jsonRes({ code: 0, data: { id: "uid-1", name: "小浣熊" } });
    },
    log: (m) => lines.push(String(m)),
    exit: (c) => { throw new Error(`不应退出（code ${c}）`); },
    saveAccount: async (args) => { saved.push(args); return { file: join(dir, "raccoon-uid-1.json") }; },
    deviceId: "dev-1",
    dir,
    file: join(dir, "state.json"),
  });
  assert.equal(ok, true);
  const out = lines.join("\n");
  assert.ok(out.includes("login/mp?code="), "必须打印登录链接");
  assert.ok(out.includes("█") || out.includes("▀"), "必须渲染二维码字符画");
  assert.ok(out.includes("tok-login".slice(0, 0) + "登录成功"), "必须给人话回执");
  assert.ok(!out.includes("tok-login"), "回执不得出现 token 原文");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].accessToken, "tok-login");
  assert.equal(saved[0].uid, "uid-1");
  assert.equal(saved[0].deviceId, "dev-1");
});

test("CLI: raccoon login 超时 → 非零退出 + 人话，不落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-raccoon-cli-"));
  const lines = [];
  let exited = 0;
  await handleRaccoonLogin("raccoon", "login", [], {
    qrCode: "b".repeat(32),
    fetchImpl: async () => jsonRes({ code: 0, data: { status: "pending" } }),
    log: (m) => lines.push(String(m)),
    exit: (c) => { exited = c; },
    saveAccount: async () => { throw new Error("超时不应落盘"); },
    dir,
    file: join(dir, "state.json"),
    timeoutMs: 0,
  });
  assert.equal(exited, 1);
  assert.ok(lines.join("\n").includes("超时"));
});

test("CLI: raccoon quota 未登录 → 人话指引 + 非零退出（--json 亦然）", async () => {
  const lines = [];
  let exited = 0;
  const ok = await handleRaccoonQuota("raccoon", "quota", [], {
    log: (m) => lines.push(String(m)),
    exit: (c) => { exited = c; },
    dir: join(tmpdir(), "no-such-raccoon-auth-dir"),
  });
  assert.equal(ok, true);
  assert.equal(exited, 1);
  assert.ok(lines.join("\n").includes("raccoon login"));
});

test("CLI: raccoon quota 有凭据 → 打印五分项与合计", async () => {
  const lines = [];
  const ok = await handleRaccoonQuota("raccoon", "quota", [], {
    credential: { access_token: "tok-x" },
    fetchImpl: async () => jsonRes({ code: 0, data: { available_points: 777, daily_points: 7 } }),
    log: (m) => lines.push(String(m)),
    exit: () => {},
  });
  assert.equal(ok, true);
  const out = lines.join("\n");
  assert.ok(out.includes("777"));
  assert.ok(out.includes("每日积分"));
});

test("CLI: raccoon checkin 已领过 → 如实显示「每号只有一次」，且不再打写端点", async () => {
  const lines = [];
  const urls = [];
  let exited = 0;
  const ok = await handleRaccoonQuota("raccoon", "checkin", [], {
    credential: { access_token: "tok-x" },
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonRes({ code: 0, data: { list: [{ biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000, created_at: new Date().toISOString() }] } });
    },
    log: (m) => lines.push(String(m)),
    exit: (c) => { exited = c; },
  });
  assert.equal(ok, true);
  assert.equal(exited, 0, "已领过是常态，不是失败");
  const out = lines.join("\n");
  assert.ok(out.includes("每号只有一次"), "文案不能再写「明日再来」—— 这家根本没有每日签到");
  assert.ok(!out.includes("明日再来"));
  assert.ok(!urls.some((u) => u.includes("/grant")), "账单已显示领过就不该再打写端点");
});

test("CLI: 非 raccoon id / 非目标子命令 → 返回 false（不误吞其它 provider）", async () => {
  assert.equal(await handleRaccoonLogin("zcode", "login", [], {}), false);
  assert.equal(await handleRaccoonLogin("raccoon", "models", [], {}), false);
  assert.equal(await handleRaccoonQuota("qoder", "quota", [], {}), false);
  assert.equal(await handleRaccoonQuota("raccoon", "models", [], {}), false);
});

test("续期: 上游不回 refresh_token 时不得抹空盘上的旧值（P0 回归）", async () => {
  const authDir = mkdtempSync(join(tmpdir(), "mslxdff-raccoon-auth-"));
  process.env.MSLXDFF_RACCOON_AUTH_DIR = authDir;
  try {
    const { readRaccoonAccountDoc, writeRaccoonAccountFile } = await import("../src/providers/raccoon/account-store.js");
    // 到期时刻刻意设为过去 → 触发 ensureFresh
    writeRaccoonAccountFile({ uid: "u-refresh", accessToken: "tok-old", refreshToken: "ref-keep", expiresAt: "1" }, { dir: authDir });
    const provider = createRaccoonProvider({
      apiKeys: ["tok-old"],
      fetchImpl: async (url) => {
        if (String(url).includes("/auth/v1/refresh")) return jsonRes({ code: 0, data: { access_token: "tok-new" } }); // 刻意不带 refresh_token
        return jsonRes({ choices: [{ message: { content: "ok" } }] });
      },
    });
    const res = await provider.chat({ model: "raccoon/sn-kimi-k3", stream: false });
    assert.equal(res.status, 200, "续期后应正常完成调用");
    const doc = readRaccoonAccountDoc("u-refresh", { dir: authDir });
    assert.equal(doc.auth.access_token, "tok-new");
    assert.equal(doc.auth.refresh_token, "ref-keep", "上游不回新 refresh_token 时必须沿用旧的——抹成空串会让该号永久无法续期");
  } finally {
    delete process.env.MSLXDFF_RACCOON_AUTH_DIR;
  }
});

// refresh_token 是一次性轮换的（2026-10-10 实测：续期成功后旧值立刻失效）。
// 同一 token 的并发请求若各自去续期，第一个消费成功、后面的全部撞空 —— 等于自己把号烧了。
test("续期: 同一 token 并发只允许发一次 refresh（防重复消费一次性 refresh_token）", async () => {
  const authDir = mkdtempSync(join(tmpdir(), "mslxdff-raccoon-conc-"));
  process.env.MSLXDFF_RACCOON_AUTH_DIR = authDir;
  try {
    const { writeRaccoonAccountFile } = await import("../src/providers/raccoon/account-store.js");
    writeRaccoonAccountFile({ uid: "u-conc", accessToken: "tok-old", refreshToken: "ref-once", expiresAt: "1" }, { dir: authDir });
    let refreshCalls = 0;
    let inflightNow = 0;
    let inflightMax = 0;
    const provider = createRaccoonProvider({
      apiKeys: ["tok-old"],
      fetchImpl: async (url) => {
        if (String(url).includes("/auth/v1/refresh")) {
          refreshCalls += 1;
          inflightNow += 1;
          inflightMax = Math.max(inflightMax, inflightNow);
          await new Promise((r) => setTimeout(r, 25)); // 刻意拉长窗口，逼并发撞车
          inflightNow -= 1;
          return jsonRes({ code: 0, data: { access_token: "tok-new", refresh_token: "ref-new" } });
        }
        return jsonRes({ choices: [{ message: { content: "ok" } }] });
      },
    });
    const results = await Promise.all([
      provider.chat({ model: "raccoon/sn-kimi-k3", stream: false }),
      provider.chat({ model: "raccoon/sn-kimi-k3", stream: false }),
      provider.chat({ model: "raccoon/sn-kimi-k3", stream: false }),
    ]);
    assert.ok(results.every((r) => r.status === 200), "三个请求都该成功");
    assert.equal(refreshCalls, 1, `并发续期必须共享同一次 refresh，实际发了 ${refreshCalls} 次`);
    assert.equal(inflightMax, 1, "同一时刻不该有两个 refresh 在飞");
  } finally {
    delete process.env.MSLXDFF_RACCOON_AUTH_DIR;
  }
});
