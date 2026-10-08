// globalworkbuddy 单测（零网络）：只锁「会被误改回国内版的地方」+ 已现网取证的行为契约。
// 取证依据全在 .scratch/globalworkbuddy/FINDINGS.md；改任何断言前先去看那里的实测记录。
// Phase 2 接线后再补 registry 双向锁 / provider-gate 入选（现在还没注册，写了必红）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/providers/globalworkbuddy/constants.js";
import { chatHeaders, refreshHeaders, catalogHeaders } from "../src/providers/globalworkbuddy/headers.js";
import { rewriteGlobalworkbuddyPayload } from "../src/providers/globalworkbuddy/payload.js";
import { unwrapConfigDocument, parseModelCatalog, creditsValue, pickCheapest, fallbackCatalog } from "../src/providers/globalworkbuddy/catalog.js";
import { classifyUpstreamError, friendlyMessage, extractDisplayMessage } from "../src/providers/globalworkbuddy/errors.js";
import { authDirFor, isGlobalDoc } from "../src/providers/globalworkbuddy/account-store.js";
import { requestDeviceState, pollDeviceToken, loginAndSave } from "../src/providers/globalworkbuddy/device-auth.js";
import { createModelsService } from "../src/providers/globalworkbuddy/models.js";
import { createAuthService } from "../src/providers/globalworkbuddy/auth.js";

const cred = { uid: "u-1", accessToken: "AT", refreshToken: "RT", domain: "www.workbuddy.ai", enterpriseId: "" };

test("常量契约：绝不掺国内版域名，refresh 路径不被 #19 的错误说法带回", () => {
  assert.equal(C.BASE, "https://www.workbuddy.ai");
  assert.equal(C.ORIGIN, C.BASE, "Origin 必须与 host 同源");
  assert.ok(!C.BASE.includes("codebuddy.cn") && !C.BASE.includes("copilot.tencent"), "国际版常量里不许出现国内域名");
  assert.equal(C.MODELS_PATH, "/v3/config");
  assert.equal(C.CHAT_PATH, "/v2/chat/completions");
  // #19（未合并 PR）声称国际版是 /v2/auth/token/refresh —— 现网 404。这行就是防有人照抄那个说法。
  assert.equal(C.REFRESH_PATH, "/v2/plugin/auth/token/refresh");
  assert.equal(C.isGlobalDomain("www.workbuddy.ai"), true);
  assert.equal(C.isGlobalDomain("workbuddy.ai"), true);
  assert.equal(C.isGlobalDomain("www.workbuddy.cn"), false, "国内版 .cn 绝不能被判成国际版");
  assert.equal(C.isGlobalDomain(""), false, "空 domain 默认不是国际版（跨区泄露的最后一道闸）");
});

test("通道隔离：chat 永不携带 refreshToken，refresh 永不携带 Authorization", () => {
  const ch = chatHeaders(cred);
  assert.equal(ch.Authorization, "Bearer AT");
  assert.equal(ch["X-Refresh-Token"], undefined, "chat 携带 refresh token = 跨通道泄露凭据");
  assert.equal(ch.Origin, "https://www.workbuddy.ai");
  assert.equal(ch["X-Domain"], "www.workbuddy.ai");
  assert.equal(ch["X-No-Enterprise-Id"], "1", "无企业号走 X-No-* 占位（上游区分缺失与为空）");

  const rh = refreshHeaders(cred);
  assert.equal(rh["X-Refresh-Token"], "RT");
  assert.equal(rh.Authorization, undefined, "refresh 不能带 Bearer（国内版/global-hi.js 就是带着过期 token 被打回）");
  assert.equal(rh["X-Auth-Refresh-Source"], "workbuddy");

  const noUid = chatHeaders({ ...cred, uid: "" });
  assert.equal(noUid["X-User-Id"], undefined);
  assert.equal(noUid["X-No-User-Id"], "1");
  assert.ok(catalogHeaders(cred).Authorization === "Bearer AT");
});

