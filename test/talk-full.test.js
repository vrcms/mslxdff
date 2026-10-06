// agent 回路全量捕获（talk/full lane）：缺省开（opt-out，显式关闭词才停写）、hops=0 才落、双层脱敏、JSONL 单条自足、单队列异步落盘 + 按字节轮转。
// 隔离：MSLXDFF_DAEMON_DIR 指向 mkdtemp；MSLXDFF_TALK_FULL 按 case 显式设/删（模块按调用读 env，与 talkLogEnabled 同构）。
// 正文桶用字面量构造（不 import 并行改动中的 stream-scan.js），本模块只读 reasoning/content/tools/n/capped 五字段。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentLoopEnabled, agentLoopDir, agentLoopFile, talkCapChars, recordAgentLoop, flushAgentLoop } from "../src/talk-full.js";
import { composeLine, shapeForCapture } from "../src/talk-full-redact.js";

const ENV_KEYS = ["MSLXDFF_DAEMON_DIR", "MSLXDFF_TALK_FULL", "MSLXDFF_TALK_CAP_CHARS", "MSLXDFF_TALK_FULL_MAX_MB", "MSLXDFF_TALK_FULL_KEEP", "MSLXDFF_TALK_FULL_MAX_LINE_MB"];
const DEF = { MSLXDFF_TALK_FULL: undefined }; // 未设 env = 缺省开（§2.1 口径）
const OFFWORD = { MSLXDFF_TALK_FULL: "0" };   // 显式关闭词（0/off/false/no/disable）
const MB = 1024 * 1024;

/** 每用例独立临时日志根；env 值为 undefined = 删除该键。 */
async function withCapture(fn, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-talkfull-"));
  const old = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.MSLXDFF_DAEMON_DIR = dir;
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(dir); } finally {
    for (const k of ENV_KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    await flushAgentLoop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 排空写队列后读该模型的全部行；逐行 JSON.parse，坏行 = 失败并带行号。 */
async function flushRows(dir, model) {
  await flushAgentLoop();
  const file = agentLoopFile(model);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`第 ${i + 1} 行不是合法 JSON: ${e.message} :: ${l.slice(0, 120)}`); }
  });
}
const bucket = (over = {}) => ({ reasoning: [], content: [], tools: [], n: 0, capped: false, ...over });
const sha1hex = (s) => createHash("sha1").update(String(s)).digest("hex"); const norm = (raw) => `${sha1hex(raw).slice(-12)}-${String(raw).slice(0, 8)}`; // 落盘形态：sha1尾12-原值前8
const fullEnv = (over = {}) => ({ MSLXDFF_TALK_FULL: "1", ...over });
const goodOut = (talk) => ({ status: 200, totalMs: 1234, detail: { sawFinishReason: "stop", usage: { prompt_tokens: 11, completion_tokens: 22 }, talk } });

const IMG_URL = "data:image/png;base64,AAAABBBBCCCCDDDD" + "E".repeat(300);
function sampleBody(extra = {}) {
  return {
    model: "qoder/qfmodel",
    messages: [
      { role: "system", content: "你是 skill 正文：调用 read_file 前先确认路径" },
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: IMG_URL } }] },
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "读文件全文", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    temperature: 0.3, max_tokens: 1024, stream: true, top_p: 1,
    ...extra,
  };
}

test("开关矩阵：缺省开、显式关闭词才关（未设/1/true/on/yes/任意其它值 = 开）", async () => {
  await withCapture(() => assert.equal(agentLoopEnabled(), true, "未设 env = 缺省开"), DEF);
  for (const w of ["1", "true", "on", "yes", "banana", "TRUE", " On "]) {
    await withCapture(() => assert.equal(agentLoopEnabled(), true, `${JSON.stringify(w)} = 开（非关闭词不静默变关）`), { MSLXDFF_TALK_FULL: w });
  }
  for (const w of ["0", "off", "false", "no", "disable", " 0 ", "OFF", " Disable "]) {
    await withCapture(() => assert.equal(agentLoopEnabled(), false, `${JSON.stringify(w)} 关（trim+lowercase）`), { MSLXDFF_TALK_FULL: w });
  }
});

