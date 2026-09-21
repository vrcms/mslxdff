// qoder 单测：encode roundtrip / 模型映射 / 信封 delta 解析 / payload 组装
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cosyEncode, cosyDecode } from "../src/providers/qoder/encode.js";
import { mapModel, buildQoderBody, buildQoderMessages, loadTemplate } from "../src/providers/qoder/payload.js";
import { extractDelta, errorStatus } from "../src/providers/qoder/sse.js";
import { deriveMachineId, deriveMachineType, deriveMachineToken, fingerprintSeed } from "../src/providers/qoder/fingerprint.js";
import { pkce, buildLoginUrl } from "../src/providers/qoder/oauth.js";
import { accountFromBlob } from "../src/providers/qoder/account-store.js";
import { getEndpoints, normalizeRegion } from "../src/providers/qoder/constants.js";
import { pickCampaign, runCheckin, fetchQuota, checkinHeaders } from "../src/providers/qoder/checkin.js";
import { handleQoderCheckin } from "../src/cli/commands/provider/qoder-checkin.js";

describe("qoder encode", () => {
  it("roundtrip 中英文与空串", () => {
    for (const s of ["hello", "hi 你好 {}", '{"a":1,"b":[1,2]}', ""]) {
      const buf = Buffer.from(s, "utf8");
      const dec = cosyDecode(cosyEncode(buf));
      assert.ok(buf.equals(dec), `roundtrip fail: ${s}`);
    }
  });
  it("自定义字母表特征（$ 代 =）", () => {
    const enc = cosyEncode(Buffer.from("hello"));
    assert.ok(!enc.includes("="), "不能出现标准 padding =");
    assert.match(enc, /^[A-Za-z0-9$+/]*$/);
  });
});

describe("qoder mapModel", () => {
  it("空/auto → qfmodel", () => {
    assert.equal(mapModel(""), "qfmodel");
    assert.equal(mapModel("auto"), "qfmodel");
    assert.equal(mapModel("AUTO"), "qfmodel");
  });
  it("上游 key 原样小写透传", () => {
    assert.equal(mapModel("qmodel_38max"), "qmodel_38max");
    assert.equal(mapModel("QFMODEL"), "qfmodel");
  });
  it("家族关键字模糊兜底", () => {
    assert.equal(mapModel("claude-sonnet-4"), "gmodel");
    assert.equal(mapModel("gpt-5"), "dmodel");
    assert.equal(mapModel("qwen3.8-flash"), "qfmodel");
  });
});

describe("qoder sse 信封解析", () => {
  it("正常 delta 帧", () => {
    const line = JSON.stringify({ headers: {}, statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: "Hi" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) });
    const d = extractDelta(line);
    assert.equal(d.content, "Hi");
    assert.equal(d.usageIn, 10);
    assert.equal(d.usageOut, 2);
  });
  it("信封 418 → upstream 错", () => {
    const line = JSON.stringify({ headers: {}, statusCodeValue: 418, body: "provider_error" });
    const d = extractDelta(line);
    assert.equal(d.err.kind, "upstream");
    assert.equal(errorStatus(d.err), 502);
  });
  it("内层业务 code!=0 → business 错", () => {
    const line = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ code: "115", message: "quota exceeded" }) });
    const d = extractDelta(line);
    assert.equal(d.err.kind, "business");
    assert.equal(errorStatus(d.err), 502);
  });
  it("内容审核 → 400", () => {
    const line = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ code: "116", message: "DataInspectionFailed: inappropriate content" }) });
    const d = extractDelta(line);
    assert.equal(d.err.kind, "content_policy");
    assert.equal(errorStatus(d.err), 400);
  });
  it("usage-only 帧不误判", () => {
    const line = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } }) });
    const d = extractDelta(line);
    assert.equal(d.content, undefined);
    assert.equal(d.usageIn, 5);
  });
});

describe("qoder payload/messages", () => {
  const template = loadTemplate();
  it("模板加载含 system + 占位符已替换", () => {
    assert.ok(Array.isArray(template.messages));
    assert.ok(template.messages.some((m) => m.role === "system"));
    assert.ok(!JSON.stringify(template).includes("{UUID1}"));
    assert.ok(!JSON.stringify(template).includes("{TIME1}"));
  });
  it("无 system 时前置模板 system，user 转 contents 形态", () => {
    const msgs = buildQoderMessages(template, [{ role: "user", content: "hi" }], false);
    assert.equal(msgs[0].role, "system");
    const user = msgs[msgs.length - 1];
    assert.equal(user.role, "user");
    assert.equal(user.contents[0].text, "hi");
    assert.ok(user.response_meta);
  });
  it("显式 system 不重复前置", () => {
    const msgs = buildQoderMessages(template, [{ role: "system", content: "custom" }, { role: "user", content: "hi" }], false);
    assert.equal(msgs[0].content, "custom");
  });
  it("buildQoderBody 填 uuid/model/max_tokens", () => {
    const messages = buildQoderMessages(template, [{ role: "user", content: "hi" }], false);
    const { body, mcSource } = buildQoderBody({ template, userType: "personal_standard", model: "qfmodel", messages, maxTokens: 100 });
    assert.equal(body.stream, true);
    assert.equal(body.model_config.key, "qfmodel");
    assert.equal(body.parameters.max_tokens, 100);
    assert.ok(body.request_id);
    assert.equal(mcSource, "system");
  });
});

