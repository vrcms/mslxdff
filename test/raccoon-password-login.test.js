// raccoon 密码登录（协议层 + CLI 分派）单测。全程注入 fetchImpl 与临时目录，不碰真实上游。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loginRaccoonWithPassword,
  normalizeNationCode,
  normalizePhone,
} from "../src/providers/raccoon/password-login.js";
import { raccoonPasswordLoginUrl, RACCOON_PASSWORD_ERRORS } from "../src/providers/raccoon/const.js";
import { handleRaccoonLogin } from "../src/cli/commands/provider/raccoon-login.js";

const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
const tmpDir = () => mkdtempSync(join(tmpdir(), "mslxdff-raccoon-pw-"));

test("password-login: 端点用 IAM 明文通道，不是需要加密手机号的 web 通道", () => {
  assert.equal(raccoonPasswordLoginUrl(), "https://xiaohuanxiong.com/api/iam/v1/auth/login/password/phone");
  assert.ok(!raccoonPasswordLoginUrl().includes("/api/web/"), "web 通道要求手机号加密（100003），不得走它");
});

test("password-login: nation_code 归一 —— 收 86/+86/数字，拒空与超长", () => {
  assert.equal(normalizeNationCode("86"), "86");
  assert.equal(normalizeNationCode("+86"), "86");
  assert.equal(normalizeNationCode(86), "86");
  assert.equal(normalizeNationCode(" 86 "), "86");
  assert.equal(normalizeNationCode(""), "");
  assert.equal(normalizeNationCode("abc"), "");
  assert.equal(normalizeNationCode("12345"), "", "超 4 位不是合法国家码");
});

test("password-login: 手机号归一去掉空格/连字符/括号", () => {
  assert.equal(normalizePhone("138 0013 8000"), "13800138000");
  assert.equal(normalizePhone("+86-138-0013-8000"), "8613800138000");
  assert.equal(normalizePhone("(138)00138000"), "13800138000");
});

test("password-login: 成功路径 —— 出站体是明文三字段，回来的是 credential 形状", async () => {
  let seenUrl = "";
  let seenBody = null;
  let seenHeaders = null;
  const cred = await loginRaccoonWithPassword(
    { phone: "138 0013 8000", password: "pw-secret", nationCode: "+86" },
    {
      env: {},
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenBody = JSON.parse(init.body);
        seenHeaders = init.headers;
        // 造一个带 exp 的 JWT，验证 expires_at 由 token 推出来
        const payload = Buffer.from(JSON.stringify({ exp: 1893456000 })).toString("base64url");
        return jsonRes({
          code: "OK",
          data: { access_token: `h.${payload}.s`, refresh_token: "rt", office_identity: "personal" },
        });
      },
    },
  );
  assert.equal(seenUrl, "https://xiaohuanxiong.com/api/iam/v1/auth/login/password/phone");
  assert.deepEqual(seenBody, { nation_code: "86", phone: "13800138000", password: "pw-secret" });
  assert.equal(seenHeaders["Content-Type"], "application/json");
  assert.ok(!("Authorization" in seenHeaders), "登录端点匿名可达，不该带 Authorization");
  assert.equal(cred.access_token, `h.${Buffer.from(JSON.stringify({ exp: 1893456000 })).toString("base64url")}.s`);
  assert.equal(cred.refresh_token, "rt");
  assert.equal(cred.office_identity, "personal");
  assert.equal(cred.expires_at, String(1893456000 * 1000), "expires_at 由 JWT exp 推出（秒→毫秒）");
});

test("password-login: 旧 web 信封 code:0 也算成功（两代兼容）", async () => {
  const cred = await loginRaccoonWithPassword(
    { phone: "13800138000", password: "x" },
    { env: {}, fetchImpl: async () => jsonRes({ code: 0, data: { access_token: "tok" } }) },
  );
  assert.equal(cred.access_token, "tok");
});

