// traework 市场侧伪设备身份（UG 接口契约）的回归测试。
// 全程不碰网络：fetchImpl 注入假上游并**抓头发给人看**；auth 目录一律走显式 dirs/临时目录，
// 绝不读写 `~/.config/mslxdff/auths/`（那是用户正在用的账号台账）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MSLXDFF_STATE_FILE = join(mkdtempSync(join(tmpdir(), "mslxdff-tw-market-")), "state.json");

const { seededStream, marketDigits, marketSession, marketUuid, marketHexSalted, deriveMarketIdentity, marketUsable, MARKET_DEVICE_ID_DIGITS } = await import("../src/providers/traework/market-identity.js");
const { ugHeaders, ugPlatformTag, ugTraceId } = await import("../src/providers/traework/headers.js");
const { ensureMarketIdentity } = await import("../src/providers/traework/account-store.js");
const { checkinStatus, checkinClaimVerified } = await import("../src/providers/traework/checkin.js");

const UID = "2508405578152720";
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("seeded_stream：空 seed 返 null（不许悄悄退化成随机），且同 seed 恒定", () => {
  assert.equal(seededStream("", "devid", 16), null);
  assert.equal(seededStream(null, "devid", 16), null);
  const a = seededStream(UID, "devid", 16);
  const b = seededStream(UID, "devid", 16);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.equal(a.length, 16);
  // 跨 salt 必须互不相同（否则三件身份会撞成一个）
  assert.notDeepEqual(Array.from(seededStream(UID, "devid", 16)), Array.from(seededStream(UID, "market", 16)));
});

test("x-device-id = 15 位纯十进制（**不是** OAuth 那个 32 位 hex）", () => {
  const d = marketDigits(UID);
  assert.equal(d.length, MARKET_DEVICE_ID_DIGITS, "位数漂了 = 上游按新设备处理，风控会跟上");
  assert.match(d, /^[0-9]+$/);
  // 回归：JS 里 String(48+b%10) 会把码点转成 "49" 两位字符 → 撑成 30 位且首位恒为 4/5
  assert.doesNotMatch(d, /^[45]/, "出现 4/5 开头连排说明又退回 String(48+…) 的错写法");
  assert.equal(marketDigits(UID), marketDigits(UID), "同 uid 必须派生同一台设备");
  assert.notEqual(marketDigits(UID), marketDigits("别的uid"));
});

test("vscode-sessionid = 64 位小写 hex；奇数长度靠截断", () => {
  const s = marketSession(UID);
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.equal(marketSession(UID), s);
  assert.equal(marketHexSalted(7, "sess", "u").length, 7, "奇数 n 必须截到 n 位（口径同参考实现 rand_hex(7)）");
});

test("x-market-user-id = 标准 uuid4 形态（版本位 4 + RFC4122 变体位）", () => {
  for (const uid of [UID, "1234567890123456", "x"]) assert.match(marketUuid(uid), UUID4);
  assert.equal(marketUuid(UID), marketUuid(UID));
});

test("derive/marketUsable：形状齐才算可用，gen 落后必须判不可用（自愈触发条件）", () => {
  const d = deriveMarketIdentity(UID);
  assert.equal(d.gen, 2);
  assert.equal(marketUsable(d), true);
  assert.equal(marketUsable(null), false);
  assert.equal(marketUsable({ ...d, gen: 1 }), false, "旧算法产物必须重建");
  assert.equal(marketUsable({ ...d, deviceId: "494957535756555248515551575352" }), false, "30 位膨胀值不可用");
  assert.equal(marketUsable({ ...d, sessionId: d.sessionId.toUpperCase() }), false, "大写 hex 不合真机形态");
});

