import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { responsesToChatBody } from "../src/responses/translate.js";
import { toModelPrompt } from "../src/upstream-engine/sdk/convert.js";
import { chatToResponsesBody } from "../src/upstream-responses.js";

// 复现 2026-09-22：用户向 ocgo/muse-spark 发图，模型说"看不到"——
// 三层转换链逐层把图丢掉。本组用例锁住：图片必须穿过全链到达上游请求体。
const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${B64}`;

describe("responses 链路图片透传（修模型看不到图）", () => {
  test("L1 入站：/v1/responses input 里的 input_image → chat image_url content part（不再丢弃）", () => {
    const body = responsesToChatBody({
      model: "ocgo/muse-spark-1.3-contributor",
      input: [
        {
          type: "message", role: "user",
          content: [
            { type: "input_text", text: "这张图里是什么？" },
            { type: "input_image", image_url: DATA_URL },
          ],
        },
      ],
      stream: true,
    });
    const u = body.messages.find((m) => m.role === "user");
    assert.ok(Array.isArray(u.content), "有图时 content 应为多模态数组");
    const text = u.content.find((p) => p.type === "text");
    const img = u.content.find((p) => p.type === "image_url");
    assert.equal(text?.text, "这张图里是什么？");
    assert.equal(img?.image_url?.url, DATA_URL, "图片必须保留（此前被静默丢弃）");
  });

  test("L2 出站（AI SDK 路径）：image_url → file part（image/*）→ 上游 input_image", () => {
    const prompt = toModelPrompt([
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: DATA_URL } }] },
    ]);
    const parts = prompt[0].content;
    // AI SDK v3 契约：image 载体 = file part；{type:"image"} 会被 SDK 序列化成 null 发上游 → 400
    const fp = parts.find((p) => p.type === "file");
    assert.ok(fp, "必须是 file part（responses 适配器对 image/* 产出 input_image）");
    assert.equal(fp.mediaType, "image/png", "data URL 的真实 mediaType 必须保留（通配会被强转 jpeg）");
    assert.ok(parts.some((p) => p.type === "text"), "文本并存");
  });

  test("L2 出站（AI SDK 路径）：http(s) 图片 URL → file part 带绝对地址", () => {
    const prompt = toModelPrompt([
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] },
    ]);
    const fp = prompt[0].content.find((p) => p.type === "file");
    assert.ok(fp, "URL 图片也应成为 file part");
    assert.equal(String(fp.data), "https://example.com/a.png");
    assert.equal(fp.mediaType, "image/*", "无 data URL 头时回退通配");
  });

  test("L3 出站（原生兜底路径）：chatToResponsesBody 把图转成 responses 规范 input_image item", () => {
    const out = chatToResponsesBody({
      model: "muse-spark-1.3-contributor",
      messages: [
        { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: DATA_URL } }] },
      ],
      stream: false,
    });
    assert.ok(Array.isArray(out.input), "有图时 input 应为 item 数组");
    const textItem = out.input.find((x) => x.type === "input_text");
    const imgItem = out.input.find((x) => x.type === "input_image");
    assert.equal(textItem?.text, "user: 看图");
    assert.equal(imgItem?.image_url, DATA_URL, "图片必须以 input_image 到达上游（此前拍平纯文本）");
  });

  test("纯文本请求 input 形状不变（string，无回归）", () => {
    const out = chatToResponsesBody({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(typeof out.input, "string");
    assert.equal(out.input, "user: hi");
    const body = responsesToChatBody({ model: "m", input: [{ type: "message", role: "user", content: "hi" }], stream: true });
    assert.equal(body.messages[0].content, "hi");
  });
});
