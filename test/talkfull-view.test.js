// 视图脚本的可测性：parseRecords / renderSession / healthReadings 都是纯函数（不碰 fs、不 console.log），
// 这里只喂 fixture 与人造对象断言；末尾两条 execFileSync 冒烟锁「坏行不致命 + 体检一节存在 + 退出码」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRecords, renderSession, healthReadings, groupSessions, prefixDiff,
  talkFullFileName, logRoot, TH,
} from "../scripts/talkfull-view.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "talkfull-sample.jsonl");
const SCRIPT = join(HERE, "..", "scripts", "talkfull-view.js");
const text = readFileSync(FIXTURE, "utf8");
const parsed = parseRecords(text);
const sessA = groupSessions(parsed.records).get("sess_loop_demo_01");
const readA = healthReadings(sessA);

// —— 捕获内容可读：坏行不致命 ——
test("坏行只计数不整体失败（spec「坏行不致命」）", () => {
  assert.equal(parsed.bad.length, 2, "两行故意写坏的 JSON 必须被统计到");
  assert.deepEqual(parsed.bad.map((b) => b.line), [3, 5], "行号可核对（只报行号与原因，不报错退出）");
  assert.equal(parsed.records.length, 12, "其余记录照常解析");
  assert.equal(parsed.totalLines, 16, "含空行在内的总行数");
});

test("空输入 / 非文本输入不崩，空行不计坏行", () => {
  for (const v of ["", "\n\n", undefined, null]) {
    const r = parseRecords(v);
    assert.deepEqual(r.records, []);
    assert.equal(r.bad.length, 0, "纯空白不是坏行");
  }
  const r = parseRecords("[1,2]\n\"str\"\n7\n{\"ok\":true}\n");
  assert.equal(r.records.length, 1, "顶层不是对象的行算坏行");
  assert.equal(r.bad.length, 3);
});

test("按 ts 正序、按 sessionKey 分组（spec「会话可分组」）", () => {
  assert.equal(sessA.length, 8, "会话 A 共 8 轮");
  const ts = sessA.map((r) => r.ts);
  assert.deepEqual([...ts].sort((a, b) => a - b), ts, "渲染顺序 = ts 正序");
  assert.deepEqual([...groupSessions(parsed.records).keys()], ["sess_loop_demo_01", "sess_b_calm_02", "sess_c_min_03"]);
});

// —— 体检五项：每项都要有判据、有点名 ——
test("① 膨胀曲线：逐轮 requestBytes/历史总长/本轮新增，并点名涨幅最大的一轮", () => {
  assert.equal(readA.growth.length, 8);
  assert.equal(readA.growth[0].requestBytes, parsed.records[0].meta.requestBytes, "requestBytes 取自 meta");
  assert.equal(readA.maxJump.turn, 3, "第 3 轮塞进大工具结果 → 必须是涨幅冠军");
  assert.ok(readA.maxJump.addedChars > 2000, `本轮新增字符数应读得出膨胀（实得 ${readA.maxJump.addedChars}）`);
  assert.ok(readA.maxJump.prevHistoryChars < readA.maxJump.historyChars);
  assert.equal(readA.growth[7].addedChars, null, "降级态轮无法 diff → 新增给 null 而不是瞎猜 0");
});

test("② 重复工具调用：同 name + 同 arguments 计满 REPEAT_MIN 才点名（spec 场景「5 次被点名」）", () => {
  assert.equal(readA.repeats.length, 1);
  const hit = readA.repeats[0];
  assert.equal(hit.name, "read_file");
  assert.equal(hit.count, 5);
  assert.deepEqual(hit.turns, [1, 2, 3, 4, 5], "所在轮序号必须逐一点名");
  assert.match(hit.argHash, /^[0-9a-f]{8}$/, "arguments 空白归一后 sha1 尾 8");
  assert.equal(readA.thresholds.REPEAT_MIN, TH.REPEAT_MIN, "读数必须带着判据出门");
});

test("② 反例：参数不同的同名工具调用不得被误判为重复", () => {
  const mk = (args, i) => ({ ts: 1000 + i, sessionKey: "s", request: { messages: [] }, response: { content: "x", toolCalls: [{ function: { name: "read_file", arguments: args } }] } });
  const rs = [mk('{"path":"a"}', 1), mk('{"path":"b"}', 2), mk('{"path":"c"}', 3)];
  assert.deepEqual(healthReadings(rs).repeats, [], "三次不同参数 → 零命中");
  // 同一份参数、只差空白：必须仍算重复（归一化判据）
  const same = [mk('{"path":"a"}', 1), mk('{ "path" : "a" }', 2), mk('{"path":"a"}\n', 3)];
  assert.equal(healthReadings(same).repeats[0].count, 3);
});

