// 环形对话日志（talk log）：供应商-模型-talk.log、最近 1 小时窗口、正文脱敏、旁路不影响转发。
// 隔离：MSLXDFF_DAEMON_DIR 指向 mkdtemp（talk/ 子目录随之落在里面）；正文桶由 stream-scan 的纯函数构造。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { talkLogName, talkLogFile, recordRelayTalk, formatTalkEntry, appendTalkEntry, trimTalkLog, recentBlocks, listRecentFiles, maskText, resetTalkLogCache, talkLogEnabled, splitEntries } from "../src/talk-log.js";
import { createTalkBucket, captureTalkSse, captureTalkMessage, captureTalkFallback, scanSseChunk } from "../src/routes/stream-scan.js";
import { createRelayPipeline } from "../src/routes/chat/relay-pipeline.js";
import { buildFallbackInfo } from "../src/routes/fallback.js";
import { appendEvent, recentEvents } from "../src/logs.js";

const LONG_SECRET = "tok_" + "A".repeat(32);
const frame = (delta) => "data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\n";

function withTalkDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-talk-"));
  const old = process.env.MSLXDFF_DAEMON_DIR;
  process.env.MSLXDFF_DAEMON_DIR = dir;
  resetTalkLogCache();
  try { return fn(dir); } finally {
    if (old === undefined) delete process.env.MSLXDFF_DAEMON_DIR; else process.env.MSLXDFF_DAEMON_DIR = old;
    resetTalkLogCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("talk log: 文件名 = 供应商-模型-talk.log", () => {
  assert.equal(talkLogName("qoder/qfmodel"), "qoder-qfmodel-talk.log");
  assert.equal(talkLogName("ocgo/muse-spark-1.3-contributor"), "ocgo-muse-spark-1.3-contributor-talk.log");
  assert.equal(talkLogName("deepseek-v3"), "deepseek-v3-talk.log", "裸 id（免费池）不带供应商段");
  assert.equal(talkLogName("../../secret"), "secret-talk.log", "路径穿越被安全化");
  assert.equal(talkLogName(""), "unknown-talk.log");
});

test("talk log: 一条对话含我问/思考/回答三段且按此序", () => {
  withTalkDir((dir) => {
    const talk = createTalkBucket();
    captureTalkSse(talk, frame({ reasoning_content: "先" }));
    captureTalkSse(talk, frame({ reasoning_content: "想一想。", content: "你好" }));
    captureTalkSse(talk, frame({ content: "，世界。" }));
    const wrote = recordRelayTalk({
      reqId: "r1", model: "qoder/qfmodel", via: "local", hops: 0,
      body: { stream: true, messages: [{ role: "system", content: "SYS_PROMPT_TEXT" }, { role: "user", content: "帮我看看这段代码" }] },
      out: { status: 200, totalMs: 1234, detail: { talk, usage: { prompt_tokens: 11, completion_tokens: 22 } } },
      echo: { upstream: "api.qoder.sh", account: "global", pick: "sticky" },
    });
    assert.equal(wrote, true);
    const file = join(dir, "talk", "qoder-qfmodel-talk.log");
    assert.ok(existsSync(file), "落在 talk/ 子目录");
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("[我问") && text.includes("[思考") && text.includes("[回答"));
    assert.ok(text.indexOf("[我问") < text.indexOf("[思考"), "问题在思考之前");
    assert.ok(text.indexOf("[思考") < text.indexOf("[回答"), "思考在回答之前");
    assert.ok(text.includes("先想一想。"), "思考分片拼回原文");
    assert.ok(text.includes("你好，世界。"), "正文分片拼回原文");
    assert.ok(!text.includes("SYS_PROMPT_TEXT"), "system prompt 不落盘（只记我发给模型的问题本身）");
    assert.match(text, /status=200 stream=1 elapsed=1234ms/);
    assert.match(text, /usage\(prompt=11,completion=22\)/);
    assert.match(text, /upstream=api\.qoder\.sh account=global pick=sticky/);
  });
});