test("ugHeaders：UG 三接口共用的 20 件头一件不能少（缺一件就可能回 9004）", () => {
  const h = ugHeaders({ accessToken: "tok", market: deriveMarketIdentity(UID) });
  const need = ["accept", "accept-language", "content-type", "user-agent", "authorization", "x-market-client-id", "x-market-user-id", "x-user-region", "x-device-id", "x-lgw-req-sdk-type", "package-type", "x-request-id", "x-lscbd-aid", "x-lscbd-platform", "app-version", "x-tt-trace-id", "vscode-sessionid", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"];
  for (const k of need) assert.ok(k in h, `缺请求头 ${k}`);
  // 线上契约固定值（出处 NextAgentX/trae-workbuddy-switch credits.rs / mod.rs，改值需先有抓包证据）
  assert.equal(h["user-agent"], "VSCode 1.107.1 (TRAE SOLO CN)");
  assert.equal(h["x-market-client-id"], "VSCode 1.107.1");
  assert.equal(h["x-lscbd-aid"], "787976");
  assert.equal(h["x-lgw-req-sdk-type"], "3");
  assert.equal(h["package-type"], "stable_cn");
  assert.equal(h["x-user-region"], "CN");
  assert.equal(h["app-version"], "0.1.45", "app-version ≠ IDE_VERSION(0.1.43)：两条通道各取各的，别合");
  assert.equal(h["sec-fetch-mode"], "no-cors");
});

test("ugHeaders：authorization 不重复加前缀（曾出现双 Cloud-IDE-JWT）", () => {
  assert.equal(ugHeaders({ accessToken: "abc" }).authorization, "Cloud-IDE-JWT abc");
  assert.equal(ugHeaders({ accessToken: "Cloud-IDE-JWT abc" }).authorization, "Cloud-IDE-JWT abc");
});

test("x-lscbd-platform 按真实平台报，x-tt-trace-id 形如 00-<16hex>-01", () => {
  assert.equal(ugPlatformTag("win32"), "windows");
  assert.equal(ugPlatformTag("darwin"), "macos");
  assert.equal(ugPlatformTag("linux"), "linux");
  assert.match(ugTraceId(() => "11111111-2222-3333-4444-555555555555"), /^00-1111111122223333-01$/);
});

test("ensureMarketIdentity：盘上无档案时只派生不建档；有档案则就地补 market 键且不动凭据", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-tw-auths-"));
  // ① 没有任何档案 → 不该凭空造文件
  const ghost = ensureMarketIdentity(UID, { dirs: [dir] });
  assert.match(ghost.deviceId, /^[0-9]{15}$/);
  assert.equal(existsSync(join(dir, `trae-${UID}.json`)), false, "无账号档案时禁止凭空建文件");
  // ② 有档案 → 补 market 键，account/auth 原样保留
  const fp = join(dir, `trae-${UID}.json`);
  const doc = { account: { uid: UID, enterpriseId: "ent", nickname: "n" }, auth: { accessToken: "AT", refreshToken: "RT", expiresAt: 9999999999, domain: "trae.cn", machineId: "M", deviceId: "D" } };
  writeFileSync(fp, JSON.stringify(doc, null, 2));
  const got = ensureMarketIdentity(UID, { dirs: [dir] });
  const after = JSON.parse(readFileSync(fp, "utf8"));
  assert.deepEqual({ ...after, account: doc.account, auth: doc.auth }, { market: after.market, account: doc.account, auth: doc.auth }, "只准多一个 market 键");
  assert.equal(after.auth.accessToken, "AT", "凭据不许被动到");
  assert.equal(after.market.deviceId, got.deviceId);
  // ③ 二次调用复用盘上身份（不重建），且形状可用
  const again = ensureMarketIdentity(UID, { dirs: [dir] });
  assert.equal(again.deviceId, got.deviceId);
  assert.equal(again.created, got.created, "created 该保留首次值，不是每次都盖新时间戳");
  // ④ 存量 gen 落后 → 就地重建
  writeFileSync(fp, JSON.stringify({ ...after, market: { ...after.market, gen: 1 } }, null, 2));
  const healed = ensureMarketIdentity(UID, { dirs: [dir] });
  assert.equal(healed.gen, 2, "gen 落后必须自愈到当前算法版本");
});