test("③ 连续零工具调用且零正文：点名区间（思考刷满也算零输出）", () => {
  assert.equal(readA.deadStreaks.length, 1);
  const s = readA.deadStreaks[0];
  assert.equal(s.from, 7);
  assert.equal(s.to, 8);
  assert.equal(s.length, TH.DEAD_STREAK_MIN);
  assert.ok(s.reasoningCharsTotal > 0, "这两轮只在想不出话，思考字符数要能佐证判据");
});

test("④ 思考循环信号：命中轮数 ≥LOOP_HINT_MIN 才给结论，且列出命中的词", () => {
  assert.deepEqual(readA.loopHints.hitTurns.map((h) => h.turn), [2, 3, 4]);
  assert.equal(readA.loopHints.triggered, true);
  assert.ok(readA.loopHints.hitTurns[0].words.includes("重试"));
  assert.ok(readA.loopHints.hitTurns[2].words.includes("previous attempt"), "英文措辞同样要命中");
});

test("④ 反例：命中轮数不够时只列读数不下结论", () => {
  const mk = (i, reasoning) => ({ ts: 1000 + i, sessionKey: "s", request: { messages: [] }, response: { reasoning, content: "好" } });
  const rd = healthReadings([mk(1, "我重试一次"), mk(2, "正常思考"), mk(3, "正常思考")]);
  assert.equal(rd.loopHints.count, 1);
  assert.equal(rd.loopHints.triggered, false, "1 < LOOP_HINT_MIN → 不给结论（MUST NOT 无判据断言）");
});

test("⑤ 额度吃光形态：length + 思考占九成 → 单列该轮并给思考/正文字符与 max_tokens（spec 场景）", () => {
  assert.equal(readA.lengthEaten.length, 1);
  const t = readA.lengthEaten[0];
  assert.equal(t.turn, 6);
  assert.ok(t.ratio >= 0.9, `思考占比必须过判据（实得 ${t.ratio}）`);
  assert.ok(t.reasoningChars > 700 && t.contentChars > 0 && t.contentChars < t.reasoningChars / 9, `思考须占九成以上（思考=${t.reasoningChars} 正文=${t.contentChars}）`);
  assert.equal(t.maxTokens, 4096, "max_tokens 从 request.params 拿");
  const noCap = healthReadings([{ ts: 1, sessionKey: "s2", request: { messages: [] }, response: { reasoning: "想".repeat(100), content: "" }, finishReason: "length" }]);
  assert.equal(noCap.lengthEaten[0].maxTokens, null, "params 里没有 max_tokens 时给 null，渲染处标「未捕获」");
});

// —— 渲染：只呈现一次的东西 + 逐轮顺序 + 截断/降级标注 ——
test("renderSession：system 全文与工具清单只呈现一次，后续轮只打新增尾巴", () => {
  const out = renderSession(sessA);
  assert.match(out, /回路体检/, "顶部必须有体检一节");
  assert.equal((out.match(/系统提示全文/g) || []).length, 1, "system 全文只在会话首条完整呈现");
  assert.equal((out.match(/\[工具清单\] 共 3 个/g) || []).length, 1, "tools 清单只完整呈现一次");
  assert.equal((out.match(/\[2\] \[用户\] 帮我梳理/g) || []).length, 1, "首条 user 不得在后续轮重复全文");
  assert.match(out, /本轮新增 \[\+2 条\]/, "前缀 diff 的新增尾巴要标 [+N 条]");
  assert.match(out, /description 前 200 字/, "工具清单判据（name + description 前 200 字 + 参数顶层键名）");
  assert.match(out, /参数顶层键: path\*, offset, limit/, "required 键标 *");
  assert.ok(!out.includes("第 200 字之后的内容不应该出现"), "description 超过 200 字必须被裁");
});

