import { performance as nodePerf } from "node:perf_hooks";

const ORIG_PREFERRED = "mimo-v2.5-free";
const ORIG_FALLBACK = "big-pickle";

/**
 * 编排深模块：mimo → pickle → gateway 三级降级 + 800ms 对冲
 * 注入化：chatOnce / chatViaGateway / cooling / config / env / performance
 */
export function createOrchestrator({
  chatOnce,
  chatViaGateway,
  cooling,
  config = {},
  env = process.env,
  performance: perf = nodePerf,
  chatWithFallbackImpl,
} = {}) {
  const CHAT_PREFERRED = config.CHAT_PREFERRED || ORIG_PREFERRED;
  const CHAT_FALLBACK = config.CHAT_FALLBACK || ORIG_FALLBACK;
  const CHAT_GATEWAY_TIMEOUT_MS = config.CHAT_GATEWAY_TIMEOUT_MS || 25000;
  const CHAT_COOLDOWN_MS = 10 * 60 * 1000;
  const CHAT_SLOW_COOLDOWN_MS = 10 * 60 * 1000;

  const _chatOnce = chatOnce || (async () => ({ ok: false, error: "no chatOnce", status: 500 }));
  const _gateway = chatViaGateway || (async () => ({ ok: false, error: "no gateway", status: 500 }));
  const _cooling = cooling || {
    isCooling: async () => false,
    recordError: async () => {},
    recordOk: async () => {},
  };

  async function isCoolingAsync(id) {
    try { return await _cooling.isCooling(id); } catch { return false; }
  }
  async function recordChatError(id, status, opts) {
    try { await _cooling.recordError(id, status, opts); } catch {}
  }
  async function recordChatOk(id, latencyMs) {
    try { await _cooling.recordOk(id, latencyMs); } catch {}
  }

  async function safeChatOnce(opts, model) {
    try {
      const r = await _chatOnce({ ...opts, model });
      return r;
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 800);
      const status = err?._t ? 502 : 502;
      return { ok: false, error: msg, status, _thrown: err };
    }
  }

  async function chatWithFallback(opts) {
    if (chatWithFallbackImpl) return chatWithFallbackImpl(opts);
    const TRACE = env.MSLXDFF_CHAT_TRACE !== "0";
    const HEDGE_MS = (() => {
      const v = Number(env.MSLXDFF_HEDGE_DELAY_MS);
      return Number.isInteger(v) && v >= 0 ? v : 800;
    })();
    const t0 = TRACE ? perf.now() : 0;

    const firstCooling = await isCoolingAsync(CHAT_PREFERRED);
    let first;
    let firstMs = 0;
    if (firstCooling) {
      if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} 跳过（冷却中）· 直接试 ${CHAT_FALLBACK}\x1b[0m`);
      first = { ok: false, error: "skip cooling", status: 429 };
    } else {
      const t = perf.now();
      first = await safeChatOnce(opts, CHAT_PREFERRED);
      firstMs = Math.round(perf.now() - t);
      if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} ${first.ok ? "OK" : "FAIL"} · ${Math.round(perf.now() - t0)}ms${first.ok ? "" : ` · ${String(first.error).slice(0, 80)}`}\x1b[0m`);
      if (first.ok) {
        await recordChatOk(CHAT_PREFERRED, firstMs);
        return { ...first, model: CHAT_PREFERRED };
      } else {
        const slow = firstMs > 20000;
        await recordChatError(CHAT_PREFERRED, first.status, { slow, latencyMs: firstMs });
      }
    }

    if (firstCooling) {
      if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} 冷却中（${CHAT_COOLDOWN_MS / 60000}min）· 直接走网关 auto，跳过 ${CHAT_FALLBACK}\x1b[0m`);
      if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} 冷却，直接走网关 auto（:8989）\x1b[0m`);
      const t2 = TRACE ? perf.now() : 0;
      const third = await _gateway(opts);
      if (TRACE) console.log(`\x1b[90m· [LLM] gateway auto ${third.ok ? "OK" : "FAIL"} · ${Math.round(perf.now() - t2)}ms · 总 ${Math.round(perf.now() - t0)}ms (gateway-fallback)\x1b[0m`);
      if (third.ok) return { ...third, model: third.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: "skip big-pickle (mimo cooling)", viaGateway: true };
      return { ok: false, error: `${CHAT_PREFERRED} cooling: ${first.error}; gateway auto failed: ${third.error}`, status: third.status || 429 };
    }

    const secondCooling = await isCoolingAsync(CHAT_FALLBACK);
    const doGateway = () => _gateway(opts);
    const doSecond = async () => {
      const t = perf.now();
      const r = await safeChatOnce(opts, CHAT_FALLBACK);
      const ms = Math.round(perf.now() - t);
      if (r.ok) await recordChatOk(CHAT_FALLBACK, ms);
      else await recordChatError(CHAT_FALLBACK, r.status, { slow: ms > 20000, latencyMs: ms });
      return { res: r, ms };
    };

    if (secondCooling) {
      if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_FALLBACK} 跳过（冷却中）· 直接走网关 auto\x1b[0m`);
      const t2 = perf.now();
      const third = await doGateway();
      if (TRACE) console.log(`\x1b[90m· [LLM] gateway auto ${third.ok ? "OK" : "FAIL"} · ${Math.round(perf.now() - t2)}ms · 总 ${Math.round(perf.now() - t0)}ms (gateway-fallback)\x1b[0m`);
      if (third.ok) return { ...third, model: third.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: "skip cooling", viaGateway: true };
      return { ok: false, error: `${CHAT_PREFERRED} failed: ${first.error}; ${CHAT_FALLBACK} failed: skip cooling; gateway auto failed: ${third.error}`, status: third.status || first.status };
    }

    if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_PREFERRED} 失败，${CHAT_FALLBACK} + gateway 对冲中（${HEDGE_MS}ms）\x1b[0m`);
    const t1 = TRACE ? perf.now() : 0;
    let secondRes = null;
    let secondMs = 0;
    let gatewayRes = null;

    const secondPromise = doSecond().then(({ res, ms }) => {
      secondRes = res; secondMs = ms;
      if (TRACE) console.log(`\x1b[90m· [LLM] ${CHAT_FALLBACK} ${res.ok ? "OK" : "FAIL"} · ${Math.round(perf.now() - t1)}ms · 总 ${Math.round(perf.now() - t0)}ms (hedge)\x1b[0m`);
      return res;
    });

    let gatewayPromise = null;
    const gatewayDelay = HEDGE_MS > 0 ? HEDGE_MS : 0;
    if (gatewayDelay > 0) {
      gatewayPromise = new Promise((resolve) => {
        setTimeout(async () => {
          const r = await doGateway();
          gatewayRes = r;
          resolve(r);
        }, gatewayDelay);
      });
    } else {
      gatewayPromise = doGateway().then((r) => { gatewayRes = r; return r; });
    }

    const raceFirstOk = async () => {
      const secondOrTimeout = await Promise.race([
        secondPromise.then((r) => ({ kind: "second", r })),
        new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), gatewayDelay)),
      ]);
      if (secondOrTimeout.kind === "second" && secondOrTimeout.r?.ok) {
        return { ok: true, res: secondOrTimeout.r, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
      }
      if (!gatewayPromise || secondOrTimeout.kind === "timeout") {
        const immediate = doGateway().then((r) => { gatewayRes = r; return r; });
        if (gatewayPromise) {
          gatewayRes = await Promise.race([gatewayPromise, immediate]);
        } else {
          gatewayRes = await immediate;
        }
      } else {
        gatewayRes = await gatewayPromise;
      }
      if (gatewayRes?.ok) return { ok: true, res: gatewayRes, model: gatewayRes.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: secondRes?.error, viaGateway: true };
      if (secondRes?.ok) return { ok: true, res: secondRes, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
      return { ok: false, gatewayRes, secondRes };
    };

    if (gatewayDelay === 0) {
      const [sRes, gRes] = await Promise.all([
        secondPromise.catch((e) => ({ ok: false, error: String(e), status: 502 })),
        doGateway().catch((e) => ({ ok: false, error: String(e), status: 502 })),
      ]);
      secondRes = sRes; gatewayRes = gRes;
      if (sRes?.ok) return { ...sRes, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
      if (gRes?.ok) return { ...gRes, model: gRes.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: sRes?.error, viaGateway: true };
      return { ok: false, error: `${CHAT_PREFERRED} failed: ${first.error}; ${CHAT_FALLBACK} failed: ${sRes?.error}; gateway auto failed: ${gRes?.error}`, status: gRes?.status || sRes?.status || first.status };
    }

    const raced = await raceFirstOk();
    if (raced.ok) {
      const r = raced.res;
      return { ...r, model: raced.model, fallback: raced.fallback, fallbackGateway: raced.fallbackGateway, firstError: raced.firstError, secondError: raced.secondError, viaGateway: raced.viaGateway };
    }
    if (!secondRes) {
      try { secondRes = await secondPromise; } catch (e) { secondRes = { ok: false, error: String(e), status: 502 }; }
    }
    if (secondRes?.ok) return { ...secondRes, model: CHAT_FALLBACK, fallback: true, firstError: first.error };
    if (!gatewayRes) {
      try { gatewayRes = await (gatewayPromise || doGateway()); } catch (e) { gatewayRes = { ok: false, error: String(e), status: 502 }; }
    }
    if (gatewayRes?.ok) return { ...gatewayRes, model: gatewayRes.model || "auto", fallbackGateway: true, fallback: true, firstError: first.error, secondError: secondRes?.error, viaGateway: true };
    return { ok: false, error: `${CHAT_PREFERRED} failed: ${first.error}; ${CHAT_FALLBACK} failed: ${secondRes?.error}; gateway auto failed: ${gatewayRes?.error}`, status: gatewayRes?.status || secondRes?.status || first.status };
  }

  async function summarizeHistory(messages) {
    const prompt = [
      { role: "system", content: "你是对话压缩助手，把以下历史对话压缩成 800 字以内的中文摘要，保留关键操作与结果、用户的偏好与待办、模型设置与群组操作及时间线，不要遗漏重要细节。" },
      { role: "user", content: messages.map((m) => `${m.role}: ${m.content || JSON.stringify(m.tool_calls || "")}`).join("\n").slice(0, 90000) },
    ];
    const r = await chatWithFallback({ messages: prompt });
    if (!r.ok) return null;
    const txt = String(r.message?.content || "").trim();
    return txt ? `【历史摘要】${txt}` : null;
  }

  // 兼容测试的额外覆盖参数
  if (chatWithFallbackImpl) {
    const orig = chatWithFallback;
    // 允许测试覆盖 summarize 内部的 chatWithFallback
    const wrapped = async (opts) => chatWithFallbackImpl(opts);
    return { chatWithFallback: wrapped, summarizeHistory: async (msgs) => {
      const prompt = [
        { role: "system", content: "你是对话压缩助手，把以下历史对话压缩成 800 字以内的中文摘要，保留关键操作与结果、用户的偏好与待办、模型设置与群组操作及时间线，不要遗漏重要细节。" },
        { role: "user", content: msgs.map((m) => `${m.role}: ${m.content || JSON.stringify(m.tool_calls || "")}`).join("\n").slice(0, 90000) },
      ];
      const r = await wrapped({ messages: prompt });
      if (!r.ok) return null;
      const txt = String(r.message?.content || "").trim();
      return txt ? `【历史摘要】${txt}` : null;
    } };
  }

  return { chatWithFallback, summarizeHistory };
}
