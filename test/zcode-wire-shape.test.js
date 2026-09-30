// zcode 出站线形（wire shape）单测：官方形态三件套 —— system 身份块 / context 前缀 / 模型请求头。
// 背景：上游 zcode-plan 通道有内容门（缺官方 system 块 → 3012）；v3.14.4 起模型请求验证码已关闭
// （client/configs captcha.skip_model_request=true），本套用例锁定官方形态防回归。TDD 先行。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ZCODE_CLI_PREFIX,
  buildZcodeSystemBlocks,
  buildZcodeContextPrefixBlock,
  attachZcodeContextPrefix,
  shapeZcodeWireRequest,
} from "../src/providers/zcode/context-shape.js";
import { buildZcodeModelHeaders } from "../src/providers/zcode/headers.js";
import { forwardZcodeChat } from "../src/providers/zcode/chat.js";
import { zcodeAppVersion } from "../src/providers/zcode/const.js";

const OK_SSE = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
const sseResponse = () => new Response(OK_SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
// 本地时区日期（避免 UTC/本地混用导致断言随环境漂移）
const LOCAL_DATE = new Date(2026, 8, 30); // 2026-09-30 本地零点

test("shape: cliPrefix 常量逐字（官方开源 cli-prefix.ts）", () => {
  assert.equal(ZCODE_CLI_PREFIX, "You are ZCode, an interactive coding agent");
});

test("shape: system 三官方块 + 调用方 system 追加其后", () => {
  const blocks = buildZcodeSystemBlocks({
    system: "caller rule",
    model: "glm-5.3-flash",
    provider: "zai",
    cwd: "C:/work/proj",
    now: LOCAL_DATE,
  });
  assert.equal(blocks.length, 4, "3 官方块 + 1 调用方块");
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[0].text, ZCODE_CLI_PREFIX);
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
  // stable 块：身份 + 安全行 + Harness
  assert.ok(blocks[1].text.includes("IMPORTANT: Assist with authorized security testing"));
  assert.ok(blocks[1].text.includes("# Harness"));
  assert.deepEqual(blocks[1].cache_control, { type: "ephemeral" });
  // dynamic 块：以 \n\n 起头（官方形态），含沟通段/Environment/powered-by
  assert.ok(blocks[2].text.startsWith("\n\n"), "dynamic 块自带左边界（builder.ts:271 注释）");
  assert.ok(blocks[2].text.includes("# Communicating with the user"));
  assert.ok(blocks[2].text.includes("# Environment"));
  assert.ok(blocks[1].text.startsWith("\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT:"), "官方 identity 内容以前导换行起（identity.ts join 原样）");
  assert.ok(blocks[2].text.includes("- Primary working directory: C:/work/proj"));
  assert.ok(blocks[2].text.includes("- You are powered by the model named zai-api/glm-5.3-flash."));
  assert.ok(blocks[2].text.includes("# Context management"));
  assert.deepEqual(blocks[2].cache_control, { type: "ephemeral" });
  // 调用方 system 原样在末尾（无 cache_control，不参与官方缓存）
  assert.equal(blocks[3].text, "caller rule");
  assert.equal(blocks[3].cache_control, undefined);
});

test("shape: 无调用方 system 时恰好三块；system 数组入参逐个展开", () => {
  const only = buildZcodeSystemBlocks({ model: "glm-5.2", provider: "zai", cwd: "/tmp", now: LOCAL_DATE });
  assert.equal(only.length, 3);
  const arr = buildZcodeSystemBlocks({
    system: ["A", "", { type: "text", text: "B" }],
    model: "glm-5.2",
    provider: "zai",
    cwd: "/tmp",
    now: LOCAL_DATE,
  });
  assert.deepEqual(arr.slice(3).map((b) => b.text), ["A", "B"]);
});

test("shape: context 前缀块 = system-reminder 包裹的 currentDate", () => {
  const b = buildZcodeContextPrefixBlock(LOCAL_DATE);
  assert.equal(b.type, "text");
  assert.ok(b.text.startsWith("<system-reminder>"));
  assert.ok(b.text.endsWith("</system-reminder>"));
  assert.ok(b.text.includes("# currentDate"));
  assert.ok(b.text.includes("Today's date is 2026-09-30."), "本地日期 ISO");
  assert.ok(b.text.includes("As you answer the user's questions, you can use the following context:"));
  assert.ok(b.text.includes("IMPORTANT: this context may or may not be relevant to your tasks."));
});

test("shape: attach 前缀到首个 user 消息最前，字符串 content 升格为块数组", () => {
  const out = attachZcodeContextPrefix([{ role: "user", content: "hi" }], LOCAL_DATE);
  assert.ok(Array.isArray(out[0].content));
  assert.ok(out[0].content[0].text.startsWith("<system-reminder>"));
  assert.equal(out[0].content[1].text, "hi");
});

