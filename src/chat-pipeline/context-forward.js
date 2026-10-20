// 转发阶段的上下文闸门编排（从 serial-trial.js 拆出，控单文件 ≤20KB 硬门）。
//
// 分工：context-guard.js 做纯判决（估算 token、比上限），本文件做**编排**——把「组员/宽带转发」
// 整段包起来，闸门一触发就收场，不再落到后面的换路逻辑。
//
// 为什么必须在这里停：闸门拦下**不是**上游失败。同一份大上下文换个目标（组员→宽带成员）照样撑爆，
// 只会白烧另一台机器的额度。故直接以标准 `context_length_exceeded` 收场，让客户端压缩后重试。
import { json } from "../routes/helpers.js";

/** 闸门产出的失败（finishContextGuard 与各 handler 共用同一个标记）。 */
export function isContextGuardErr(e) {
  return Boolean(e && typeof e === "object" && e.contextGuard);
}

/**
 * 收场：未 flush 时回标准错误体（客户端据 code 触发压缩）；已 flush（流式已开始）交给既有出口写 in-band 帧。
 */
export async function finishContextGuard({
  res, body, lastErr, order, handlerCtx, evt, logCall, logError, mark, perf0, stages, done,
  requested, useAuto, model, exhaustedLocal,
}) {
  const g = lastErr?.contextGuard || {};
  evt("context-guard", {
    reqId: handlerCtx.reqId, model, estimated: g.estimated, limit: g.limit, over: g.over,
    action: "stop-forwarding",
  });
  try { logError(model, 400, lastErr.message); } catch {}
  if (!res?.headersSent) {
    return json(res, 400, {
      error: { type: "invalid_request_error", code: "context_length_exceeded", message: lastErr.message },
    });
  }
  await exhaustedLocal({
    res, body, lastErr, order,
    handlerCtx: { ...handlerCtx, model, reqId: handlerCtx.reqId },
    evt, logCall, mark, perf0, stages, done, requested, useAuto,
  });
  return { done: true };
}

/**
 * 跑一段转发并在闸门触发时立即收场。
 * @param {Function} run 真正发起转发的函数（应返回 {handled, lastErr}）
 * @param {object} ctx 收场所需的上下文（res/body/order/handlerCtx/evt/...）
 * @returns {Promise<{done:boolean, lastErr?:object}>}
 */
export async function forwardOrGuard(run, ctx) {
  const r = await run();
  if (r?.handled) return { done: true };
  if (isContextGuardErr(r?.lastErr)) {
    await finishContextGuard({ ...ctx, lastErr: r.lastErr });
    return { done: true };
  }
  return { done: false, lastErr: r?.lastErr };
}
