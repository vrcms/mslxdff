// globalqwenwork 单测：门面 + 常量契约 + 注册表子串陷阱（注入假 fetch，零网络）。
// 与 qwenwork 同协议，故只测「差异面 + 会被误改回 cn 的地方」，不重复测协议细节。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGlobalQwenworkProvider } from "../src/providers/globalqwenwork/index.js";
import { accountFromBlob } from "../src/providers/globalqwenwork/account-store.js";
import { mapModel, buildBody } from "../src/providers/globalqwenwork/payload.js";
import * as G from "../src/providers/globalqwenwork/constants.js";
import * as CN from "../src/providers/qwenwork/constants.js";
import { getCustomProviderFactory } from "../src/providers/registry.js";
import { splitModelId } from "../src/providers/model-id.js";
import { classifyProvider } from "../src/providers/classify.js";
import { AUTH_DOC_PROVIDER_IDS } from "../src/runtime/provider-gate.js";

const BLOB = JSON.stringify({ device_token: "dt-fake", refresh_token: "drt-fake" });

function sseBody(frames) {
  const enc = new TextEncoder();
  const chunks = frames.map((f) => enc.encode(`data: ${f}\n\n`));
  let i = 0;
  return new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); } });
}
function chunkFrame(content) {
  return JSON.stringify({ id: "c1", model: "pool", choices: [{ index: 0, delta: { role: "assistant", content } }] });
}

test("常量契约：三处必须与国际站一致、且与 cn 不同（防误改回 cn）", () => {
  assert.equal(G.BASE, "https://gateway.qwenwork.ai");
  assert.notEqual(G.BASE, CN.BASE, "BASE 不得与 cn 站相同");
  assert.equal(G.CLIENT_ID, "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a");
  assert.notEqual(G.CLIENT_ID, CN.CLIENT_ID, "client_id 必须独立（用 cn 的会被 selectAccounts 判 query not_allowed）");
  assert.equal(G.REDIRECT_URI, "qwenwork://");
  assert.notEqual(G.REDIRECT_URI, CN.REDIRECT_URI);
  // 协议同构面：这两处若被"顺手改"就会 403
  assert.equal(G.RSA_MODULUS_HEX, CN.RSA_MODULUS_HEX, "RSA 模数与 cn 同枚（实测 .ai 接受）");
  assert.equal(G.MODEL_SLICE, "qwork");
  assert.equal(G.DEFAULT_MODEL, "qwork-auto");
  assert.notDeepEqual(G.KNOWN_MODELS.map((m) => m.key), CN.KNOWN_MODELS.map((m) => m.key), "两站模型池必须不同");
});

test("registry 子串陷阱：globalqwenwork 绝不被 cn 条目抢走（first-match-wins）", async () => {
  for (const base of ["", "globalqwenwork://native", "https://gateway.qwenwork.ai"]) {
    const f = await getCustomProviderFactory("globalqwenwork", base);
    assert.ok(f, `baseUrl=${base || "(空)"} 未命中任何工厂`);
    assert.equal(f().id, "globalqwenwork", `baseUrl=${base || "(空)"} 被错误工厂接管`);
  }
  // 反向：cn 不能被 global 条目抢走
  for (const base of ["", "qwenwork://native", "https://gateway.qwenwork.cn"]) {
    const f = await getCustomProviderFactory("qwenwork", base);
    assert.equal(f?.()?.id, "qwenwork", `cn 在 baseUrl=${base || "(空)"} 下被抢`);
  }
});

test("前缀分流：globalqwenwork/ 与 qwenwork/ 各自独立", () => {
  const known = ["opencode", "qwenwork", "globalqwenwork"];
  const a = splitModelId("globalqwenwork/qwork-auto", known);
  assert.equal(a.provider, "globalqwenwork");
  assert.equal(a.raw, "qwork-auto");
  const b = splitModelId("qwenwork/flash", known);
  assert.equal(b.provider, "qwenwork");
  assert.equal(b.raw, "flash");
});

test("分类与门禁：local-only + auth 号型（无 baseUrl 也须启用）", () => {
  assert.equal(classifyProvider("globalqwenwork"), "local-only");
  assert.ok(AUTH_DOC_PROVIDER_IDS.includes("globalqwenwork"), "漏加则 provider 被静默跳过（qoder 旧坑）");
});

