// 门归属端到端：同一模型先后经三道门（/v1/chat/completions、/v1/responses、/v1/messages）各打一发，
// 四类日志身份（calls.log / talk/*.log / talk/full/*.jsonl / <模型>.log）必须各带本次的门短码。
// 这条文件就是用户报障「日志把 v1/messages 和 v1/chat/completions 混一起」的证伪器：
// 任何一处写点漏传 api，该处就会缺字段；任何一处把门写死，别的门就会串味。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import * as realLogs from "../src/logs.js";
import { talkLogFile, resetTalkLogCache } from "../src/talk-log.js"; // talk-log 缓存日志目录 → 换 env 必须重置，否则路径指回旧根
import { agentLoopFile, flushAgentLoop } from "../src/talk-full.js";
import { modelLogFile, appendModelTrace } from "../src/model-trace.js";

const TOKEN = "a".repeat(64);
const MODEL = "apikind/model-x";
const ALL_KINDS = ["chat", "responses", "messages", "other"];
// logs 门面必须含 appendModelTrace：src/logs.js 不导出它（真网关由 runtime/bootstrap.js 组装门面），
// 而 pipeline 用可选调用 logs?.appendModelTrace?.() —— 门面缺这一块时轨迹槽**静默不写**，正是本测试要抓的那类漏。
const LOGS_FACADE = { ...realLogs, appendModelTrace };

const DOORS = [
  { kind: "chat", path: "/v1/chat/completions", body: () => ({ model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] }) },
  { kind: "responses", path: "/v1/responses", body: () => ({ model: MODEL, stream: true, input: "hi" }) },
  { kind: "messages", path: "/v1/messages", body: () => ({ model: MODEL, stream: true, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }) },
];

// 上游一律按 OpenAI SSE 回（三门内部都折成 chat 打上游）
function sseUpstream() {
  const srv = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  await res.text(); // 流式也要读完，收尾才会落日志
  return res.status;
}

/** 落盘可能是微任务级延后：轮询到出现为止，超时即失败（不用 sleep 猜时长）。 */
async function readWhen(file, { timeoutMs = 4000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8").trim();
      if (text) return text;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等不到落盘内容: ${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function withEnv(dir, fn) {
  const keys = ["MSLXDFF_DAEMON_DIR", "MSLXDFF_TALK_LOG", "MSLXDFF_TALK_FULL", "MSLXDFF_USAGE_LOG"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { MSLXDFF_DAEMON_DIR: dir, MSLXDFF_TALK_LOG: "1", MSLXDFF_TALK_FULL: "1", MSLXDFF_USAGE_LOG: "0" });
  resetTalkLogCache(); // talkDir() 有缓存：env 换根后不重置，talk 文件会落在旧根（本文件踩过）
  try { return await fn(); } finally {
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    resetTalkLogCache(); // 恢复后同样重置，别把本文件的日志根漏给别的测试
  }
}

for (const door of DOORS) {
  test(`门归属端到端：${door.path} → 四类日志都带 api=${door.kind}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "mslxdff-apikind-"));
    const up = await sseUpstream();
    const client = createUpstreamClient({ baseUrl: `http://127.0.0.1:${up.address().port}`, retry: {} });
    const srv = startServer({ router: createRouter({ token: TOKEN, upstream: client, logs: LOGS_FACADE }) }, 0);
    await srv.ready();
    try {
      // 取名必须在 env 生效期内：withEnv 一恢复 env，路径 helper 就会指回默认根（那会读到真实用户日志）
      let paths;
      const status = await withEnv(dir, async () => {
        const st = await post(srv.server.address().port, door.path, door.body());
        await flushAgentLoop();
        paths = { talk: talkLogFile(MODEL), full: agentLoopFile(MODEL), trace: modelLogFile(MODEL) };
        return st;
      });
      assert.equal(status, 200, `${door.path} 未 200，后面的断言都无意义`);

      // 1) calls.log（JSONL）
      const rows = (await readWhen(join(dir, "calls.log"))).split("\n").map((l) => JSON.parse(l));
      const row = rows[rows.length - 1];
      assert.equal(row.api, door.kind, `calls.log 行的 api 应为 ${door.kind}，实为 ${JSON.stringify(row.api)}`);
      for (const other of ALL_KINDS.filter((k) => k !== door.kind)) {
        assert.doesNotMatch(await readWhen(join(dir, "calls.log")), new RegExp(`"api":"${other}"`), `calls.log 串进了别的门 ${other}`);
      }

      // 2) talk/<模型>-talk.log（人读头行）
      const talk = await readWhen(paths.talk);
      assert.match(talk, new RegExp(`\\bapi=${door.kind}\\b`), `talk 头行缺 api=${door.kind}：${talk.split("\n")[0]}`);

      // 3) talk/full/*.jsonl（机读语料，记录级字段）
      const fullFile = paths.full;
      const rec = JSON.parse((await readWhen(fullFile)).split("\n").pop());
      assert.equal(rec.api, door.kind, "talkfull 记录级 api 不符");

      // 4) <模型>.log（带 reqId 的轨迹）
      const trace = await readWhen(paths.trace);
      assert.match(trace, new RegExp(`incoming api=${door.kind}\\b`), `轨迹 incoming 行缺 api=${door.kind}：${(trace.match(/incoming .*/g) || []).slice(-1)}`);
    } finally {
      await srv.close().catch(() => {});
      srv.server.closeAllConnections?.();
      up.closeAllConnections?.();
      await new Promise((r) => up.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("门归属：三门分别落码，互不串味（把任一处的门写死就会在这里红）", async () => {
  const seen = {};
  for (const door of DOORS) {
    const dir = mkdtempSync(join(tmpdir(), "mslxdff-apikind2-"));
    const up = await sseUpstream();
    const client = createUpstreamClient({ baseUrl: `http://127.0.0.1:${up.address().port}`, retry: {} });
    const srv = startServer({ router: createRouter({ token: TOKEN, upstream: client, logs: LOGS_FACADE }) }, 0);
    await srv.ready();
    try {
      await withEnv(dir, async () => { await post(srv.server.address().port, door.path, door.body()); });
      const rows = (await readWhen(join(dir, "calls.log"))).split("\n").map((l) => JSON.parse(l));
      seen[door.kind] = rows[rows.length - 1].api;
    } finally {
      await srv.close().catch(() => {});
      srv.server.closeAllConnections?.();
      up.closeAllConnections?.();
      await new Promise((r) => up.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(seen, { chat: "chat", responses: "responses", messages: "messages" });
});
