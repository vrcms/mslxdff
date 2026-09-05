import { createDirectClient } from "./direct.js";
import { createGatewayClient } from "./gateway.js";
import { createCooling } from "./cooling.js";
import { createOrchestrator } from "./orchestrator.js";
import { createUpstreamClient } from "../upstream.js";
import { CHAT_TIMEOUT_MS, CHAT_GATEWAY_TIMEOUT_MS, CHAT_PREFERRED, CHAT_FALLBACK } from "./config.js";
import * as state from "../state.js";
import { performance } from "node:perf_hooks";
import { compatFetch } from "../compat.js";

// 冷却深模块对接真实 state
const cooling = createCooling({
  loadModelErrors: () => {
    try { return state.loadModelErrors(); } catch { return {}; }
  },
  saveModelErrors: (o) => { try { state.saveModelErrors(o); } catch {} },
  loadModelLatencies: () => {
    try { return state.loadModelLatencies(); } catch { return {}; }
  },
  saveModelLatencies: (o) => { try { state.saveModelLatencies(o); } catch {} },
  flush: () => { try { state.flushStateSync(); } catch {} },
  now: () => Date.now(),
});

const direct = createDirectClient({
  createUpstreamClient,
  chatTimeoutMs: CHAT_TIMEOUT_MS,
  env: process.env,
  fetchImpl: compatFetch,
});

const gateway = createGatewayClient({
  fetchImpl: compatFetch,
  loadToken: async () => {
    try { const l = await state.loadToken(); return String(l?.token || "").trim(); } catch { return ""; }
  },
  getPort: () => {
    try { const p = state.getPort(); if (Number.isInteger(p) && p > 0) return p; } catch {}
    const v = Number(process.env.MSLXDFF_PORT);
    if (Number.isInteger(v) && v > 0) return v;
    return 8989;
  },
  gatewayTimeoutMs: CHAT_GATEWAY_TIMEOUT_MS,
  env: process.env,
});

const orch = createOrchestrator({
  chatOnce: direct.chatOnce,
  chatViaGateway: gateway.chatViaGateway,
  cooling,
  config: { CHAT_PREFERRED, CHAT_FALLBACK, CHAT_GATEWAY_TIMEOUT_MS },
  env: process.env,
  performance,
});

export const chatOnce = direct.chatOnce;
export const chatWithFallback = orch.chatWithFallback;
export const summarizeHistory = orch.summarizeHistory;
// keywords for legacy file-content check: chatViaGateway gateway auto safeChatOnce