test("talk log: 正文里的凭据落盘前脱敏，但保留换行", () => {
  const masked = maskText(`第一行 token=${LONG_SECRET}\n第二行 sk-abcdefghijklmnopqrst\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123456789`);
  assert.ok(!masked.includes(LONG_SECRET), "裸 token= 长值被抹");
  assert.ok(!masked.includes("sk-abcdefghijklmnopqrst"), "sk- 密钥被抹");
  assert.ok(!masked.includes("eyJzdWIi"), "JWT 载荷被抹");
  assert.ok(masked.includes("[已脱敏]"));
  assert.ok(masked.includes("\n"), "换行保留（要读的是回答本身，不能压成一行）");
  withTalkDir(() => {
    const talk = createTalkBucket();
    captureTalkSse(talk, frame({ content: `报错拉不住：token=${LONG_SECRET}` }));
    recordRelayTalk({ reqId: "r2", model: "a/b", body: { messages: [{ role: "user", content: "q" }] }, out: { status: 200, detail: { talk } }, echo: {} });
    assert.ok(!readFileSync(talkLogFile("a/b"), "utf8").includes(LONG_SECRET), "落盘文件里查不到原密钥");
  });
});

test("talk log: 工具调用按 index 合回完整参数（流式分片）", () => {
  const talk = createTalkBucket();
  captureTalkSse(talk, frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "get_time", arguments: "" } }] }));
  captureTalkSse(talk, frame({ tool_calls: [{ index: 0, function: { arguments: '{"tz":' } }] }));
  captureTalkSse(talk, frame({ tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] }));
  assert.equal(talk.tools.length, 1, "同一个 index 只算一次调用");
  assert.equal(talk.tools[0].id, "call_1");
  assert.equal(talk.tools[0].function.name, "get_time");
  assert.equal(JSON.parse(talk.tools[0].function.arguments).tz, "UTC", "arguments 逐段拼回可解析 JSON");
});

test("talk log: 非流式与透传兜底都收正文", () => {
  const t1 = createTalkBucket();
  captureTalkMessage(t1, { reasoning: "非流式思考", content: "非流式回答", tool_calls: [{ id: "c2", function: { name: "f", arguments: "{}" } }] });
  assert.equal(t1.reasoning.join(""), "非流式思考");
  assert.equal(t1.content.join(""), "非流式回答");
  const t2 = createTalkBucket();
  captureTalkFallback(t2, "上游直接给的一段纯文本");
  assert.equal(t2.content.join(""), "上游直接给的一段纯文本");
  const t3 = createTalkBucket();
  captureTalkSse(t3, frame({ content: "已有正文" }));
  captureTalkFallback(t3, "不该再来一遍");
  assert.equal(t3.content.join(""), "已有正文", "已有 chat 正文时兜底不重复塞");
});

test("talk log: 空轮不占环形窗口", () => {
  withTalkDir(() => {
    const wrote = recordRelayTalk({ reqId: "r3", model: "qoder/qfmodel", via: "local", body: { messages: [] }, out: { status: 200, detail: { talk: createTalkBucket() } }, echo: {} });
    assert.equal(wrote, false, "零正文零思考零工具 → 不落（空转由 relay-pipeline 另行报错）");
    assert.equal(existsSync(talkLogFile("qoder/qfmodel")), false);
  });
});

test("talk log: 环形只留最近 1 小时，出窗条目被淘汰", () => {
  withTalkDir(() => {
    const f = talkLogFile("ring/ringmodel");
    const now = Date.now();
    const oldTs = now - 121 * 60 * 1000; // 2 小时前
    appendTalkEntry({ file: f, block: formatTalkEntry({ reqId: "old", model: "ring/ringmodel", question: "很久以前的问题", answer: "很久以前的回答", ts: oldTs }), atMs: oldTs });
    resetTalkLogCache(); // 模拟 daemon 重启：内存基线清空后要从盘上把最老 ts 认回来
    appendTalkEntry({ file: f, block: formatTalkEntry({ reqId: "new", model: "ring/ringmodel", question: "刚才的问题", answer: "刚才的回答", ts: now }), atMs: now });
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes("很久以前"), "出窗旧条目被丢");
    assert.ok(text.includes("刚才的回答"));
    assert.equal(recentBlocks({ file: f }).length, 1);
  });
});

