import { performance } from "node:perf_hooks";
import { injectReasoningContent } from "../reasoning.js";
import { runHook } from "../plugins.js";
import { errMsg, json } from "../routes/helpers.js";
import { hedgeDelayMs, shouldHedge } from "../routes/hedge.js";
import { handleHedge } from "../routes/chat/hedge-handler.js";
import { handleLocalRelay } from "../routes/chat/local-handler.js";
import { handlePeerRelay } from "../routes/chat/peer-handler.js";
import { handleBroadbandRelay } from "../routes/chat/broadband-handler.js";
import { handleViaRoute } from "../routes/chat/via-route-handler.js";
import { handleExhaustedLocal, handleExhaustedAll } from "../routes/chat/exhausted-handler.js";
import { shouldUseGroupForModel, isHardLocalOnly, isKeyProviderDirectOnly } from "../state/schemas/use-group.js";
import { summarizeRequest, upstreamEcho } from "../model-trace.js";
import { isEmptyTurnError } from "../routes/chat/relay-pipeline.js";
import { emptyRetryCfg, emptyRaiseCap, withRaisedMaxTokens, withOutputFloor, emptyNudgeCfg, withEmptyNudge, computeNextDelay, emptyTurnBudgetMs, emptyTurnMinRaiseTo } from "./empty-turn.js";
import { classifyTerminalUpstream, readVerdictText, terminalShortcircuitOff } from "./terminal-verdict.js";
import { forwardOrGuard } from "./context-forward.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function groupSkipReason(model) {
  if (isHardLocalOnly(model)) return "provider local-only（禁组员，仅本机直连）";
  if (isKeyProviderDirectOnly(model)) return "key provider default direct（仅本机直连，MSLXDFF_USE_GROUP_KEYS=1 可开组员）";
  return "useGroup=off";
}

/**
 * 串行 trial — 从 engine.js 抽出的第二段：via-route 单路径 → 串行 trial →
 * hedge/local/peer/broadband/exhausted。恒终结，返回 { done:true }。
 */
