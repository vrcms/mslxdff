// 空轮的可挽救性策略（relay 的三个问题在这里回答，stream.js 只负责转发循环）：
//   ① 哪些帧还能撤销？—— 一次尝试在「出现任何模型产出」之前写下去的只有空 delta 帧与 [DONE]，
//      这些字节一旦入下游就撤不回（重拉的正文会接在一个已完成的流后面），所以一律暂扣；
//      攒爆上限（异常形状）才被迫提交，行为退回改前。
//   ② 撤销窗口留不留？—— 流结束仍零产出且下游还活着 → 不 res.end()，把这次尝试交回同模型重拉 /
//      换候选，让后面那发的正文还能顺着同一条连接送出去。
//   ③ 全部救不回来怎么收场？—— 恰好一次、形状与已发出的字节相容（见 endHeldFailure / endEmptyTurnStream）。
// 另有一条次序铁律：`[DONE]` 是流的终点，客户端解析器一见它就收尾 —— 所以**任何要补在它前面的错误帧
// 都必须先把 [DONE] 暂扣住**（tail 槽），否则错误永不可见、还会留下两个终止符。
// 拆出原因：这些策略与 relay 本体同处一文件会破仓库 20KB 硬门，且语义本就独立（不碰上游读取与闸门计时）。
import { json } from "./helpers.js";

// 暂扣上限：正常空轮的前缀就是几帧空 delta + 一个 [DONE]；超过即说明不是这个形状，别为它囤内存。
export const HOLD_MAX_FRAMES = 64;
export const HOLD_MAX_BYTES = 32 * 1024;

/**
 * 把一个 chunk 里夹带的 `[DONE]` 终止帧切下来：返回 { head, rest }，head = 该帧之前的全部字节，
 * rest = 从 `data: [DONE]` 那一行的行首到 chunk 末尾。
 *
 * 为什么必须在 submit 之前切：网络 chunk 边界与 SSE 帧边界**无关**（TCP 分段事实），上游常把末个
 * 内容帧与 `data: [DONE]` 一次 flush 送进同一个 chunk。这种帧若整体直写，`[DONE]` 就抢在错误帧
 * 之前到达客户端 —— 客户端一见 `[DONE]` 即收尾，截断错误帧永远看不见（BUG-17 的修复在这类形态下
 * 完全失效），且收场还会因为 tail 槽空着而补出第二个 `[DONE]`。故 `[DONE]` 必须扣进 tail 槽，
 * 由 flushTail 决定它的最终时机（错误帧之后）。
 *
 * 必须**行锚定**：正文里出现字面量 `[DONE]`（本仓域内很常见——讨论 SSE 的对话）绝不能误判成终止帧，
 * 故只认「整行 trims 后等于 `data: [DONE]`」。扫描走 latin1（1 字节↔1 字符），索引与字节一一对应，
 * 不受多字节字符切分影响。
 */
function toBuf(buf) {
  if (typeof buf === "string") return Buffer.from(buf, "utf8");
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return null;
}
const DONE_LINE_RE = /(^|\n)[ \t]*data:[ \t]*\[DONE\][ \t]*\r?(?=\n|$)/g;
function splitTrailingDone(buf) {
  const b = toBuf(buf);
  if (!b) return null;
  const s = b.toString("latin1");
  DONE_LINE_RE.lastIndex = 0;
  let last = null;
  for (let m; (m = DONE_LINE_RE.exec(s)); ) last = m; // 取最后一个终止帧行
  if (!last) return null;
  const head = last.index + (last[1] === "\n" ? 1 : 0);
  return { head: b.subarray(0, head), rest: b.subarray(head) };
}

/**
 * 这个 chunk 的**最后一个未结束行**像不像 `data: [DONE]` 的半截？
 *
 * 上面的行锚定只解决「完整终止帧与正文同 chunk」，解决不了**终止帧自己被 TCP 切开**
 * （`…data: [DO` | `NE]\n\n` 两个 chunk）。这种形态下行锚定永远匹配不到 ⇒ 终止符照样
 * 抢先于错误帧、收场照样补出第二个 `[DONE]`（实测复现）。故凡尾部是终止行前缀的，
 * 先扣住等下一块拼上再判；下一块到齐后发现不是终止帧，立刻原样放行。
 *
 * 只认「去掉行首空白后是 `data: [DONE]` 的字面前缀」，且长度有上限（半个帧不会很长），
 * 避免把普通正文尾巴扣住。
 */