test("renderSession：逐轮顺序 = 头（时间/模型/状态/耗时/usage/finish）→ 思考 → 正文 → 工具调用 → 下一轮工具结果", () => {
  const out = renderSession(sessA);
  const head = out.indexOf("── 轮 1/8");
  const think = out.indexOf("[模型思考]", head);
  const body = out.indexOf("[模型正文]", head);
  const call = out.indexOf("[工具调用]", head);
  const result = out.indexOf("[工具结果] tool_call_id=call_1", head);
  assert.ok(head < think && think < body && body < call && call < result, "顺序错就读不回回路");
  assert.match(out.slice(head, think), /status=200[\s\S]*耗时=\d+ms[\s\S]*finish=tool_calls/, "标题行含状态/耗时/finishReason");
  assert.match(out.slice(head, think), /usage: prompt=\d+ completion=\d+ total=\d+/, "usage 必须打出来");
  assert.match(out, /→ read_file 参数=\{"path":"docs\/ARCHITECTURE.md"\}/, "工具调用给 name + arguments");
});

test("renderSession：降级轮与 truncated 轮在轮次标题行醒目标注（spec「截断必须显式」）", () => {
  const out = renderSession(sessA);
  assert.match(out, /⚠降级:该轮请求体已降级为结构摘要/, "降级态必须标注");
  assert.match(out, /sha1尾8=/, "结构摘要逐条给 chars/hash/head");
  assert.match(out, /轮 8\/8[\s\S]{0,400}⚠truncated:内容触顶不完整/, "truncated 标在轮次标题附近");
  assert.match(out.slice(out.indexOf("── 轮 8/8")), /无法与上一条做前缀 diff/);
  const sessB = groupSessions(parsed.records).get("sess_b_calm_02");
  assert.match(renderSession(sessB), /⚠truncated/, "响应侧截断（非降级）同样要标");
});

test("体检五项判据都随输出打印（MUST NOT 输出无判据的结论式断言）", () => {
  const out = renderSession(sessA);
  assert.equal((out.match(/判据/g) || []).length >= 5, true, "五项各有一条判据");
  for (const n of ["①", "②", "③", "④", "⑤"]) assert.ok(out.includes(n), `缺读数 ${n}`);
  assert.match(out, new RegExp(`REPEAT_MIN=${TH.REPEAT_MIN}[\\s\\S]*DEAD_STREAK_MIN=${TH.DEAD_STREAK_MIN}[\\s\\S]*LOOP_HINT_MIN=${TH.LOOP_HINT_MIN}[\\s\\S]*REASONING_RATIO_MIN=${TH.REASONING_RATIO_MIN}`), "阈值常量必须打印在体检节里");
});

test("纯函数纪律：renderSession / healthReadings 不 console.log", () => {
  const orig = console.log;
  let calls = 0;
  console.log = () => { calls++; };
  try { renderSession(sessA); healthReadings(sessA); } finally { console.log = orig; }
  assert.equal(calls, 0, "打印只准发生在 CLI 入口");
});

test("缺字段容忍：整条 response/meta/usage 都没有也不崩，读数给「未捕获」", () => {
  const sessC = groupSessions(parsed.records).get("sess_c_min_03");
  const out = renderSession(sessC);
  assert.match(out, /usage: 未捕获/);
  assert.match(out, /hops: \?/);
  assert.match(out, /\[模型正文\]（0 字符）/);
  const rd = healthReadings([{ ts: 5, sessionKey: "x" }]);
  assert.equal(rd.turnCount, 1);
  assert.equal(rd.growth[0].requestBytes, null);
  assert.deepEqual(rd.repeats, []);
  assert.equal(rd.deadStreaks.length, 0, "单轮零输出未达 DEAD_STREAK_MIN → 只给判据不点名");
});

test("prefixDiff 本体：共享前缀、分叉、无前一条三种形态", () => {
  const sys = { role: "system", content: "S" };
  const u = { role: "user", content: "U" };
  const a = { role: "assistant", content: "A" };
  assert.deepEqual(prefixDiff(null, [sys, u]).added, [sys, u], "会话首条 = 全部是新增");
  assert.deepEqual(prefixDiff([sys, u], [sys, u, a]).added, [a]);
  const d = prefixDiff([sys, u, a], [sys, u, { role: "user", content: "改了历史" }]);
  assert.equal(d.same, 2);
  assert.equal(d.diverged, true, "客户端改写历史必须被标出来而不是静默丢弃");
});

