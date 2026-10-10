// raccoon 鉴权工具单测：JWT 过期判断三分支、指纹恒 8 字符、uid 归一优先级。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeJwtExpMs,
  isRaccoonExpired,
  isRaccoonExpiringSoon,
  raccoonCredentialExpiresAtMs,
  raccoonTokenFingerprint,
  resolveRaccoonUid,
} from "../src/providers/raccoon/auth.js";

const b64u = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
const fakeJwt = (payload) => `${b64u({ alg: "none" })}.${b64u(payload)}.sig`;

test("decodeJwtExpMs: 合法 JWT 的 exp 转毫秒", () => {
  const exp = 1_800_000_000;
  assert.equal(decodeJwtExpMs(fakeJwt({ exp })), exp * 1000);
});

test("decodeJwtExpMs: 坏格式与缺 exp 返回 undefined", () => {
  assert.equal(decodeJwtExpMs("not-a-jwt"), undefined);
  assert.equal(decodeJwtExpMs(""), undefined);
  assert.equal(decodeJwtExpMs(undefined), undefined);
  assert.equal(decodeJwtExpMs(`${b64u({})}.${b64u({ noExp: 1 })}.s`), undefined);
  assert.equal(decodeJwtExpMs(`${b64u({})}.${b64u({ exp: -1 })}.s`), undefined);
  assert.equal(decodeJwtExpMs(`${b64u({})}.!!!not-base64!!!.s`), undefined);
});

test("isRaccoonExpired: 过期/未过期/拿不到到期时刻三分支", () => {
  const now = 1_800_000_000_000;
  const past = { access_token: fakeJwt({ exp: 1_700_000_000 }) };
  const future = { access_token: fakeJwt({ exp: 1_900_000_000 }) };
  assert.equal(isRaccoonExpired(past, now), true);
  assert.equal(isRaccoonExpired(future, now), false);
  assert.equal(isRaccoonExpired({ access_token: "opaque" }, now), false);
});

test("raccoonCredentialExpiresAtMs: expires_at 字符串优先，秒与毫秒都吃", () => {
  const now = 1_800_000_000_000;
  assert.equal(raccoonCredentialExpiresAtMs({ expires_at: "1800000000", access_token: "x" }), 1_800_000_000_000);
  assert.equal(raccoonCredentialExpiresAtMs({ expires_at: "1800000000000", access_token: "x" }), 1_800_000_000_000);
  assert.equal(raccoonCredentialExpiresAtMs({ access_token: fakeJwt({ exp: 1_900_000_000 }) }), 1_900_000_000_000);
  assert.equal(raccoonCredentialExpiresAtMs({ access_token: "opaque" }), undefined);
  assert.equal(isRaccoonExpired({ expires_at: "1700000000" }, now), true);
});

test("isRaccoonExpiringSoon: 临期提前量生效", () => {
  const now = 1_800_000_000_000;
  const soon = { access_token: fakeJwt({ exp: 1_800_000_030 }) };
  assert.equal(isRaccoonExpiringSoon(soon, now, 60_000), true);
  assert.equal(isRaccoonExpiringSoon(soon, now, 10_000), false);
});

test("raccoonTokenFingerprint: 恒 8 字符且稳定，空输入为空串", () => {
  const fp = raccoonTokenFingerprint("some-token");
  assert.equal(fp.length, 8);
  assert.match(fp, /^[0-9a-f]{8}$/);
  assert.equal(raccoonTokenFingerprint("some-token"), fp);
  assert.equal(raccoonTokenFingerprint(""), "");
});

test("resolveRaccoonUid: userId > officeIdentity > 指纹回退", () => {
  assert.equal(resolveRaccoonUid({ userId: "u1", officeIdentity: "o1", token: "t" }), "u1");
  assert.equal(resolveRaccoonUid({ officeIdentity: "o1", token: "t" }), "o1");
  assert.equal(resolveRaccoonUid({ token: "t" }), raccoonTokenFingerprint("t"));
  assert.notEqual(resolveRaccoonUid({ token: "t" }), "");
});