export async function runSerialTrial(ctx, deps = {}) {
  const {
    viaRoute = handleViaRoute,
    hedge = handleHedge,
    localRelay = handleLocalRelay,
    peerRelay = handlePeerRelay,
    broadbandRelay = handleBroadbandRelay,
    exhaustedLocal = handleExhaustedLocal,
    exhaustedAll = handleExhaustedAll,
  } = deps;
  const {
    order, reqId, requested, body, hops, useAuto, lockModel, plugins,
    auto, upstream, peers, groups, bus, token, canFallback, canForwardPeers,
    perf0, stages, mark, evt, logCall, logError, done, handlerCtx,
    res, startedAt, logs,
  } = ctx;
  const shareKeys = ctx.shareKeys ?? ctx.policy?.shareKeys ?? {};
  const workbuddyUid = ctx.workbuddyUid ?? ctx.policy?.workbuddyUid ?? null;

  let viaRouteLastErr = null;
  if (!useAuto && requested && requested.includes("/") && canForwardPeers && !lockModel && peers && shouldUseGroupForModel(requested)) {
    try {
      const vr = await viaRoute({ model: requested, body, peers, handlerCtx, evt, logCall, logError, mark, perf0, attemptStartMs: performance.now(), stages, startedAt, plugins, res, requested, useAuto, lockModel, auto });
      if (vr.handled) return { done: true };
      if (vr.lastErr) viaRouteLastErr = vr.lastErr;
    } catch (e) {
      evt("via-route-exception", { reqId, model: requested, error: errMsg(e) });
    }
  } else if (!useAuto && requested && requested.includes("/") && canForwardPeers && !lockModel && peers) {
    evt("group-skip", { reqId, model: requested, reason: `${groupSkipReason(requested)} (via-route)` });
  }

  let lastErr = viaRouteLastErr;
  // 指定模型只走单候选（order=[requested]），组员/组长接力在同模型内进行；候选间不换模型。
  // canFallback 仅对 auto 的多候选生效。poolFallback/"同池互备"已移除：指定模型绝不漂移到别的模型。
  const canFailover = () => canFallback;
  // 请求级空轮等待累计（跨候选）：阶梯是「每发候选」各算的，不设顶就会 N×(2+8+30) 把客户端吊在门外
  let requestWaitedMs = 0;
  candidate: for (let idx = 0; idx < order.length; idx++) {
    const model = order[idx];
    handlerCtx.model = model;
    handlerCtx.orderLen = order.length;
    handlerCtx.idx = idx;
    evt("model-try", { reqId, model, idx, remaining: order.length - idx });
    if (plugins?.length) {
      const bt = await runHook(plugins, "model:beforeTry", { reqId, requested, model, idx, hops });
      for (const e of bt.errors) evt("plugin-hook-error", { reqId, hook: "model:beforeTry", plugin: e.plugin, error: e.error });
      if (bt.value === false || bt.value?.skip === true) { evt("plugin-hook", { reqId, hook: "model:beforeTry", applied: true, skipped: model }); continue; }
    }
    let upRes = null;
    let forwarded = { ...injectReasoningContent(model, body), model };
    // 首发输出额度托底（plugin hook 前——plugin 有最终发言权，硬底线只约束客户端直发 body）
    const _floored = withOutputFloor(forwarded);
    if (_floored !== forwarded) {
      const _fk = ["max_tokens", "max_completion_tokens"].find((k) => _floored[k] !== forwarded[k]) || "max_tokens";
      evt("output-floor", { reqId, model, key: _fk, raiseFrom: Number(forwarded[_fk]), raiseTo: Number(_floored[_fk]) });
      forwarded = _floored;
    }
    if (plugins?.length) {
      const ur = await runHook(plugins, "upstream:request", { reqId, requested, model, payload: forwarded, stream: Boolean(body.stream) });
      for (const e of ur.errors) evt("plugin-hook-error", { reqId, hook: "upstream:request", plugin: e.plugin, error: e.error });
      if (ur.changed && ur.value?.payload && typeof ur.value.payload === "object") { forwarded = ur.value.payload; evt("plugin-hook", { reqId, hook: "upstream:request", applied: true, model, rewrittenModel: forwarded.model ?? null }); }
    }
    const chatOpts = {};
    if (Object.keys(shareKeys).length) chatOpts.shareKeys = shareKeys;
    if (workbuddyUid) chatOpts.workbuddyUid = workbuddyUid;
    if (handlerCtx?.sessionId) chatOpts.sessionId = handlerCtx.sessionId;
    // reqId = 本次客户端请求的身份：供应商据此"同请求粘号"（重试不换号，只有 401/403/429/5xx 冷却才换）
    if (reqId) chatOpts.reqId = reqId;
    const chatOptsArg = Object.keys(chatOpts).length ? chatOpts : undefined;
    // 空转 200（模型无输出）同模型暂停重试：默认 3 次、阶梯 [2s,8s,30s]；仅 EMPTY_MODEL_RESPONSE，
    // 429/403/500 与 fetch 异常走原有切号/failover（防烧额度）。MSLXDFF_EMPTY_TURN_RETRIES=0 关闭。
    // 探针（x-mslxdff-probe:1）不重试：调用方只要一个「活不活」的答案，重试阶梯会把它吊 40s。
    const isProbe = handlerCtx?.isProbe === true;
    const emptyCfg = isProbe ? { max: 0, steps: null, delayMs: 0 } : emptyRetryCfg();
    const raiseCap = emptyRaiseCap();
    const nudgeCfg = emptyNudgeCfg();
    let emptyRetried = 0;
    let emptyWaitedMs = 0;
    for (;;) {
      const tUp = performance.now();
      evt("upstream-try", { reqId, model, attempt: idx + 1, emptyRetry: emptyRetried, payload: summarizeRequest(forwarded) });
      try {
        upRes = await upstream.chat(forwarded, chatOptsArg);
        evt("upstream-done", { reqId, model, ok: !(upRes instanceof Error) && upRes.status < 400, status: upRes instanceof Error ? null : upRes.status, timing: upRes._t ?? null, error: null, ...upstreamEcho(upRes) });
      } catch (err) {
        if (auto) await auto.recordError(model, { message: errMsg(err) });
        lastErr = { model, upstream: null, status: 502, message: errMsg(err) };
        logError(model, 502, errMsg(err));
        evt("upstream-error", { reqId, model, status: 502, message: errMsg(err), timing: err._t ?? { attempts: [], waitMs: 0, totalMs: Math.round(performance.now() - tUp) } });
        upRes = null;
      }
      if (plugins?.length) {
        runHook(plugins, "upstream:response", {
          reqId, requested, model,
          status: upRes instanceof Error ? null : upRes instanceof Object ? (upRes.status ?? null) : null,
          ok: !(upRes instanceof Error) && upRes ? upRes.status < 400 : false,
          error: upRes instanceof Error ? errMsg(upRes) : null,
          timing: upRes?._t ?? null,
        }).catch(() => {});
      }
      mark(`up-${model}`);
      if (upRes && upRes.status >= 400) {
        const isAllowlistBlock = upRes.status === 403 && (upRes.headers?.get?.("x-mslxdff-allowlist") === "1");
        if (isAllowlistBlock) {
          let bodyText = null; try { bodyText = await upRes.clone().text(); } catch {}
          let errBody = { error: `model not allowed for provider` };
          try { errBody = bodyText ? JSON.parse(bodyText) : errBody; } catch { errBody = { error: bodyText || "model not allowed" }; }
          if (useAuto) {
            logError(model, 403, errBody.error || "model not allowed");
            evt("upstream-error", { reqId, model, status: 403, message: errBody.error, timing: upRes._t ?? null, allowlist: true, skipped: true });
            lastErr = { model, upstream: upRes, status: 403, message: errBody.error || "model not allowed" };
            if (canFallback && idx < order.length - 1) { evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: `allowlist skip ${errBody.error || "blocked"}` }); continue candidate; }
            return json(res, 403, errBody);
          }
          logError(model, 403, errBody.error || "model not allowed");
          evt("upstream-error", { reqId, model, status: 403, message: errBody.error, timing: upRes._t ?? null, allowlist: true });
          return json(res, 403, errBody);
        }
        if (auto) await auto.recordError(model, { status: upRes.status });
        // 读失败响应体（clone 不影响后续 relay 转发原响应；1s 上限防流式错误体拖慢）。
        // 两份文本分工写死：`upRaw` 喂判据（≤4KB，反向护栏不能被 400 字摘要喂不到——多 provider 明细体
        // 如 OpenRouter 的 `metadata.raw[]` 会把 rate limit 排在 model not found 之后），`upBody` 供日志摘要。
        let upRaw = "";
        let upBody = "";
        upRaw = await readVerdictText(upRes);
        upBody = upRaw.replace(/\s+/g, " ").slice(0, 400);
        const upMsg = upBody || `upstream ${upRes.status}`;
        lastErr = { model, upstream: upRes, status: upRes.status, message: upMsg };
        // 终局判决短路（判据与现网取证见 terminal-verdict.js）
        const verdict = classifyTerminalUpstream(upRes.status, upRaw);
        const terminalOn = verdict.terminal && !terminalShortcircuitOff();
        // 一行话把「判决」与「原文」一起落 errors.log（不分两行：同一发失败在 errors.log 里只该有一条）
        logError(model, upRes.status, `upstream ${upRes.status}${upBody ? ` body=${upBody.slice(0, 300)}` : ""}${terminalOn ? ` · 终局判决 ${verdict.kind}（跳过组员接力）` : ""}`);
        evt("upstream-error", { reqId, model, status: upRes.status, message: upMsg.slice(0, 300), timing: upRes._t ?? null, ...upstreamEcho(upRes) });
        if (terminalOn) {
          evt("upstream-terminal", { reqId, model, status: upRes.status, kind: verdict.kind, marker: verdict.marker, peersSkipped: true });
          // ASCII 具名头。**不**复用 x-mslxdff-notice：那头的既定语义是「已被别的模型代答」（与
          // x-mslxdff-fallback 成组，src/routes/fallback.js:27-39），拿它报「没代答、直接拒」会把按头
          // 判是否换模型的下游 UI 读反。头值只填 ASCII 枚举，中文留在 evt/logError/timeline（文件是 UTF-8）。
          try { if (!res.headersSent && typeof res.setHeader === "function") res.setHeader("x-mslxdff-terminal", verdict.kind); } catch {}
          if (canFallback && idx < order.length - 1) {
            // 判决只对**这个模型**成立 → 换下一候选。这里刻意不挂 upstream：这条 Response 的 body 没被
            // 消费，挂在 lastErr 上带到收场会白占连接（收场只 relay 最后一发），故直接 cancel 后只留文本。
            lastErr = { model, upstream: null, status: upRes.status, message: upMsg, terminal: verdict.kind };
            try { const cx = upRes.body?.cancel?.(); if (cx && typeof cx.catch === "function") cx.catch(() => {}); } catch {}
            evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: `terminal ${verdict.kind}: ${upMsg.slice(0, 80)}` });
            continue candidate;
          }
          // 收场交回既有出口：exhaustedLocal 见 lastErr.upstream 会 relay **原响应**（原状态码 + 原字节 +
          // 原头），并自带 logCall / result / client-response / talk 语料落盘。自己 json() 反而劣化：
          // 只能给被截到 400 字的二手摘要、JSON.parse 失败时退成字符串 error（SDK 读 err.error.message
          // 拿到 undefined），且 SSE 已 flush 时 helpers 的 in-band 错误帧会把对象写成 [object Object]。
          await exhaustedLocal({ res, body, lastErr, order, handlerCtx: { ...handlerCtx, model, reqId }, evt, logCall, mark, perf0, stages, done, requested, useAuto });
          return { done: true };
        }
        upRes = null;
        break;
      }
      if (upRes) {
        const isStream = Boolean(body.stream);
        const d = hedgeDelayMs();
        const hasPeers = Boolean(peers) && peers.ordered().length > 0;
        const canUseGroup = shouldUseGroupForModel(model);
        const doHedge = canUseGroup && shouldHedge({ isStream, canForwardPeers, hedgeDelayMs: d, hasPeers, model }) && upRes.status === 200 && upRes.body;
        if (doHedge) {
          const hr = await hedge({ upRes, model, body, order, idx, lastErr, requested, useAuto, lockModel, auto, peers, handlerCtx, evt, logCall, logError, mark, perf0, attemptStartMs: tUp, stages, startedAt, plugins, res, hedgeDelayMs: d });
          if (hr.handled) return { done: true };
          if (hr.lastErr) lastErr = hr.lastErr;
          if (hr.upRes === null) upRes = null;
          else if (hr.upRes) upRes = hr.upRes;
        }
        if (upRes) {
          const lr = await localRelay({ upRes, model, body, order, idx, lastErr, requested, useAuto, lockModel, auto, handlerCtx, evt, logCall, logError, mark, perf0, attemptStartMs: tUp, stages, startedAt, plugins, res });
          if (lr.handled) {
            // 空转重试后真拿到输出 = 降级但成功（WARN 语义）：必须交代"第几次救回来的、白等了多久"，
            // 否则用户只看到"这一发变慢了"，无从判断是重试在兜底还是上游真的死了。
            // 「救回」必须有送达证据：handled:true 也可能来自下游已断开/零输出路径（见 ADR-0043），
            // 只认 relay 报上来的 wrotePayload —— 没有正文到下游就不许记成功，否则日志在骗排障的人。
            if (emptyRetried > 0 && lr.wrotePayload === true) {
              evt("empty-turn-recovered", { reqId, model, retries: emptyRetried, max: emptyCfg.max, waitedMs: emptyWaitedMs, ...upstreamEcho(upRes) });
            }
            return { done: true };
          }
          if (lr.lastErr && isEmptyTurnError(lr.lastErr)) {
            // 空转判据原文（finish_reason / 零正文 / 上游错误摘要）随事件落盘，排障不必再翻第二个文件
            const _why = String(lr.lastErr.message || "").replace(/\s+/g, " ").trim().slice(0, 220);
            const budgetMs = emptyTurnBudgetMs();
            const budgetLeftMs = budgetMs - requestWaitedMs;
            if (emptyRetried < emptyCfg.max && budgetLeftMs > 0) {
              // 口径（用户定）：正文为空就重试，最多 emptyCfg.max 次——不设"能不能送达"的前提，
              // 大不了两次都空，反正不是无限重试。抬额度只加不减且有顶（默认 16384）：
              // 思考刷满 max_tokens 是零正文的主因，同参重拉必然复现，抬一次才算换了打法。
              emptyRetried++;
              const _before = Number(forwarded.max_tokens ?? forwarded.max_completion_tokens) || null;
              // 客户端没设额度也兜底发明一次：现网主流空轮就是「思考吃满 max_tokens、正文为零」，同参重拉必复现
              const _raised = withRaisedMaxTokens(forwarded, raiseCap, emptyTurnMinRaiseTo());
              let _after = null;
              if (_raised !== forwarded) { forwarded = _raised; _after = Number(forwarded.max_tokens ?? forwarded.max_completion_tokens); }
              const _isLast = emptyRetried >= emptyCfg.max;
              let _nudged = false;
              if (nudgeCfg.enabled && _isLast) {
                const _next = withEmptyNudge(forwarded, nudgeCfg.text);
                if (_next !== forwarded) { forwarded = _next; _nudged = true; }
              }
              // 事件在 sleep **之前**发：对着日志能立刻看到"正在暂停 Nms 重拉"，而不是等结果
              // 带上"刚空转的是哪个号/哪个站"：切号是重试驱动的，日志必须能自证
              const stepIdx = emptyCfg.steps ? (emptyRetried - 1) % emptyCfg.steps.length : 0;
              const rawDelayMs = computeNextDelay(emptyRetried - 1, emptyCfg.steps, lr.lastErr);
              const delayMs = Math.min(rawDelayMs, budgetLeftMs); // 末次等待不越过请求级预算
              emptyWaitedMs += delayMs;
              requestWaitedMs += delayMs;
              evt("empty-turn-retry", { reqId, model, retry: emptyRetried, step: stepIdx, max: emptyCfg.max, delayMs, waitedMs: emptyWaitedMs, requestWaitedMs, budgetMs, nudged: _nudged ? 1 : undefined, raiseFrom: _after != null ? _before : undefined, raiseTo: _after ?? undefined, reason: _why, ...upstreamEcho(upRes) });
              await sleep(delayMs);
              continue;
            }
            // 次数用尽（或被 MSLXDFF_EMPTY_TURN_RETRIES=0 关掉）→ 记一行"不再重试"再交回 failover
            const _budgetOut = emptyRetried < emptyCfg.max && emptyTurnBudgetMs() - requestWaitedMs <= 0;
            evt("empty-turn-exhausted", { reqId, model, retries: emptyRetried, max: emptyCfg.max, waitedMs: emptyWaitedMs, requestWaitedMs, budgetMs: emptyTurnBudgetMs(), budgetOut: _budgetOut ? 1 : undefined, reason: _why, ...upstreamEcho(upRes) });
            try { logError(model, 502, `空转重试 ${emptyRetried}/${emptyCfg.max} 后仍无输出${emptyCfg.max === 0 ? "（MSLXDFF_EMPTY_TURN_RETRIES=0 已关闭重试）" : _budgetOut ? `（请求级等待预算 ${emptyTurnBudgetMs()}ms 用尽）` : ""}：${_why}`); } catch {}
          }
          if (lr.lastErr) { lastErr = lr.lastErr; continue candidate; }
          return { done: true };
        }
        break;
      }
      break;
    }
    // 转发闸门（详见 context-forward.js）：被拦即收场，不许换路重试——同一份大上下文换个目标照样撑爆。
    const gc = { res, body, order, handlerCtx, evt, logCall, logError, mark, perf0, stages, done, requested, useAuto, model, exhaustedLocal };
    if (canForwardPeers) {
      if (!shouldUseGroupForModel(model)) {
        evt("group-skip", { reqId, model, reason: `${groupSkipReason(model)} (peer)` });
      } else {
        const fr = await forwardOrGuard(() => peerRelay({ model, body, lastErr, requested, useAuto, lockModel, auto, peers, handlerCtx, evt, logCall, mark, perf0, attemptStartMs: performance.now(), stages, startedAt, plugins, res }), gc);
        if (fr.done) return fr;
        lastErr = fr.lastErr ?? lastErr;
      }
    }
    if (groups) {
      if (!shouldUseGroupForModel(model)) {
        evt("group-skip", { reqId, model, reason: `${groupSkipReason(model)} (broadband)` });
      } else {
        const fr = await forwardOrGuard(() => broadbandRelay({ model, body, hops, lastErr, requested, useAuto, lockModel, auto, groups, token, bus, logs, handlerCtx, evt, mark, perf0, attemptStartMs: performance.now(), stages, res, startedAt, plugins }), gc);
        if (fr.done) return fr;
        lastErr = fr.lastErr ?? lastErr;
      }
    }
    if (canFailover()) { evt("fallback", { reqId, from: model, to: order[idx + 1] ?? null, reason: lastErr?.message || `upstream ${lastErr?.status ?? 502}` }); continue; }
    await exhaustedLocal({ res, body, lastErr, order, handlerCtx: { ...handlerCtx, model, reqId }, evt, logCall, mark, perf0, stages, done, requested, useAuto });
    return { done: true };
  }
  await exhaustedAll({ res, body, lastErr, order, requested, handlerCtx: { ...handlerCtx, reqId, startedAt }, evt, logCall, mark, perf0, stages });
  return { done: true };
}