test("mapModel：国际站池 + 常用别名", () => {
  assert.equal(mapModel("qwork-auto"), "qwork-auto");
  assert.equal(mapModel(""), "qwork-auto");
  assert.equal(mapModel("auto"), "qwork-auto");
  assert.equal(mapModel("flash"), "qwork-auto");
  assert.equal(mapModel("pro"), "qwork-advanced");
  assert.equal(mapModel("qwork-advanced"), "qwork-advanced");
});

test("buildBody：request_id 三同、stream 恒 true、system 抽到顶层", () => {
  const b = JSON.parse(buildBody({ model: "qwork-auto", messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] }, "qwork-auto"));
  assert.equal(b.request_id, b.request_set_id);
  assert.equal(b.request_id, b.chat_record_id);
  assert.equal(b.stream, true);
  assert.equal(b.system, "S");
  assert.ok(!b.messages.some((m) => m.role === "system"), "system 不得留在 messages");
  assert.equal(b.parameters.max_tokens, 32000);
  assert.equal(b.model_config.key, "qwork-auto");
  assert.equal(b.model_config.is_reasoning, false, "国际站两模型均非 reasoning");
});

test("accountFromBlob：双形状兼容", () => {
  assert.equal(accountFromBlob(BLOB)?.accessToken, "dt-fake");
  assert.equal(accountFromBlob(JSON.stringify({ accessToken: "x" }))?.accessToken, "x");
  assert.equal(accountFromBlob("not-json"), null);
});

test("无号 → 401 提示 globalqwenwork login（不与 cn 提示串台）", async () => {
  process.env.MSLXDFF_TEST = "1";
  try {
    const p = createGlobalQwenworkProvider({ apiKeys: [] });
    const res = await p.chat({ model: "globalqwenwork/qwork-auto", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.match(j.error.message, /globalqwenwork login/);
  } finally {
    delete process.env.MSLXDFF_TEST;
  }
});

test("401 + 有 refresh → 刷新后同号重试（refresh 端点与 cn 同形状）", async () => {
  let chatCalls = 0;
  const seen = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("userinfo")) return new Response(JSON.stringify({ id: "uid-9", name: "n" }), { status: 200 });
    if (u.includes("deviceToken/refresh")) {
      assert.equal(JSON.parse(opts.body).refresh_token, "drt-fake", "国际站 refresh 须收 cn 原形状 {refresh_token}");
      assert.ok(u.includes("gateway.qwenwork.ai"), "refresh 必须打 .ai 而非 .cn");
      return new Response(JSON.stringify({ token: "dt-new", refresh_token: "drt-new" }), { status: 200 });
    }
    chatCalls++;
    if (chatCalls === 1) return new Response("unauthorized", { status: 401 });
    return new Response(sseBody([chunkFrame("retry-ok")]), { status: 200 });
  };
  const p = createGlobalQwenworkProvider({ apiKeys: [BLOB], fetchImpl });
  const res = await p.chat({ model: "qwork-advanced", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, "retry-ok");
  assert.equal(chatCalls, 2);
  assert.ok(seen.every((u) => !u.includes("gateway.qwenwork.cn")), "任何请求都不得漏打到 cn 站");
});
test("额度耗尽 → 429 quota_exhausted（全号耗尽收口头为 -quota-exhausted）", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("userinfo")) return new Response(JSON.stringify({ id: "uid-q", name: "n" }), { status: 200 });
    return new Response("credits exhausted", { status: 429 });
  };
  const p = createGlobalQwenworkProvider({ apiKeys: [BLOB], fetchImpl });
  const res = await p.chat({ model: "qwork-auto", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.type, "quota_exhausted");
  assert.equal(res.headers.get("x-mslxdff-globalqwenwork-quota-exhausted"), "1");
});

test("listModels：上游失败时用 2 个国际站快照兜底且带前缀", async () => {
  const fetchImpl = async () => new Response("bad", { status: 500 });
  const p = createGlobalQwenworkProvider({ apiKeys: [BLOB], fetchImpl });
  const list = await p.listModels();
  assert.equal(list.length, 2);
  assert.ok(list.every((m) => m.id.startsWith("globalqwenwork/")));
  assert.ok(list.every((m) => m.owned_by === "globalqwenwork"));
});
