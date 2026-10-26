// todaycn persona 单测：契约文本幂等（追加/摘除）、人设读写（假 fetch，不触网）、CLI 分发。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TODAYCN_PERSONA_CONTRACT,
  hasPersonaContract,
  withPersonaContract,
  stripPersonaContract,
  readTodaycnPersona,
  applyTodaycnPersona,
  removeTodaycnPersona,
} from "../src/providers/todaycn/persona.js";
import { handleTodaycnPersona } from "../src/cli/commands/provider/todaycn-persona.js";

const BASE_PERSONA = "温暖但直接。回复中不要使用 markdown 格式。";

/** 假上游：GET 回当前人设，PATCH 写回并回读；记录每次调用。 */
function personaFetch({ character = BASE_PERSONA, patchOk = true, onPatch } = {}) {
  let current = character;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url: String(url), method });
    if (!String(url).includes("/v1/agents/default")) return new Response("{}", { status: 404 });
    if (method === "PATCH") {
      const body = JSON.parse(init.body);
      if (onPatch) onPatch(body);
      if (!patchOk) return new Response("nope", { status: 400 });
      current = String(body.agentCharacter ?? "");
      return new Response(JSON.stringify({ agentName: "旺财", agentCharacter: current }), { status: 200 });
    }
    return new Response(JSON.stringify({ agentName: "旺财", agentCharacter: current }), { status: 200 });
  };
  return { fetchImpl, calls, get: () => current };
}

test("契约文本：追加幂等、摘除幂等、只摘自己那一段", () => {
  const once = withPersonaContract(BASE_PERSONA);
  assert.ok(hasPersonaContract(once));
  assert.ok(once.startsWith(BASE_PERSONA), "原人设必须完整保留在契约之前");
  assert.equal(withPersonaContract(once), once, "已含契约时不得重复追加");
  assert.equal(withPersonaContract(""), TODAYCN_PERSONA_CONTRACT);
  assert.equal(stripPersonaContract(once), BASE_PERSONA);
  assert.equal(stripPersonaContract(BASE_PERSONA), BASE_PERSONA, "没人设时摘除应原样返回");
  assert.equal(stripPersonaContract(TODAYCN_PERSONA_CONTRACT), "", "整段就是契约时应摘成空");
  let s = BASE_PERSONA;
  for (let i = 0; i < 5; i += 1) s = withPersonaContract(s);
  assert.equal(stripPersonaContract(s), BASE_PERSONA, "往返 5 次不得漂移");
});

test("readTodaycnPersona：GET 一次并回显 agentName/agentCharacter", async () => {
  const h = personaFetch();
  const r = await readTodaycnPersona({ token: "tok", fetchImpl: h.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.agentName, "旺财");
  assert.equal(r.agentCharacter, BASE_PERSONA);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "GET");
  assert.ok(h.calls[0].url.endsWith("/v1/agents/default"));
});

test("applyTodaycnPersona：先读后写、回读校验；第二次幂等不写盘", async () => {
  let patched = 0;
  const h = personaFetch({ onPatch: () => { patched += 1; } });
  const first = await applyTodaycnPersona({ token: "tok", fetchImpl: h.fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.ok(first.after.includes(TODAYCN_PERSONA_CONTRACT));
  assert.equal(patched, 1);
  const second = await applyTodaycnPersona({ token: "tok", fetchImpl: h.fetchImpl });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(patched, 1, "幂等：第二次不得再写盘");
});

test("removeTodaycnPersona：摘除后回读不含契约；再摘幂等", async () => {
  const h = personaFetch({ character: withPersonaContract(BASE_PERSONA) });
  const first = await removeTodaycnPersona({ token: "tok", fetchImpl: h.fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(h.get(), BASE_PERSONA, "摘除后应还原成原人设");
  const second = await removeTodaycnPersona({ token: "tok", fetchImpl: h.fetchImpl });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
});

test("写入失败（400）如实报错，不谎报成功", async () => {
  const h = personaFetch({ patchOk: false });
  const r = await applyTodaycnPersona({ token: "tok", fetchImpl: h.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.reason, /写入失败/);
});

test("CLI：persona apply 走账号令牌写盘；persona off=rollback；无账号给登录指引", async () => {
  const lines = [];
  const h = personaFetch();
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes("/api/auth/token")) return new Response(JSON.stringify({ token: "tok-1" }), { status: 200 });
    return h.fetchImpl(url, init);
  };
  const exits = [];
  const deps = {
    fetchImpl,
    accounts: [{ uid: "u1", name: "mslxd", refreshCredential: "cred-1", deviceId: "d_1", optionId: "" }],
    log: (m) => lines.push(String(m)),
    exit: (c) => { exits.push(c); },
  };
  assert.equal(await handleTodaycnPersona("todaycn", "persona", ["apply"], deps), true);
  assert.ok(h.get().includes(TODAYCN_PERSONA_CONTRACT));
  assert.ok(lines.some((l) => l.includes("写入完成")));

  assert.equal(await handleTodaycnPersona("todaycn", "persona", ["off"], deps), true);
  assert.equal(h.get(), BASE_PERSONA);

  assert.equal(await handleTodaycnPersona("todaycn", "persona", [], deps), true);
  assert.ok(lines.some((l) => l.includes("契约段是否已写入: 否")));

  const emptyDeps = { ...deps, accounts: [] };
  assert.equal(await handleTodaycnPersona("todaycn", "persona", ["show"], emptyDeps), true);
  assert.deepEqual(exits, [1]);
  assert.ok(lines.some((l) => l.includes("先接入账号")));

  assert.equal(await handleTodaycnPersona("cline", "persona", ["show"], deps), false);
  assert.equal(await handleTodaycnPersona("todaycn", "login", [], deps), false);
});