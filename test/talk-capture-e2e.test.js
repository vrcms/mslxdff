// e2e（openspec fix-talk-capture-frame-loss）：真 relay() 转发被恶意切分的 SSE 字节流 →
// 收场 flush（relay-pipeline 现姿势）→ recordAgentLoop 落盘 → 从磁盘读回。
// 断言：ASCII 的 tool arguments 逐字完整（丢帧回归的现网形状）；CJK 被切帧整行弃、绝无乱码入档；
// 透传给客户端的字节与上游字节全等（纯旁路红线）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relay } from "../src/routes/stream.js";
import { captureTalkFlush } from "../src/routes/stream-scan.js";
import { recordAgentLoop, flushAgentLoop } from "../src/talk-full.js";

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    wroteRaw: [],
    ended: false,
    _handlers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    write(c) { this.wroteRaw.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8")); return true; },
    end(c) { this.ended = true; if (c != null) this.wroteRaw.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8")); },
    on(k, fn) { (this._handlers[k] ??= []).push(fn); return this; },
    removeListener(k, fn) { const a = this._handlers[k]; if (a) this._handlers[k] = a.filter((f) => f !== fn); return this; },
    emit(k, ...args) { for (const f of [...(this._handlers[k] || [])]) f(...args); },
  };
  return res;
}

test("e2e：恶意切分的 SSE 流经 relay→flush→talkfull 落盘后 arguments 逐字完整", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-e2e-"));
  const oldEnv = { ...process.env };
  delete process.env.MSLXDFF_TALK_LOG; // 缺省开 = 建桶
  delete process.env.MSLXDFF_TALK_FULL; // 缺省开 = 落语料
  process.env.MSLXDFF_DAEMON_DIR = dir;
  try {
    const ARGS = '{"file_path": "D:\\\\www\\\\wwwroot\\\\dcflow\\\\.feature-tree\\\\branches\\\\relay.md"}';
    const fr = (o) => `data: ${JSON.stringify(o)}\n\n`;
    const wire =
      fr({ choices: [{ delta: { content: "你好，" } }] }) +
      fr({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"file_path": "D:\\\\w' } }] } }] }) +
      fr({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ww\\\\wwwroot\\\\dcflow\\\\.feature-tree\\\\bra' } }] } }] }) +
      fr({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'nches\\\\relay.md"}' } }] } }] }) +
      fr({ choices: [{ delta: { content: "世界！" } }] }) +
      fr({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n" +
      // 合成「缺尾换行的末帧」（流被截断的形状）：无 flush 则此行蒸发——让 e2e 真走 flush 路径（review P2-3）
      'data: {"choices":[{"delta":{"content":"收尾"}}]}';
    const bytes = Buffer.from(wire, "utf8");
    // 恶意切点：①第二条 arguments 的 ASCII 中段（丢帧回归的正中形状）②「世」三字节中间（CJK 守卫）③两条帧之间
    const c1 = bytes.indexOf(Buffer.from("bra", "utf8")) + 1;
    const cjk = bytes.indexOf(Buffer.from("世", "utf8")) + 1;
    const cuts = [0, Math.min(c1, cjk), Math.max(c1, cjk), bytes.length];
    const chunks = [];
    for (let i = 0; i < cuts.length - 1; i++) chunks.push(bytes.subarray(cuts[i], cuts[i + 1]));
    assert.ok(chunks.every((c) => c.length > 0), "切点必须都落在流内部");

    const res = fakeRes();
    const upRes = {
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: {
        async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
        cancel() {},
      },
    };
    const body = { stream: true, model: "mock/talk-e2e-m", messages: [{ role: "user", content: "读它" }] };
    const out = await relay(res, upRes, body, { streamTimeoutMs: 0 });
    assert.equal(out.status, 200);
    assert.equal(out.detail.exitReason, "normal");

    // relay-pipeline 的现姿势：record* 读桶前先 flush
    captureTalkFlush(out.detail.talk);

    // 红线 1：透传字节与上游全等（捕获怎么改都不许动下游一个字节）
    assert.equal(Buffer.concat(res.wroteRaw).equals(bytes), true, "客户端收到的字节必须与上游逐字节一致");
    // 红线 2：语料侧 arguments 逐字完整（改前此处会少一截——正是 43% 落空的机理）
    assert.equal(out.detail.talk.tools.length, 1);
    assert.equal(out.detail.talk.tools[0].function.arguments, ARGS, "跨 chunk 的 arguments 碎片必须原样拼回");
    // 红线 3：被切成不可逆半字的帧整行弃——宁缺毋滥，绝无 U+FFFD；丢弃必须显式计数（review P1-1）
    assert.equal(out.detail.talk.content.join(""), "你好，收尾", "CJK 断字帧整行弃（记 dropped），完整帧与 flush 回收的末行照常入档");
    assert.ok(!out.detail.talk.content.join("").includes("\uFFFD"));
    assert.equal(out.detail.talk.dropped, 1, "被丢弃的 CJK 帧必须留数，不许静默");

    // 真落盘：recordAgentLoop → flushAgentLoop → 读回 jsonl
    const wrote = recordAgentLoop({ reqId: "e2e-req", api: "chat", model: "mock/talk-e2e-m", via: "local", hops: 0, body, out, sessionKey: "ses_e2e", clientIp: "127.0.0.1", attemptMs: out.totalMs, relayMs: out.totalMs });
    assert.equal(wrote, true, "recordAgentLoop 应受理");
    await flushAgentLoop();
    const fullDir = join(dir, "talk", "full");
    const files = readdirSync(fullDir);
    assert.equal(files.length, 1, `应有且仅有一个语料文件：${files}`);
    const lines = readFileSync(join(fullDir, files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    const rec = lines[0];
    assert.equal(JSON.stringify(rec.response.toolCalls[0].function.arguments), JSON.stringify(ARGS), "落盘回读：arguments 仍逐字完整");
    assert.deepEqual(JSON.parse(rec.response.toolCalls[0].function.arguments), { file_path: "D:\\www\\wwwroot\\dcflow\\.feature-tree\\branches\\relay.md" }, "回读的 arguments 必须可 JSON.parse 且路径完整");
    assert.equal(rec.response.content, "你好，收尾", "磁盘回读：flush 回收的末帧必须在场");
    assert.equal(rec.meta.truncated, false);
    assert.equal(rec.meta.droppedFrames, 1, "落盘读数：不可逆丢弃必须显式可见（P1-1），truncated=false 不再是「假完整」");
  } finally {
    for (const k of ["MSLXDFF_DAEMON_DIR"]) if (!(k in oldEnv)) delete process.env[k]; else process.env[k] = oldEnv[k];
    Object.assign(process.env, { MSLXDFF_TALK_LOG: oldEnv.MSLXDFF_TALK_LOG, MSLXDFF_TALK_FULL: oldEnv.MSLXDFF_TALK_FULL });
    if (oldEnv.MSLXDFF_TALK_LOG === undefined) delete process.env.MSLXDFF_TALK_LOG;
    if (oldEnv.MSLXDFF_TALK_FULL === undefined) delete process.env.MSLXDFF_TALK_FULL;
    rmSync(dir, { recursive: true, force: true });
  }
});
