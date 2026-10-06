// agent 回路全量捕获（talk/full lane）：每轮 agent↔模型的完整请求/响应以 JSONL 只读语料落盘，供人调试 agent 与 skill。
// 与 talk-log.js 分工：那边「人读环形稿、只留最后一问」，这里「机读全量、一条自足」—— 缺省开（opt-out），只有显式关闭词 MSLXDFF_TALK_FULL=0/off/false/no/disable 才停写。
// 纯旁路：不改响应字节/状态码/闸门与空轮判据，异常一律吞掉返回 false；写盘走模块内单 promise 链串行 appendFile（design D11）。
// 处理链（写前，顺序冻结）在 ./talk-full-redact.js；执行时机在写队列任务内、不在请求收场路径（P1-C）。
import { chmodSync, mkdirSync } from "node:fs";
import { appendFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logDir } from "./logs.js";
import { talkLogName } from "./talk-log.js";
import { fmtShanghaiYMDHMS } from "./time.js";
import { composeLine, normSessionKey, shapeForCapture, stringifySafe } from "./talk-full-redact.js";

const MB = 1024 * 1024;
function envInt(name, dflt) { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt; }
const maxLineBytes = () => envInt("MSLXDFF_TALK_FULL_MAX_LINE_MB", 16) * MB; // 单条超限降级阈值
const maxFileBytes = () => envInt("MSLXDFF_TALK_FULL_MAX_MB", 50) * MB;      // 单文件轮转阈值（按字节不按时间）
const keepCount = () => { const n = Number(process.env.MSLXDFF_TALK_FULL_KEEP); return Number.isInteger(n) && n >= 0 ? n : 3; };

/** 缺省开（opt-out，ADR-0046）：只有显式关闭词 0/off/false/no/disable（trim+lowercase）才关；未设、1、true、on、yes 与任意其它值一律开 —— 写错的值不得静默变关。 */
export function agentLoopEnabled() {
  const v = String(process.env.MSLXDFF_TALK_FULL ?? "").trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no" || v === "disable");
}

/** 响应正文桶上限的单一真相：MSLXDFF_TALK_CAP_CHARS 正数覆盖 ＞ 缺省开 200 万 ＞ 显式关 40 万（两档数字逐字不变，档位随 agentLoopEnabled 连动，避免两处真相）。 */
export function talkCapChars() {
  const n = Number(process.env.MSLXDFF_TALK_CAP_CHARS);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return agentLoopEnabled() ? 2_000_000 : 400_000;
}

export function agentLoopDir() { return join(logDir(), "talk", "full"); }
/** 与 talk.log 命名同源：<dir>/<供应商>-<模型>-talkfull.jsonl（talkLogName 的 -talk.log 换成 -talkfull.jsonl）。 */
export function agentLoopFile(model) { return join(agentLoopDir(), `${talkLogName(model).replace(/(?:-talk)?\.log$/, "")}-talkfull.jsonl`); }

// ── 落盘：模块内单队列（写与轮转同队、不抢跑）+ 按字节 rename 轮转 ──────────
let queue = Promise.resolve();
const readyDirs = new Set();
const chmodded = new Set();
function enqueue(task) { queue = queue.then(task).catch(() => {}); return queue; }
async function rotate(file, keep) {
  await rm(`${file}.${keep}`, { force: true }).catch(() => {});
  for (let i = keep - 1; i >= 1; i--) await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
  await rename(file, `${file}.1`).catch(() => {});
}
/** 单次写尝试：仅缓存未命中才 mkdir；appendFile 失败返回 false（不抛），由 queueWrite 决定是否重试一次。 */
async function writeOnce(file, line) {
  const dir = dirname(file);
  if (!readyDirs.has(dir)) { try { mkdirSync(dir, { recursive: true }); readyDirs.add(dir); } catch { return false; } } // 目录只在受理后出现
  const st = await stat(file).catch(() => null);
  if (st && st.size > maxFileBytes()) {
    const keep = keepCount();
    if (keep < 1) await rm(file, { force: true }).catch(() => {});
    else await rotate(file, keep);
  }
  try { await appendFile(file, `${line}\n`, { mode: 0o600 }); } catch { return false; }
  if (!chmodded.has(file)) { chmodded.add(file); try { chmodSync(file, 0o600); } catch {} } // mode 只在新建生效，存量补一次
  return true;
}
// 读数口径单一真相（design D3）：本次尝试墙钟优先；起点不可得时回退 relay 内部 totalMs（此时 elapsedMs 与 relayMs 同值，不伪造）。
function elapsedOf(attempt, total) {
  const a = Number(attempt);
  if (Number.isFinite(a)) return a;
  const t = Number(total);
  return Number.isFinite(t) ? t : null;
}

