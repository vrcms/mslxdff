import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLogName, summarizeRequest, formatModelTrace, appendModelTrace, shouldTraceModel } from "../src/model-trace.js";
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
