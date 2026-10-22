import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLogName, summarizeRequest, formatModelTrace, appendModelTrace, shouldTraceModel, upstreamEcho } from "../src/model-trace.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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
  // verdict/login/nocapacity/qoderRetry（2026-10-22 补）：qoder 判决定点日志字段——
  // 排查 403 盲飞必须能从日志分辨「login 误伤/queue 漏检/压根没命中」，缺了只能靠猜。
  assert.deepEqual(upstreamEcho(q), { upstream: "api1.qoder.sh", account: "global", pick: "sticky", cooled: "429", queued: null, login: null, nocapacity: null, verdict: null, qoderRetry: null });
  const qq = new Response("", { headers: { "x-mslxdff-qoder-queued": "1", "x-mslxdff-qoder-verdict": "queue-nocapacity", "x-mslxdff-qoder-retry-after": "30" } });
  assert.equal(upstreamEcho(qq).queued, "1", "排队旗标要能被管线取到（ADR-0044）");
  assert.equal(upstreamEcho(qq).verdict, "queue-nocapacity", "判决定点字段要能取到（排障第一眼）");
  assert.equal(upstreamEcho(qq).qoderRetry, "30");
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

test("model trace: 空转重试结局（重拉抬额/救回/用尽）各自成行且默认可见", () => {
  assert.equal(shouldTraceModel("empty-turn-recovered"), true);
  assert.equal(shouldTraceModel("empty-turn-exhausted"), true);
  const r = formatModelTrace({ type: "empty-turn-retry", reqId: "r0", model: "m", data: { retry: 1, max: 2, delayMs: 2000, waitedMs: 2000, raiseFrom: 8192, raiseTo: 16384 } });
  assert.match(r, /空转重试：retry 1\/2 delay=2000ms waited=2000ms max_tokens 8192→16384/);
  const ok = formatModelTrace({ type: "empty-turn-recovered", reqId: "r1", model: "m", data: { retries: 1, max: 2, delayMs: 2000, waitedMs: 2000 } });
  assert.match(ok, /空转重试成功：第 1\/2 次重拉/);
  assert.match(ok, /白等 2000ms/);
  const lost = formatModelTrace({ type: "empty-turn-exhausted", reqId: "r2", model: "m", data: { retries: 2, max: 2, waitedMs: 4000, reason: "EMPTY_MODEL_RESPONSE: finish_reason=length" } });
  assert.match(lost, /空转重试已用尽：重试 2\/2/);
  assert.match(lost, /累计等待 4000ms/);
  assert.match(lost, /finish_reason=length/);
});

test("model trace: 空转判据原文落日志但凭据仍脱敏", () => {
  const s = formatModelTrace({ type: "empty-turn-retry", reqId: "r1", model: "m", data: { retry: 1, max: 2, delayMs: 2000, reason: "upstream=api.example.com?token=SECRETABC authorization=SECRETDEF" } });
  assert.ok(!s.includes("SECRETABC"), "reason 走 safeText 脱敏（URL 参数形）");
  assert.ok(!s.includes("SECRETDEF"), "reason 走 safeText 脱敏（k=v 形）");
});

test("model trace: empty-turn-retry 的 step 必须出现在人读行（登记≠可见，本项目踩过）", () => {
  const ladder = formatModelTrace({ type: "empty-turn-retry", reqId: "r1", model: "m", data: { retry: 2, step: 1, max: 3, delayMs: 8000, waitedMs: 10000, reason: "EMPTY_MODEL_RESPONSE: no content" } });
  assert.match(ladder, /retry 2\/3 step=1/, "step 只进 DECISION_FIELDS 不够：本事件走自定义渲染串，字段会被短路吞掉");
  assert.match(ladder, /delay=8000ms/);
  assert.match(ladder, /waited=10000ms/);
  const legacy = formatModelTrace({ type: "empty-turn-retry", reqId: "r1", model: "m", data: { retry: 1, step: 0, max: 2, delayMs: 2000, waitedMs: 2000 } });
  assert.match(legacy, /step=0/, "逃生阀模式 step=0 也得可见，否则 grep step= 假阴性");
});

// ---- 门短码：incoming 行带 api=，让「这发是哪扇门」在轨迹里一眼可读 ----
test("model trace: incoming 行带 api 短码；无值时整段不写", () => {
  const req = summarizeRequest({ messages: [{ role: "user", content: "x" }], stream: true });
  const line = formatModelTrace({ type: "request", reqId: "r1", model: "acme/m", data: { api: "messages", hops: 0 }, request: req });
  assert.match(line, /incoming api=messages\b/, line);
  const chatLine = formatModelTrace({ type: "request", reqId: "r2", model: "acme/m", data: { api: "chat", hops: 0 }, request: req });
  assert.match(chatLine, /incoming api=chat\b/, chatLine);
  const bare = formatModelTrace({ type: "request", reqId: "r3", model: "acme/m", data: { hops: 0 }, request: req });
  assert.doesNotMatch(bare, /api=/, `未传 api 不得出现该段：${bare}`);
});

