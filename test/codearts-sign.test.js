// codearts SDK-HMAC-SHA256 签名 golden 测试（对齐华为云 AKSKSigner / codearts2api signer.go）。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalUriPath, canonicalQuery, canonicalHeaders, signRequest, sha256Hex, hmacHex } from "../src/providers/codearts/sign.js";

describe("codearts sign", () => {
  test("canonicalUriPath 末尾补斜杠 + 段编码", () => {
    assert.equal(canonicalUriPath("/api/v2/chat/completions"), "/api/v2/chat/completions/");
    assert.equal(canonicalUriPath("/"), "/");
    assert.equal(canonicalUriPath("/v1/agent-center/agents/useragents"), "/v1/agent-center/agents/useragents/");
    // 非 pchar 字符被编码
    assert.equal(canonicalUriPath("/a b/中文"), "/a%20b/%E4%B8%AD%E6%96%87/");
  });

  test("canonicalQuery key/value 排序 + Go 风格空格转 +", () => {
    assert.equal(canonicalQuery(""), "");
    assert.equal(canonicalQuery("offset=0&limit=100&is_primary_agent=true"), "is_primary_agent=true&limit=100&offset=0");
    assert.equal(canonicalQuery("b=2&a=1&a=0"), "a=0&a=1&b=2");
    assert.equal(canonicalQuery("k=hello%20world"), "k=hello+world");
    assert.equal(canonicalQuery("?x=1"), "x=1");
  });

  test("canonicalHeaders 全头小写排序 + SignedHeaders 分号串", () => {
    const { canonical, signed } = canonicalHeaders({ "Content-Type": "application/json", Accept: " text/event-stream " });
    assert.equal(signed, "accept;content-type");
    assert.equal(canonical, "accept:text/event-stream\ncontent-type:application/json\n");
  });

  test("signRequest golden：fixed now 下 canonical/stringToSign/authorization 可复算", () => {
    const now = new Date("2026-09-15T08:15:30Z");
    const body = JSON.stringify({ hello: "world" });
    const url = "https://example.com/api/v2/chat/completions?b=2&a=1";
    const cred = { accessKeyId: "AKTEST", secretAccessKey: "SKTEST", securityToken: "TOKEN" };
    const { headers, stringToSign, canonicalRequest } = signRequest({
      method: "post",
      url,
      headers: { "content-type": "application/json", accept: "text/event-stream", "maas_type": "benefit" },
      body,
      cred,
      now,
    });

    const payloadHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
    const expectedCanonical = [
      "POST",
      "/api/v2/chat/completions/",
      "a=1&b=2",
      "accept:text/event-stream\ncontent-type:application/json\nhost:example.com\nmaas_type:benefit\nx-sdk-content-sha256:" + payloadHash + "\nx-sdk-date:20260915T081530Z\nx-security-token:TOKEN\n",
      "accept;content-type;host;maas_type;x-sdk-content-sha256;x-sdk-date;x-security-token",
      payloadHash,
    ].join("\n");
    const expectedSTS = ["SDK-HMAC-SHA256", "20260915T081530Z", crypto.createHash("sha256").update(expectedCanonical, "utf8").digest("hex")].join("\n");
    const expectedSig = crypto.createHmac("sha256", "SKTEST").update(expectedSTS, "utf8").digest("hex");

    assert.equal(canonicalRequest, expectedCanonical);
    assert.equal(stringToSign, expectedSTS);
    assert.match(headers.authorization, /^SDK-HMAC-SHA256 Access=AKTEST, SignedHeaders=accept;content-type;host;maas_type;x-sdk-content-sha256;x-sdk-date;x-security-token, Signature=[0-9a-f]{64}$/);
    assert.ok(headers.authorization.endsWith(expectedSig));
    assert.equal(headers["x-sdk-date"], "20260915T081530Z");
    assert.equal(headers["x-sdk-content-sha256"], payloadHash);
    assert.equal(headers["x-security-token"], "TOKEN");
    assert.equal(headers.host, undefined); // host 不透传给 fetch（HTTP 客户端自发）
  });

  test("无 securityToken 时不带 x-security-token 且不进 SignedHeaders", () => {
    const { headers } = signRequest({ method: "GET", url: "https://example.com/v1/model/builtin", headers: { "content-type": "application/json" }, body: "", cred: { accessKeyId: "A", secretAccessKey: "S" }, now: new Date("2026-09-15T08:15:30Z") });
    assert.equal(headers["x-security-token"], undefined);
    assert.ok(!headers.authorization.includes("x-security-token"));
  });

  test("sha256Hex/hmacHex 与 node:crypto 一致", () => {
    assert.equal(sha256Hex("hello"), crypto.createHash("sha256").update("hello").digest("hex"));
    assert.equal(hmacHex("k", "m"), crypto.createHmac("sha256", "k").update("m").digest("hex"));
  });
});
