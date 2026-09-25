import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTimeline } from "../src/timeline.js";

test("timeline: 直连成功可读", () => {
  const s = formatTimeline({ reqId: "r1", model: "muse", direct: [{ status: 200 }], result: { status: 200, detail: { sawFinishReason: "tool_calls", toolCalls: 2, chars: 35 } }, totalMs: 21432 });
  assert.match(s, /\[req=r1\]/);
  assert.match(s, /\[direct=200\]/);
  assert.match(s, /\[result=200 tool_calls tools=2 chars=35\]/);
  assert.match(s, /\[total=21432ms\]/);
});

test("timeline: peer 失败/胜负与直连失败汇总", () => {
  const s = formatTimeline({ reqId: "r2", model: "muse", direct: [{ status: 429, reason: "FreeUsageLimitError" }], peers: [{ peer: "http://149.13.91.10:8989", ok: true, latencyMs: 16062 }], result: { status: 200, detail: { sawFinishReason: "stop", chars: 32 } }, totalMs: 21432 });
  assert.match(s, /\[direct=429 FreeUsageLimitError\]/);
  assert.match(s, /peer=149\.13\.91\.10:8989 win 16062ms/);
  assert.match(s, /\[result=200 stop chars=32\]/);
});

test("timeline: 重试计数与空字段不抛错", () => {
  const s = formatTimeline({ reqId: "r3", model: "m", retries: 2, result: { status: 502, detail: { timedOut: true } } });
  assert.match(s, /\[retry=2\]/);
  assert.match(s, /\[direct=-\]/);
  assert.match(s, /\[result=502 timedOut=1\]/);
});
