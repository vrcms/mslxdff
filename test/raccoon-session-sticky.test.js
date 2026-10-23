// raccoon 会话粘号：一段对话固定一个号，会话之间轮换（积分按会话均摊，而不是逐轮打散）。
// 同时锁住旧行为：没有会话标识时仍是逐调用轮转。全程注入 fetchImpl 与隔离 state。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-raccoon-sticky-")), "state.json");

const { createRaccoonProvider } = await import("../src/providers/raccoon/index.js");
const { createStickyPicker } = await import("../src/providers/raccoon/sticky.js");

const jsonRes = (obj, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});
const keyOf = (init) => String(init?.headers?.Authorization || "").replace(/^Bearer /, "");
const BODY = { model: "raccoon/sn-kimi-k3", messages: [{ role: "user", content: "hi" }], stream: false };
const okRes = () => jsonRes({ choices: [{ message: { content: "ok" } }] });
const quotaRes = () => jsonRes({ code: 400001, message: "积分不足" });

test("会话粘号: 同一会话多轮固定一个号，换会话才轮转到下一个号", async () => {
  const seen = [];
  const provider = createRaccoonProvider({
    apiKeys: ["tok-1", "tok-2"],
    fetchImpl: async (url, init) => { seen.push(keyOf(init)); return okRes(); },
  });
  assert.equal((await provider.chat(BODY, { sessionId: "sess-A" })).status, 200);
  assert.equal((await provider.chat(BODY, { sessionId: "sess-A" })).status, 200);
  assert.deepEqual(seen, ["tok-1", "tok-1"], "同一会话第二轮不许换号");

  assert.equal((await provider.chat(BODY, { sessionId: "sess-B" })).status, 200);
  assert.equal(seen[2], "tok-2", "新会话应轮转到下一个号（积分按会话均摊）");

  await provider.chat(BODY, { sessionId: "sess-A" });
  assert.equal(seen[3], "tok-1", "回到 A 会话仍用 A 的号");
});

test("会话粘号: 该号被判积分不足 → 本次请求内换号，该会话此后粘住新号", async () => {
  const seen = [];
  const provider = createRaccoonProvider({
    apiKeys: ["tok-1", "tok-2"],
    fetchImpl: async (url, init) => {
      const key = keyOf(init);
      seen.push(key);
      return key === "tok-1" ? quotaRes() : okRes();
    },
  });
  const first = await provider.chat(BODY, { sessionId: "sess-S" });
  assert.equal(first.status, 200, "坏号失败后应在同一请求内换好号");
  assert.deepEqual(seen, ["tok-1", "tok-2"], "冷却唯一正当理由：该号进冷却才换");

  seen.length = 0;
  assert.equal((await provider.chat(BODY, { sessionId: "sess-S" })).status, 200);
  assert.deepEqual(seen, ["tok-2"], "粘号表必须跟着换号，否则每轮都先撞一次死号");
});

test("会话粘号: 没有会话标识时保持逐调用轮转（旧行为不变）", async () => {
  const seen = [];
  const provider = createRaccoonProvider({
    apiKeys: ["tok-1", "tok-2"],
    fetchImpl: async (url, init) => { seen.push(keyOf(init)); return okRes(); },
  });
  await provider.chat(BODY);
  await provider.chat(BODY);
  await provider.chat(BODY);
  assert.deepEqual(seen, ["tok-1", "tok-2", "tok-1"]);
});

test("会话粘号: 只有 reqId 时按「同请求粘号」（重试不换号）", async () => {
  const seen = [];
  const provider = createRaccoonProvider({
    apiKeys: ["tok-1", "tok-2"],
    fetchImpl: async (url, init) => { seen.push(keyOf(init)); return okRes(); },
  });
  await provider.chat(BODY, { reqId: "r-1" });
  await provider.chat(BODY, { reqId: "r-1" });
  assert.deepEqual(seen, ["tok-1", "tok-1"]);
});

test("会话粘号: 续期换了 token 后同一会话仍留在同一账号（不漂到别的号）", async () => {
  const authDir = mkdtempSync(join(tmpdir(), "mslxdff-raccoon-sticky-auth-"));
  process.env.MSLXDFF_RACCOON_AUTH_DIR = authDir;
  try {
    const { writeRaccoonAccountFile } = await import("../src/providers/raccoon/account-store.js");
    // 到期时刻刻意设为过去 → 触发 ensureFresh（refresh 一次性轮换，成功后 token 换成 tok-new）
    writeRaccoonAccountFile({ uid: "u-sticky", accessToken: "tok-old", refreshToken: "ref-keep", expiresAt: "1" }, { dir: authDir });
    const chatKeys = [];
    const provider = createRaccoonProvider({
      apiKeys: ["tok-old", "tok-2"],
      fetchImpl: async (url, init) => {
        if (String(url).includes("/auth/v1/refresh")) return jsonRes({ code: 0, data: { access_token: "tok-new" } });
        chatKeys.push(keyOf(init));
        return okRes();
      },
    });
    assert.equal((await provider.chat(BODY, { sessionId: "sess-R" })).status, 200);
    assert.deepEqual(chatKeys, ["tok-new"], "续期后用新 token 发请求");

    chatKeys.length = 0;
    assert.equal((await provider.chat(BODY, { sessionId: "sess-R" })).status, 200);
    assert.deepEqual(chatKeys, ["tok-new"], "同一个会话应继续用同一个账号的新 token，不许漂到 tok-2");
  } finally {
    delete process.env.MSLXDFF_RACCOON_AUTH_DIR;
  }
});

test("会话粘号: MSLXDFF_RACCOON_STICKY_MS=0 关闭 → 退回逐调用轮转", async () => {
  process.env.MSLXDFF_RACCOON_STICKY_MS = "0";
  try {
    const seen = [];
    const provider = createRaccoonProvider({
      apiKeys: ["tok-1", "tok-2"],
      fetchImpl: async (url, init) => { seen.push(keyOf(init)); return okRes(); },
    });
    await provider.chat(BODY, { sessionId: "sess-Z" });
    await provider.chat(BODY, { sessionId: "sess-Z" });
    assert.deepEqual(seen, ["tok-1", "tok-2"]);
  } finally {
    delete process.env.MSLXDFF_RACCOON_STICKY_MS;
  }
});

test("粘号选择器: TTL 过期 / 冷却 / remember / forget 的判定", () => {
  let now = 1_000;
  let cursor = 0;
  const keys = ["k1", "k2"];
  const cooling = new Set();
  const pick = createStickyPicker({
    pick: () => { const k = keys[cursor % keys.length]; cursor += 1; return k; },
    isCooling: (k) => cooling.has(k),
    now: () => now,
    ttlMs: 100,
  });
  assert.equal(pick("s1"), "k1");
  assert.equal(pick("s1"), "k1", "TTL 内复用");
  now += 101;
  assert.equal(pick("s1"), "k2", "TTL 过期 → 重新轮转");
  cooling.add("k2");
  assert.equal(pick("s1"), "k1", "上次的号在冷却 → 换号");
  pick.remember("s1", "k2");
  cooling.delete("k2");
  assert.equal(pick("s1"), "k2", "remember 后钉到指定号");
  pick.forget("s1");
  assert.equal(pick("s1"), "k2", "forget 后不再复用记录，按轮转游标继续（游标停在 k1 之后）");
  assert.equal(pick(null), "k1", "无 scope 直接轮转");
});
