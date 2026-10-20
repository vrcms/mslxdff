// 转发前上下文预检：本地额度用完、要把同一份大上下文转给组员时先拦下来，
// 让客户端按 `context_length_exceeded` 触发压缩，而不是白烧对方额度再撞上游 400。
//
// 现网依据（errors.log，2026-10-19～20）：376 条 `context_length_exceeded` 中，
// 274 条来自 broadband（组员执行）、93 条 messages、9 条 chat；模型集中在 deepseek-v4.1-flash-free(323)。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  forwardMaxContextTokens,
  estimateChatBodyTokens,
  overForwardLimit,
  contextGuardMessage,
  DEFAULT_FORWARD_MAX_CONTEXT_TOKENS,
} from "../src/chat-pipeline/context-guard.js";

const ENV = "MSLXDFF_FORWARD_MAX_CONTEXT_TOKENS";
function withEnv(v, fn) {
  const saved = process.env[ENV];
  if (v === undefined) delete process.env[ENV];
  else process.env[ENV] = v;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }
}

// 造一份大约 n 个 ASCII token 的 chat body（3.6 字符 ≈ 1 token，留余量便于断言方向）
function bodyOfChars(chars) {
  return { messages: [{ role: "user", content: "x".repeat(chars) }] };
}

describe("context-guard：上限解析", () => {
  test("缺省是 200k", () => {
    withEnv(undefined, () => assert.equal(forwardMaxContextTokens(), DEFAULT_FORWARD_MAX_CONTEXT_TOKENS));
    assert.equal(DEFAULT_FORWARD_MAX_CONTEXT_TOKENS, 200_000);
  });

  test("显式值生效、小数向下取整", () => {
    withEnv("1500", () => assert.equal(forwardMaxContextTokens(), 1500));
    withEnv("1234.9", () => assert.equal(forwardMaxContextTokens(), 1234));
  });

  test("0/负数 = 关闭预检（退回旧行为）", () => {
    withEnv("0", () => assert.equal(forwardMaxContextTokens(), 0));
    withEnv("-1", () => assert.equal(forwardMaxContextTokens(), 0));
  });

  test("非法值按默认，不静默关掉闸门", () => {
    withEnv("abc", () => assert.equal(forwardMaxContextTokens(), DEFAULT_FORWARD_MAX_CONTEXT_TOKENS));
    withEnv("0.5", () => assert.equal(forwardMaxContextTokens(), DEFAULT_FORWARD_MAX_CONTEXT_TOKENS));
  });
});

describe("context-guard：token 估算", () => {
  test("纯 ASCII 按 3.6 字符/token 估", () => {
    const n = estimateChatBodyTokens(bodyOfChars(3600));
    assert.equal(n, 1000);
  });

  test("中文按 1 字/token 量级估（不能低估，否则闸门形同虚设）", () => {
    const body = { messages: [{ role: "user", content: "汉".repeat(500) }] };
    // 计数公式给非空内容一个 ≥1 的下限，故 500 字得到 501；关键是量级 = 字数，不是字数/3.6
    const n = estimateChatBodyTokens(body);
    assert.ok(n >= 500 && n <= 502, `中文应约等于字数，实际 ${n}`);
  });

  test("工具面（name/description/schema）计入估算", () => {
    const bare = estimateChatBodyTokens({ messages: [{ role: "user", content: "hi" }] });
    const withTools = estimateChatBodyTokens({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "Read", description: "d".repeat(3600), parameters: {} } }],
    });
    assert.ok(withTools > bare + 900, `工具面应显著计入：bare=${bare} withTools=${withTools}`);
  });

  test("tool_calls 的参数算进上下文", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ function: { name: "Bash", arguments: "y".repeat(3600) } }] },
      ],
    };
    assert.ok(estimateChatBodyTokens(body) > 900);
  });

  test("空 body 不炸，返回 0 或极小值", () => {
    assert.ok(estimateChatBodyTokens({}) <= 1);
    assert.ok(estimateChatBodyTokens({ messages: [] }) <= 1);
  });
});

describe("context-guard：判决", () => {
  test("未超限 → 放行（null）", () => {
    withEnv("2000", () => {
      assert.equal(overForwardLimit(bodyOfChars(3600)), null); // 1000 tokens < 2000
    });
  });

  test("超限 → 给出估算/上限/超出量", () => {
    withEnv("500", () => {
      const r = overForwardLimit(bodyOfChars(7200)); // 2000 tokens
      assert.ok(r, "必须判超限");
      assert.equal(r.estimated, 2000);
      assert.equal(r.limit, 500);
      assert.equal(r.over, 1500);
    });
  });

  test("关闭闸门（limit=0）时一律放行", () => {
    withEnv("0", () => assert.equal(overForwardLimit(bodyOfChars(36000)), null));
  });

  test("恰好在边界上 → 放行（<= 不算超）", () => {
    withEnv("1000", () => assert.equal(overForwardLimit(bodyOfChars(3600)), null));
  });
});

describe("context-guard：给客户端的文案", () => {
  test("必须含 context_length_exceeded（客户端据此触发压缩）", () => {
    const msg = contextGuardMessage({ estimated: 250000, limit: 200000 });
    assert.match(msg, /context_length_exceeded/);
    assert.match(msg, /250000/);
    assert.match(msg, /200000/);
  });

  test("必须明确指向 /compact 与重试", () => {
    const msg = contextGuardMessage({ estimated: 1, limit: 2 });
    assert.match(msg, /compact/i);
    assert.match(msg, /重试/);
  });
});
