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
  createQrCode,
  buildQrUrl,
  pollQrLoginOnce,
  pollQrLogin,
  refreshRaccoonCredential,
} from "../src/providers/raccoon/login.js";
import { parseRaccoonEnvelope, isRaccoonAuthFailure } from "../src/providers/raccoon/envelope.js";

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

test("login: createQrCode 为 32 位 hex；buildQrUrl 带 code 与 appname", () => {
  const code = createQrCode();
  assert.match(code, /^[0-9a-f]{32}$/);
  const url = buildQrUrl(code);
  assert.ok(url.startsWith("https://xiaohuanxiong.com/login/mp?code="));
  assert.ok(url.includes(`code=${code}`));
  assert.ok(url.includes(encodeURIComponent("商汤小浣熊官网")));
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

test("envelope: 200001/200003/401 判为登录态失效，0 不算", () => {
  assert.equal(isRaccoonAuthFailure(parseRaccoonEnvelope({ code: 200001 }), 200), true);
  assert.equal(isRaccoonAuthFailure(parseRaccoonEnvelope({ code: 200003 }), 200), true);
  assert.equal(isRaccoonAuthFailure(parseRaccoonEnvelope({ code: 0 }), 401), true);
  assert.equal(isRaccoonAuthFailure(parseRaccoonEnvelope({ code: 0 }), 200), false);
  assert.equal(parseRaccoonEnvelope({ code: 0, data: { status: "pending" } }).data.status, "pending");
});