test("talkFullFileName：与 talkLogName 同规则（供应商/模型 → 供应商-模型），只换尾缀", () => {
  assert.equal(talkFullFileName("qoder/qfmodel"), "qoder-qfmodel-talkfull.jsonl");
  assert.equal(talkFullFileName("Qoder/QFModel"), "qoder-qfmodel-talkfull.jsonl");
  assert.equal(talkFullFileName(" Qoder / QFModel "), "qoder---qfmodel-talkfull.jsonl", "空格折叠成 -（与 talkLogName 逐字同规则，两侧一致才算等价）");
  assert.equal(talkFullFileName("free"), "free-talkfull.jsonl", "裸 id（免费池）只有一段");
  assert.equal(talkFullFileName("a/b/c"), "a-b-c-talkfull.jsonl");
  assert.equal(talkFullFileName(undefined), "unknown-talkfull.jsonl");
  assert.equal(talkFullFileName("qoder/未 知 模型!!"), "qoder-talkfull.jsonl", "非 ASCII 与空格同样折叠成 - 再剪尾（talkLogName 既有行为）");
  assert.equal(talkFullFileName("x/" + "very-deep".repeat(60)).length, 180 + "-talkfull.jsonl".length, "超 180 字符要裁掉（talkLogName 同规则）");
});

test("logRoot：MSLXDFF_DAEMON_DIR ＞ state 同目录 ＞ ~/.config/mslxdff（只读脚本自己实现同口径）", () => {
  assert.equal(logRoot({ MSLXDFF_DAEMON_DIR: "/tmp/daemon" }), "/tmp/daemon");
  assert.match(logRoot({ MSLXDFF_STATE_FILE: join("/tmp", "aaa", "state.json") }), /aaa$/);
  assert.match(logRoot({}), /[.\\/]config/, "兜底走 ~/.config/mslxdff");
});

