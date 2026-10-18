// raccoon 出站头 / 账号落盘 / 扫码登录状态机 / 信封解析 的单测。
// 全程注入 fetchImpl 与临时目录，不碰真实上游、不碰真实 state。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raccoonAuthHeaders } from "../src/providers/raccoon/headers.js";
import {
  writeRaccoonAccountFile,
  readRaccoonAccountDoc,
  saveRaccoonAccount,
  ensureRaccoonDeviceId,
} from "../src/providers/raccoon/account-store.js";
import {
  createQrSession,
  buildQrUrl,
  cancelQrSession,
  pollQrLoginOnce,
  pollQrLogin,
  refreshRaccoonCredential,
} from "../src/providers/raccoon/login.js";
import { parseRaccoonEnvelope, isRaccoonAuthFailure, isRaccoonOk } from "../src/providers/raccoon/envelope.js";

const tmpDir = () => mkdtempSync(join(tmpdir(), "mslxdff-raccoon-"));
const jsonResponse = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
const dataResp = (data) => async () => jsonResponse({ code: 0, message: "success", data });

test("headers: 字段与 pack.js raccoonHeaders 一一对应；device_id 为空则不发", () => {
  const h = raccoonAuthHeaders({ access_token: "tok", office_identity: "" }, { env: {} });
  assert.equal(h.Authorization, "Bearer tok");
  assert.equal(h["X-Org-Code"], "");
  assert.equal(h["X-Raccoon-Language"], "zh");
  assert.equal(h["X-Client-Platform"], "desktop-windows");
  assert.equal(h["X-Client-Version"], "v1.0.35");
  assert.equal(h["User-Agent"], "Raccoon Work/1.0.35 (Windows)");
  assert.equal(h["Content-Type"], "application/json");
  assert.ok(!("X-Client-Device-ID" in h), "device_id 为空时不应发该头");
  const h2 = raccoonAuthHeaders({ access_token: "tok", device_id: "dev-1" }, { env: {} });
  assert.equal(h2["X-Client-Device-ID"], "dev-1");
});

test("headers: 版本走 env 可配，UA 版本段去 v 前缀", () => {
  const h = raccoonAuthHeaders({ access_token: "t" }, { env: { MSLXDFF_RACCOON_CLIENT_VERSION: "v2.5.0" } });
  assert.equal(h["X-Client-Version"], "v2.5.0");
  assert.equal(h["User-Agent"], "Raccoon Work/2.5.0 (Windows)");
});

