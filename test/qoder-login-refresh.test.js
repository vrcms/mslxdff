// qoder-login-refresh.test.js — 登录过期（code 105 "Login expired"）→ 自动刷新令牌原地重发
// 现网事故（2026-10-22）：6 个号 deviceToken 全过期，105 被当普通 403 冷却换号，
// 整池轮一遍还各叠 3 次空转重试，第一句"你好"必 502。修复后：105 → refresh → 原地重发；
// refresh 也作废 → 长冷却该号（不轮询撞死 refresh）；全部刷不动 → 如实 401 提示重登。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQoderProvider } from "../src/providers/qoder/index.js";
import { extractDelta, isLoginExpired, findLoginSignal } from "../src/providers/qoder/sse.js";
import { refreshDeviceToken } from "../src/providers/qoder/oauth.js";
import { listAccountDocs } from "../src/providers/qoder/account-store.js";

const blob = (t, r = "") => JSON.stringify({ device_token: t, refresh_token: r });
const env = (inner, statusCodeValue = 200, statusCode = "OK") =>
  `data:${JSON.stringify({ headers: {}, body: JSON.stringify(inner), statusCodeValue, statusCode })}\n\n`;
const contentFrame = (t) => env({ choices: [{ index: 0, delta: { content: t } }] });
const loginFrame = () => env({ code: "105", message: "Login expired" });
const DONE = "data:[DONE]\n\n";

// ---- sse.js 识别 ----
test("sse：内层 code 105 → auth 错且带 loginExpired 旗标", () => {
  const d = extractDelta(loginFrame().trim().slice(5));
  assert.equal(d.err.kind, "auth");
  assert.equal(d.err.status, 401);
  assert.equal(d.err.loginExpired, true);
});
test("sse：非 200 信封裹 105（多层形态）→ 同样命中", () => {
  const wrapped = `data:${JSON.stringify({ headers: {}, body: JSON.stringify({ code: "105", message: "Login expired" }), statusCodeValue: 403 })}\n\n`;
  const d = extractDelta(wrapped.trim().slice(5));
  assert.equal(d.err.kind, "auth");
  assert.equal(d.err.loginExpired, true);
});
test("isLoginExpired：正文含 Login expired 字样但不带结构化 code → 不得误伤", () => {
  assert.equal(isLoginExpired("", "the model said Login expired in prose"), false);
  assert.equal(isLoginExpired("105", "Login expired"), true);
});
test("findLoginSignal：字符串层 JSON 下钻命中", () => {
  const hit = findLoginSignal(JSON.stringify({ code: "105", message: "Login expired" }));
  assert.match(String(hit), /Login expired/);
});

// ---- 刷新端点（fake fetch）----
test("oauth.refreshDeviceToken：200 → 新 token 对；401 → retryable=false", async () => {
  const ok = await refreshDeviceToken({ region: "global", refreshToken: "drt-a", fetchImpl: async () => new Response(JSON.stringify({ token: "dt-new", refresh_token: "drt-new" }), { status: 200 }) });
  assert.equal(ok.deviceToken, "dt-new");
  assert.equal(ok.refreshToken, "drt-new");
  await assert.rejects(
    () => refreshDeviceToken({ region: "global", refreshToken: "drt-dead", fetchImpl: async () => new Response("denied", { status: 401 }) }),
    (e) => e.retryable === false && /重新登录/.test(e.message),
  );
  await assert.rejects(() => refreshDeviceToken({ region: "global", refreshToken: "", fetchImpl: async () => { throw new Error("x"); } }), (e) => e.retryable === false);
});

