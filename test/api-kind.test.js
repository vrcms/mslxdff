// 入站协议门短码（api kind）：唯一判定函数的口径锁。
// 集合封闭 = chat|messages|responses|other；认不出的路必须是 other，绝不能是空/undefined。
import { test } from "node:test";
import assert from "node:assert/strict";

import { apiKindOf, apiKindOfUrl, API_KINDS } from "../src/api-kind.js";
import { withBody } from "../src/routes/responses-route.js";

test("api-kind: 三道门各归其码（query 与子路径不许把门洗掉）", () => {
  assert.equal(apiKindOfUrl("/v1/chat/completions"), "chat");
  assert.equal(apiKindOfUrl("/v1/responses"), "responses");
  assert.equal(apiKindOfUrl("/v1/responses?x=1"), "responses");
  assert.equal(apiKindOfUrl("/v1/messages"), "messages");
  assert.equal(apiKindOfUrl("/v1/messages?beta=true"), "messages");
  assert.equal(apiKindOfUrl("/v1/messages/count_tokens"), "messages");
});

test("api-kind: 前缀相似的路不得串门", () => {
  assert.equal(apiKindOfUrl("/v1/messagesXYZ"), "other");   // 不是 /v1/messages 的子段
  assert.equal(apiKindOfUrl("/v1/chat/completions/extra"), "chat");
  assert.equal(apiKindOfUrl("/v2/messages"), "other");
  assert.equal(apiKindOfUrl(""), "other");
  assert.equal(apiKindOfUrl("/"), "other");
});

test("api-kind: 无 url / 非字符串一律 other（不抛、不返回 undefined）", () => {
  for (const v of [undefined, null, "", 42, {}, [], true]) {
    assert.equal(apiKindOfUrl(v), "other", `url=${JSON.stringify(v)}`);
  }
  assert.equal(apiKindOf(undefined), "other");
  assert.equal(apiKindOf({}), "other");
});

test("api-kind: 从 req 读 url，且 withBody 的门面克隆不得丢门", () => {
  assert.equal(apiKindOf({ url: "/v1/messages" }), "messages");
  // /v1/responses 与 /v1/messages 外壳都用 withBody 造 fakeReq 喂 pipeline：它若丢掉 url，门就会当场退化成 other
  assert.equal(apiKindOf(withBody({ url: "/v1/messages?beta=true" }, { model: "acme/m" })), "messages");
  assert.equal(apiKindOf(withBody({ url: "/v1/responses" }, { model: "acme/m" })), "responses");
  assert.equal(apiKindOf(withBody({ url: "/v1/chat/completions" }, { model: "acme/m" })), "chat");
});

test("api-kind: 短码集合封闭——新增一门必须显式改这里", () => {
  assert.deepEqual([...API_KINDS].sort(), ["chat", "messages", "other", "responses"]);
});