// BUG-31：裁剪策略是 slice(-100) —— 按**行数**回退，与按字节的 1MB 阈值严重不匹配。
// 实测 cline-cline-pass-deepseek-v4.1-flash.log 到 1,006,482 字节 / 5346 行时触发，
// 一次丢掉 5246 行（98.1% 历史），事后回溯基本不可用 —— 与 logs.js 里已修掉的 BUG-10 同型。
test("model trace: 超限裁剪必须按字节留 3/4，不能断崖砍到 100 行", () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-trace-trim-"));
  const file = join(dir, "acme.log");
  try {
    // 造 ~1.05MB：每行约 200 字节 × 5300 行，贴近现网实测体量
    const line = (i) => `[2026-10-17 21:00:00] [req=r${i}] [model=acme/m] [stage=x] ${"a".repeat(150)}`;
    const rows = Array.from({ length: 5300 }, (_, i) => line(i));
    writeFileSync(file, rows.join("\n") + "\n");
    const before = Buffer.byteLength(readFileSync(file, "utf8"));
    assert.ok(before > 1024 * 1024, `构造体量需超阈值，实际 ${before}`);

    appendModelTrace("acme/m", { type: "result", reqId: "after", model: "acme/m", data: {} }, { file });

    const text = readFileSync(file, "utf8");
    const after = Buffer.byteLength(text);
    const lines = text.split("\n").filter(Boolean);
    // 按字节留 3/4 ⇒ 约 2000+ 行；旧实现只剩 100 行
    assert.ok(lines.length > 1000, `裁剪后行数应远多于 100，实际 ${lines.length}`);
    assert.ok(after > 500 * 1024, `裁剪后体量应保留大部分，实际 ${after}`);
    assert.ok(after <= 1024 * 1024 + 512, `仍须落到阈值内，实际 ${after}`);
    // 末尾必须补换行，否则下一条会接到半截行上
    assert.ok(text.endsWith("\n"), "裁剪结果须以换行收尾");
    // 最新的那条必须还在
    assert.ok(text.includes("[req=after]"), "裁剪后新写入的行不得丢失");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("中继全流程日志：relay-received/queued/member-result 都带目标 + 内容", () => {
  const recv = formatModelTrace({ type: "relay-received", reqId: "r1", model: "m", data: { target: "relay://0b295c55", group: "my@mslxd", via: "broadband", messages: 902, tools: 285, maxTokens: 64000 } });
  assert.match(recv, /relay-received/);
  assert.match(recv, /target=relay:\/\/0b295c55/, "必须带目标成员（否则认不出转给谁）");
  assert.match(recv, /msgs=902/);
  assert.match(recv, /tools=285/);

  const q = formatModelTrace({ type: "relay-queued", reqId: "r1", model: "m", data: { target: "relay://0b295c55", reqId: "r1" } });
  assert.match(q, /relay-queued/);
  assert.match(q, /target=relay:\/\/0b295c55/);

  const res = formatModelTrace({ type: "relay-member-result", reqId: "r1", model: "m", data: { target: "relay://0b295c55", ok: false, status: 502, ms: 1200, respChars: 40, respBody: '{"error":"context_length_exceeded"}' } });
  assert.match(res, /relay-member-result/);
  assert.match(res, /target=relay:\/\/0b295c55/);
  assert.match(res, /FAIL/);
  assert.match(res, /status=502/);
  assert.match(res, /context_length_exceeded/, "必须带成员回的正文摘要（这就是「组员回了什么」）");
});

test("中继日志：relay-try/fail 带 target（回归：旧白名单会吞掉 target）", () => {
  const try_ = formatModelTrace({ type: "relay-try", reqId: "r2", model: "m", data: { target: "relay://0b295c55", group: "my@mslxd", via: "via-leader" } });
  assert.match(try_, /target=relay:\/\/0b295c55/, "relay-try 必须带 target");
  const fail = formatModelTrace({ type: "relay-fail", reqId: "r2", model: "m", data: { target: "relay://0b295c55", status: 401, message: "Unauthorized" } });
  assert.match(fail, /target=relay:\/\/0b295c55/, "relay-fail 必须带 target");
  assert.match(fail, /status=401/);
});
