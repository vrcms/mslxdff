import { test, describe } from "node:test";
import assert from "node:assert/strict";

// 红阶段：模块尚不存在，应报 MODULE_NOT_FOUND
import { isResponsesModel, chatToResponsesBody, responsesToChatJson } from "../src/upstream-responses.js";

describe("upstream responses 转换层", () => {
  test("US1 muse-spark 走 responses，其余走 chat", () => {
    assert.equal(isResponsesModel("muse-spark-1.2-contributor-free"), true);
    assert.equal(isResponsesModel("MUSE-SPARK-X"), true);
    assert.equal(isResponsesModel("big-pickle"), false);
    assert.equal(isResponsesModel(""), false);
  });

  test("US2 chat body 转 responses：system 进 instructions", () => {
    const out = chatToResponsesBody({
      model: "muse-spark-1.2",
      messages: [
        { role: "system", content: "sys-prompt" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 100,
    });
    assert.equal(out.model, "muse-spark-1.2");
    assert.equal(out.instructions, "sys-prompt");
    assert.match(out.input, /user: hi/);
    assert.equal(out.max_output_tokens, 100);
    assert.equal(out.stream, false);
  });

  test("US3 responses 成功态转回 chat 形状", () => {
    const chat = responsesToChatJson({
      id: "resp_1",
      model: "muse-spark-1.2",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    });
    assert.equal(chat.object, "chat.completion");
    assert.equal(chat.choices[0].message.content, "hello");
    assert.equal(chat.choices[0].finish_reason, "stop");
    assert.equal(chat.usage.completion_tokens, 10);
  });
});
