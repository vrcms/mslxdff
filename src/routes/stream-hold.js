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
  let committed = false;
  let draining = false;
  const writeNow = (buf, size) => {
    if (!draining && tail) flushTail(); // 保持帧序：先补已暂扣的 [DONE]，再写新到的
    detail.wroteChunks += 1;
    detail.wroteBytes += size;
    try { res.write(buf); } catch { /* 下游已断开：onClose 已掐上游 */ }
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
    /** 提交：按序补写 pending（不含 tail），再写本帧，此后一律直写。 */
    submit(buf, size) {
      committed = true;
      drainPending();
      writeNow(buf, size);
    },
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
 * SSE 收场：错误帧 → 上游原 [DONE]（若被暂扣过）→ end。
 * 铁律：终止符只能有一个，且必须排在错误帧之后 —— 否则客户端在错误帧到达前就已收尾。
 */
function closeSseWithError(res, msg, flushTail) {
  try {
    res.write(`data: ${JSON.stringify({ error: { message: msg, type: "mslxdff_empty_turn" } })}\n\n`);
  } catch { /* 下游已断：收不到是它的权利 */ }
  let emittedDone = false;
  try { emittedDone = typeof flushTail === "function" ? !!flushTail() : false; } catch { /* ignore */ }
  if (!emittedDone) { try { res.write("data: [DONE]\n\n"); } catch { /* ignore */ } }
  try { res.end(); } catch { /* ignore */ }
  return true;
}
