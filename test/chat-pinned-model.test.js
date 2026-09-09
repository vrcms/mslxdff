import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../src/chat/orchestrator.js";
import { createEngine } from "../src/chat/engine.js";
import { handleSlash } from "../src/chat/terminal.js";

function fakeOrch({ failModels = [], okModels = [], env = {} } = {}) {
  const calls = [];
  const chatOnce = async (opts) => {
    const model = opts.model || "mimo-v2.5-free";
    calls.push(model);
    if (failModels.includes(model)) return { ok: false, error: `upstream ${model} down`, status: 502 };
    if (okModels.length === 0 || okModels.includes(model)) return { ok: true, message: { role: "assistant", content: `hi from ${model}` }, status: 200 };
    return { ok: false, error: `upstream ${model} down`, status: 502 };
  };
  const orch = createOrchestrator({
    chatOnce,
    chatViaGateway: async () => ({ ok: false, error: "no gateway in test", status: 502 }),
    cooling: { isCooling: async () => false, recordError: async () => {}, recordOk: async () => {} },
    env: { MSLXDFF_CHAT_TRACE: "0", MSLXDFF_HEDGE_DELAY_MS: "0", ...env },
  });
  return { orch, calls };
}

test("严格模式：指定模型成功，只调该模型一次", async () => {
  const { orch, calls } = fakeOrch({ okModels: ["big-pickle"] });
  const r = await orch.chatWithFallback({ messages: [{ role: "user", content: "hi" }], model: "big-pickle" });
  assert.equal(r.ok, true);
  assert.equal(r.model, "big-pickle");
  assert.deepEqual(calls, ["big-pickle"]);
  assert.equal(r.fallback, undefined);
});

test("严格模式：指定模型失败，不降级到 pickle/auto", async () => {
  const { orch, calls } = fakeOrch({ failModels: ["deepseek-v4-flash-free"] });
  const r = await orch.chatWithFallback({ messages: [{ role: "user", content: "hi" }], model: "deepseek-v4-flash-free" });
  assert.equal(r.ok, false);
  assert.equal(r.pinnedModel, "deepseek-v4-flash-free");
  assert.match(r.error, /指定模型 deepseek-v4-flash-free 失败/);
  assert.match(r.error, /不自动换模型/);
  assert.deepEqual(calls, ["deepseek-v4-flash-free"]);
});

test("严格模式：指定 mimo 也严格（不因它冷却/失败切 pickle）", async () => {
  const { orch, calls } = fakeOrch({ failModels: ["mimo-v2.5-free"] });
  const r = await orch.chatWithFallback({ messages: [{ role: "user", content: "hi" }], model: "mimo-v2.5-free" });
  assert.equal(r.ok, false);
  assert.deepEqual(calls, ["mimo-v2.5-free"]);
});

test("默认链不回归：无 model 时 mimo 失败退 pickle", async () => {
  const { orch, calls } = fakeOrch({ failModels: ["mimo-v2.5-free"], okModels: ["big-pickle"] });
  const r = await orch.chatWithFallback({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.ok, true);
  assert.equal(r.model, "big-pickle");
  assert.equal(r.fallback, true);
  assert.deepEqual(calls, ["mimo-v2.5-free", "big-pickle"]);
});

test("opts.model=auto 走默认链（不触发严格模式）", async () => {
  const { orch, calls } = fakeOrch({ failModels: ["mimo-v2.5-free"], okModels: ["big-pickle"] });
  const r = await orch.chatWithFallback({ messages: [{ role: "user", content: "hi" }], model: "auto" });
  assert.equal(r.ok, true);
  assert.equal(r.model, "big-pickle");
  assert.deepEqual(calls, ["mimo-v2.5-free", "big-pickle"]);
});

test("engine：runTurn 第三参透传给 chatWithFallback", async () => {
  const seen = [];
  const engine = createEngine({ chatWithFallback: async (opts) => { seen.push(opts.model ?? null); return { ok: true, message: { content: "ok" } }; } });
  await engine.runTurn("a", [{ role: "user", content: "a" }]);
  await engine.runTurn("b", [{ role: "user", content: "b" }], "big-pickle");
  assert.deepEqual(seen, [null, "big-pickle"]);
});

test("handleSlash /model：非 free 模型拒绝", () => {
  const out = [];
  const orig = console.log;
  console.log = (l) => out.push(String(l));
  try {
    const r = handleSlash("/model glm-5.2", { pinnedModel: null });
    assert.equal(r.handled, true);
    assert.equal("pinnedModel" in r, false);
  } finally { console.log = orig; }
  assert.ok(out.some((l) => l.includes("不在 opencode free 池")));
});

test("handleSlash /model：带供应商前缀一律拒绝（-chat 只支持 opencode 上游）", () => {
  for (const id of ["deepseek/chat-free", "workbuddy/hy3", "clinebot/deepseek/X"]) {
    const out = [];
    const orig = console.log;
    console.log = (l) => out.push(String(l));
    try {
      const r = handleSlash(`/model ${id}`, { pinnedModel: null });
      assert.equal(r.handled, true);
      assert.equal("pinnedModel" in r, false, `${id} 不应被放行`);
    } finally { console.log = orig; }
    assert.ok(out.some((l) => l.includes("只支持 opencode 上游")), id);
  }
});

test("handleSlash /model：deepseek 供应商的 -free 模型也不放行（有前缀）", () => {
  const r = handleSlash("/model deepseek/reasoner-free", { pinnedModel: null });
  assert.equal("pinnedModel" in r, false);
});

test("handleSlash /model：free 模型锁定成功", () => {
  const out = [];
  const orig = console.log;
  console.log = (l) => out.push(String(l));
  try {
    const r = handleSlash("/model nemotron-3.5-lightning-free", { pinnedModel: null });
    assert.equal(r.pinnedModel, "nemotron-3.5-lightning-free");
  } finally { console.log = orig; }
  assert.ok(out.some((l) => l.includes("已锁定")));
});

test("handleSlash /model：big-pickle 特例可锁定", () => {
  const r = handleSlash("/model big-pickle", { pinnedModel: null });
  assert.equal(r.pinnedModel, "big-pickle");
});

test("handleSlash /model auto：解除锁定", () => {
  const r = handleSlash("/model auto", { pinnedModel: "big-pickle" });
  assert.equal(r.pinnedModel, null);
});

test("handleSlash /model：无参显示当前锁定", () => {
  const out = [];
  const orig = console.log;
  console.log = (l) => out.push(String(l));
  try { handleSlash("/model", { pinnedModel: "ling-3.0-flash-fin-free" }); } finally { console.log = orig; }
  assert.ok(out.some((l) => l.includes("当前锁定模型：ling-3.0-flash-fin-free")));
});