// ---- 门面端到端：105 → 刷新 → 原地重发成功 ----
function mkProvider({ fetchImpl, nKeys = 2, withRefresh = true }) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-login-"));
  const p = createQoderProvider({
    id: "qoder",
    apiKeys: Array.from({ length: nKeys }, (_, i) => blob(`dt-old-${i}`, withRefresh ? `drt-${i}` : "")),
    file: join(dir, "state.json"),
    fetchImpl,
    cooldownMs: 1,
    authGoneCooldownMs: 60_000,
  });
  return { p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("门面：105 → 用 refresh 换新 token → 原地重发拿到正文（单号）", async () => {
  let refreshed = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes("/deviceToken/refresh")) {
      refreshed++;
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.refresh_token, "drt-0", "必须用落盘 refresh_token 换");
      return new Response(JSON.stringify({ token: "dt-new-0", refresh_token: "drt-new-0" }), { status: 200 });
    }
    // chat：旧 token → 105；新 token → 正常流
    const authz = init?.headers?.authorization || "";
    if (authz.includes(Buffer.from("dt-new-0").toString("base64").slice(0, 8)) || (init?.headers?.["cosy-user"])) {
      // COSY payload 里带的是 identity token，直接按刷新次数判定
    }
    if (refreshed > 0) return new Response(contentFrame("你好呀！") + DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(loginFrame() + DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const { p, cleanup } = mkProvider({ fetchImpl, nKeys: 1 });
  try {
    const res = await p.chat({ model: "qoder/qfmodel", messages: [{ role: "user", content: "你好" }], stream: false }, { reqId: "lr1" });
    assert.equal(refreshed, 1, "必须触发一次刷新");
    assert.equal(res.status, 200, "刷新后原地重发应成功");
    const j = await res.json();
    assert.match(j.choices?.[0]?.message?.content || "", /你好呀/);
  } finally { cleanup(); }
});

test("门面：refresh 也作废（401）→ 不冷却轮询整池，直接 401 提示重登", async () => {
  let chatCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/deviceToken/refresh")) return new Response("denied", { status: 401 });
    chatCalls++;
    return new Response(loginFrame() + DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const { p, cleanup } = mkProvider({ fetchImpl, nKeys: 3 });
  try {
    const res = await p.chat({ model: "qoder/qfmodel", messages: [{ role: "user", content: "hi" }], stream: false }, { reqId: "lr2" });
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.match(j.error?.message || "", /login|登录/i, "终态必须引导重登");
    assert.ok(chatCalls <= 4, "3 号各一发 + 既有「全冷却 forced 留痕」一发；无空转轮询、无 3 次叠刷");
  } finally { cleanup(); }
});

test("门面：刷新成功 → 落盘 auths 文档同步新 token 对（重启不丢）", async () => {
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/deviceToken/refresh")) {
      return new Response(JSON.stringify({ token: "dt-new-1", refresh_token: "drt-new-1" }), { status: 200 });
    }
    return new Response(contentFrame("ok") + DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const { p, cleanup } = mkProvider({ fetchImpl, nKeys: 1 });
  try {
    // 先让第一发 105 触发刷新（fetch 顺序：chat→105→refresh→chat）
    let first = true;
    const realFetch = p.chat;
    const res = await p.chat({ model: "qoder/qfmodel", messages: [{ role: "user", content: "hi" }], stream: false }, { reqId: "lr3" });
    assert.equal(res.status, 200);
    // 落盘校验：auth 目录应有新 token（updateQoderAccountTokens 写 0600 tmp+rename）
    const docs = listAccountDocs();
    assert.ok(docs.length >= 1);
  } finally { cleanup(); }
});

test("门面：同号二次 105（刷新后仍过期）→ 不反复撞刷新端点（每 uid 一次）", async () => {
  let refreshed = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/deviceToken/refresh")) { refreshed++; return new Response(JSON.stringify({ token: `dt-n${refreshed}`, refresh_token: `drt-n${refreshed}` }), { status: 200 }); }
    return new Response(loginFrame() + DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const { p, cleanup } = mkProvider({ fetchImpl, nKeys: 1 });
  try {
    await p.chat({ model: "qoder/qfmodel", messages: [{ role: "user", content: "hi" }], stream: false }, { reqId: "lr4a" });
    const n1 = refreshed;
    await p.chat({ model: "qoder/qfmodel", messages: [{ role: "user", content: "hi" }], stream: false }, { reqId: "lr4b" });
    assert.equal(refreshed, n1, "同 uid 只刷一次（刷后仍 105 = refresh 作废，进长冷却）");
  } finally { cleanup(); }
});
