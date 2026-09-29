// qwenwork 单测：签名底座（vendored 原作者实现）。不碰网络，只验结构与拼接顺序。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { signHeaders } from "../src/providers/qwenwork/cosy.js";
import { MODELS_URL, CHAT_URL } from "../src/providers/qwenwork/constants.js";

const ACC = { uid: "u-test-1", nickname: "tester", email: "e@x", accessToken: "dt-fake-token-for-shape-test" };

test("authorization 形状: Bearer COSY.<b64>.<md5-32>", () => {
  const h = signHeaders(ACC, "", MODELS_URL, "", "application/json");
  assert.match(h.authorization, /^Bearer COSY\.[A-Za-z0-9+/]+={0,2}\.[0-9a-f]{32}$/);
});

test("五段拼接顺序: payload/cosyKey/date/body/pathSig（错序不复现）", () => {
  const body = JSON.stringify({ hello: "world" });
  const h = signHeaders(ACC, body, CHAT_URL, "flash");
  const rest = h.authorization.slice("Bearer COSY.".length);
  const i = rest.lastIndexOf(".");
  const b64 = rest.slice(0, i);
  const sig = rest.slice(i + 1);
  const ok = createHash("md5").update(`${b64}\n${h["cosy-key"]}\n${h["cosy-date"]}\n${body}\n/api/v2/service/pro/sse/agent_chat_generation`).digest("hex");
  assert.equal(ok, sig);
  const wrong = createHash("md5").update(`${h["cosy-key"]}\n${b64}\n${h["cosy-date"]}\n${body}\n/api/v2/service/pro/sse/agent_chat_generation`).digest("hex");
  assert.notEqual(wrong, sig);
});

test("payloadB64 是标准 base64 且键升序", () => {
  const h = signHeaders(ACC, "", MODELS_URL, "", "application/json");
  const rest = h.authorization.slice("Bearer COSY.".length);
  const b64 = rest.slice(0, rest.lastIndexOf("."));
  const p = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  const keys = Object.keys(p);
  assert.deepEqual(keys, [...keys].sort());
  assert.deepEqual(keys, ["cosyVersion", "ideVersion", "info", "requestId", "version"]);
});

test("19+2 个必需头齐全；有 modelKey 才带 x-model-*", () => {
  const withModel = signHeaders(ACC, "{}", CHAT_URL, "flash");
  assert.equal(withModel["x-model-key"], "flash");
  assert.equal(withModel["x-model-source"], "system");
  const without = signHeaders(ACC, "", MODELS_URL, "", "application/json");
  assert.ok(!("x-model-key" in without));
  for (const k of ["cosy-version", "cosy-clienttype", "cosy-business-product", "cosy-business-type", "cosy-scene", "cosy-machineos", "login-version", "cosy-key", "cosy-user", "cosy-date", "cosy-machineid", "x-qwenwork-version", "x-qwenwork-release-version", "x-qwenwork-build", "user-agent"]) {
    assert.ok(withModel[k], `缺头 ${k}`);
  }
  assert.equal(withModel["cosy-scene"], "qwork");
  assert.equal(withModel["cosy-clienttype"], "6");
  assert.equal(withModel["cosy-business-product"], "qoder_work");
});

test("cosyKey 是 128B 密文的 base64（172 字符）", () => {
  const h = signHeaders(ACC, "", MODELS_URL, "", "application/json");
  assert.equal(h["cosy-key"].length, 172);
});

test("空 accessToken 直接抛错（不签空会话）", () => {
  assert.throws(() => signHeaders({ uid: "x" }, "", MODELS_URL, "", "application/json"), /empty access token/);
});
