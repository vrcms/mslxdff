import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClineProvider } from "../src/providers/cline/index.js";

const DUMMY_RT = "eyJhbGciOiJIUzI1NiJ9.fake_refresh_token_long_12345678901234567890";

function mockFetch({ refreshOk = true, chatSse = true } = {}) {
  const calls = { refresh: 0, chat: 0, models: 0 };
  async function fetchImpl(url, opts) {
    const u = String(url);
    if (u.includes("/auth/refresh")) {
      calls.refresh++;
      if (!refreshOk) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({
        data: { accessToken: "fake_at_abc", refreshToken: DUMMY_RT, expiresAt: Date.now() + 10 * 60 * 1000 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/chat/completions")) {
      calls.chat++;
      const h = new Headers(opts.headers || {});
      assert.ok(String(h.get("user-agent")).includes("Cline/"), "must carry Cline UA");
      assert.ok(String(h.get("authorization")).startsWith("Bearer workos:"), "must carry workos token");
      assert.equal(h.get("x-client-type"), "cline-sdk");
      const body = JSON.parse(opts.body || "{}");
      if (chatSse) {
        const sse = `data: ${JSON.stringify({ id: "r1", choices: [{ delta: { content: "你好" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ data: body }), { status: 200 });
    }
    if (u.includes("/recommended-models")) {
      calls.models++;
      return new Response(JSON.stringify({ free: [{ id: "deepseek/deepseek-v4-flash" }, { id: "poolside/laguna-s-2.1:free" }] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }
  return { fetchImpl, calls };
}

test("cline: refresh token detected, legacy sk_ key not", () => {
  const p1 = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl: async () => new Response("", { status: 404 }) });
  assert.ok(p1._authPool, "refresh token must enable auth pool");
  assert.equal(p1._authPool.getAccounts().length, 1);
  const p2 = createClineProvider({ id: "clinebot", apiKeys: ["sk_test123"], fetchImpl: async () => new Response("", { status: 404 }) });
  assert.equal(p2._authPool, null, "sk_ key must stay legacy direct mode");
});

test("cline: chat exchanges refresh for workos token and sends fingerprint headers", async () => {
  const { fetchImpl, calls } = mockFetch();
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  const resp = await p.chat({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(resp.status, 200);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.chat, 1);
  const txt = await resp.text();
  assert.ok(txt.includes("你好"), "stream body must contain content");
});

test("cline: non-stream deepseek forces upstream stream and aggregates", async () => {
  const seen = [];
  const { fetchImpl } = mockFetch();
  const orig = fetchImpl;
  const wrapped = async (url, opts) => {
    if (String(url).includes("/chat/completions")) {
      seen.push(JSON.parse(opts.body || "{}"));
    }
    return orig(url, opts);
  };
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl: wrapped });
  const resp = await p.chat({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(resp.status, 200);
  assert.equal(seen[0].stream, true, "deepseek must be forced to stream=true");
  const j = JSON.parse(await resp.text());
  assert.equal(j.choices[0].message.content, "你好");
});

test("cline: listModels only returns free array with provider prefix", async () => {
  const { fetchImpl, calls } = mockFetch();
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  const models = await p.listModels();
  assert.equal(calls.models, 1);
  assert.deepEqual(models.map((m) => m.id), ["clinebot/deepseek/deepseek-v4-flash", "clinebot/poolside/laguna-s-2.1:free"]);
});

test("cline: models 401 falls back to bundled free list incl glm-5.3-flash", async () => {
  let seenUrl = "";
  async function fetchImpl(url, opts) {
    if (String(url).includes("recommended-models")) {
      seenUrl = String(url);
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    return new Response("", { status: 404 });
  }
  const p = createClineProvider({ id: "clinebot", baseUrl: "https://api.cline.bot", apiKeys: [], fetchImpl });
  const models = await p.listModels();
  assert.ok(seenUrl.endsWith("/api/v1/ai/cline/recommended-models"), `models url must be normalized, got ${seenUrl}`);
  const ids = models.map((m) => m.id);
  assert.ok(ids.includes("clinebot/z-ai/glm-5.3-flash"), "fallback must include glm-5.3-flash");
});

test("cline: refresh URL not doubled when baseUrl already has /api/v1", async () => {
  const { createAuthPool } = await import("../src/providers/cline/auth.js");
  let seenUrl = "";
  const pool = createAuthPool({
    id: "clinebot",
    baseUrl: "https://api.cline.bot/api/v1",
    keys: [DUMMY_RT],
    fetchImpl: async (url, opts) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ data: { accessToken: "at_ok", refreshToken: DUMMY_RT, expiresAt: Date.now() + 600000 } }), { status: 200 });
    },
  });
  const at = await pool.refreshOne(pool.getAccounts()[0]);
  assert.equal(at, "at_ok");
  assert.ok(seenUrl === "https://api.cline.bot/api/v1/auth/refresh", `refresh url must not double, got ${seenUrl}`);
});

test("cline: version-hint 401 must not mark dead (only invalid_grant kills)", async () => {
  const { createAuthPool, isInvalidGrant } = await import("../src/providers/cline/auth.js");
  const versionMsg = "Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account.";
  assert.equal(isInvalidGrant(versionMsg, 401), false, "version 401 must not be invalid_grant");
  assert.equal(isInvalidGrant('{"error":"invalid_grant"}', 400), true);
  const pool = createAuthPool({
    id: "clinebot",
    baseUrl: "https://api.cline.bot/api/v1",
    keys: [DUMMY_RT],
    fetchImpl: async () => new Response(versionMsg, { status: 401 }),
  });
  await assert.rejects(() => pool.refreshOne(pool.getAccounts()[0]), /refresh_failed/);
  assert.equal(pool.getAccounts()[0].dead, undefined, "version 401 must cool down, not kill");
});

test("cline: invalid_grant marks account dead, transient failure does not", async () => {
  const { createAuthPool } = await import("../src/providers/cline/auth.js");
  const deadPool = createAuthPool({
    id: "clinebot",
    keys: [DUMMY_RT],
    fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  });
  await assert.rejects(() => deadPool.refreshOne(deadPool.getAccounts()[0]), /invalid_grant/);
  assert.equal(deadPool.getAccounts()[0].dead, true, "invalid_grant must mark dead");
  await assert.rejects(() => deadPool.refreshOne(deadPool.getAccounts()[0]), /invalid_grant/);
  const livePool = createAuthPool({
    id: "clinebot",
    keys: [DUMMY_RT],
    fetchImpl: async () => new Response("boom", { status: 500 }),
  });
  await assert.rejects(() => livePool.refreshOne(livePool.getAccounts()[0]), /refresh_failed/);
  assert.equal(livePool.getAccounts()[0].dead, undefined, "transient 500 must not mark dead");
});

test("cline: 429 错误体在上层仍可读（SDK 通道 body 一次性需重建）", async () => {
  const body429 = JSON.stringify({ error: { code: "INFERENCE_CAP_ERROR", message: "Daily free limit reached" } });
  async function fetchImpl(url, opts) {
    const u = String(url);
    if (u.includes("/auth/refresh")) return new Response(JSON.stringify({ data: { accessToken: "at", refreshToken: DUMMY_RT, expiresAt: Date.now() + 600000 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/chat/completions")) return new Response(body429, { status: 429, headers: { "Content-Type": "application/json" } });
    return new Response("", { status: 404 });
  }
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  const res = await p.chat({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(res.status, 429);
  assert.match(await res.text(), /Daily free limit reached/, "上层必须能读到错误体");
  await p.close();
});

test("cline: refresh failure cools account and retry hits next", async () => {
  let n = 0;
  async function fetchImpl(url, opts) {
    if (String(url).includes("/auth/refresh")) {
      n++;
      if (n <= 1) return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
      return new Response(JSON.stringify({ data: { accessToken: "at2", refreshToken: DUMMY_RT, expiresAt: Date.now() + 600000 } }), { status: 200 });
    }
    if (String(url).includes("/chat/completions")) {
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("", { status: 404 });
  }
  const p = createClineProvider({ id: "clinebot", apiKeys: [DUMMY_RT], fetchImpl });
  const resp = await p.chat({ model: "poolside/laguna-s-2.1:free", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(resp.status, 200);
  assert.ok(n >= 2, "must retry refresh after first failure");
});

test("cline: models fallback aligns with upstream free 5 (incl cline-free/*)", async () => {
  const p = createClineProvider({ id: "clinebot", baseUrl: "https://api.cline.bot", apiKeys: [], fetchImpl: async () => new Response("boom", { status: 500 }) });
  const models = await p.listModels();
  const ids = models.map((m) => m.id);
  assert.equal(ids.length, 5, "fallback must carry 5 entries");
  assert.ok(ids.includes("clinebot/cline-free/deepseek-v4.1-flash"), "must include cline-free/deepseek-v4.1-flash");
  assert.ok(ids.includes("clinebot/cline-free/muse-spark-1.3-contributor"), "must include cline-free/muse-spark-1.3-contributor");
  assert.ok(ids.includes("clinebot/z-ai/glm-5.3-flash"), "must include z-ai/glm-5.3-flash");
  assert.ok(ids.includes("clinebot/cline-free/solar-pro4"), "must include cline-free/solar-pro4");
  assert.ok(ids.includes("clinebot/poolside/laguna-s-2.1:free"), "must include poolside/laguna-s-2.1:free");
  await p.close();
});

test("cline: preheat creates snapshot, stays silent when unchanged, reports diff on change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cline-free-"));
  const snap = join(dir, "snap.json");
  let free = ["z-ai/glm-5.3-flash", "cline-free/solar-pro4"];
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  const mk = () => createClineProvider({
    id: "clinebot", baseUrl: "https://api.cline.bot", apiKeys: [], snapshotPath: snap,
    fetchImpl: async () => new Response(JSON.stringify({ free: free.map((id) => ({ id })) }), { status: 200 }),
  });
  try {
    const p1 = mk();
    await p1.preheat();
    await p1.close();
    assert.deepEqual(JSON.parse(readFileSync(snap, "utf8")).free, free, "snapshot must persist free ids on first run");
    assert.ok(logs.some((l) => l.includes("snapshot created")), "first run must log snapshot creation");

    logs.length = 0;
    const p2 = mk();
    await p2.preheat();
    await p2.close();
    assert.equal(logs.filter((l) => l.includes("free models updated")).length, 0, "unchanged run must stay silent");

    logs.length = 0;
    free = ["z-ai/glm-5.3-flash", "cline-free/deepseek-v4.1-flash"];
    const p3 = mk();
    await p3.preheat();
    await p3.close();
    const upd = logs.find((l) => l.includes("free models updated"));
    assert.ok(upd, "change must be logged");
    assert.ok(upd.includes("cline-free/deepseek-v4.1-flash"), "added id must appear in log");
    assert.ok(upd.includes("cline-free/solar-pro4"), "removed id must appear in log");
    assert.deepEqual(JSON.parse(readFileSync(snap, "utf8")).free, free, "snapshot must update after change");
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cline: checkFreeUpdates is independently callable (startup hook, not dispatcher preheat)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cline-free-"));
  const snap = join(dir, "snap.json");
  const p = createClineProvider({
    id: "clinebot", baseUrl: "https://api.cline.bot", apiKeys: [], snapshotPath: snap,
    fetchImpl: async () => new Response(JSON.stringify({ free: [{ id: "z-ai/glm-5.3-flash" }] }), { status: 200 }),
  });
  assert.equal(typeof p.checkFreeUpdates, "function", "provider must expose checkFreeUpdates for the startup hook");
  const r = await p.checkFreeUpdates();
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(snap, "utf8")).free, ["z-ai/glm-5.3-flash"], "startup hook must refresh the snapshot");
  await p.close();
  rmSync(dir, { recursive: true, force: true });
});

test("cline: preheat failure leaves snapshot untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cline-free-"));
  const snap = join(dir, "snap.json");
  writeFileSync(snap, JSON.stringify({ free: ["z-ai/glm-5.3-flash"] }), "utf8");
  const p = createClineProvider({
    id: "clinebot", baseUrl: "https://api.cline.bot", apiKeys: [], snapshotPath: snap,
    fetchImpl: async () => new Response("bad", { status: 500 }),
  });
  const r = await p.preheat();
  assert.equal(r.ok, false, "preheat must report failure");
  assert.deepEqual(JSON.parse(readFileSync(snap, "utf8")).free, ["z-ai/glm-5.3-flash"], "failed fetch must not wipe snapshot");
  await p.close();
  rmSync(dir, { recursive: true, force: true });
});