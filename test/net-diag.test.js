import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, describeErrorText } from "../src/net-diag.js";

test("01 裸 Error：无 code，summary 回落到 name + message", () => {
  const d = describeError(new Error("boom"));
  assert.equal(d.code, "");
  assert.equal(d.name, "Error");
  assert.equal(d.summary, "Error — boom");
});

test("02 fetch failed + cause ECONNREFUSED：展开 cause、带 peer 地址", () => {
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED", address: "1.2.3.4", syscall: "connect" }),
  });
  const d = describeError(err);
  assert.equal(d.code, "ECONNREFUSED");
  assert.equal(d.addr, "1.2.3.4");
  assert.equal(d.syscall, "connect");
  assert.match(d.summary, /ECONNREFUSED/);
  assert.match(d.summary, /连接被拒绝/);
  assert.match(d.summary, /peer=1\.2\.3\.4/);
});

test("03 嵌套 cause（两层）：取到最深的 ENOTFOUND", () => {
  const err = { message: "fetch failed", cause: { message: "socket", cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND nope.invalid" } } };
  const d = describeError(err);
  assert.equal(d.code, "ENOTFOUND");
  assert.match(d.summary, /DNS 解析失败/);
});

test("04 undici 超时类：name 当 code、中文短语对得上", () => {
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Headers Timeout Error"), { name: "HeadersTimeoutError", code: "UND_ERR_HEADERS_TIMEOUT" }),
  });
  const d = describeError(err);
  assert.equal(d.code, "UND_ERR_HEADERS_TIMEOUT");
  assert.match(d.summary, /等响应头超时/);
});

test("05 网络不可达 ENETUNREACH", () => {
  const err = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }) });
  const d = describeError(err);
  assert.equal(d.code, "ENETUNREACH");
  assert.match(d.summary, /网络不可达/);
});

test("06 非 Error 值不炸", () => {
  assert.doesNotThrow(() => describeError("just a string"));
  assert.doesNotThrow(() => describeError(undefined));
  assert.doesNotThrow(() => describeError(null));
  assert.equal(typeof describeErrorText(new Error("x")), "string");
});

test("07 addr 可从 message 里兜底提取 IP", () => {
  const err = { message: "connect failed 10.0.0.9:8989", cause: { code: "ETIMEDOUT", message: "connect ETIMEDOUT 10.0.0.9:8989" } };
  const d = describeError(err);
  assert.equal(d.code, "ETIMEDOUT");
  assert.equal(d.addr, "10.0.0.9:8989");
  assert.match(d.summary, /连接超时/);
});
