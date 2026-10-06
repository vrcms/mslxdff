import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightMs, scanSseChunk, scanNonStreamBody, createTalkBucket, createTalkBucketIfEnabled, captureTalkSse } from "../src/routes/stream-scan.js";

// 量测锚点：上报用的首字必须补上「上游尝试开始 → 转发层入口」这段等待
// （qoder 等 provider 会在这段里预读首帧，见 ADR-0036；不补就永远读成 0/1ms）
test("上报锚点偏移 = 转发入口时刻 − 本次上游尝试起点", () => {
  // 尝试 1000ms 起，转发层 13000ms 才拿到响应（上游排队 12 秒）→ 该补 12000ms
  assert.equal(preflightMs(13_000, 1_000), 12_000);
});

// 降级不得变成故障源：拿不到锚点就当没这段等待（等于修复前行为），不能算出 NaN
test("无锚点（未传/非有限）时偏移为 0，退化为修复前口径", () => {
  assert.equal(preflightMs(13_000, undefined), 0);
  assert.equal(preflightMs(13_000, null), 0);
  assert.equal(preflightMs(13_000, NaN), 0);
  assert.equal(preflightMs(13_000, "1000"), 0, "字符串时刻不可信，按无锚点处理");
});

// 混钟防线：若哪天把 Date.now() 当锚点传进来，差值会是巨大负数 → 必须 clamp 0，
// 绝不能让上报时长变成负值或假高值
test("锚点晚于转发入口（时钟源不一致）时偏移 clamp 到 0", () => {
  assert.equal(preflightMs(1_000, 13_000), 0);
  assert.equal(preflightMs(5, 1_777_000_000_000), 0, "Date.now 混进 performance.now 的实测形状");
});

// —— 思考内容必须被观测到（qoder 等上游不上报 reasoning_tokens，现网 1249 行全记 0）——
function blankDetail() {
  return { usage: null, chars: 0, reasoningChars: 0, toolCalls: 0, chatShaped: false, sawDone: false, sawFinishReason: null };
}
const dataLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test("逐帧扫描分开统计正文与思考字符（usage 帧路径）", () => {
  const detail = blankDetail();
  const text = dataLine({ choices: [{ index: 0, delta: { reasoning_content: "R".repeat(40) } }] })
    + dataLine({ choices: [{ index: 0, delta: { content: "0123456789" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } });
  scanSseChunk(detail, text);
  assert.equal(detail.chars, 10, "chars 只算正文，思考不得混进来");
  assert.equal(detail.reasoningChars, 40, "思考字符必须单独累计");
});

test("无 usage 帧时走正则兜底，思考字符同样要记（reasoning_content）", () => {
  const detail = blankDetail();
  scanSseChunk(detail, dataLine({ choices: [{ index: 0, delta: { reasoning_content: "思".repeat(20) } }] }));
  assert.equal(detail.reasoningChars, 20);
  assert.equal(detail.chars, 0, "纯思考轮的正文计数保持 0（空转判定依赖它）");
});

test("另一种上游的 reasoning 字段名同样计入思考字符", () => {
  const detail = blankDetail();
  scanSseChunk(detail, dataLine({ choices: [{ index: 0, delta: { reasoning: "x".repeat(12) } }] }));
  assert.equal(detail.reasoningChars, 12);
});

test("非流式聚合体也记思考字符（qoder stream:false 出口在 message.reasoning_content）", () => {
  const detail = blankDetail();
  scanNonStreamBody(detail, { choices: [{ message: { content: "答案", reasoning_content: "T".repeat(36) } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  assert.equal(detail.chars, 2, "正文只算 content");
  assert.equal(detail.reasoningChars, 36);
});

// —— 响应正文捕获桶：上限单一真相 + 建桶条件（tasks 3.1）——
// 这些开关都是「按调用读 env」无 import 期冻结，可在同文件内设/删；undefined = 删除该键。
const TALK_ENV_KEYS = ["MSLXDFF_TALK_LOG", "MSLXDFF_TALK_FULL", "MSLXDFF_TALK_CAP_CHARS", "MSLXDFF_DAEMON_DIR"];
function withTalkEnv(env, fn) {
  const old = Object.fromEntries(TALK_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of TALK_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = String(v); }
  try { return fn(); } finally {
    for (const k of TALK_ENV_KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}
const talkFrame = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

test("createTalkBucket() 未传 cap：上限逐字等于现状 400_000（锁死不变）", () => {
  withTalkEnv({}, () => {
    const talk = createTalkBucket();
    assert.equal(talk.cap, 400_000, "缺省 40 万必须与改前逐字一致");
    assert.equal(talk.n, 0);
    assert.equal(talk.capped, false);
  });
});

test("createTalkBucketIfEnabled：未设任何 env（缺省开）→ 建桶且上限 2_000_000（§2.2 改档）", () => {
  withTalkEnv({}, () => {
    const talk = createTalkBucketIfEnabled();
    assert.ok(talk, "talk.log 默认开 + full 缺省开 → 建桶");
    assert.equal(talk.cap, 2_000_000);
  });
});

test("createTalkBucketIfEnabled：MSLXDFF_TALK_FULL=0（显式关）→ 上限回 400_000", () => {
  withTalkEnv({ MSLXDFF_TALK_FULL: "0" }, () => {
    assert.equal(createTalkBucketIfEnabled().cap, 400_000, "显式关闭词 = 40 万档（与改前逐字同值）");
  });
});

test("createTalkBucketIfEnabled：MSLXDFF_TALK_CAP_CHARS=123 两态覆盖（优先于任何缺省档）", () => {
  withTalkEnv({ MSLXDFF_TALK_CAP_CHARS: "123" }, () => {
    assert.equal(createTalkBucketIfEnabled().cap, 123, "缺省开态：覆盖压过 200 万");
  });
  withTalkEnv({ MSLXDFF_TALK_FULL: "0", MSLXDFF_TALK_CAP_CHARS: "123" }, () => {
    assert.equal(createTalkBucketIfEnabled().cap, 123, "显式关态：覆盖同样生效");
  });
});

test("createTalkBucketIfEnabled：talk.log 关而 full 缺省开 → 桶仍被创建（响应正文不得全丢）", () => {
  withTalkEnv({ MSLXDFF_TALK_LOG: "0" }, () => {
    const talk = createTalkBucketIfEnabled();
    assert.ok(talk, "talk.log=0 且 full 缺省开时不许 null——否则 capture 全程记到空气");
    assert.equal(talk.cap, 2_000_000);
  });
  withTalkEnv({ MSLXDFF_TALK_LOG: "0", MSLXDFF_TALK_FULL: "1" }, () => {
    assert.equal(createTalkBucketIfEnabled().cap, 2_000_000, "显式 =1 旧姿势继续有效");
  });
  withTalkEnv({ MSLXDFF_TALK_LOG: "0", MSLXDFF_TALK_FULL: "0" }, () => {
    assert.equal(createTalkBucketIfEnabled(), null, "两开关都显式关 = 零开销");
  });
});

test("talkPush 按 talk.cap 判顶：撞顶置 capped=true 且停止累积", () => {
  const talk = createTalkBucket(5);
  captureTalkSse(talk, talkFrame({ content: "12345" }));
  assert.equal(talk.capped, false, "恰好到顶不算截断");
  assert.equal(talk.n, 5);
  captureTalkSse(talk, talkFrame({ content: "X" }));
  assert.equal(talk.capped, true, "超出必须显式置位");
  assert.equal(talk.content.join(""), "12345", "撞顶后的分片不再进桶");
  assert.equal(talk.n, 5);
});