describe("qoder fingerprint/oauth/store 基元", () => {
  it("指纹派生稳定性与形状", () => {
    const seed = fingerprintSeed("uid-1", "dt-x");
    assert.equal(seed, "uid-1");
    assert.match(deriveMachineId(seed), /^[0-9a-f]{32}$/);
    assert.equal(deriveMachineType(seed).length, 18);
    assert.equal(deriveMachineToken(seed).length, 43);
    assert.equal(fingerprintSeed("", "dt-x"), "cred:dt-x");
    assert.equal(deriveMachineId(fingerprintSeed("", "dt-x")), deriveMachineId("cred:dt-x"), "空 uid 走 cred 种子");
  });
  it("pkce verifier/challenge 配对 + login url", () => {
    const { verifier, challenge } = pkce();
    assert.ok(verifier.length >= 40 && !verifier.includes("="));
    const url = buildLoginUrl({ region: "cn", nonce: "n1", challenge });
    assert.ok(url.startsWith("https://qoder.com.cn/device/selectAccounts"));
    assert.ok(url.includes("client_id="));
  });
  it("region 归一 + blob 解析", () => {
    assert.equal(normalizeRegion("CN"), "cn");
    assert.equal(normalizeRegion("whatever"), "global");
    const blob = accountFromBlob(JSON.stringify({ device_token: "dt-a", refresh_token: "drt-b" }));
    assert.equal(blob.deviceToken, "dt-a");
    assert.equal(blob.deviceToken, "dt-a");
    assert.equal(accountFromBlob("not-json"), null);
  });
  it("端点表 cn/global 各就位", () => {
    assert.ok(getEndpoints("global").modelListURL.includes("qoder.sh"));
    assert.ok(getEndpoints("cn").modelListURL.includes("qoder.com.cn"));
    assert.ok(getEndpoints("cn").chatStreamURL.includes("agent_chat_generation"));
  });
});