const MAX_DONE_LINE_LEN = 32;
function doneLinePrefix(buf) {
  const s = buf.toString("latin1");
  const nl = s.lastIndexOf("\n");
  const tail = s.slice(nl + 1); // 最后一个 \n 之后 = 本 chunk 未结束的那一行
  if (!tail || tail.length > MAX_DONE_LINE_LEN) return 0;
  const t = tail.replace(/^[ \t]+/, "").toLowerCase().replace(/[ \t]+/g, " ");
  if (!t) return 0;
  // `data: [DONE]` 与 `data:[DONE]` 两种空白写法都可能是上游形式
  if ("data: [done]".startsWith(t) || "data:[done]".startsWith(t)) return Buffer.byteLength(tail, "latin1");
  return 0;
}

// 空轮「延后封口 + 前缀暂扣」总开关（默认开）。0/off/false = 关：连缓冲都不做，流一结束立即 end()，
// 逐字节复现改前行为（代价：之后的空轮重拉/换候选写的是一次已终结的响应，只省额度、救不回正文）。
export function holdEndEnabled() {
  const s = String(process.env.MSLXDFF_EMPTY_TURN_HOLD_END ?? "").trim().toLowerCase();
  return !(s === "0" || s === "off" || s === "false");
}

/**
 * 可撤销前缀缓冲。帧分三类：
 *  - 注释帧（非数据帧）：直写，不影响可撤销性（客户端视作噪声）；
 *  - 可撤销前缀（空 delta / finish-only 帧）：暂扣，出现模型产出时按序补写；
 *  - `[DONE]`：即使已提交也暂扣在 tail 槽，直到确认没有错误帧要补在它前面。
 * 记账（detail.wroteChunks/wroteBytes）由本模块负责，调用方不必自己数字节。
 */