test("talkCapChars 单一真相：env 覆盖 > 缺省开 200 万 > 显式关 40 万（§2.2 档位矩阵）", async () => {
  await withCapture(() => assert.equal(talkCapChars(), 2_000_000, "未设 env = 缺省开档"), DEF);
  await withCapture(() => assert.equal(talkCapChars(), 400_000, "显式关 = 40 万档"), OFFWORD);
  await withCapture(() => assert.equal(talkCapChars(), 12345, "正数 env 覆盖优先"), fullEnv({ MSLXDFF_TALK_CAP_CHARS: "12345" }));
  await withCapture(() => assert.equal(talkCapChars(), 123, "覆盖在显式关态同样生效"), { MSLXDFF_TALK_FULL: "0", MSLXDFF_TALK_CAP_CHARS: "123" });
  await withCapture(() => assert.equal(talkCapChars(), 123, "覆盖在缺省开态同样生效"), { MSLXDFF_TALK_CAP_CHARS: "123" });
});

test("目录与文件名：<日志根>/talk/full/<供应商>-<模型>-talkfull.jsonl", async () => {
  await withCapture(() => {
    assert.equal(agentLoopDir(), join(process.env.MSLXDFF_DAEMON_DIR, "talk", "full"));
    assert.equal(agentLoopFile("qoder/qfmodel"), join(agentLoopDir(), "qoder-qfmodel-talkfull.jsonl"));
    assert.equal(agentLoopFile("deepseek-v3"), join(agentLoopDir(), "deepseek-v3-talkfull.jsonl"));
    assert.equal(agentLoopFile("../../secret"), join(agentLoopDir(), "secret-talkfull.jsonl"), "路径穿越被安全化");
  }, fullEnv());
});

test("显式关闭（MSLXDFF_TALK_FULL=0）：返回 false 且不创建 talk/full 目录", async () => {
  await withCapture((dir) => {
    assert.equal(agentLoopEnabled(), false);
    assert.equal(recordAgentLoop({ reqId: "r1", model: "qoder/qfmodel", hops: 0, body: sampleBody(), out: goodOut(bucket()), clientIp: "127.0.0.1" }), false);
    assert.equal(existsSync(join(dir, "talk")), false, "关闭态连 talk/ 都不该被动（spec：关闭态 MUST NOT 建目录）");
  }, OFFWORD);
});

test("缺省态（未设 env）：recordAgentLoop 受理并落盘（spec：缺省启动即捕获）", async () => {
  await withCapture(async (dir) => {
    assert.equal(agentLoopEnabled(), true, "未设 env = 开");
    assert.equal(recordAgentLoop({ reqId: "r1", model: "qoder/qfmodel", hops: 0, body: sampleBody(), out: goodOut(bucket()), clientIp: "127.0.0.1" }), true);
    const rows = await flushRows(dir, "qoder/qfmodel");
    assert.equal(rows.length, 1, "缺省态就落盘，不再要求先设 =1");
    assert.equal(rows[0].reqId, "r1");
  }, DEF);
});

test("hops>0 不落（组员转发）；hops=0 落且 clientIp 在场", async () => {
  await withCapture(async (dir) => {
    assert.equal(recordAgentLoop({ reqId: "peer", model: "qoder/qfmodel", hops: 1, body: sampleBody(), out: goodOut(bucket()) }), false, "hops=1 不落");
    assert.equal(recordAgentLoop({ reqId: "peer2", model: "qoder/qfmodel", hops: "2", body: sampleBody(), out: goodOut(bucket()) }), false, "字符串 hops 也拦");
    assert.equal(existsSync(agentLoopFile("qoder/qfmodel")), false);
    assert.equal(recordAgentLoop({ reqId: "local", model: "qoder/qfmodel", via: "local", hops: 0, body: sampleBody(), out: goodOut(bucket()), clientIp: "203.0.113.7" }), true);
    const rows = await flushRows(dir, "qoder/qfmodel");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clientIp, "203.0.113.7", "hops=0 的记录带 clientIp 供核对");
    assert.equal(rows[0].hops, 0);
  }, fullEnv());
});