/** 抓头的假上游：按端点回固定 JSON，同时把 headers 交出来供断言。 */
function capture(canned = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    const key = Object.keys(canned).find((k) => String(url).includes(k));
    return { status: 200, text: async () => JSON.stringify(key ? canned[key] : { checked_in: false, enable: true, credits: 100, code: 0 }) };
  };
  return { seen, fetchImpl };
}

test("端到端：checkinStatus 真的把 15 位 x-device-id 发出去了（而不是只改单元测试）", async () => {
  const c = capture();
  const st = await checkinStatus({ cred: { accessToken: "tok", uid: UID, market: deriveMarketIdentity(UID) }, fetchImpl: c.fetchImpl });
  assert.equal(st.checkedIn, false);
  const h = c.seen[0].headers;
  assert.match(h["x-device-id"], /^[0-9]{15}$/);
  assert.match(h["x-market-user-id"], UUID4);
  assert.match(h["vscode-sessionid"], /^[0-9a-f]{64}$/);
});

test("端到端：两次请求身份三件恒定，只有 request-id/trace-id 该变", async () => {
  const c = capture();
  const m = deriveMarketIdentity(UID);
  await checkinStatus({ cred: { accessToken: "tok", uid: UID, market: m }, fetchImpl: c.fetchImpl });
  await checkinStatus({ cred: { accessToken: "tok", uid: UID, market: m }, fetchImpl: c.fetchImpl });
  const [a, b] = c.seen.map((s) => s.headers);
  assert.equal(a["x-device-id"], b["x-device-id"]);
  assert.equal(a["vscode-sessionid"], b["vscode-sessionid"]);
  assert.notEqual(a["x-request-id"], b["x-request-id"], "request-id 每请求一个新的");
});

test("端到端：claim 回执带 9004 时判未到账并原样带出错误码（不许记成功）", async () => {
  const c = capture({
    "checkin_credits/status": { checked_in: false, enable: true, credits: 100, code: 0 },
    "checkin_credits/claim": { code: 9004, message: "The submitted order parameters are incorrect." },
  });
  const r = await checkinClaimVerified({ cred: { accessToken: "tok", uid: UID, market: deriveMarketIdentity(UID) }, fetchImpl: c.fetchImpl });
  assert.equal(r.claimed, false);
  assert.equal(r.phantom, false, "9004 是明确失败，不算谎报");
  assert.match(r.msg, /9004/);
  assert.ok(c.seen.some((s) => s.url.includes("/claim")), "确实打过 claim");
});

test("withTraeworkIdentity：把被 normalizeAuths 剥掉的 machineId/deviceId 回文档补回来", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-tw-id-"));
  const fp = join(dir, `trae-${UID}.json`);
  writeFileSync(fp, JSON.stringify({ account: { uid: UID, enterpriseId: "ent" }, auth: { accessToken: "AT-doc", refreshToken: "RT", machineId: "M32", deviceId: "D32", domain: "trae.cn" } }, null, 2));
  const { withTraeworkIdentity } = await import("../src/providers/traework/account-store.js");
  // 模拟从 state 读出来的行（只有 4 个字段 —— normalizeAuths 的产物）
  const rows = withTraeworkIdentity([{ uid: UID, domain: "trae.cn", enterpriseId: "ent", refreshToken: "RT" }], { dirs: [dir] });
  assert.equal(rows[0].machineId, "M32", "设备身份必须回文档取");
  assert.equal(rows[0].deviceId, "D32");
  assert.equal(rows[0].accessToken, "AT-doc", "state 行没有 accessToken 时兜文档那份");
  // state 已有 accessToken 时以 state 为准（keyring 按它轮转），不许被文档盖掉
  const keep = withTraeworkIdentity([{ uid: UID, accessToken: "AT-state", refreshToken: "RT", domain: "trae.cn", enterpriseId: "ent" }], { dirs: [dir] });
  assert.equal(keep[0].accessToken, "AT-state");
  // 文档里没有对应 uid → 原样返回，不编造
  const ghost = withTraeworkIdentity([{ uid: "nobody", domain: "trae.cn" }], { dirs: [dir] });
  assert.equal(ghost[0].machineId, undefined);
});