test("talk log: 窗口内条目都留着（不是只留最后一条）", () => {
  withTalkDir(() => {
    const f = talkLogFile("ring/keep");
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const ts = now - i * 60 * 1000;
      appendTalkEntry({ file: f, block: formatTalkEntry({ reqId: `k${i}`, model: "ring/keep", question: `问 ${i}`, answer: `答 ${i}`, ts }), atMs: ts });
    }
    assert.equal(recentBlocks({ file: f }).length, 5);
    assert.equal(trimTalkLog(f, now), 0, "未出窗未超预算 → 淘汰 0 条");
  });
});

test("talk log: 单文件字节封顶，丢最老的保最新", () => {
  const oldCap = process.env.MSLXDFF_TALK_LOG_MAX_KB;
  process.env.MSLXDFF_TALK_LOG_MAX_KB = "20";
  try {
    withTalkDir(() => {
      const f = talkLogFile("ring/cap");
      const now = Date.now();
      const big = "x".repeat(4000);
      for (let i = 0; i < 20; i++) appendTalkEntry({ file: f, block: formatTalkEntry({ reqId: `c${i}`, model: "ring/cap", question: big, answer: big, ts: now + i }), atMs: now + i });
      const text = readFileSync(f, "utf8");
      assert.ok(Buffer.byteLength(text, "utf8") <= 20 * 1024 + 1024, `封顶生效（实际 ${Buffer.byteLength(text)} 字节）`);
      assert.ok(text.includes("req=c19"), "最新一条必须在");
      assert.ok(!text.includes("req=c0 "), "最老一条先被丢");
    });
  } finally {
    if (oldCap === undefined) delete process.env.MSLXDFF_TALK_LOG_MAX_KB; else process.env.MSLXDFF_TALK_LOG_MAX_KB = oldCap;
  }
});

test("talk log: MSLXDFF_TALK_LOG=0 整条链路静默", () => {
  const old = process.env.MSLXDFF_TALK_LOG;
  process.env.MSLXDFF_TALK_LOG = "0";
  try {
    assert.equal(talkLogEnabled(), false);
    withTalkDir(() => {
      const talk = createTalkBucket();
      captureTalkSse(talk, frame({ content: "不该落盘" }));
      assert.equal(recordRelayTalk({ reqId: "r4", model: "off/offmodel", body: { messages: [{ role: "user", content: "hi" }] }, out: { status: 200, detail: { talk } }, echo: {} }), false);
      assert.equal(existsSync(talkLogFile("off/offmodel")), false);
    });
  } finally {
    if (old === undefined) delete process.env.MSLXDFF_TALK_LOG; else process.env.MSLXDFF_TALK_LOG = old;
  }
});

test("talk log: detail.talk 绝不进 events.log（正文只准进 talk/*.log）", () => {
  withTalkDir(() => {
    const talk = createTalkBucket();
    captureTalkSse(talk, frame({ content: "这段正文不许出现在 debug 流" }));
    appendEvent({ type: "relay-done", reqId: "r5", model: "qoder/qfmodel", detail: { chars: 13, talk } });
    const raw = readFileSync(join(process.env.MSLXDFF_DAEMON_DIR, "events.log"), "utf8");
    assert.ok(!raw.includes("这段正文不许出现在 debug 流"), "events.log 里没有问答正文");
    assert.ok(!raw.includes('"talk"'));
    const row = recentEvents(1)[0];
    assert.equal(row.detail.talkChars, 17, "留计数：debug 仍看得出这轮出了多少字");
    assert.equal(talk.content.length, 1, "剥离用的是副本，原桶还在（落盘要靠它）");
  });
});

test("talk log: 未开启时 scanSseChunk 不碰正文（零开销）", () => {
  const detail = { chars: 0, reasoningChars: 0, sawDone: false, sawFinishReason: null, chatShaped: false, usage: null, toolCalls: 0 };
  scanSseChunk(detail, frame({ reasoning_content: "思考", content: "回答" }));
  assert.equal(detail.chars, 2);
  assert.equal(detail.reasoningChars, 2);
  assert.equal(detail.talk, undefined, "没建桶就没有桶");
});