test("payload：首条 system 前插 + developer 归一 + tool_choice 压 string + off 剥离（四条均为国际版实测）", () => {
  const src = { model: "hy3", stream: false, messages: [{ role: "user", content: "hi" }] };
  const out = rewriteGlobalworkbuddyPayload(src);
  assert.equal(out.messages[0].role, "system", "缺首条 system 会被上游 400/11128 拒");
  assert.equal(out.stream, true, "上游拒绝非流式");
  assert.equal(src.messages.length, 1, "不得污染调用方的入参");

  const dev = rewriteGlobalworkbuddyPayload({ model: "hy3", messages: [{ role: "developer", content: "x" }, { role: "user", content: "hi" }] });
  assert.equal(dev.messages[0].role, "system", "developer → system（否则 11128 unapproved channel）");
  assert.equal(dev.messages.length, 2, "developer 被归一后不该再多插一条 system");

  const tc = rewriteGlobalworkbuddyPayload({ model: "hy3", messages: [{ role: "system", content: "s" }], tool_choice: { type: "function", function: { name: "noop" } }, tools: [{ type: "function" }] });
  assert.equal(tc.tool_choice, "noop", "对象形 tool_choice 会 400/11101");
  const none = rewriteGlobalworkbuddyPayload({ model: "hy3", messages: [{ role: "system", content: "s" }], tool_choice: "none", tools: [{ type: "function" }] });
  assert.equal(none.tool_choice, undefined);
  assert.equal(none.tools, undefined, "说不用工具又不删 tools，上游会拒");

  const off = rewriteGlobalworkbuddyPayload({ model: "gpt-6-astra", reasoning_effort: "off", messages: [{ role: "system", content: "s" }] });
  assert.equal(off.reasoning_effort, undefined, "字面量 off 在 GPT 系 400/11133");
  const low = rewriteGlobalworkbuddyPayload({ model: "gpt-6-astra", reasoning_effort: "low", messages: [{ role: "system", content: "s" }] });
  assert.equal(low.reasoning_effort, "low", "正规档位必须透传");
});

const fixtureDoc = {
  models: [
    { id: "hy3", name: "Hy3", credits: "x0.00", maxInputTokens: 128000, maxOutputTokens: 8192, contextWindow: { defaultLength: 200000, supportedLengths: [200000, 1000000] } },
    { id: "gpt-6-astra", credits: "x6.67 credits", maxInputTokens: 400000, maxOutputTokens: 16000 },
    { id: "retired", credits: "x0.00", maxInputTokens: 1000, maxOutputTokens: 100, disabled: true },
    { id: "no-caps", credits: "x0.00", maxInputTokens: 0, maxOutputTokens: 0 },
    { id: "zero-out", credits: "x0.01", maxInputTokens: 1000, maxOutputTokens: 0 },
  ],
  agents: [{ name: "cli", models: ["hy3", "gpt-6-astra", "retired", "no-caps", "zero-out", "ghost-alias"] }],
  modelPromotions: [
    { modelIds: ["hy3"], enabled: true, label: "Free now", factor: 0, validFrom: 1, validTo: Date.now() + 86400000 },
    { modelIds: ["gpt-6-astra"], enabled: true, label: "EXPIRED", factor: 0.5, validFrom: 1, validTo: 1000 },
  ],
};

test("catalog：成员=cli 白名单 ∩ 可用行；disabled/零上限/幽灵别名一律不进选择器", () => {
  const wrapped = parseModelCatalog(unwrapConfigDocument({ code: 0, msg: "OK", data: fixtureDoc }));
  const bare = parseModelCatalog(unwrapConfigDocument(fixtureDoc)); // /v3/config 两种形状都要吃
  assert.deepEqual(bare.map((m) => m.id), wrapped.map((m) => m.id));
  assert.deepEqual(wrapped.map((m) => m.id), ["hy3", "gpt-6-astra"], "按 credits 升序；disabled/无上限/白名单外不得混入");
  assert.equal(wrapped[0].contextWindow, 200000, "国际版窗口取 contextWindow.defaultLength，不是平铺 maxInputTokens");
  assert.deepEqual(wrapped[0].supportedContextWindows, [200000, 1000000]);
  assert.equal(wrapped[0].promotions.length, 1, "过期促销必须被丢掉（继续显示折扣等于把用户要付的钱报少）");
  assert.equal(wrapped[0].promotions[0].label, "Free now");
  assert.equal(wrapped[1].promotions.length, 0);
  assert.equal(creditsValue("x6.67 credits"), 6.67, "上游单位词要折掉再比价");
  assert.equal(pickCheapest(wrapped).id, "hy3");
  assert.equal(fallbackCatalog()[0].source, "fallback", "兜底表必须可辨识，且不带编造的窗口数字");
  assert.deepEqual(parseModelCatalog({ models: [], agents: [] }), [], "无 cli 白名单 → 空表，由调用方决定回落");
});