// ---------- 签到（按区域选域名 + 活动类型）----------
describe("qoder checkin", () => {
  const fake = (routes) => {
    const calls = [];
    const impl = async (url, init = {}) => {
      const method = init.method || "GET";
      calls.push({ url: String(url), method, headers: init.headers || {}, body: init.body });
      const hit = routes.find((r) => String(url).includes(r.match) && (!r.method || r.method === method));
      if (!hit) return new Response(JSON.stringify({ errorCode: "NotFound", errorMessage: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      return new Response(typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body), { status: hit.status || 200, headers: { "Content-Type": "application/json" } });
    };
    impl.calls = calls;
    return impl;
  };

  it("cn：daily-check-in status + claim 成功", async () => {
    const f = fake([
      { match: "/daily-check-in/status", body: { campaignKey: "cn_daily_check_in_legacy", status: "CLAIMABLE", rewardCredits: 100, currentStreakDays: 2, totalClaimDays: 2, totalRewardCredits: 200 } },
      { match: "/daily-check-in/claim", method: "POST", body: { success: true, rewardCredits: 100 } },
    ]);
    const r = await runCheckin({ deviceToken: "dt-a", region: "cn", fetchImpl: f });
    assert.equal(r.status, "claimed");
    assert.equal(r.amount, 100);
    assert.equal(r.streak, 3);
    assert.equal(r.totalCredits, 300);
    assert.ok(f.calls[0].url.startsWith("https://openapi.qoder.com.cn/"), "cn 走 *.qoder.com.cn");
    assert.equal(f.calls[0].headers["cosy-clienttype"], "10");
    assert.equal(checkinHeaders("dt-a").authorization, "Bearer dt-a");
  });

  it("cn：409 = 今日已领取", async () => {
    const f = fake([
      { match: "/daily-check-in/status", body: { status: "CLAIMED", rewardCredits: 100 } },
      { match: "/daily-check-in/claim", method: "POST", status: 409, body: { errorCode: "AlreadyExists" } },
    ]);
    const r = await runCheckin({ deviceToken: "dt-a", region: "cn", fetchImpl: f });
    assert.equal(r.status, "already");
    assert.equal(r.ok, true);
  });

  it("global：daily-check-in 404 → 回落 campaigns；促销默认不领", async () => {
    const campaigns = { claimable: true, campaigns: [{ campaignId: "c1", campaignKey: "act-x", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE" }] };
    const f = fake([
      { match: "/daily-check-in/status", status: 404, body: { errorCode: "NotFound" } },
      { match: "/sash/api/v1/me/campaigns", method: "GET", body: campaigns },
      { match: "/claim", method: "POST", body: { status: "CLAIMED", replayed: false, grantId: "g1" } },
    ]);
    const r = await runCheckin({ deviceToken: "dt-a", region: "global", fetchImpl: f });
    assert.equal(r.status, "no_campaign");
    assert.ok(f.calls[0].url.startsWith("https://openapi.qoder.sh/"), "global 走 *.qoder.sh");
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 0, "默认不碰促销条目");

    const f2 = fake([
      { match: "/daily-check-in/status", status: 404, body: {} },
      { match: "/sash/api/v1/me/campaigns", method: "GET", body: campaigns },
      { match: "/claim", method: "POST", body: { status: "CLAIMED", replayed: false, benefit: { amount: 0 } } },
    ]);
    const r2 = await runCheckin({ deviceToken: "dt-a", region: "global", fetchImpl: f2, allowPromo: true });
    assert.equal(r2.status, "claimed");
    assert.equal(f2.calls.filter((c) => c.method === "POST").length, 1);
  });

  it("pickCampaign 优先 CLAIM_BENEFIT + 干跑不发 claim", async () => {
    const picked = pickCampaign([
      { campaignId: "p", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE" },
      { campaignId: "b", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE" },
    ]);
    assert.equal(picked.target.campaignId, "b");
    const picked2 = pickCampaign([{ campaignId: "x", actionType: "VIEW_DETAILS", claimStatus: "CLAIMED" }]);
    assert.equal(picked2.target, null);
    assert.equal(picked2.claimed, true);

    const f = fake([
      { match: "/daily-check-in/status", body: { status: "CLAIMABLE", rewardCredits: 100 } },
      { match: "/daily-check-in/claim", method: "POST", body: {} },
    ]);
    const r = await runCheckin({ deviceToken: "dt-a", region: "cn", fetchImpl: f, probeOnly: true });
    assert.equal(r.status, "claimable");
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
  });

  it("401 → 提示重新 login；quota 解析", async () => {
    const f = fake([{ match: "/daily-check-in/status", status: 401, body: { code: "TOKEN_EXPIRE" } }]);
    const r = await runCheckin({ deviceToken: "dt-a", region: "global", fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.message, /重新 mslxdff -provider qoder login/);

    const fq = fake([{ match: "/api/v2/quota/usage", body: { userQuota: { total: 400, used: 100, remaining: 300, unit: "credits" }, isQuotaExceeded: false } }]);
    const q = await fetchQuota({ deviceToken: "dt-a", region: "cn", fetchImpl: fq });
    assert.deepEqual([q.ok, q.remaining, q.total, q.exhausted], [true, 300, 400, false]);
  });

  it("CLI：无账号给引导，有账号打印结果并可 --json", async () => {
    const out = [];
    const ok = await handleQoderCheckin("qoder", "checkin", ["checkin"], { accounts: [], log: (m) => out.push(m), noExit: true });
    assert.equal(ok, true);
    assert.ok(out.join("\n").includes("-provider qoder login"));

    const f = fake([
      { match: "/daily-check-in/status", body: { status: "CLAIMABLE", rewardCredits: 100, currentStreakDays: 1, totalClaimDays: 1, totalRewardCredits: 100 } },
      { match: "/daily-check-in/claim", method: "POST", body: { success: true, rewardCredits: 100 } },
      { match: "/api/v2/quota/usage", body: { userQuota: { total: 100, used: 100, remaining: 0, unit: "credits" }, isQuotaExceeded: true } },
    ]);
    const out2 = [];
    const ok2 = await handleQoderCheckin("qoder", "checkin", ["checkin", "--json"], {
      accounts: [{ uid: "d210f787-b3bf-48e9-bdc8-1246259dd198", deviceToken: "dt-a", region: "cn" }],
      fetchImpl: f, log: (m) => out2.push(m), noExit: true,
    });
    assert.equal(ok2, true);
    const json = JSON.parse(out2[out2.length - 1]);
    assert.equal(json.claimed, 1);
    assert.equal(json.results[0].quota, "0/100 credits（已耗尽）");
  });
});