export function createRevocablePrefix(res, detail, { maxFrames = HOLD_MAX_FRAMES, maxBytes = HOLD_MAX_BYTES } = {}) {
  let pending = [];
  let pendingBytes = 0;
  let tail = null;      // [DONE] 槽：必须最后写，且要让位给错误帧
  let carry = null;     // 半截 `data: [DONE]` 行：等下一块拼上再判（见 doneLinePrefix）
  let committed = false;
  let draining = false;
  let inCarryFlush = false;
  const writeNow = (buf, size) => {
    // carry 是**先到**的字节：任何直写都必须等它先出，否则下游看到乱序帧。
    // 之前只有 submit() 自己消化 carry，hold() 的两个分支与注释帧直写都绕过了它（实测确认）。
    if (!inCarryFlush && carry) flushCarry();
    if (!draining && tail) flushTail(); // 保持帧序：先补已暂扣的 [DONE]，再写新到的
    detail.wroteChunks += 1;
    detail.wroteBytes += size;
    try { res.write(buf); } catch { /* 下游已断开：onClose 已掐上游 */ }
  };
  /**
   * 放行扣着的半截行。它若没以换行结尾**必须补一个** —— 否则随后的错误帧 / `[DONE]` 会粘在同一行上
   * （`data: [DOdata: [DONE]`）：既不是合法 SSE 行、客户端也认不出终止符（实测终止符数=0，比多一个更糟）。
   */
  const flushCarry = () => {
    if (!carry) return false;
    const c = carry;
    carry = null;
    const endsWithNl = c.size > 0 && c.buf[c.size - 1] === 0x0a;
    const b = endsWithNl
      ? (toBuf(c.buf) ?? Buffer.alloc(0))
      : Buffer.concat([toBuf(c.buf) ?? Buffer.alloc(0), Buffer.from("\n", "utf8")]);
    inCarryFlush = true;
    try { writeNow(b, b.length); } finally { inCarryFlush = false; }
    return true;
  };
  const drainPending = () => {
    draining = true;
    try {
      for (const p of pending) writeNow(p.buf, p.size);
    } finally {
      draining = false;
    }
    pending = [];
    pendingBytes = 0;
  };
  const flushTail = () => {
    if (!tail) return false;
    const t = tail;
    tail = null;
    detail.wroteChunks += 1;
    detail.wroteBytes += t.size;
    try { res.write(t.buf); } catch { /* 下游已断开 */ }
    return true; // 告诉收场方：[DONE] 已经由这一帧发出去了，别再补第二个
  };
  return {
    get committed() { return committed; },
    get heldFrames() { return pending.length + (tail ? 1 : 0); },
    /**
     * 暂扣一帧。isDone=true 的帧进 tail 槽（无论是否已提交）；否则进 pending（未提交时可整段撤销）。
     * 返回 false = pending 超上限放不下，调用方必须改为提交，别默默丢字节。
     */
    hold(buf, size, isDone = false) {
      if (isDone) {
        // 半截终止行若还扣着（上一块尾部像终止行前缀、本块却是独立完整终止帧），必须先放出去：
        // 直接塞进 tail 会让它和 [DONE] 粘成 `data: [DOdata: [DONE]` —— 非法行，客户端认不出终止符（实测数=0）。
        if (carry) flushCarry();
        if (tail) flushTail();
        tail = { buf, size };
        return true;
      }
      if (committed) { writeNow(buf, size); return true; }
      if (pending.length >= maxFrames || pendingBytes + size > maxBytes) return false;
      pending.push({ buf, size });
      pendingBytes += size;
      return true;
    },
    /**
     * 提交：按序补写 pending（不含 tail），再写本帧，此后一律直写。
     * 夹带的 `[DONE]` 先切进 tail 槽：chunk 边界≠帧边界，末个内容帧常与 `[DONE]` 同 chunk 到达，
     * 整体直写会让终止符抢先于截断错误帧（见 splitTrailingDone）。
     */
    submit(buf, size) {
      committed = true;
      drainPending();
      // 上一块末尾扣着半个终止帧行：先拼上，整帧判过再决定去留
      let b = buf;
      if (carry) {
        const joined = Buffer.concat([carry.buf, toBuf(buf) ?? Buffer.alloc(0)]);
        b = joined;
        carry = null;
      }
      const sp = splitTrailingDone(b);
      if (sp) {
        if (sp.head.length) writeNow(sp.head, sp.head.length);
        if (tail) flushTail(); // 极端：本帧前已有暂扣的 [DONE]，保序先补
        tail = { buf: sp.rest, size: sp.rest.length };
        return;
      }
      // 尾部是终止行前缀（终止帧被 TCP 切开）：扣住等下一块，别让它抢先入下游
      const pl = doneLinePrefix(b);
      if (pl > 0 && pl < b.length) {
        const keep = b.subarray(b.length - pl);
        const head = b.subarray(0, b.length - pl);
        if (head.length) writeNow(head, head.length);
        carry = { buf: keep, size: keep.length };
        return;
      }
      if (pl > 0) { carry = { buf: b, size: b.length }; return; } // 整块就是半截行
      writeNow(b, b.length);
    },
    /**
     * 收场兜底：扣着的半截行（若上游就此断了，它就是最后一帧）必须原样放出去，不能吞字节。
     * 补换行的理由见模块内 flushCarry。
     */
    flushCarry,
    /** 收尾前补写 pending；tail 留给 flushTail 决定时机（错误帧要先站上去）。 */
    commit() {
      committed = true;
      drainPending();
    },
    flushTail,
    writeNow,
  };
}

/**
 * 收场时按到达顺序放行暂扣内容：先放半截终止行（carry），再放 `[DONE]`（tail）。
 * 两段都在 prefix 里，故调用方只需要一个函数——顺序不能反：carry 是先到的字节。
 * @returns {boolean} true = `[DONE]` 确实由这次调用写出去（收场方别再补第二个）
 */
export function flushPrefixTail(prefix) {
  try { prefix.flushCarry(); } catch { /* ignore */ }
  try { return !!prefix.flushTail(); } catch { return false; }
}

