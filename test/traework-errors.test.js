// traework 错误分类单测：Classify 各分支 + SOLOStreamError.kind。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, ErrKind, SOLOStreamError, isSessionDead } from "../src/providers/traework/errors.js";
import { normalizeExpiresAt as normExp } from "../src/providers/traework/token.js";

describe("traework errors", () => {
  test("1005 → plan_limit（两种写法）", () => {
    assert.equal(classify(200, '{"code":1005,"message":"plan exhausted"}'), ErrKind.PLAN_LIMIT);
    assert.equal(classify(403, "error 1005 plan limit"), ErrKind.PLAN_LIMIT);
  });
  test("401 → session_dead", () => {
    assert.equal(classify(401, "anything"), ErrKind.SESSION_DEAD);
    assert.equal(classify(401, ""), ErrKind.SESSION_DEAD);
  });
  test("429 → soft_rate；404 → not_found；5xx → server；其余 4xx → client", () => {
    assert.equal(classify(429, ""), ErrKind.SOFT_RATE);
    assert.equal(classify(404, ""), ErrKind.NOT_FOUND);
    assert.equal(classify(500, ""), ErrKind.SERVER);
    assert.equal(classify(503, ""), ErrKind.SERVER);
    assert.equal(classify(400, ""), ErrKind.CLIENT);
    assert.equal(classify(403, "forbidden"), ErrKind.CLIENT);
  });
  test("2xx → none", () => {
    assert.equal(classify(200, ""), ErrKind.NONE);
  });
  test("isSessionDead：401 恒真；标记匹配", () => {
    assert.equal(isSessionDead(401, ""), true);
    assert.equal(isSessionDead(200, "token invalid"), true);
    assert.equal(isSessionDead(200, "ok"), false);
  });
  test("SOLOStreamError.kind：1005 → plan_limit，其余 → client", () => {
    assert.equal(new SOLOStreamError(1005, "x").kind(), ErrKind.PLAN_LIMIT);
    assert.equal(new SOLOStreamError(500, "x").kind(), ErrKind.CLIENT);
  });
  test("normalizeExpiresAt：毫秒→秒，秒不变", () => {
    assert.equal(normExp(1786847930141), 1786847930);
    assert.equal(normExp(1786847930), 1786847930);
  });
});