test("shape: attach 幂等 + 首条非 user 不动", () => {
  const once = attachZcodeContextPrefix([{ role: "user", content: [{ type: "text", text: "hi" }] }], LOCAL_DATE);
  const twice = attachZcodeContextPrefix(once, LOCAL_DATE);
  assert.equal(twice[0].content.length, 2, "已挂则不重复挂");
  assert.equal(twice[0].content[0].text, once[0].content[0].text);
  const sys = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
  const out = attachZcodeContextPrefix(sys, LOCAL_DATE);
  assert.equal(out[0].role, "system");
  assert.equal(out[1].content, "u", "仅认首条消息");
});

test("shape: shapeZcodeWireRequest 归一小写模型 + 组装 system/messages，其余字段透传", () => {
  const req = shapeZcodeWireRequest(
    { model: "GLM-5.3-Flash", max_tokens: 128, stream: true, system: "keep me", messages: [{ role: "user", content: "hi" }], tools: [{ name: "f" }] },
    { cwd: "/w", provider: "zai", now: LOCAL_DATE },
  );
  assert.equal(req.model, "glm-5.3-flash", "官方出站为小写模型名");
  assert.equal(Array.isArray(req.system), true);
  assert.equal(req.system[0].text, ZCODE_CLI_PREFIX);
  assert.ok(req.system.some((b) => b.text === "keep me"));
  assert.ok(String(req.messages[0].content[0].text || "").startsWith("<system-reminder>"));
  assert.equal(req.max_tokens, 128);
  assert.equal(req.stream, true);
  assert.deepEqual(req.tools, [{ name: "f" }]);
});

test("headers: buildZcodeModelHeaders 官方模型请求形态（无 deviceMid / 无验证码头 / 双鉴权头）", () => {
  const h = buildZcodeModelHeaders({ token: "jwt.tok", platform: "win32", arch: "x64", lang: "zh-CN", tz: "Asia/Shanghai", osVersion: "10.0.26200", requestId: "req-1", traceId: "tr-1" });
  assert.equal(h.authorization, "Bearer jwt.tok");
  assert.equal(h["x-api-key"], "jwt.tok", "官方 x-api-key + Bearer 并存");
  assert.equal(h["user-agent"], `ZCode/${zcodeAppVersion({})} ai-sdk/anthropic/3.0.81`);
  assert.equal(h["x-title"], "Z Code@cli", "CLI 形态（非 @electron）");
  assert.equal(h["anthropic-version"], "2023-06-01");
  assert.equal(h["accept-encoding"], "gzip");
  assert.equal(h["x-release-channel"], "production");
  assert.equal(h["x-zcode-app-version"], zcodeAppVersion({}));
  assert.equal(h["x-zcode-agent"], "glm");
  assert.equal(h["x-zcode-session-type"], "main");
  assert.equal(h["http-referer"], "https://zcode.z.ai");
  assert.equal(h["x-platform"], "win32-x64");
  assert.equal(h["x-os-category"], "windows");
  assert.equal(h["x-os-version"], "10.0.26200");
  assert.equal(h["x-request-id"], "req-1");
  assert.equal(h["x-zcode-trace-id"], "tr-1");
  assert.equal(h["x-device-mid"], undefined, "模型请求不带 device-mid（官方不带）");
  assert.equal(h["X-Device-Mid"], undefined);
  assert.equal(h["x-aliyun-captcha-verify-param"], undefined, "v3.14.4 起模型请求免验证码，永不带 param");
});

test("headers: 默认 request/trace id 为 uuid 形", () => {
  const h = buildZcodeModelHeaders({ token: "t" });
  assert.match(h["x-request-id"], /^[0-9a-f-]{36}$/i);
  assert.match(h["x-zcode-trace-id"], /^[0-9a-f-]{36}$/i);
});

test("chat: forwardZcodeChat 出站即官方线形（小写模型 + 身份块 + cli 头，忽略 deviceMid 入参）", async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return sseResponse();
  };
  await forwardZcodeChat({
    body: { model: "zcode/GLM-5.2", messages: [{ role: "system", content: "rule" }, { role: "user", content: "hi" }], stream: false },
    token: "tok-abc",
    deviceMid: "mid-should-be-ignored",
    fetchImpl,
  });
  assert.ok(seen.url.endsWith("/api/v1/zcode-plan/anthropic/v1/messages"));
  assert.equal(seen.body.model, "glm-5.2");
  assert.equal(seen.body.system[0].text, ZCODE_CLI_PREFIX);
  assert.ok(seen.body.system.some((b) => b.text === "rule"), "调用方 system 保留在尾部");
  assert.ok(String(seen.body.messages[0].content[0].text || "").startsWith("<system-reminder>"), "首 user 挂 currentDate 前缀");
  assert.equal(seen.headers["x-title"], "Z Code@cli");
  assert.equal(seen.headers["x-api-key"], "tok-abc");
  assert.equal(seen.headers["x-device-mid"], undefined);
});
