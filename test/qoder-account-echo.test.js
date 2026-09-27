// qoder 账号轮换可观测：runChat 返回的 Response 必须回显本次请求的
// x-mslxdff-upstream（host）与 x-mslxdff-qoder-region（cn|global），
// 不落凭据；模型日志由管线层读取这两个头，才知道"这次谁上的、打哪个站"。
// 背景：qoder 多账号分属 cn/global 两区，keyring 每请求轮换 → URL 跟着切，
// 但此前 provider 内部选号完全静默，模型日志看不到任何切换痕迹。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatService } from "../src/providers/qoder/chat.js";

const sess = { identity: { userType: "personal_standard", securityOauthToken: "dt-x" }, machineId: "m", machineToken: "t" };
const frame = (j) => `data: ${JSON.stringify({ headers: {}, body: JSON.stringify(j), statusCodeValue: 200 })}\n\n`;
const okBody = (c) => frame({ choices: [{ delta: { content: c } }] }) + frame({ usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "data: [DONE]\n\n";

test("成功路径回显 upstream host 与 region（cn）", async () => {
  const svc = createChatService({ fetchImpl: async () => new Response(okBody("A"), { status: 200 }), timeoutMs: 5000 });
  const res = await svc.runChat({ model: "qfmodel", messages: [{ role: "user", content: "hi" }], stream: false }, sess, "cn");
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get("x-mslxdff-upstream") || ""), /gateway\.qoder\.com\.cn/, "cn 区应回显 cn 域名");
  assert.equal(res.headers.get("x-mslxdff-qoder-region"), "cn");
});

test("成功路径回显 upstream host 与 region（global）", async () => {
  const svc = createChatService({ fetchImpl: async () => new Response(okBody("B"), { status: 200 }), timeoutMs: 5000 });
  const res = await svc.runChat({ model: "qfmodel", messages: [{ role: "user", content: "hi" }], stream: false }, sess, "global");
  assert.match(String(res.headers.get("x-mslxdff-upstream") || ""), /api1\.qoder\.sh/, "global 区应回显 api1.qoder.sh");
  assert.equal(res.headers.get("x-mslxdff-qoder-region"), "global");
});

test("错误路径同样回显（401 JSON 与流内 error 都带账号头）", async () => {
  const svc = createChatService({ fetchImpl: async () => new Response("nope", { status: 401 }), timeoutMs: 5000 });
  const j = await svc.runChat({ model: "qfmodel", messages: [], stream: false }, sess, "global");
  assert.equal(j.status, 401);
  assert.equal(j.headers.get("x-mslxdff-qoder-region"), "global");
  const s = await svc.runChat({ model: "qfmodel", messages: [], stream: true }, sess, "global");
  assert.equal(s.status, 200);
  assert.equal(s.headers.get("x-mslxdff-qoder-region"), "global");
});

test("fetch 异常路径也回显（502 JSON 带 region 头）", async () => {
  const svc = createChatService({ fetchImpl: async () => { throw new Error("boom"); }, timeoutMs: 5000 });
  const r = await svc.runChat({ model: "qfmodel", messages: [], stream: false }, sess, "cn");
  assert.equal(r.status, 502);
  assert.equal(r.headers.get("x-mslxdff-qoder-region"), "cn");
});