test("talk log: relay-pipeline 汇合点真的触发落盘", async () => {
  await withTalkDir(async () => {
    const talk = createTalkBucket();
    captureTalkSse(talk, frame({ content: "管道里落的那句" }));
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); }, write() { return this; }, end() { return this; }, on() { return this; }, removeListener() { return this; } };
    const upRes = new Response("", { headers: { "x-mslxdff-upstream": "api.qoder.sh", "x-mslxdff-workbuddy-uid": "u1" } });
    const pipe = createRelayPipeline({
      relay: async () => ({ status: 200, ttfMs: 10, totalMs: 200, aborted: false, interrupted: false, preflightMs: 0, detail: { chars: 8, toolCalls: 0, exitReason: "normal", talk, usage: { prompt_tokens: 3, completion_tokens: 4 } } }),
      buildFallbackInfo,
      auto: { recordOk: async () => {}, recordError: async () => {}, recordLatency: async () => {} },
      evt: () => {}, mark: () => {}, logCall: () => {}, logError: () => {}, perfNow: () => 1000,
      constants: { STREAM_TIMEOUT_MS: 25_000, SLOW_TOTAL_MS: 20_000, STALL_TIMEOUT_MS: 0, SCORE_STALL_MS: 15_000 },
    });
    const r = await pipe.execute({
      res, upRes, body: { stream: true, messages: [{ role: "user", content: "管道外的问题" }] },
      requested: "qoder/qfmodel", actual: "qoder/qfmodel", via: "local", handlerCtx: { reqId: "r-pipe", hops: 0 },
    });
    assert.equal(r.handled, true);
    const text = readFileSync(talkLogFile("qoder/qfmodel"), "utf8");
    assert.ok(text.includes("管道里落的那句"), "真实输出落进对话日志");
    assert.ok(text.includes("管道外的问题"), "我的问题落进对话日志");
    assert.match(text, /upstream=api\.qoder\.sh account=u1/, "回显头跟着进元信息（谁答的）");
  });
});

test("talk log: 列目录给调研入口（按最近活跃排序）", () => {
  withTalkDir(() => {
    const now = Date.now();
    const f1 = talkLogFile("p1/m1");
    const f2 = talkLogFile("p2/m2");
    appendTalkEntry({ file: f1, block: formatTalkEntry({ reqId: "a", model: "p1/m1", answer: "一", ts: now - 5000 }), atMs: now - 5000 });
    appendTalkEntry({ file: f2, block: formatTalkEntry({ reqId: "b", model: "p2/m2", answer: "二", ts: now }), atMs: now });
    // 两次写入可能落在同一毫秒（mtime 相等时排序会退化到 readdir 顺序）→ 显式钉住活跃度，只验排序口径本身
    utimesSync(f1, new Date(now - 5000), new Date(now - 5000));
    utimesSync(f2, new Date(now), new Date(now));
    assert.deepEqual(listRecentFiles().map((f) => f.name), ["p2-m2-talk.log", "p1-m1-talk.log"]);
  });
});

// —— 截断必须显式，不得静默断尾（tasks 3.2）——
test("talk log: 桶撞顶 → 头部行带 truncated=1 cap= chars=，且一眼写明内容可能不完整", () => {
  withTalkDir(() => {
    const talk = createTalkBucket(10);
    captureTalkSse(talk, frame({ reasoning_content: "思考很长很长远超十个字" }));
    captureTalkSse(talk, frame({ content: "后半截没了" }));
    assert.equal(talk.capped, true, "前置条件：确实撞顶");
    const chars = talk.n; // 撞顶时刻的已捕获字符数（分片整块进桶，可略超 cap）
    assert.equal(recordRelayTalk({ reqId: "rc1", model: "cap/trim", via: "local", hops: 0, body: { messages: [{ role: "user", content: "问" }] }, out: { status: 200, detail: { talk } }, echo: {} }), true);
    const text = readFileSync(talkLogFile("cap/trim"), "utf8");
    const lines = text.split("\n");
    const head = lines[0];
    assert.match(head, /truncated=1/, "头部行必须显式标截断");
    assert.match(head, /cap=10/, "上限读数必须在场");
    assert.ok(head.includes(`chars=${chars}`), `已捕获字符数必须在场，实际头部行：${head}`);
    assert.ok(lines[1].includes("不完整"), "紧跟头部行的人类可读提醒：思考/正文可能不完整");
  });
});