test("errors：403 不再一律当鉴权失败；11140=可重试的安全拦截，积分不足才冷却换号", () => {
  const safety = { status: 403, body: JSON.stringify({ code: 11140, msg: "request illegal", displayMsg: { zh: "内容未通过安全审核，请调整后重试。", en: "safety" } }) };
  const cls = classifyUpstreamError(safety.status, safety.body);
  assert.equal(cls.kind, "safety");
  assert.equal(extractDisplayMessage(safety.body), "内容未通过安全审核，请调整后重试。");
  assert.equal(friendlyMessage(cls.kind, safety.body).includes("403"), false, "错误文案里不许出现裸 403（下游适配器按 \\b403\\b 误判成 API Key 无效）");
  assert.ok(friendlyMessage(cls.kind, safety.body).includes("11140"));

  assert.equal(classifyUpstreamError(403, '{"code":1,"msg":"积分不足"}').kind, "hard_credit");
  assert.equal(classifyUpstreamError(402, "").kind, "hard_credit");
  assert.equal(classifyUpstreamError(403, "invalid token").kind, "session_dead");
  assert.equal(classifyUpstreamError(401, "<html>401</html>").kind, "session_dead");
  assert.equal(classifyUpstreamError(400, '{"code":11101,"msg":"Unmarshal chat params failed"}').kind, "param");
  assert.equal(classifyUpstreamError(400, '{"code":11128,"msg":"first message is not system prompt"}').kind, "param");
  assert.equal(classifyUpstreamError(429, "").kind, "rate_limit");
  assert.equal(classifyUpstreamError(503, "").kind, "server");
  assert.equal(classifyUpstreamError(200, "").kind, "unknown");
});

test("account-store 纯策略面：目录跟账本走，domain 缺失即不认国际版", () => {
  assert.equal(authDirFor({ explicit: "/tmp/x", stateFile: "/s/state.json" }), "/tmp/x");
  assert.equal(authDirFor({ testEnv: true }), authDirFor({ testEnv: true }), "测试环境走独立临时目录（不碰真凭据）");
  assert.ok(authDirFor({ testEnv: true }).includes("globalworkbuddy"), "测试目录必须与国内版分开");
  assert.ok(authDirFor({ stateFile: "/a/b/state.json" }).endsWith("auths"), "缺省跟账本（state 同目录/auths）");
  assert.equal(isGlobalDoc({ auth: { domain: "www.workbuddy.ai" } }), true);
  assert.equal(isGlobalDoc({ auth: { domain: "www.codebuddy.cn" } }), false);
  assert.equal(isGlobalDoc({ auth: {} }), false, "normalizeAuths 会默认填国内域 —— 缺 domain 一律不认");
});

