import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLogName, summarizeRequest, formatModelTrace, appendModelTrace, shouldTraceModel, upstreamEcho } from "../src/model-trace.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

test("model trace: 文件名按模型安全化", () => {
  assert.equal(modelLogName("ocgo/muse-spark-1.3-contributor"), "ocgo-muse-spark-1.3-contributor.log");
  assert.equal(modelLogName("../../secret"), "secret.log");
  assert.equal(modelLogName(""), "unknown.log");
});

test("model trace: 请求摘要不含正文和凭据", () => {
  const s = summarizeRequest({ messages: [{ role: "user", content: "SECRET_PROMPT" }], tools: [{ type: "function" }], max_tokens: 32, stream: true, temperature: 0 });
  assert.deepEqual(s, { stream: true, messages: 1, roles: { user: 1 }, tools: 1, maxTokens: 32, temperature: 0, topP: null });
  assert.ok(!JSON.stringify(s).includes("SECRET_PROMPT"));
});

test("model trace: 阶段格式可读且脱敏", () => {
  const s = formatModelTrace({ type: "upstream-error", reqId: "r1", model: "ocgo/muse", data: { status: 429, message: "refreshToken=SECRET" } });
  assert.match(s, /\[req=r1\].*\[model=ocgo\/muse\].*status=429/);
  assert.ok(!s.includes("SECRET"));
  const relay = formatModelTrace({ type: "relay-done", reqId: "r2", model: "m", data: { status: 200, detail: { sawFinishReason: "tool_calls", toolCalls: 2, chars: 3, usage: { completion_tokens: 9 } } } });
  assert.match(relay, /finish=tool_calls.*tools=2.*chars=3.*completion=9/);
});

test("model trace: 上游/组员 payload 摘要只显示结构", () => {
  const s = formatModelTrace({ type: "upstream-try", reqId: "r1", model: "m", data: { model: "m", attempt: 1, payload: { stream: true, messages: 3, roles: { user: 2, assistant: 1 }, tools: 5, maxTokens: 64 } } });
  assert.match(s, /target=m attempt=1 payload=stream=true messages=3 roles=/);
  assert.match(s, /tools=5/);
  const p = formatModelTrace({ type: "peer-request", reqId: "r1", model: "m", data: { peer: "http://127.0.0.1:8989", model: "m", payload: { messages: 2, tools: 1 } } });
  assert.match(p, /peer=127\.0\.0\.1:8989/);
  assert.match(p, /payload=messages=2 tools=1/);
});

test("model trace: 多阶段同步追加且保序", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-model-trace-"));
  const old = process.env.MSLXDFF_DAEMON_DIR;
  process.env.MSLXDFF_DAEMON_DIR = dir;
  try {
    for (const type of ["request", "ordered", "upstream-try", "relay-done", "client-response"]) {
      appendModelTrace("ocgo/muse-spark-1.3-contributor", { type, reqId: "r1", model: "ocgo/muse-spark-1.3-contributor" });
    }
    const text = readFileSync(join(dir, "ocgo-muse-spark-1.3-contributor.log"), "utf8");
    const stages = text.trim().split("\n").map((line) => line.match(/stage=([^ ]+)\]/)?.[1]);
    assert.deepEqual(stages, ["request", "ordered", "upstream-try", "relay-done", "client-response"]);
  } finally {
    if (old === undefined) delete process.env.MSLXDFF_DAEMON_DIR; else process.env.MSLXDFF_DAEMON_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model trace: 只记录关键阶段并脱敏 URL 凭据", () => {
  assert.equal(shouldTraceModel("request"), true);
  assert.equal(shouldTraceModel("peer-health"), false);
  assert.equal(shouldTraceModel("heartbeat"), false);
  const s = formatModelTrace({ type: "upstream-error", reqId: "r1", model: "m", data: { status: 401, message: "https://api.example.com?token=SECRET&refreshToken=SECRET" } });
  assert.ok(!s.includes("SECRET"));
});

test("model trace: upstream-done 渲染 via/account（账号与上游可观测）", () => {
  const hit = formatModelTrace({ type: "upstream-done", reqId: "r1", model: "qoder/qfmodel", data: { status: 200, upstream: "api1.qoder.sh", account: "global" } });
  assert.match(hit, /status=200.*via=api1\.qoder\.sh account=global/);
  const miss = formatModelTrace({ type: "upstream-done", reqId: "r2", model: "m", data: { status: 200 } });
  assert.ok(!miss.includes("via="), "无回显头时不渲染 via（向后兼容其它供应商）");
  assert.ok(!miss.includes("account="), "无回显头时不渲染 account");
});