test("talk log: 未撞顶的条目不得多出 truncated/封顶噪音字段", () => {
  withTalkDir(() => {
    const talk = createTalkBucket();
    captureTalkSse(talk, frame({ reasoning_content: "想一想", content: "答一答" }));
    assert.equal(talk.capped, false);
    recordRelayTalk({ reqId: "rc2", model: "cap/keep", via: "local", hops: 0, body: { messages: [{ role: "user", content: "问" }] }, out: { status: 200, detail: { talk } }, echo: {} });
    const text = readFileSync(talkLogFile("cap/keep"), "utf8");
    assert.ok(!text.includes("truncated"), "没截断就不许多这一项");
    assert.ok(!text.includes("封顶"), "没到字节上限就不许多这一项");
    assert.ok(!text.includes("…[已截断]"));
  });
});

test("talk log: 段正文被 maskText 字节封顶砍掉时，标签行必须体现封顶（不许看着像完整）", () => {
  const capped = formatTalkEntry({ reqId: "t1", model: "m", question: "问".repeat(9000), answer: "短答" });
  const label = capped.split("\n").find((l) => l.startsWith("[我问"));
  assert.match(label, /^\[我问 · \d+ 字 · 已封顶\]$/, `标签行要带封顶标记，实际：${label}`);
  assert.ok(capped.includes("…[已截断]"), "正文尾标保持原样（向后兼容）");
  const clean = formatTalkEntry({ reqId: "t2", model: "m", question: "短问", answer: "短答", thinking: "短想" });
  assert.ok(!clean.includes("已封顶"), "未封顶时标签行逐字如旧");
  assert.ok(clean.includes("[我问 · 2 字]"), `[我问 · N 字] 旧格式不得变形：${clean.split("\n").find((l) => l.startsWith("[我问"))}`);
});

