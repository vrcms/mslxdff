import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightMs, scanSseChunk, scanNonStreamBody, createTalkBucket, createTalkBucketIfEnabled, captureTalkSse, captureTalkFlush } from "../src/routes/stream-scan.js";

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

// —— 回归：帧被网络 chunk 从中间切断，不得丢 tool arguments（观测层丢帧取证根因）——
// 现网证据：raccoon/sn-deepseek-v4-1-flash 语料响应侧 43% tool 路径参数比真实输出少 1~10 字符，
// 客户端透传字节完好、请求侧回显 0 例——丢在 captureTalkSse 的「按 chunk 逐行 parse、半行即弃」。
test("帧被网络 chunk 从中间切断不丢内容（回归丢帧）", () => {
  const full =
    talkFrame({ content: "你好" }) +
    talkFrame({ tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: '{"file_path":"D:\\\\www\\\\root\\\\dcflow\\\\.feature-tree\\\\branches\\\\relay.md"}' } }] }) +
    talkFrame({ content: "世界" });
  const base = createTalkBucket();
  captureTalkSse(base, full);
  assert.equal(base.tools.length, 1, "基准：一次喂入必须含该工具调用");
  assert.ok(base.tools[0].function.arguments.includes("relay.md"), "基准：arguments 完整");
  // 把第二条帧（工具调用）的 arguments 从中间劈成两半，落在 data 行内部（非换行处）
  const cutAt = full.indexOf("branches") + 3;
  const chunk1 = full.slice(0, cutAt);
  const chunk2 = full.slice(cutAt);
  assert.ok(!chunk1.endsWith("\n"), "切点必须落在行内，复现半帧");
  const split = createTalkBucket();
  captureTalkSse(split, chunk1);
  captureTalkSse(split, chunk2);
  assert.equal(split.tools.length, 1, "切包后工具调用不得蒸发");
  assert.equal(split.tools[0].function.arguments, base.tools[0].function.arguments, "arguments 必须逐字全等（丢帧会少字符）");
  assert.equal(split.content.join(""), base.content.join(""), "切包后正文必须全等");
  assert.equal(split.dropped, 0, "拼回成功的行不得计为丢弃（dropped 只在不可逆时增长，review P1-1）");
});

test("多切点参数化：任意位置切包 vs 整包一次喂入，桶内容全等", () => {
  const full =
    talkFrame({ content: "甲" }) +
    talkFrame({ reasoning_content: "乙丙丁" }) +
    talkFrame({ tool_calls: [{ index: 0, id: "c", function: { name: "Grep", arguments: '{"pat":"x/y","g":2}' } }] }) +
    talkFrame({ content: "戊" });
  const base = createTalkBucket();
  captureTalkSse(base, full);
  let diffs = 0;
  for (let i = 1; i < full.length; i++) {
    const t = createTalkBucket();
    captureTalkSse(t, full.slice(0, i));
    captureTalkSse(t, full.slice(i));
    const same =
      t.content.join("") === base.content.join("") &&
      t.reasoning.join("") === base.reasoning.join("") &&
      JSON.stringify(t.tools) === JSON.stringify(base.tools);
    if (!same) diffs++;
  }
  assert.equal(diffs, 0, `存在 ${diffs} 个切点使捕获内容少于整包喂入（丢帧）`);
});

test("末行缺换行不蒸发：captureTalkFlush 回收流末无 \\n 的完整行", () => {
  const line = "data: " + JSON.stringify({ choices: [{ delta: { content: "收尾" } }] });
  const t = createTalkBucket();
  captureTalkSse(t, talkFrame({ content: "前" }) + line); // 末行缺尾 \n：模拟流在末帧后直接收场
  assert.equal(t.content.join(""), "前", "未 flush：行未收尾先不入桶（等拼）");
  assert.equal(t.remain, line, "未 flush：末行完好在缓冲里");
  captureTalkFlush(t);
  assert.equal(t.content.join(""), "前收尾", "flush 后末行必须入桶");
  captureTalkFlush(t); captureTalkFlush(t); // 幂等：重复调用不加戏
  assert.equal(t.content.join(""), "前收尾");
});

test("拼回行含 U+FFFD（切点落在多字节字符中间）整行弃：绝不把乱码记成模型输出", () => {
  const bytes = Buffer.from(talkFrame({ content: "处理中" }), "utf8");
  const cjk = bytes.indexOf(Buffer.from("処", "utf8")) >= 0 ? bytes.indexOf(Buffer.from("処", "utf8")) : bytes.indexOf(Buffer.from("处", "utf8"));
  const c1 = bytes.subarray(0, cjk + 1).toString("utf8"); // 把首字节后的续字节切给下一 chunk → 两侧各产 U+FFFD
  const c2 = bytes.subarray(cjk + 1).toString("utf8");
  assert.ok(c1.includes("\uFFFD") || c2.includes("\uFFFD"), "用例前提：按字节切开确有解码损伤");
  const t = createTalkBucket();
  captureTalkSse(t, c1);
  captureTalkSse(t, c2);
  captureTalkFlush(t);
  assert.ok(!t.content.join("").includes("\uFFFD"), "桶内不得出现替换符乱码");
  assert.ok(!t.content.join("").includes("理中"), "宁缺毋滥：不可逆的半截内容不保");
  assert.equal(t.dropped, 1, "不可逆丢弃必须显式计数（review P1-1：绝不静默吃字）");
});

test("三段切点 + 收场 flush：多边界拼接仍与整包全等（review P2-4）", () => {
  const full =
    talkFrame({ content: "甲" }) +
    talkFrame({ tool_calls: [{ index: 0, id: "c", function: { name: "Edit", arguments: '{"a":"D:\\\\x\\\\y\\\\z.md","b":2}' } }] }) +
    talkFrame({ reasoning_content: "丙丁" }) +
    talkFrame({ content: "戊" });
  const base = createTalkBucket();
  captureTalkSse(base, full);
  let diffs = 0;
  for (let i = 1; i < full.length - 1; i += 5) {
    for (let j = i + 1; j < full.length; j += 5) {
      const t = createTalkBucket();
      captureTalkSse(t, full.slice(0, i));
      captureTalkSse(t, full.slice(i, j));
      captureTalkSse(t, full.slice(j));
      captureTalkFlush(t); // 末段缺 \n 时靠 flush 回收
      const same =
        t.content.join("") === base.content.join("") &&
        t.reasoning.join("") === base.reasoning.join("") &&
        JSON.stringify(t.tools) === JSON.stringify(base.tools) &&
        Number(t.dropped) === 0;
      if (!same) diffs++;
    }
  }
  assert.equal(diffs, 0, `存在 ${diffs} 组双切点使捕获内容偏离整包（多边界丢帧）`);
});

test("超限半行：拼接前丢弃、显式记 dropped，且不吞本轮正常帧（review P2-5/P1-1）", () => {
  const t = createTalkBucket();
  captureTalkSse(t, "data: " + "x".repeat(2_000_005)); // 无尾换行的超限半行
  assert.equal(t.remain.length > 2_000_000, true, "第一轮：超限半行先进缓冲（丢弃发生在拼接前）");
  captureTalkSse(t, talkFrame({ content: "回来了" })); // 下一轮：先弃超限半行，再照常消费本轮完整帧
  assert.equal(t.dropped, 1, "超限丢弃必须记数");
  assert.equal(t.content.join(""), "回来了", "弃半行不许连累本轮正常数据");
  assert.equal(t.remain, "");
});