test("全空判据：两侧全空且 status!==200 不落；status=200 的空轮照样留档", async () => {
  await withCapture(async (dir) => {
    assert.equal(recordAgentLoop({ reqId: "e1", model: "a/b", hops: 0, body: { messages: [] }, out: { status: 502, detail: {} } }), false);
    assert.equal(recordAgentLoop({ reqId: "e2", model: "a/b", hops: 0, body: null, out: null }), false, "入参残缺也不抛、不落");
    assert.equal(existsSync(agentLoopFile("a/b")), false);
    assert.equal(recordAgentLoop({ reqId: "e3", model: "a/b", hops: 0, body: { messages: [] }, out: { status: 200, detail: {} } }), true, "200 空轮留档（failover 各成一条的底座）");
    const rows = await flushRows(dir, "a/b");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].request.messages, []);
    assert.equal(rows[0].status, 200);
  }, fullEnv());
});

test("记录形状：字段冻结齐全、请求侧全量、图片部件摘要化、params 只收标量", async () => {
  await withCapture(async (dir) => {
    const body = sampleBody();
    const before = JSON.stringify(body);
    const talk = bucket({ content: ["回答正文"], reasoning: ["思考"], n: 8 });
    assert.equal(recordAgentLoop({ reqId: "r9", model: "qoder/qfmodel", via: "local", hops: 0, body, out: goodOut(talk), sessionKey: "ses_fixed", clientIp: "10.0.0.2", echo: { upstream: "api.qoder.sh", account: "global", pick: "sticky", cooled: "1" } }), true);
    const [row] = await flushRows(dir, "qoder/qfmodel");
    for (const k of ["ts", "time", "reqId", "sessionKey", "clientIp", "model", "via", "hops", "status", "stream", "elapsedMs", "usage", "finishReason", "upstream", "account", "pick", "request", "response", "meta"]) assert.ok(k in row, `缺字段 ${k}`);
    for (const k of ["requestBytes", "responseChars", "reasoningChars", "truncated", "cap", "relayMs"]) assert.ok(k in row.meta, `缺 meta.${k}`);
    assert.equal(row.reqId, "r9");
    assert.equal(row.status, 200);
    assert.equal(row.stream, 1, "stream 用 1/0");
    assert.equal(row.elapsedMs, 1234, "无 attemptMs 时回退 out.totalMs（elapsed 与 relayMs 同值）");
    assert.equal(row.meta.relayMs, 1234, "relay 内部计时恒写 meta.relayMs（§2.4/§3.5）");
    assert.deepEqual(row.usage, { prompt_tokens: 11, completion_tokens: 22 });
    assert.equal(row.finishReason, "stop");
    assert.equal(row.upstream, "api.qoder.sh");
    assert.equal(row.account, "global");
    assert.equal(row.pick, "sticky");
    assert.match(row.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(row.sessionKey, norm("ses_fixed"), "落盘形态 = sha1尾12-原值前8");
    assert.equal(row.request.model, "qoder/qfmodel");
    assert.equal(row.request.messages.length, 2, "system+user 全量在场（不像 talk.log 只留最后一条）");
    assert.ok(row.request.messages[0].content.includes("skill 正文"), "system prompt 全文落盘");
    assert.equal(row.request.messages[1].content[1], `[图片 ${IMG_URL.slice(0, 60)}]`, "图片部件只留前 60 字");
    assert.ok(!JSON.stringify(row).includes("E".repeat(100)), "图片料不留");
    assert.equal(row.request.tools?.[0]?.function?.name, "read_file");
    assert.deepEqual(row.request.params, { temperature: 0.3, max_tokens: 1024, stream: true, top_p: 1 }, "params 只收标量键");
    assert.equal(row.response.content, "回答正文");
    assert.equal(row.response.reasoning, "思考");
    assert.equal(row.meta.responseChars, 8, "桶的 n 显式写出");
    assert.equal(row.meta.reasoningChars, 2);
    assert.equal(row.meta.truncated, false);
    assert.equal(row.meta.cap, 2_000_000);
    assert.ok(row.meta.requestBytes > 0);
    assert.equal(JSON.stringify(body), before, "捕获不改调用方的 body（只读旁路）");
  }, fullEnv());
});

test("递归字段黑名单：api_key/accessToken/token 被抹，同层业务字段原样", async () => {
  await withCapture(async (dir) => {
    const body = {
      messages: [
        { role: "user", content: "查一下" },
        { role: "tool", tool_call_id: "c1", content: '{"api_key":"LEAKVALUE123456","region":"cn-east","retry":3}' },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "call_upstream", arguments: '{"accessToken":"SECRETTOKEN98765","endpoint":"https://x.example"}' } }] },
        { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "ok", token: "TOKINARRAYVALUE99" }] },
      ],
    };
    const talk = bucket({ content: ["ok"], n: 2 });
    assert.equal(recordAgentLoop({ reqId: "rk", model: "a/b", hops: 0, body, out: goodOut(talk) }), true);
    const rows = await flushRows(dir, "a/b");
    const text = JSON.stringify(rows);
    for (const leak of ["LEAKVALUE123456", "SECRETTOKEN98765", "TOKINARRAYVALUE99"]) assert.ok(!text.includes(leak), `${leak} 不得出现在盘上`);
    const [row] = rows;
    const toolMsg = JSON.parse(row.request.messages[1].content);
    assert.equal(toolMsg.api_key, "[已脱敏]");
    assert.equal(toolMsg.region, "cn-east", "同层业务字段原样");
    assert.equal(toolMsg.retry, 3);
    const args = JSON.parse(row.request.messages[2].tool_calls[0].function.arguments);
    assert.equal(args.accessToken, "[已脱敏]");
    assert.equal(args.endpoint, "https://x.example", "同层业务字段原样");
    assert.equal(row.request.messages[3].content[0].token, "[已脱敏]");
    assert.equal(row.request.messages[3].content[0].text, "ok", "同层业务字段原样");
  }, fullEnv());
});