// 失败分支重试一次（正常路径零额外成本）：readyDirs 缓存过期（用户手工 rm -r / 移走 talk/full）时
// 先清掉目录缓存重走 mkdir + chmod，仍失败才彻底放弃（继续吞，契约：捕获失败绝不打扰请求）。
// 重活全在已排队的异步任务里做（P1-C）：整 body 序列化算 requestBytes + composeLine（递归黑名单串化 → 整串 6 条正则
// → 整记录 JSON.parse 回验 → 超限时最多 64 趟三级钳制重序列化）。留在同步段等于每条请求收场都付这份 CPU
// （4MB body 实测 ~21ms、16MB 级可到百毫秒事件循环停顿），与 design「纯旁路不占请求路径」相抵。
// 落盘逐字不变的前提：① rec 里派生自 body 的结构（request/response）已由 shapeForCapture 在同步段深拷定稿，
// 队列任务只读 body 算长度、不再读它的结构（recordAgentLoop 之后无任何生产调用方改写 body：空转抬额走的
// withRaisedMaxTokens 也是产新对象）；② 键序按字面量插入序冻结 → requestBytes 先占位再回填，事后补键会被
// JSON.stringify 排到 meta 末尾；③ 队列内异常照旧由 enqueue 的 .catch(() => {}) 吞掉（受理即返回 true，与写盘失败同语义）；
// ④ limitBytes 与 agentLoopFile 仍在受理时刻算：env 阈值若挪到队列里读，测试/关停路径的 env 还原会把降级档位读错。
function queueWrite(file, rec, body, limitBytes) {
  return enqueue(async () => {
    rec.meta.requestBytes = Buffer.byteLength(stringifySafe(body ?? {}), "utf8");
    const line = composeLine(rec, limitBytes);
    if (await writeOnce(file, line)) return;
    readyDirs.delete(dirname(file)); chmodded.delete(file);
    await writeOnce(file, line);
  });
}
/** 排空写队列：测试断言前与进程退出前调用。 */
export async function flushAgentLoop() {
  for (let i = 0; i < 1000; i++) { const q = queue; await q; if (q === queue) return; }
}

/**
 * 一条上游尝试 = 一行自包含 JSONL。判据顺序即契约：
 * ① 开关 ② hops>0（组员转发的对话不落盘，spec「只捕获本机自发流量」）③ 两侧全空且 status≠200 ④ 受理。
 * 任何异常吞掉返回 false，MUST NOT 抛出影响请求。
 */
export function recordAgentLoop({ reqId, model, via, hops, body, out, sessionKey, clientIp, echo, attemptMs, relayMs } = {}) {
  if (!agentLoopEnabled()) return false;
  try {
    if (Number(hops) > 0) return false;
    const talk = out?.detail?.talk || {};
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const reasoning = (talk.reasoning || []).join("");
    const content = (talk.content || []).join("");
    const toolCalls = Array.isArray(talk.tools) ? talk.tools : [];
    const status = out?.status == null || !Number.isFinite(Number(out.status)) ? null : Number(out.status);
    if (!msgs.length && !reasoning && !content && !toolCalls.length && status !== 200) return false;
    const at = Date.now();
    const rec = {
      ts: at, time: fmtShanghaiYMDHMS(new Date(at)),
      reqId: reqId ?? null, sessionKey: normSessionKey(sessionKey, msgs), clientIp: clientIp ?? null,
      model: String(model || "unknown"), via: via ?? null,
      hops: hops == null || hops === "" || !Number.isFinite(Number(hops)) ? null : Number(hops),
      status, stream: body?.stream ? 1 : 0, elapsedMs: elapsedOf(attemptMs, out?.totalMs),
      usage: out?.detail?.usage ?? null, finishReason: out?.detail?.sawFinishReason ?? null,
      upstream: echo?.upstream ?? null, account: echo?.account ?? null, pick: echo?.pick ?? null,
      ...shapeForCapture({ body, model, msgs, reasoning, content, toolCalls }),
      meta: {
        requestBytes: 0, // 占位只冻键序（P1-C）：真值在 queueWrite 的队列任务里按整 body 序列化回填
        responseChars: Number.isFinite(Number(talk.n)) ? Number(talk.n) : content.length, // 桶的 n 显式写进读数
        reasoningChars: reasoning.length,                                                 // 思考与正文分列，不互相吞并
        truncated: Boolean(talk.capped),                                                  // 撞顶必须看得见
        cap: talkCapChars(),
        relayMs: elapsedOf(relayMs, out?.totalMs), // relay 内部计时恒写：与 elapsedMs（尝试墙钟）分列，「上游多久 vs 写给客户端多久」可各自判读
      },
    };
    queueWrite(agentLoopFile(rec.model), rec, body, maxLineBytes()); // 阈值与目标文件在受理时刻定档，序列化/降级/回验全在队列内
    return true;
  } catch { return false; }
}