test("account-store: 落盘可读回、权限 0600（POSIX）、device_id 持久复用", () => {
  const dir = tmpDir();
  try {
    const fp = writeRaccoonAccountFile({ uid: "u1", accessToken: "tok", deviceId: "dev" }, { dir });
    const doc = JSON.parse(readFileSync(fp, "utf8"));
    assert.equal(doc.auth.access_token, "tok");
    assert.equal(doc.auth.device_id, "dev");
    if (process.platform !== "win32") assert.equal(statSync(fp).mode & 0o777, 0o600);
    assert.equal(ensureRaccoonDeviceId({ uid: "u1", dir }), "dev");
    const fp2 = writeRaccoonAccountFile({ uid: "u1", accessToken: "tok2", deviceId: ensureRaccoonDeviceId({ uid: "u1", dir }) }, { dir });
    assert.equal(fp2, fp);
    assert.equal(readRaccoonAccountDoc("u1", { dir }).auth.access_token, "tok2");
    assert.equal(readRaccoonAccountDoc("u1", { dir }).auth.device_id, "dev");
    assert.equal(readRaccoonAccountDoc("nobody", { dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account-store: saveRaccoonAccount 以 auths 文档为准**覆盖** keys，换 token 不留死号，且不丢 allowlist", async () => {
  const dir = tmpDir();
  const sf = join(dir, "state.json");
  try {
    await saveRaccoonAccount({ uid: "u1", accessToken: "tok1", dir, file: sf });
    const { loadProviderConfig, saveProviderConfig } = await import("../src/state.js");
    const cur = loadProviderConfig("raccoon", { file: sf });
    saveProviderConfig("raccoon", { ...cur, allowedModels: ["sn-kimi-k3"] }, { file: sf });
    const r = await saveRaccoonAccount({ uid: "u1", accessToken: "tok2", dir, file: sf });
    const cfg = loadProviderConfig("raccoon", { file: sf });
    // 旧实现是「只增不减」→ tok1 永久留在池里；token 约 3 小时一换，ring 会反复选中已作废的号撞 401
    assert.deepEqual(cfg.keys, ["tok2"], "keys 必须等于各号文档里的当前 token，不多不少");
    assert.deepEqual(cfg.allowedModels, ["sn-kimi-k3"], "allowlist 不应被 keys 重建抹掉");
    assert.equal(r.keys, 1);
    assert.equal(r.updated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account-store: 多号各留一个 token；syncRaccoonKeys 能把分叉的 keys 自愈回文档值", async () => {
  const dir = tmpDir();
  const sf = join(dir, "state.json");
  try {
    const { syncRaccoonKeys, writeRaccoonAccountFile } = await import("../src/providers/raccoon/account-store.js");
    const { loadProviderConfig } = await import("../src/state.js");
    await saveRaccoonAccount({ uid: "uA", accessToken: "tokA", dir, file: sf });
    await saveRaccoonAccount({ uid: "uB", accessToken: "tokB", dir, file: sf });
    assert.deepEqual([...loadProviderConfig("raccoon", { file: sf }).keys].sort(), ["tokA", "tokB"], "覆盖式同步不能误删别的号");
    // 复现线上现场：provider 续期只回写了账号文档，keys 还停在作废的旧 token 上
    writeRaccoonAccountFile({ uid: "uA", accessToken: "tokA-new", refreshToken: "r", expiresAt: "9" }, { dir });
    const out = await syncRaccoonKeys({ dirs: [dir], file: sf });
    assert.equal(out.changed, true);
    assert.equal(out.dropped, 1, "被续期作废的旧 token 该被剔除");
    assert.deepEqual([...loadProviderConfig("raccoon", { file: sf }).keys].sort(), ["tokA-new", "tokB"]);
    const again = await syncRaccoonKeys({ dirs: [dir], file: sf });
    assert.equal(again.changed, false, "幂等：已一致就不该反复写盘");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login: createQrSession 用服务端签发的 code/scan_path，URL 带 source=platform", async () => {
  // 2026-10 上游改版后的真实响应形状（本机实测）
  const resp = async () => jsonResponse({
    code: "OK",
    message: "success",
    data: { expires_in: 300, poll_interval: 2, qrcode_code: "qr-abc123", scan_path: "/login/mp", status: "pending" },
  });
  const s = await createQrSession({ fetchImpl: resp });
  assert.equal(s.qrcodeCode, "qr-abc123");
  assert.equal(s.scanPath, "/login/mp");
  assert.equal(s.expiresInMs, 300_000);
  assert.equal(s.pollIntervalMs, 2000);
  assert.ok(s.qrUrl.includes("code=qr-abc123"));
  assert.ok(s.qrUrl.includes("source=platform"), "新版网关按 source 区分扫码来源，缺了会被判非法码");
  assert.ok(s.qrUrl.includes(encodeURIComponent("商汤小浣熊官网")));
});

test("login: createQrSession 缺 qrcode_code 必须抛错，绝不降级出自造码", async () => {
  const noCode = async () => jsonResponse({ code: "OK", data: { expires_in: 300, poll_interval: 2, scan_path: "/login/mp" } });
  await assert.rejects(() => createQrSession({ fetchImpl: noCode }), /qrcode_code/);
  const failed = async () => jsonResponse({ code: "SOMETHING_ELSE", message: "boom" });
  await assert.rejects(() => createQrSession({ fetchImpl: failed }), /签发失败/);
});

test("login: raccoonQrPageUrl 只接受站内相对 scan_path（防被响应带着跳外站）", () => {
  assert.ok(buildQrUrl("c", "/login/mp").startsWith("https://xiaohuanxiong.com/login/mp?"));
  for (const evil of ["//evil.com/x", "https://evil.com/x", "/a\\b", "/a b", ""]) {
    assert.ok(buildQrUrl("c", evil).startsWith("https://xiaohuanxiong.com/login/mp?"), `拒绝非法 scan_path: ${evil}`);
  }
});

test("login: cancelQrSession 走 PUT 且吞掉失败（取消是礼貌动作）", async () => {
  let seen = null;
  const ok = async (url, init) => { seen = { url, init }; return jsonResponse({ code: "OK" }); };
  await cancelQrSession("qr-1", { fetchImpl: ok });
  assert.equal(seen.init.method, "PUT");
  assert.equal(JSON.parse(seen.init.body).status, "canceled");
  const boom = async () => { throw new Error("net down"); };
  await cancelQrSession("qr-1", { fetchImpl: boom }); // 不应抛
});

test("login: pollQrLoginOnce 四态 + 网络异常折 pending + 缺 token 不算成功", async () => {
  assert.equal((await pollQrLoginOnce("c", { fetchImpl: dataResp({ status: "pending" }) })).status, "pending");
  const logging = await pollQrLoginOnce("c", { fetchImpl: dataResp({ status: "logging", expired_at: "2026-01-01" }) });
  assert.equal(logging.status, "logging");
  assert.equal(logging.expiredAt, "2026-01-01");
  assert.equal((await pollQrLoginOnce("c", { fetchImpl: dataResp({ status: "canceled" }) })).status, "canceled");
  const ok = await pollQrLoginOnce("c", { fetchImpl: dataResp({ status: "success", access_token: "tok", refresh_token: "ref" }) });
  assert.equal(ok.status, "success");
  assert.equal(ok.credential.access_token, "tok");
  assert.equal(ok.credential.refresh_token, "ref");
  const noToken = await pollQrLoginOnce("c", { fetchImpl: dataResp({ status: "success" }) });
  assert.equal(noToken.status, "pending", "success 但缺 access_token 不得当作成功");
  const boom = async () => { throw new Error("net down"); };
  assert.equal((await pollQrLoginOnce("c", { fetchImpl: boom })).status, "pending");
});

test("login: pollQrLogin 走 pending→success；canceled 与 timeout 各自终止", async () => {
  let n = 0;
  const seq = async () => jsonResponse({ code: 0, data: n++ < 2 ? { status: "pending" } : { status: "success", access_token: "tok" } });
  const r = await pollQrLogin("c", { fetchImpl: seq, sleepFn: async () => {} });
  assert.equal(r.status, "success");
  assert.equal(r.credential.access_token, "tok");
  assert.equal(n, 3);

  const cancel = dataResp({ status: "canceled" });
  assert.equal((await pollQrLogin("c", { fetchImpl: cancel, sleepFn: async () => {} })).status, "canceled");

  let t = 0;
  const to = await pollQrLogin("c", { fetchImpl: dataResp({ status: "pending" }), sleepFn: async () => {}, timeoutMs: 5, now: () => (t += 10) });
  assert.equal(to.status, "timeout");
});

test("login: refresh 换 token；缺新 refresh 沿用旧的；401 抛 authExpired", async () => {
  const next = await refreshRaccoonCredential(
    { access_token: "old", refresh_token: "ref" },
    { fetchImpl: dataResp({ access_token: "new-tok" }) },
  );
  assert.equal(next.access_token, "new-tok");
  assert.equal(next.refresh_token, "ref", "上游不返回新 refresh_token 时必须沿用旧的");
  assert.equal(next.access_token.length > 0, true);

  const rotated = await refreshRaccoonCredential(
    { access_token: "old", refresh_token: "ref" },
    { fetchImpl: dataResp({ access_token: "new-tok", refresh_token: "ref2" }) },
  );
  assert.equal(rotated.refresh_token, "ref2");

  const unauth = async () => jsonResponse({ code: 200003, message: "登录已过期" }, 401);
  await assert.rejects(
    () => refreshRaccoonCredential({ access_token: "old", refresh_token: "ref" }, { fetchImpl: unauth }),
    (e) => e.authExpired === true,
  );
});

test("login: IAM 通道（code:\"OK\"）四态照常判定，AUTH_QRCODE_EXPIRED 单列 expired", async () => {
  // 新通道信封：code 是字符串 "OK"，不是数字 0 —— 旧判据 `code !== 0` 会把成功全判成失败
  const iam = (data) => async () => jsonResponse({ code: "OK", message: "success", data });
  assert.equal((await pollQrLoginOnce("c", { fetchImpl: iam({ status: "pending" }) })).status, "pending");
  assert.equal((await pollQrLoginOnce("c", { fetchImpl: iam({ status: "canceled" }) })).status, "canceled");
  const ok = await pollQrLoginOnce("c", { fetchImpl: iam({ status: "success", access_token: "tok", refresh_token: "ref" }) });
  assert.equal(ok.status, "success");
  assert.equal(ok.credential.access_token, "tok");

  // 码被服务端作废：必须报 expired，不能让用户对着一个死码一直等
  const dead = async () => jsonResponse({ code: "AUTH_QRCODE_EXPIRED", message: "二维码已过期" });
  assert.equal((await pollQrLoginOnce("c", { fetchImpl: dead })).status, "expired");
  const polled = await pollQrLogin("c", { fetchImpl: dead, sleepFn: async () => {} });
  assert.equal(polled.status, "expired");
});

test("login: 轮询按服务端下发的 poll_interval 调速", async () => {
  const seen = [];
  let n = 0;
  const seq = async () => {
    n += 1;
    return jsonResponse({
      code: "OK",
      data: n < 2 ? { status: "pending", poll_interval: 5 } : { status: "success", access_token: "tok", poll_interval: 5 },
    });
  };
  const r = await pollQrLogin("c", { fetchImpl: seq, intervalMs: 2000, sleepFn: async (ms) => { seen.push(ms); } });
  assert.equal(r.status, "success");
  assert.equal(seen[0], 5000, "服务端说 5s 就该 5s，不能用本地默认 2s");
});

test("envelope: 200001/200003/401 判为登录态失效，0 与 \"OK\" 都算成功", () => {
  assert.equal(isRaccoonAuthFailure(parseRaccoonEnvelope({ code: 200001 }), 200), true);
  assert.equal(isRaccoonAuthFailure(parseRaccoonEnvelope({ code: 200003 }), 200), true);
  assert.equal(isRaccoonAuthFailure(parseRaccoonEnvelope({ code: 0 }), 401), true);
  assert.equal(isRaccoonAuthFailure(parseRaccoonEnvelope({ code: 0 }), 200), false);
  assert.equal(parseRaccoonEnvelope({ code: 0, data: { status: "pending" } }).data.status, "pending");
  // 两代通道的成功码
  assert.equal(isRaccoonOk(parseRaccoonEnvelope({ code: 0 })), true);
  assert.equal(isRaccoonOk(parseRaccoonEnvelope({ code: "OK" })), true);
  assert.equal(isRaccoonOk(parseRaccoonEnvelope({ code: "AUTH_QRCODE_EXPIRED" })), false);
  assert.equal(isRaccoonOk(parseRaccoonEnvelope({ code: 200003 })), false);
});