test("password-login: 密码错 → 码表人话，且错误里绝不出现密码原文", async () => {
  await assert.rejects(
    () => loginRaccoonWithPassword(
      { phone: "13800138000", password: "topsecret" },
      { env: {}, fetchImpl: async () => jsonRes({ code: "AUTH_ACCOUNT_OR_PASSWORD_INVALID", message: "account or password invalid" }, 401) },
    ),
    (err) => {
      assert.match(err.message, /手机号或密码不正确/);
      assert.ok(!err.message.includes("topsecret"), "错误信息不得泄漏密码");
      assert.equal(err.code, "AUTH_ACCOUNT_OR_PASSWORD_INVALID");
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("password-login: 未登记的码透出上游文案，不臆造人话", async () => {
  await assert.rejects(
    () => loginRaccoonWithPassword(
      { phone: "13800138000", password: "x" },
      { env: {}, fetchImpl: async () => jsonRes({ code: "SOME_NEW_CODE", message: "上游新花样" }, 400) },
    ),
    /上游新花样/,
  );
});

test("password-login: 缺 access_token 判失败，不写半截凭据", async () => {
  await assert.rejects(
    () => loginRaccoonWithPassword(
      { phone: "13800138000", password: "x" },
      { env: {}, fetchImpl: async () => jsonRes({ code: "OK", data: { refresh_token: "only" } }) },
    ),
    /缺少 access_token/,
  );
});

test("password-login: 本地校验先于出网 —— 空手机号/空密码/坏国家码都不发请求", async () => {
  let called = 0;
  const boom = { env: {}, fetchImpl: async () => { called += 1; return jsonRes({ code: "OK", data: { access_token: "t" } }); } };
  await assert.rejects(() => loginRaccoonWithPassword({ phone: "", password: "x" }, boom), /手机号不能为空/);
  await assert.rejects(() => loginRaccoonWithPassword({ phone: "13800138000", password: "" }, boom), /密码不能为空/);
  await assert.rejects(() => loginRaccoonWithPassword({ phone: "13800138000", password: "x", nationCode: "zz" }, boom), /国家码不合法/);
  assert.equal(called, 0, "三个本地校验都必须在出网之前拦下");
});

test("password-login: 网络异常给可操作人话，不抛原生 fetch 堆栈", async () => {
  await assert.rejects(
    () => loginRaccoonWithPassword(
      { phone: "13800138000", password: "x" },
      { env: {}, fetchImpl: async () => { throw new Error("ETIMEDOUT"); } },
    ),
    /密码登录请求失败：ETIMEDOUT/,
  );
});

test("CLI: `login --password` 转交密码链路，且不改动扫码路径的分派", async () => {
  const dir = tmpDir();
  try {
    const logs = [];
    const calls = [];
    const ok = await handleRaccoonLogin("raccoon", "login", ["login", "--password", "--phone=13800138000"], {
      dir,
      skipReward: true,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
        if (String(url).includes("login/password/phone")) {
          return jsonRes({ code: "OK", data: { access_token: "tok-pw", refresh_token: "rt" } });
        }
        if (String(url).includes("iam/confirm")) return jsonRes({ code: "OK" });
        if (String(url).includes("user_info")) return jsonRes({ code: "OK", data: { id: "u-pw", name: "小明" } });
        return jsonRes({ code: "OK", data: {} });
      },
      password: "pw-from-deps",
      log: (m) => logs.push(String(m)),
      exit: (code) => { throw new Error(`unexpected exit(${code})`); },
    });
    assert.equal(ok, true);
    const pwCall = calls.find((c) => c.url.includes("login/password/phone"));
    assert.ok(pwCall, "必须打过密码端点");
    assert.deepEqual(pwCall.body, { nation_code: "86", phone: "13800138000", password: "pw-from-deps" });
    assert.ok(calls.some((c) => c.url.includes("iam/confirm")), "登录后必须确认会话（否则业务端点全 400 200901）");
    const text = logs.join("\n");
    assert.match(text, /登录成功/);
    assert.match(text, /密码登录（手机号 \*+8000）/, "回执回显手机号但打码");
    assert.ok(!text.includes("pw-from-deps"), "回执绝不能出现密码");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: 不带 --password 的 login 仍走扫码路径（不误伤）", async () => {
  const dir = tmpDir();
  try {
    const calls = [];
    await handleRaccoonLogin("raccoon", "login", ["login"], {
      dir,
      skipReward: true,
      qrSession: { qrcodeCode: "qr-1", scanPath: "/login/mp", expiresInMs: 1000, pollIntervalMs: 1000 },
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url).includes("mp/qrcode/login")) return jsonRes({ code: "OK", data: { status: "canceled" } });
        return jsonRes({ code: "OK", data: {} });
      },
      log: () => {},
      exit: () => {},
    });
    assert.ok(!calls.some((u) => u.includes("login/password/phone")), "无 --password 时不得走密码链路");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: 密码错时给人话 + 重试指引，并以非零码退出", async () => {
  let exitCode = null;
  const logs = [];
  const ok = await handleRaccoonLogin("raccoon", "login", ["login", "--password"], {
    password: "wrong",
    phone: "13800138000",
    fetchImpl: async () => jsonRes({ code: "AUTH_ACCOUNT_OR_PASSWORD_INVALID" }, 401),
    log: (m) => logs.push(String(m)),
    exit: (c) => { exitCode = c; },
  });
  assert.equal(ok, true);
  assert.equal(exitCode, 1, "登录失败必须以非零码退出");
  const text = logs.join("\n");
  assert.match(text, /手机号或密码不正确/);
  assert.match(text, /可重试：mslxdff -provider raccoon login --password/);
  assert.ok(!text.includes("wrong"), "失败回执不得回显密码");
});

test("const: 码表只放实测见过的码，且都有人话", () => {
  for (const [code, msg] of Object.entries(RACCOON_PASSWORD_ERRORS)) {
    assert.ok(code.length > 0 && msg.length > 0);
  }
  assert.equal(RACCOON_PASSWORD_ERRORS.AUTH_ACCOUNT_OR_PASSWORD_INVALID, "手机号或密码不正确");
});