// —— default-on-agent-loop-capture §2.3/§3.2：finish= 头行、零正文显式标注、attemptMs/relayMs 读数（红灯先行）——
test("talk log: 只调工具零正文轮 → 头行 finish=tool_calls 且回答段明写「本轮无正文」（不再静默跳块）", () => {
  withTalkDir(() => {
    const talk = createTalkBucket();
    captureTalkSse(talk, frame({ tool_calls: [{ index: 0, id: "c1", function: { name: "get_time", arguments: "{}" } }] }));
    assert.equal(talk.content.length, 0, "前置条件：正文零");
    assert.equal(recordRelayTalk({ reqId: "f1", model: "fin/tool", via: "local", hops: 0, body: { messages: [{ role: "user", content: "几点" }] }, out: { status: 200, totalMs: 88, detail: { talk, sawFinishReason: "tool_calls" } }, echo: {} }), true, "零正文工具轮不再整条不落（既有判据里有 tools 就该落）");
    const text = readFileSync(talkLogFile("fin/tool"), "utf8");
    assert.match(text, /^#talk-entry ts=\d+ .*finish=tool_calls/, "头行必须带 finish=<值>");
    assert.ok(text.includes("[回答 · 0 字 · 本轮无正文（finish=tool_calls）]"), "零正文必须写出来，不能靠缺块暗示");
    assert.ok(!text.includes("----8<----\n\n---->8----"), "无正文标注不套 CUT 围栏");
    assert.ok(text.includes("[工具调用"), "工具调用块照旧呈现");
    assert.ok(text.includes("[END]"), "[END] 结构不破");
    assert.equal(splitEntries(text).length, 1, "splitEntries 分块结构不破");
  });
});

test("talk log: 传 attemptMs → 头行 elapsed= 取本次尝试墙钟、relayMs= 保留 relay 内部 totalMs；有正文段与改动前逐字一致", () => {
  withTalkDir(() => {
    const talk = createTalkBucket();
    captureTalkSse(talk, frame({ content: "缓冲重放的正文" }));
    recordRelayTalk({ reqId: "f2", model: "fin/elapsed", via: "local", hops: 0, body: { messages: [{ role: "user", content: "q" }] }, out: { status: 200, totalMs: 2, detail: { talk } }, echo: {}, attemptMs: 7207 });
    const text = readFileSync(talkLogFile("fin/elapsed"), "utf8");
    const head = text.split("\n")[0];
    assert.match(head, /elapsed=7207ms/, "elapsed= 取本次上游尝试墙钟（hedge 重放不再报 2ms）");
    assert.match(head, /relayMs=2ms/, "relay 内部计时另列（两值不同才出现）");
    assert.ok(!text.includes("本轮无正文"), "有正文时不得出现无正文标注");
    assert.ok(text.includes("缓冲重放的正文"));
  });
});

test("talk log: 未传 attemptMs → elapsed= 回退 totalMs 且不打 relayMs（同值不重复）；缺 finish 落 finish=-", () => {
  withTalkDir(() => {
    const talk = createTalkBucket();
    captureTalkSse(talk, frame({ content: "普通一次尝试" }));
    recordRelayTalk({ reqId: "f3", model: "fin/plain", via: "local", hops: 0, body: { messages: [{ role: "user", content: "q" }] }, out: { status: 200, totalMs: 200, detail: { talk } }, echo: {} });
    const head = readFileSync(talkLogFile("fin/plain"), "utf8").split("\n")[0];
    assert.match(head, /elapsed=200ms/, "回退 relay 内部计时");
    assert.ok(!head.includes("relayMs="), "与 elapsed 同值时头行不打印 relayMs（克制噪音，grill Q3）");
    assert.match(head, /finish=-/, "上游没给 finish_reason → 缺值占位，不得省略字段");
  });
});

// —— P1-B 防回归（零正文判据漏空白）：只调工具 + 吐个换行是真实 agent 形态，
// 判据 `answer === ""` 放过 " "/" \n" 后 pushBlock 的 !m.trim() 会把块整个跳过 →
// 「本轮无正文」与「正文丢盘」再度同形。判据必须看 trim，不看长度。
test("talk log: 正文只有空白（两个空格/一个换行）→ 仍判「本轮无正文」，头行 finish 值原样", () => {
  for (const blank of ["  ", "\n", " \n\t "]) {
    const entry = formatTalkEntry({ reqId: "b1", model: "x/y", status: 200, ts: 1700000000000, question: "问", answer: blank, finishReason: "tool_calls" });
    assert.match(entry, /^#talk-entry ts=\d+ .*finish=tool_calls/, `头行 finish=${JSON.stringify(blank)} 形态下仍须带真值`);
    assert.ok(entry.includes("[回答 · 0 字 · 本轮无正文（finish=tool_calls）]"), `空白正文 ${JSON.stringify(blank)} 必须落「本轮无正文」标注，不得静默丢块：${entry}`);
    assert.ok(!entry.includes("----8<----\n \n---->8----"), "空白不得伪装成正文块落盘");
    assert.ok(!entry.includes("[回答 · 2 字]") && !entry.includes("[回答 · 1 字]"), "空白字数不得被当成正文字数");
  }
});

test("talk log: 有正文（非空白）时整条目逐字不变（判据收紧只影响空白态）", () => {
  const golden = "#talk-entry ts=1700000000000 time=2023-11-15 06:13:20 req=g1 model=x/y via=local hops=0 status=200 stream=1 elapsed=5ms finish=tool_calls\n\n[我问 · 2 字]\n----8<----\n问题\n---->8----\n\n[思考 · 2 字]\n----8<----\n在想\n---->8----\n\n[回答 · 3 字]\n----8<----\n有正文\n---->8----\n\n[工具调用 · 13 字]\n----8<----\n[{\"id\":\"c1\"}]\n---->8----\n\n[END]\n\n";
  const got = formatTalkEntry({
    reqId: "g1", model: "x/y", via: "local", hops: 0, status: 200, stream: true, elapsedMs: 5,
    ts: 1700000000000, question: "问题", thinking: "在想", answer: "有正文",
    tools: '[{"id":"c1"}]', finishReason: "tool_calls",
  });
  assert.equal(got, golden, "有正文路径的字节序列必须与改动前一致");
  assert.ok(!got.includes("本轮无正文"), "有正文时不得出现无正文标注");
});