test("文本形态凭据：sk- 密钥与 JWT 落盘前被抹", async () => {
  await withCapture(async (dir) => {
    const body = { messages: [{ role: "user", content: "我的 key 是 sk-abcdefghijklmnopqrstuvwx，票据 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234，查一下天气" }] };
    assert.equal(recordAgentLoop({ reqId: "rm", model: "a/b", hops: 0, body, out: goodOut(bucket({ content: ["ok"], n: 2 })) }), true);
    const rows = await flushRows(dir, "a/b");
    const text = JSON.stringify(rows);
    assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwx"), "sk- 串被抹");
    assert.ok(!text.includes("eyJzdWIi"), "JWT 载荷被抹");
    assert.ok(text.includes("查一下天气"), "业务文本可读");
  }, fullEnv());
});

test("整串正则误伤防线：值收尾撞上脱敏正则时该行仍是合法 JSON 且原值不落盘", async () => {
  await withCapture(async (dir) => {
    const body = { messages: [{ role: "user", content: "帮我把 header 设成 x-api-key: SUPERSECRETHEADERVALUE0000" }] };
    assert.equal(recordAgentLoop({ reqId: "rn", model: "a/b", hops: 0, body, out: goodOut(bucket({ content: ["ok"], n: 2 })) }), true);
    const [row] = await flushRows(dir, "a/b");
    assert.ok(!JSON.stringify(row).includes("SUPERSECRETHEADERVALUE0000"), "头形态凭据仍被抹");
    assert.ok(row.request.messages[0].content.startsWith("帮我把 header 设成"), "正文其余部分保留");
  }, fullEnv());
});