test("model trace: empty-turn-retry 可见（同请求切号换 URL 的真因，此前被阶段白名单吞掉）", () => {
  assert.equal(shouldTraceModel("empty-turn-retry"), true);
  const s = formatModelTrace({ type: "empty-turn-retry", reqId: "r1", model: "qoder/qfmodel", data: { retry: 1, max: 2, delayMs: 1000, upstream: "api1.qoder.sh", account: "global" } });
  assert.match(s, /retry 1\/2 delay=1000ms/);
  assert.match(s, /after=api1\.qoder\.sh account=global/);
  assert.match(s, /reason=empty turn/);
  const bare = formatModelTrace({ type: "empty-turn-retry", reqId: "r2", model: "m", data: { retry: 2, max: 2, delayMs: 1000 } });
  assert.ok(!bare.includes("after="), "无回显头时不渲染 after（其它供应商零变化）");
  assert.ok(!bare.includes("account="), "无回显头时不渲染 account");
});

test("model trace: 黑名单语义——新事件默认可见，只有噪声/敏感面被排除", () => {
  // 起因：白名单曾把 empty-turn-retry（"URL 在切"的真因）静默吞掉。
  // 现在语义反转：关键决定默认可见，确属噪声才登记进 TRACE_DENY。
  assert.equal(shouldTraceModel("brand-new-decision"), true, "新增事件默认可见");
  assert.equal(shouldTraceModel("model-select"), true);
  assert.equal(shouldTraceModel("client-session"), false, "会话标识属敏感面");
  assert.equal(shouldTraceModel("upstream-probe"), false, "探针类排除噪声");
  assert.equal(shouldTraceModel("upstream-probe-error"), false);
  assert.equal(shouldTraceModel(""), false);
});

test("model trace: 决定类事件只渲染登记字段，不落 payload/detail", () => {
  const s = formatModelTrace({
    type: "model-select", reqId: "r1", model: "m",
    data: { reason: "auto", pick: "sticky", cooled: "429", from: "a", to: "b", payload: { messages: 999 }, detail: { chars: 12345 } },
  });
  assert.match(s, /reason=auto/);
  assert.match(s, /pick=sticky/);
  assert.match(s, /cooled=429/);
  assert.match(s, /from=a to=b/);
  assert.ok(!s.includes("999"), "payload 不入模型日志（加日志 ≠ 倒数据）");
  assert.ok(!s.includes("12345"), "detail 不入模型日志");
});

test("model trace: upstreamEcho 认回显头，无头返回空（其它供应商零变化）", () => {
  const q = new Response("", { headers: { "x-mslxdff-upstream": "api1.qoder.sh", "x-mslxdff-qoder-region": "global", "x-mslxdff-qoder-account": "sticky", "x-mslxdff-qoder-cooldown": "429" } });
  assert.deepEqual(upstreamEcho(q), { upstream: "api1.qoder.sh", account: "global", pick: "sticky", cooled: "429" });
  const wb = new Response("", { headers: { "x-mslxdff-workbuddy-uid": "u1" } });
  assert.equal(upstreamEcho(wb).account, "u1", "workbuddy 账号走同一字段");
  assert.deepEqual(upstreamEcho(null), {}, "非 Response 不炸");
  assert.deepEqual(upstreamEcho({}), {});
});

test("model trace: relay-done/result 也带 upstream/account/pick（终局可追溯）", () => {
  const r = formatModelTrace({ type: "result", reqId: "r1", model: "qoder/qfmodel", data: { status: 200, via: "local", actual: "qoder/qfmodel", upstream: "gateway.qoder.com.cn", account: "cn", pick: "sticky" } });
  assert.match(r, /via=local.*upstream=gateway\.qoder\.com\.cn account=cn pick=sticky/);
  const d = formatModelTrace({ type: "relay-done", reqId: "r2", model: "m", data: { status: 200, upstream: "api1.qoder.sh", account: "global", detail: { chars: 5 } } });
  assert.match(d, /upstream=api1\.qoder\.sh account=global/);
  const bare = formatModelTrace({ type: "result", reqId: "r3", model: "m", data: { status: 200, via: "local" } });
  assert.ok(!bare.includes("upstream="), "无回显头时零变化");
});