// —— CLI 冒烟 ——
function runCli(args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

test("冒烟：--file 跑 fixture 退出码 0，输出含「体检」且坏行被计数", () => {
  const out = runCli(["--file", FIXTURE]);
  assert.match(out, /回路体检/);
  assert.match(out, /坏行 2 条/);
  assert.match(out, /①[\s\S]*⑤/);
});

test("冒烟：--tail 收窄窗口、--session 过滤会话", () => {
  const t1 = runCli(["--file", FIXTURE, "--tail", "1"]);
  assert.match(t1, /只渲染末 1 轮/);
  assert.match(t1, /样本：1 轮/);
  const s = runCli(["--file", FIXTURE, "--session", "sess_b_calm_02"]);
  assert.ok(!s.includes("sess_loop_demo_01 ｜"), "其它会话不得混进渲染");
  assert.match(s, /会话 sess_b_calm_02/);
  const none = runCli(["--file", FIXTURE, "--session", "ses_不存在"]);
  assert.match(none, /0 命中/);
});

test("冒烟：无 --file 时列候选目录（首行给目录总占用），缺文件时退出码非 0 且给人话", () => {
  const empty = join(dirname(FIXTURE), "__no_such_talkfull_dir__");
  const out = runCli([], { MSLXDFF_DAEMON_DIR: empty });
  assert.match(out, /\[成本\][\s\S]*总占用/, "首行必须是目录总占用（读者看得见成本）");
  assert.match(out, /目录不存在|没有文件/);
  let err = null;
  try { execFileSync(process.execPath, [SCRIPT, "--model", "qoder/qfmodel"], { encoding: "utf8", env: { ...process.env, MSLXDFF_DAEMON_DIR: empty }, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { err = e; }
  assert.ok(err, "--model 解析不到文件必须以非 0 退出");
  assert.equal(err.status, 1);
  assert.match(err.stderr, /该文件不存在/);
});

// —— P0 修复回归（对抗性复审 2026-10-05）：锁「与写侧同形 + 读数不骗人」 ——
const recShape = (over = {}) => ({ // 与 src/talk-full.js 实际写出的形状一致（stream 是数字，meta 带 cap）
  ts: 1791173000000, time: "2026-10-05 12:03:20", reqId: "req-p0-01", sessionKey: "sess_p0", clientIp: "127.0.0.1",
  model: "qoder/qfmodel", via: "local", hops: 0, status: 200, stream: 1, elapsedMs: 1234,
  usage: null, finishReason: "stop", upstream: null, account: null, pick: null,
  request: { model: "qoder/qfmodel", messages: [{ role: "user", content: "hi" }], tools: null, params: {} },
  response: { reasoning: "", content: "ok", toolCalls: [] },
  meta: { requestBytes: 100, responseChars: 2, reasoningChars: 0, truncated: false, cap: 2000000 },
  ...over,
});

test("P0-1 与写侧同形：stream 落数字 0/1 时渲染为 1/0，不再是 ?（fixture 已回写侧形状）", () => {
  const out = renderSession([recShape(), recShape({ stream: 0 })]);
  assert.match(out, /stream=1/);
  assert.match(out, /stream=0/);
  assert.ok(!out.includes("stream=?"), "数字 0/1 不得再渲染成 ?");
});

test("P0-2 窗口首轮：无 diff 基线时标 n/a 且不参与「涨幅最大」竞争", () => {
  const big = recShape({ reqId: "req-p0-big", request: { model: "m", messages: [{ role: "user", content: "x".repeat(5000) }], tools: null, params: {} }, meta: { requestBytes: 6000, responseChars: 2, reasoningChars: 0, truncated: false, cap: 100 } });
  const rd = healthReadings([big]);
  assert.equal(rd.maxJump, null, "窗口首轮（无上一条）不得被当成涨幅冠军");
  assert.equal(rd.growth[0].addedChars, null);
});

test("P0-3 上一条为降级摘要时：下一轮不误报「历史不共享前缀」，diff 基线作废", () => {
  const degraded = recShape({ reqId: "req-p0-deg", request: { model: "m", messages: [{ i: 0, role: "user", chars: 100, hash: "abcd1234", head: "…" }], tools: null, params: {} } });
  const next = recShape({ reqId: "req-p0-next", request: { model: "m", messages: [{ role: "user", content: "brand new" }], tools: null, params: {} } });
  const out = renderSession([degraded, next]);
  assert.ok(!out.includes("历史不共享前缀"), "降级摘要不是真实历史，不得判分叉");
  assert.match(out, /降级|无法比对|n\/a/);
});

test("P0-4 零输出按 status/finishReason 分流：上游失败不算「模型空转」", () => {
  const failed = recShape({ reqId: "req-p0-err", status: 502, finishReason: null, response: { reasoning: "", content: "", toolCalls: [] } });
  const failed2 = recShape({ reqId: "req-p0-err2", status: 502, finishReason: null, response: { reasoning: "", content: "", toolCalls: [] } });
  const rd = healthReadings([failed, failed2]);
  assert.equal(rd.deadStreaks.length, 0, "非 200 的零输出轮不得进「连续空转」点名");
  assert.equal(rd.deadByError.length, 2, "应单列到「非空轮零输出（原因见 status）」");
});

// —— §3.6 读侧新口径：elapsedMs（尝试墙钟）优先，缺失回落 meta.relayMs 并标注来源 ——
test("§3.6 耗时读数：elapsedMs 缺失 → 回落 meta.relayMs 并标注来源；在场 → 原样，两值不同另列 relayMs", () => {
  const noElapsed = recShape({ reqId: "v-fb", elapsedMs: null, meta: { requestBytes: 100, responseChars: 2, reasoningChars: 0, truncated: false, cap: 2_000_000, relayMs: 4321 } });
  const out1 = renderSession([noElapsed]);
  assert.match(out1, /耗时=4321ms/, "elapsedMs 缺失时回落 meta.relayMs 并打出来");
  assert.match(out1, /relayMs/, "标注回退来源，别把 relay 计时误读成尝试墙钟");
  const withElapsed = recShape({ reqId: "v-ok", elapsedMs: 7207, meta: { requestBytes: 100, responseChars: 2, reasoningChars: 0, truncated: false, cap: 2_000_000, relayMs: 2 } });
  const out2 = renderSession([withElapsed]);
  assert.match(out2, /耗时=7207ms/, "elapsedMs 在场时仍取它（新口径真值）");
  assert.match(out2, /relayMs=2ms/, "两值不同才另列 relayMs");
});

test("§3.6 文案：缺省态提示改「缺省已开、MSLXDFF_TALK_FULL=0 可关」，旧「默认关」表述清除", () => {
  const empty = join(dirname(FIXTURE), "__no_such_talkfull_dir__");
  const out = runCli([], { MSLXDFF_DAEMON_DIR: empty });
  assert.match(out, /缺省已开/);
  assert.match(out, /MSLXDFF_TALK_FULL=0/);
  assert.ok(!out.includes("默认关"), "「回路语料默认关」旧文案不得残留");
});
