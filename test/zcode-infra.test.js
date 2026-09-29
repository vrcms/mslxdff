// zcode 基础设施单测（const / auth / headers / account-store）— TDD 先行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ZCODE_MESSAGES_URL,
  ZCODE_START_PLAN_MODELS,
  ZCODE_MODEL_CATALOG,
  zcodeAppVersion,
  zcodeErrorKind,
  canonicalZcodeModel,
} from "../src/providers/zcode/const.js";
import { decodeJwtPayload, isJwtExpired, tokenFingerprint } from "../src/providers/zcode/auth.js";
import { buildZcodeHeaders, osCategory } from "../src/providers/zcode/headers.js";
import { saveZcodeAccount, listZcodeAccountDocs, ensureZcodeDeviceMid } from "../src/providers/zcode/account-store.js";

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const fakeJwt = (payload) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.${"s".repeat(32)}`;

test("const: 网关地址与目录常量", () => {
  assert.equal(ZCODE_MESSAGES_URL, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
  assert.deepEqual(ZCODE_START_PLAN_MODELS, ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]);
  assert.ok(ZCODE_MODEL_CATALOG.includes("GLM-5.3"));
  assert.ok(ZCODE_MODEL_CATALOG.includes("GLM-5.3-Flash"));
});

test("const: 版本默认 3.11.2，env 可覆盖", () => {
  assert.equal(zcodeAppVersion({}), "3.11.2");
  assert.equal(zcodeAppVersion({ MSLXDFF_ZCODE_APP_VERSION: "9.9.9" }), "9.9.9");
  assert.equal(zcodeAppVersion({ MSLXDFF_ZCODE_APP_VERSION: "  " }), "3.11.2");
});

test("const: 业务码分类", () => {
  assert.equal(zcodeErrorKind(1005), "quota");
  assert.equal(zcodeErrorKind(401), "auth");
  assert.equal(zcodeErrorKind(1006), "auth");
  assert.equal(zcodeErrorKind(3002), "rate_limit");
  assert.equal(zcodeErrorKind(3008), "rate_limit");
  assert.equal(zcodeErrorKind(3007), "security");
  assert.equal(zcodeErrorKind(2007), "server");
  assert.equal(zcodeErrorKind(99999), "unknown");
});

test("const: canonical 模型 id 大小写归一", () => {
  assert.equal(canonicalZcodeModel("zcode/glm-5.3-flash"), "GLM-5.3-Flash");
  assert.equal(canonicalZcodeModel("glm-5.2"), "GLM-5.2");
  assert.equal(canonicalZcodeModel("custom-x"), "custom-x");
});

test("auth: JWT 解析/过期/指纹", () => {
  const expired = fakeJwt({ exp: 1700000000 });
  const fresh = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(decodeJwtPayload(expired)?.exp, 1700000000);
  assert.equal(isJwtExpired(expired), true);
  assert.equal(isJwtExpired(fresh), false);
  assert.equal(decodeJwtPayload("not-a-jwt"), null);
  assert.equal(isJwtExpired("not-a-jwt"), false, "无法解析时不误判过期");
  assert.equal(tokenFingerprint(fresh), fresh.slice(0, 8));
  assert.equal(tokenFingerprint(""), "");
});

test("headers: 12 项 source headers + Authorization，字段与官方同形", () => {
  const h = buildZcodeHeaders({ token: fakeJwt({ exp: 99 }), version: "3.11.2", deviceMid: "mid-1", lang: "zh-CN", tz: "Asia/Shanghai", platform: "win32", arch: "x64", osVersion: "10.0.26100", requestId: "req-1" });
  assert.equal(h["User-Agent"], "ZCode/3.11.2");
  assert.equal(h["HTTP-Referer"], "https://zcode.z.ai");
  assert.equal(h["X-Title"], "Z Code@electron");
  assert.equal(h["X-ZCode-App-Version"], "3.11.2");
  assert.equal(h["X-Platform"], "win32-x64");
  assert.equal(h["X-Release-Channel"], "stable");
  assert.equal(h["X-Client-Language"], "zh-CN");
  assert.equal(h["X-Client-Timezone"], "Asia/Shanghai");
  assert.equal(h["X-Os-Category"], "windows");
  assert.equal(h["X-Os-Version"], "10.0.26100");
  assert.equal(h["X-Device-Mid"], "mid-1");
  assert.equal(h["x-request-id"], "req-1");
  assert.match(h["Authorization"], /^Bearer eyJ/);
});

test("headers: 无 token 不出 Authorization；无 deviceMid 省略该头；非 ASCII 值被剔除", () => {
  const h = buildZcodeHeaders({ version: "3.11.2", platform: "darwin", arch: "arm64", osVersion: "", lang: "zh-CN", tz: "UTC" });
  assert.equal(h["Authorization"], undefined);
  assert.equal(h["X-Device-Mid"], undefined);
  assert.equal(h["X-Os-Version"], undefined, "空 osVersion 省略");
  const h2 = buildZcodeHeaders({ version: "3.11.2", deviceMid: "中文设备", platform: "linux", arch: "x64" });
  assert.equal(h2["X-Device-Mid"], undefined, "非 ASCII mid 应被剔除而不是抛错");
  assert.ok(h2["x-request-id"], "缺省 request-id 自动生成");
  assert.equal(osCategory("darwin"), "macos");
  assert.equal(osCategory("win32"), "windows");
  assert.equal(osCategory("linux"), "linux");
});

test("account-store: 落盘 0600 + 目录可发现 + state 同步", async () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-acc-"));
  const dir = join(root, "auths");
  const file = join(root, "state.json");
  try {
    const jwt = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const saved = await saveZcodeAccount({ uid: "u1", jwt, name: "小明", email: "a@b.c", provider: "zai", dir, file });
    assert.ok(existsSync(saved.file), "账号文件已落盘");
    if (process.platform !== "win32") assert.equal(statSync(saved.file).mode & 0o777, 0o600);
    const docs = listZcodeAccountDocs({ dirs: [dir] });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].uid, "u1");
    assert.equal(docs[0].jwt, jwt);
    const st = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(st.providerConfigs.zcode.keys, [jwt], "state keys 同步");

    // 二次登录同 uid：不重复 key
    await saveZcodeAccount({ uid: "u1", jwt, name: "小明", provider: "zai", dir, file });
    const st2 = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(st2.providerConfigs.zcode.keys, [jwt]);

    // deviceMid 生成并持久复用
    const mid1 = ensureZcodeDeviceMid({ uid: "u1", dir });
    const mid2 = ensureZcodeDeviceMid({ uid: "u1", dir });
    assert.ok(mid1 && mid1.length >= 8, "mid 已生成");
    assert.equal(mid1, mid2, "二次调用返回同值");
    const doc = JSON.parse(readFileSync(saved.file, "utf8"));
    assert.equal(doc.auth.deviceMid, mid1, "mid 持久化在账号文档");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