test("并发灌 50 条零撕裂：逐行可解析、50 个 reqId 一个不少", async () => {
  await withCapture(async (dir) => {
    const talk = bucket({ content: ["x".repeat(20000)], n: 20000 });
    for (let i = 0; i < 50; i++) {
      assert.equal(recordAgentLoop({ reqId: `c${i}`, model: "a/b", hops: 0, body: { messages: [{ role: "user", content: `q${i}` }] }, out: { status: 200, detail: { talk } } }), true);
    }
    const rows = await flushRows(dir, "a/b");
    assert.equal(rows.length, 50);
    assert.equal(new Set(rows.map((r) => r.reqId)).size, 50, "零撕裂、零丢条");
  }, fullEnv());
});

test("单条超限降级：messages 换结构摘要、truncated=true、行字节不超上限", async () => {
  await withCapture(async (dir) => {
    const body = { messages: [{ role: "user", content: "u".repeat(1_400_000) }] };
    assert.equal(recordAgentLoop({ reqId: "big", model: "a/b", hops: 0, body, out: goodOut(bucket({ content: ["ok"], n: 2 })) }), true);
    const rows = await flushRows(dir, "a/b");
    assert.equal(rows.length, 1, "记录不丢");
    const row = rows[0];
    assert.equal(row.meta.truncated, true, "降级必须显式");
    assert.equal(row.reqId, "big", "元信息仍在");
    const sum = row.request.messages[0];
    assert.deepEqual(Object.keys(sum).sort(), ["chars", "hash", "head", "i", "role"], "摘要形状 {i,role,chars,hash,head}");
    assert.equal(sum.role, "user");
    assert.equal(sum.chars, 1_400_000, "字符数读数保留");
    assert.match(sum.hash, /^[0-9a-f]{8}$/, "sha1 尾 8");
    assert.equal(sum.head.length, 500, "首 500 字");
    assert.ok(Buffer.byteLength(readFileSync(agentLoopFile("a/b"), "utf8"), "utf8") <= MB, "总字节 ≤ 上限");
  }, fullEnv({ MSLXDFF_TALK_FULL_MAX_LINE_MB: "1" }));
});

test("缺省 MAX_LINE_MB 下 1.4MB 记录不触发降级", async () => {
  await withCapture(async (dir) => {
    const body = { messages: [{ role: "user", content: "v".repeat(1_400_000) }] };
    recordAgentLoop({ reqId: "norm", model: "a/b", hops: 0, body, out: goodOut(bucket({ content: ["ok"], n: 2 })) });
    const rows = await flushRows(dir, "a/b");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.truncated, false);
    assert.equal(typeof rows[0].request.messages[0].content, "string", "未超限 → messages 保持原形状");
  }, fullEnv());
});