test("device-auth：pending 不当失败、5xx 才抛、落盘拿到的是上游 domain", async () => {
  let polls = 0;
  const fake = async (url, opts = {}) => {
    if (url.includes("/v2/plugin/auth/state")) {
      assert.equal(opts.method, "POST");
      assert.ok(!String(opts.headers.Authorization || ""), "登录前手里没有凭据");
      return new Response(JSON.stringify({ code: 0, data: { state: "st-1", authUrl: "https://www.workbuddy.ai/authorize?state=st-1" } }), { status: 200 });
    }
    if (url.includes("/v2/plugin/auth/token")) {
      polls += 1;
      if (polls === 1) return new Response(JSON.stringify({ code: 11217, msg: "login ing" }), { status: 200 }); // 还没授权
      if (polls === 2) return new Response("boom", { status: 502 });
      return new Response(JSON.stringify({ code: 0, data: { accessToken: "AT", refreshToken: "RT", expiresIn: 100, domain: "www.workbuddy.ai" } }), { status: 200 });
    }
    if (url.includes("/v2/plugin/login/account")) {
      assert.equal(opts.headers.Authorization, "Bearer AT");
      return new Response(JSON.stringify({ code: 0, data: { uid: "u-9", enterpriseId: "", nickname: "nick" } }), { status: 200 });
    }
    throw new Error(`未预期的请求: ${url}`);
  };
  assert.deepEqual(await requestDeviceState({ fetchImpl: fake }), { state: "st-1", authUrl: "https://www.workbuddy.ai/authorize?state=st-1" });
  assert.equal(await pollDeviceToken({ fetchImpl: fake, state: "st-1" }), null, "业务 code≠0 是 pending，不是失败");

  const savedArgs = [];
  const out = await loginAndSave({
    fetchImpl: fake,
    save: async (a) => { savedArgs.push(a); return { file: "f", accounts: 1 }; },
    sleep: async () => {},
    onAuthUrl: () => {},
    log: () => {},
  });
  assert.equal(out.uid, "u-9");
  assert.equal(savedArgs[0].domain, "www.workbuddy.ai", "domain 必须落盘：它是 region 判定的唯一依据");
  assert.equal(savedArgs[0].accessToken, "AT");
  assert.ok(polls >= 3, "pending/5xx 都应被吞掉继续轮");
});

test("models：id 带 globalworkbuddy/ 前缀、上游失败回落兜底且**标明来源**", async () => {
  const doc = { code: 0, data: { models: [{ id: "hy3", credits: "x0.00", maxInputTokens: 1000, maxOutputTokens: 100 }], agents: [{ name: "cli", models: ["hy3"] }] } };
  let mode = "ok";
  const fake = async () => mode === "ok"
    ? new Response(JSON.stringify(doc), { status: 200 })
    : new Response("<html>500 Internal Server Error</html>", { status: 500 });
  const svc = createModelsService({ fetchImpl: fake, getCred: async () => ({ uid: "u", accessToken: "AT", domain: "www.workbuddy.ai" }) });
  const first = await svc.listModels();
  assert.equal(first[0].id, "globalworkbuddy/hy3", "两区模型 id 同名但语义不同，前缀是路由与防串的唯一依据");
  assert.equal(svc.catalogSource().source, "upstream");
  mode = "down";
  svc.clearCache();
  const after = await svc.listModels();
  assert.ok(after.length, "上游挂了也要给出列表（目录空掉比目录旧更伤）");
  assert.equal(svc.catalogSource().source, "fallback", "兜底必须可辨识，绝不冒充上游目录");
  assert.ok(after.every((m) => String(m.id).startsWith("globalworkbuddy/")));
});

test("auth：刷新采纳上游 domain/expiresIn；失败返回 null 且不动凭据；请求不带 Bearer", async () => {
  const seen = [];
  let reply = { code: 0, data: { accessToken: "AT2", refreshToken: "RT2", expiresIn: 600, domain: "www.workbuddy.ai" } };
  const persisted = [];
  const svc = createAuthService({
    fetchImpl: async (url, opts) => { seen.push({ url, opts }); return new Response(JSON.stringify(reply), { status: 200 }); },
    applyRefresh: async (a) => { persisted.push(a); },
  });
  const cred = { uid: "u-1", accessToken: "AT", refreshToken: "RT", domain: "www.workbuddy.ai" };
  assert.equal(await svc.refreshTokenFor(cred), "AT2");
  assert.equal(seen[0].opts.headers.Authorization, undefined, "刷新通道不带 Bearer（可能已过期的 token 打刷新口是错的做法）");
  assert.equal(seen[0].opts.headers["X-Refresh-Token"], "RT");
  assert.ok(seen[0].url.endsWith("/v2/plugin/auth/token/refresh"));
  assert.equal(persisted[0].domain, "www.workbuddy.ai");
  assert.ok(persisted[0].expiresAt > Math.floor(Date.now() / 1000), "expiresIn 必须换算成绝对时间落盘，否则临期刷新无从判断");

  reply = { code: 12153, msg: "refresh token failed" };
  assert.equal(await svc.refreshTokenFor(cred), null, "业务码非 0 ⇒ null，交给上层换号，绝不抛穿对话");
  assert.equal(persisted.length, 1, "刷新失败不得改动作废盘上的好凭据");
});