/**
 * 终局收场：把响应「恰好一次」关掉，形状必须与已经发出去的东西相容。
 * - headers 未 flush → 502 JSON（干净的 OpenAI 形错误）；
 * - headers 已 flush（hold 期间发过 keepalive 注释帧，状态码锁死 200 text/event-stream）
 *   → SSE 错误帧 + [DONE]：绝不把 JSON 体混进 event-stream，也绝不抛 ERR_HTTP_HEADERS_SENT。
 * 错误文案带 EMPTY_MODEL_RESPONSE 前缀（与 errors.log / isEmptyTurnError 判据同源，可 grep 对账）。
 */
export function endHeldFailure(res, message, flushTail) {
  if (!res || res.writableEnded) return false;
  const msg = String(message || "EMPTY_MODEL_RESPONSE: empty turn, no recovery");
  if (!res.headersSent) {
    // headers 都没发出去 ⇒ 这一发的暂扣帧全部作废（它们属于失败的那一发，客户端从没收到）
    json(res, 502, { error: msg });
    return true;
  }
  return closeSseWithError(res, msg, flushTail);
}

/**
 * 已经提交过内容、但正文为零的流（现网主流：思考刷满 max_tokens）：错误帧必须排在
 * 上游的 `[DONE]` **之前**，否则客户端一见 [DONE] 就收尾，原因永不可见。
 * flushTail = 把暂扣的 [DONE] 补写出去（由调用方在错误帧之后、end() 之前触发）。
 */
export function endEmptyTurnStream(res, message, flushTail) {
  if (!res || res.writableEnded) return false;
  return closeSseWithError(res, String(message || "EMPTY_MODEL_RESPONSE: empty turn"), flushTail);
}

/**
 * 截断收场（判据 + 收场一起，供 relay 的断流分支一行调用）。
 *
 * 触发形态：流已写出真实内容、却**从未收到上游的终止标记**（`sawFinishReason=null`）就被中断
 * —— 超时腰斩、上游连接断、`upstream-error` 都走这里。旧行为只补一个 `[DONE]` 再按 200 成功返回，
 * 于是客户端既无错误帧也无 finish_reason，**分不出「答完了」与「被砍断」**，会把半截回答当完整结果
 * 继续用（比直接报错更危险）；calls.log 也把这次事故记成一次成功的慢请求。
 * 现网取证：300s 腰斩 2012 块 / 416KB 输出，errors.log 零记录、calls.log 记 200。
 *
 * 收场形状与空轮一致（错误帧 → 原 [DONE] → end），type 另标以便客户端区分两种失败。
 * @returns {boolean} true = 已按「截断」收场；false = 流本来就有终止标记，调用方照旧补 [DONE]
 */
export function endTruncatedStream(res, detail, flushTail) {
  if (!res || res.writableEnded) return false;
  if (detail?.sawFinishReason) return false; // 上游交代过结局，不算截断
  const d = detail || {};
  const why = d.upstreamError || d.exitReason || "stream ended";
  const msg = `STREAM_TRUNCATED: 上游在收到 ${d.receivedChunks || 0} 块 / ${d.receivedBytes || 0} 字节后中断，`
    + `未发出 finish_reason（${why}）— 回答可能在半途被截断`;
  if (detail) { detail.truncated = true; detail.exitReason = "truncated"; detail.upstreamErrorText = d.upstreamErrorText || msg; }
  closeSseWithError(res, msg, flushTail, "mslxdff_truncated");
  return true;
}

/**
 * SSE 收场：错误帧 → 上游原 [DONE]（若被暂扣过）→ end。
 * 铁律：终止符只能有一个，且必须排在错误帧之后 —— 否则客户端在错误帧到达前就已收尾。
 */
function closeSseWithError(res, msg, flushTail, type = "mslxdff_empty_turn") {
  try {
    res.write(`data: ${JSON.stringify({ error: { message: msg, type } })}\n\n`);
  } catch { /* 下游已断：收不到是它的权利 */ }
  let emittedDone = false;
  try { emittedDone = typeof flushTail === "function" ? !!flushTail() : false; } catch { /* ignore */ }
  if (!emittedDone) { try { res.write("data: [DONE]\n\n"); } catch { /* ignore */ } }
  try { res.end(); } catch { /* ignore */ }
  return true;
}