test("按字节轮转：旧份 ≤KEEP、总占用有上界、当前文件逐行可解析", async () => {
  await withCapture(async (dir) => {
    const keep = 2;
    const talk = bucket({ content: ["x".repeat(100_000)], n: 100_000 });
    for (let i = 0; i < 30; i++) recordAgentLoop({ reqId: `rot${i}`, model: "a/b", hops: 0, body: { messages: [{ role: "user", content: `r${i}` }] }, out: { status: 200, detail: { talk } } });
    await flushAgentLoop();
    const dir2 = join(dir, "talk", "full");
    const names = readdirSync(dir2).filter((n) => n.startsWith("a-b-talkfull.jsonl"));
    const olds = names.filter((n) => /^a-b-talkfull\.jsonl\.\d+$/.test(n)).map((n) => Number(n.split(".").pop()));
    assert.ok(olds.length >= 1, "至少轮转出一份旧文件");
    assert.ok(olds.length <= keep, `旧份数 ≤KEEP（实际 ${olds.length}）`);
    assert.ok(Math.max(...olds) <= keep, "序号不超 KEEP");
    assert.ok(names.includes("a-b-talkfull.jsonl"), "当前文件在场（轮转后仍继续写）");
    const total = names.reduce((acc, n) => acc + statSync(join(dir2, n)).size, 0);
    assert.ok(total <= (keep + 1) * (MB + 150 * 1024), `总占用有上界（实际 ${total}）`);
    const rows = await flushRows(dir, "a/b");
    assert.ok(rows.length >= 1, "当前文件逐行可解析");
  }, fullEnv({ MSLXDFF_TALK_FULL_MAX_MB: "1", MSLXDFF_TALK_FULL_KEEP: "2" }));
});

test("sessionKey：无头跨 10 轮（换模型）稳定；带头以头为唯一派生源；不同会话不同键", async () => {
  await withCapture(async (dir) => {
    const mk = (reqId, model, user, extra = {}) => ({ reqId, model, hops: 0, body: { messages: [{ role: "system", content: "SYS" }, { role: "user", content: user }] }, out: { status: 200, detail: {} }, ...extra });
    for (let i = 0; i < 10; i++) assert.equal(recordAgentLoop(mk(`s${i}`, i % 2 ? "p/m2" : "p/m1", "同一会话")), true);
    await flushAgentLoop();
    const rows = [...await flushRows(dir, "p/m1"), ...await flushRows(dir, "p/m2")];
    assert.equal(rows.length, 10);
    assert.equal(new Set(rows.map((r) => r.sessionKey)).size, 1, "10 轮同键，切模型不漂");
    assert.equal(new Set(rows.map((r) => r.reqId)).size, 10, "reqId 各不相同");
    const derived = rows[0].sessionKey;
    assert.match(derived, /^[0-9a-f]{12}-.{1,8}$/, "归一化形态 sha1尾12-原值前8");
    assert.equal(recordAgentLoop(mk("h1", "p/m1", "同一会话", { sessionKey: "ses_headvalue_9f8e7d" })), true);
    assert.equal(recordAgentLoop(mk("h2", "p/m2", "同一会话", { sessionKey: "ses_headvalue_9f8e7d" })), true);
    assert.equal(recordAgentLoop(mk("h3", "p/m1", "另一段会话")), true);
    const all = [...await flushRows(dir, "p/m1"), ...await flushRows(dir, "p/m2")];
    const headed = all.filter((r) => ["h1", "h2"].includes(r.reqId)).map((r) => r.sessionKey);
    assert.equal(headed.length, 2);
    assert.ok(headed.every((k) => k === norm("ses_headvalue_9f8e7d")), "带头时以头为唯一派生源");
    assert.notEqual(headed[0], derived, "头派生键与无头派生键不同");
    assert.notEqual(all.find((r) => r.reqId === "h3").sessionKey, derived, "不同会话不同键");
  }, fullEnv());
});

test("响应桶 capped：meta.truncated=true 且 cap 有值（禁止静默断尾）", async () => {
  await withCapture(async (dir) => {
    const talk = bucket({ reasoning: ["R".repeat(10)], content: ["C"], n: 400_000, capped: true });
    assert.equal(recordAgentLoop({ reqId: "cap", model: "a/b", hops: 0, body: { messages: [{ role: "user", content: "q" }] }, out: goodOut(talk) }), true);
    const [row] = await flushRows(dir, "a/b");
    assert.equal(row.meta.truncated, true);
    assert.equal(row.meta.cap, 2_000_000);
    assert.equal(row.meta.responseChars, 400_000);
    assert.equal(row.meta.reasoningChars, 10, "思考与正文分列计量");
    assert.equal(row.response.reasoning, "R".repeat(10));
  }, fullEnv());
});

test("工具调用按桶原样落档（分片已合回的 arguments 可读）", async () => {
  await withCapture(async (dir) => {
    const talk = bucket({ tools: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } }], n: 0 });
    assert.equal(recordAgentLoop({ reqId: "tc", model: "a/b", hops: 0, body: { messages: [{ role: "user", content: "几点" }] }, out: goodOut(talk) }), true);
    const [row] = await flushRows(dir, "a/b");
    assert.equal(row.response.toolCalls.length, 1);
    assert.equal(row.response.toolCalls[0].function.name, "get_time");
    assert.deepEqual(JSON.parse(row.response.toolCalls[0].function.arguments), { tz: "UTC" }, "思考零字符、只有工具调用的轮次照样留档");
  }, fullEnv());
});

test("权限位：新建文件 0600（POSIX；Windows 无意义跳过）", async () => {
  await withCapture(async (dir) => {
    recordAgentLoop({ reqId: "p1", model: "a/b", hops: 0, body: { messages: [{ role: "user", content: "q" }] }, out: { status: 200, detail: {} } });
    await flushAgentLoop();
    if (process.platform !== "win32") {
      const mode = statSync(agentLoopFile("a/b")).mode & 0o777;
      assert.equal(mode, 0o600, `权限位应为 0600，实际 ${mode.toString(8)}`);
    }
  }, fullEnv());
});
test("目录缓存过期自愈：捕获目录被 rm -r 后再写一条 → 目录重建、新记录在场", async () => {
  await withCapture(async (dir) => {
    const model = "heal/m1";
    assert.equal(recordAgentLoop({ reqId: "before", model, hops: 0, body: sampleBody(), out: goodOut(bucket({ content: ["甲"], n: 1 })) }), true);
    await flushAgentLoop();
    assert.equal(existsSync(agentLoopFile(model)), true, "首条落盘");
    rmSync(agentLoopDir(), { recursive: true, force: true });
    assert.equal(existsSync(agentLoopDir()), false, "目录确实被删（模拟 Migration Plan 的手工清理）");
    assert.equal(recordAgentLoop({ reqId: "after", model, hops: 0, body: sampleBody(), out: goodOut(bucket({ content: ["乙"], n: 1 })) }), true);
    await flushAgentLoop();
    assert.equal(existsSync(agentLoopFile(model)), true, "目录被外力删掉必须自愈重建（不得静默丢条）");
    const rows = await flushRows(dir, model);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reqId, "after", "重建后新记录在场");
    assert.equal(rows[0].response.content, "乙");
  }, fullEnv());
});

test("三级钳制（纯函数）：摘要先丢 head、必要时只留末尾 N 条，行字节必 ≤ limitBytes", () => {
  const msgs = Array.from({ length: 20_000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}:` + "y".repeat(60) }));
  const rec = {
    ts: 1, time: "2026-01-01 00:00:00", reqId: "pure", sessionKey: "k", model: "a/pure", via: "local",
    hops: 0, status: 200, stream: 1, elapsedMs: 1, usage: null, finishReason: null, upstream: null, account: null, pick: null,
    ...shapeForCapture({ body: { messages: msgs }, model: "a/pure", msgs, reasoning: "", content: "", toolCalls: [] }),
    meta: { requestBytes: 1, responseChars: 0, reasoningChars: 0, truncated: false, cap: 2_000_000 },
  };
  const limit = 512 * 1024;
  const line = composeLine(rec, limit);
  assert.ok(Buffer.byteLength(line, "utf8") <= limit, "最终行字节 ≤ limitBytes");
  const row = JSON.parse(line);
  assert.equal(row.meta.truncated, true, "截断必须显式");
  assert.equal(row.meta.cap, 2_000_000, "cap 语义不变");
  assert.equal(row.meta.summaryTrimmed, true, "读侧看得出摘要被削过（不再逐条带 head）");
  assert.equal(typeof row.meta.messagesOmitted, "number");
  assert.ok(row.meta.messagesOmitted > 0, "丢条数有读数");
  assert.ok(row.request.messages.length > 0 && row.request.messages.length < 20_000, "只保留末尾 N 条");
  assert.ok(row.request.messages.every((m) => !("head" in m)), "摘要退化为 role+chars+hash");
  assert.deepEqual(Object.keys(row.request.messages.at(-1)).sort(), ["chars", "hash", "i", "role"]);
});

test("三级钳制（落盘路径）：MAX_LINE_MB=1 下超量 message 的记录仍 ≤ 1MB 且逐行可解析", async () => {
  await withCapture(async (dir) => {
    const msgs = Array.from({ length: 30_000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i}|` + "z".repeat(40) }));
    assert.equal(recordAgentLoop({ reqId: "huge", model: "a/huge", hops: 0, body: { messages: msgs }, out: goodOut(bucket({ content: ["ok"], n: 2 })) }), true);
    const rows = await flushRows(dir, "a/huge");
    assert.equal(rows.length, 1, "记录不丢");
    assert.equal(rows[0].reqId, "huge");
    assert.equal(rows[0].meta.truncated, true);
    assert.equal(rows[0].meta.summaryTrimmed, true);
    assert.ok(rows[0].meta.messagesOmitted > 0);
    assert.ok(Buffer.byteLength(readFileSync(agentLoopFile("a/huge"), "utf8"), "utf8") <= MB, "盘上这条 ≤ 1MB");
  }, fullEnv({ MSLXDFF_TALK_FULL_MAX_LINE_MB: "1" }));
});

test("三级钳制地板：超长标量 params（非 messages 载荷）也被削到 ≤ limitBytes", () => {
  const msgs = [{ role: "user", content: "hi" }];
  const body = { messages: msgs, user: "P".repeat(3_000_000) }; // completions 的巨型 prompt 形态：scalarParams 原样收
  const rec = {
    ts: 1, time: "2026-01-01 00:00:00", reqId: "floor", sessionKey: "k", model: "a/floor", via: "local",
    hops: 0, status: 200, stream: 1, elapsedMs: 1, usage: null, finishReason: null, upstream: null, account: null, pick: null,
    ...shapeForCapture({ body, model: "a/floor", msgs, reasoning: "", content: "", toolCalls: [] }),
    meta: { requestBytes: 1, responseChars: 0, reasoningChars: 0, truncated: false, cap: 2_000_000 },
  };
  const limit = 1024 * 1024;
  const line = composeLine(rec, limit);
  assert.ok(Buffer.byteLength(line, "utf8") <= limit, "极大 params 也必须被削到上限内");
  const row = JSON.parse(line);
  assert.equal(row.meta.truncated, true);
  assert.equal(row.meta.summaryTrimmed, true);
  assert.ok(row.request.params.user.length < 1000, "超长标量被截短");
  assert.ok(row.request.params.user.endsWith("…[已截断]"), "截短可见");
});

test("attemptMs 语义：elapsedMs 取本次尝试墙钟、meta.relayMs 恒存 relay 内部 totalMs（§2.4/§3.5）", async () => {
  await withCapture(async (dir) => {
    assert.equal(recordAgentLoop({ reqId: "hedge", model: "a/b", hops: 0, body: { messages: [{ role: "user", content: "q" }] }, out: { status: 200, totalMs: 2, detail: { talk: bucket({ content: ["重放"], n: 2 }) } }, attemptMs: 7207 }), true);
    const [row] = await flushRows(dir, "a/b");
    assert.equal(row.elapsedMs, 7207, "hedge 缓冲重放场景不再把重放耗时当 elapsedMs");
    assert.equal(row.meta.relayMs, 2, "relay 内部计时另存 meta.relayMs");
  }, fullEnv());
});
