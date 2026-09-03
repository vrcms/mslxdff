import { performance } from "node:perf_hooks";
import { estimateChars, needsCompress } from "./store.js";
import { CHAT_KEEP_RECENT, CHAT_MAX_TOOL_LOOPS } from "./config.js";
import { buildDedupKey, runTool } from "./tool-handlers.js";

// 纯引擎：无 readline/ANSI/spinner，单一 runTurn 可测
export function createEngine({
  chatWithFallback,
  summarizeHistory,
  getToolDefs = () => [],
  execCommand,
  readFileTool,
  curlTool,
  onTrace = () => {},
  config = {},
} = {}) {
  const CWF = chatWithFallback || (async () => ({ ok: false, error: "no chat" }));
  const SUM = summarizeHistory || (async () => null);
  const GTOOLS = getToolDefs;
  const EXEC = execCommand || (async () => ({ ok: false, output: "no exec" }));
  const READ = readFileTool || (async () => ({ ok: false, output: "no read" }));
  const CURL = curlTool || (async () => ({ ok: false, output: "no curl" }));

  async function maybeCompress(messages) {
    if (!needsCompress(messages)) return [...messages];
    const sys = messages[0];
    const rest = messages.slice(1);
    if (rest.length <= CHAT_KEEP_RECENT + 2) return [...messages];
    const t0 = performance.now();
    const toSummarize = rest.slice(0, -CHAT_KEEP_RECENT);
    const keep = rest.slice(-CHAT_KEEP_RECENT);
    const chars = estimateChars(messages);
    onTrace(`[压缩] 触发 ${chars}字 > 400000阈值 · 待压 ${toSummarize.length}条 保留 ${keep.length}条`);
    const summary = await SUM(toSummarize);
    const dt = Math.round(performance.now() - t0);
    if (!summary) {
      onTrace(`[压缩] 失败/空 · ${dt}ms → 截断`);
      return [sys, ...keep];
    }
    const summaryMsg = { role: "system", content: summary };
    const next = [sys, summaryMsg, ...keep];
    onTrace(`[压缩] 完成 ${toSummarize.length}条→${summary.length}字 · ${dt}ms · 新总量约 ${estimateChars(next)}字`);
    return next;
  }

  async function runTurn(userText, messages) {
    const tools = GTOOLS();
    messages.push({ role: "user", content: userText });
    let loops = 0;
    let lastModel = null;
    let lastProvider = null;
    let lastUsage = null;
    let lastFallback = false;
    let lastFallbackGateway = false;
    let lastLatency = 0;
    const t0 = performance.now();
    const turnStart = performance.now();
    const seenCalls = new Map();
    let duplicateStrikes = 0;
    let forceNoTools = false;
    onTrace(`[turn] 开始 "${userText.slice(0, 60)}${userText.length > 60 ? "…" : ""}" · 历史 ${messages.length}条 约 ${estimateChars(messages)}字`);
    while (loops < CHAT_MAX_TOOL_LOOPS) {
      const tLoop = performance.now();
      const tComp = performance.now();
      const cur = await maybeCompress(messages);
      const compressMs = Math.round(performance.now() - tComp);
      if (compressMs > 50) onTrace(`[loop ${loops}] 压缩耗时 ${compressMs}ms`);
      messages.length = 0;
      for (const m of cur) messages.push(m);
      const tCall = performance.now();
      let res;
      const activeTools = forceNoTools ? [] : tools;
      res = await CWF({ messages, tools: activeTools });
      if (forceNoTools && res.ok && res.message?.tool_calls?.length) {
        onTrace(`[guard] 禁工具模式下仍收到 tool_calls，已拦截`);
        res.message.tool_calls = [];
        if (!res.message.content) res.message.content = "（已拦截违规工具调用，请基于已有结果直接回答）";
      }
      const llmMs = Math.round(performance.now() - tCall);
      onTrace(`[loop ${loops}] LLM ${llmMs}ms${compressMs > 50 ? ` (含压缩 ${compressMs}ms)` : ""} · ${estimateChars(messages)}字上下文`);
      lastLatency = llmMs;
      if (!res.ok) {
        const err = `大模型暂不可用：${res.error}`;
        messages.push({ role: "assistant", content: err });
        return { text: err, model: null, latency: lastLatency, usage: null, fallback: false, ok: false };
      }
      lastModel = res.model;
      lastProvider = res.provider || null;
      lastUsage = res.usage || null;
      lastFallback = !!res.fallback;
      lastFallbackGateway = !!res.fallbackGateway || !!res.viaGateway;
      const msg = res.message;
      const toolCalls = msg.tool_calls || [];
      let fallbackCmd = null;
      if (!toolCalls.length && msg.content) {
        const m = String(msg.content).match(/\{[^}]*"command"\s*:\s*"([^"]+)"[^}]*\}/);
        if (m) fallbackCmd = m[1];
      }
      if (!toolCalls.length && !fallbackCmd) {
        const text = String(msg.content || "").trim() || "(空回复)";
        messages.push({ role: "assistant", content: text });
        const totalMs = Math.round(performance.now() - t0);
        let note = "";
        if (lastFallbackGateway) note = "\n[注：mimo/big-pickle 均不可用，已自动切本地网关 auto（:8989）]";
        else if (lastFallback) note = "\n[注：mimo 不可用，已用 big-pickle]";
        onTrace(`[turn] 完成 总计 ${totalMs}ms · LLM ${lastLatency}ms · 0 工具${lastFallbackGateway ? " · gateway-fallback" : ""}`);
        return { text: text + note, model: lastModel, provider: lastProvider, latency: lastLatency, usage: lastUsage, fallback: lastFallback, fallbackGateway: lastFallbackGateway, ok: true, totalMs };
      }
      const calls = toolCalls.length ? toolCalls : [{ id: "fallback-1", function: { name: "run_command", arguments: JSON.stringify({ command: fallbackCmd }) } }];
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
      onTrace(`[tools] 本轮 ${calls.length} 个调用 ${calls.map((c) => c.function?.name).join(",")} · 顺序执行`);
      const tTools = performance.now();
      const toolResults = [];
      const toolDeps = { execCommand: EXEC, readFileTool: READ, curlTool: CURL, onTrace };
      for (const c of calls) {
        const name = c.function?.name;
        let args = {};
        try { args = JSON.parse(c.function?.arguments || "{}"); } catch {}
        const t1 = performance.now();
        const dedupKey = buildDedupKey(name, args);
        const seen = seenCalls.get(dedupKey);
        if (seen) {
          const dt = Math.round(performance.now() - t1);
          onTrace(`[tool] ${name} 重复调用已跳过 · ${dt}ms · 之前 ${seen.count} 次`);
          toolResults.push({
            id: c.id,
            content: `SKIPPED_DUP: 此工具调用在本轮已执行过 ${seen.count} 次，结果相同请直接基于已有信息回答用户，不要再重复调用。\n--- 首次结果复用 ---\n${seen.firstResult.slice(0, 6000)}`,
          });
          continue;
        }
        const result = await runTool({ name, args, userText, ...toolDeps });
        if (!seenCalls.has(dedupKey)) seenCalls.set(dedupKey, { count: 1, firstResult: result });
        else seenCalls.get(dedupKey).count++;
        toolResults.push({ id: c.id, content: result });
      }
      for (const tr of toolResults) messages.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
      if (toolResults.some((tr) => String(tr.content).startsWith("SKIPPED_DUP"))) {
        duplicateStrikes++;
        forceNoTools = true;
        messages.push({ role: "system", content: "系统提示：你已重复调用相同工具，工具侧已复用首次结果并跳过执行。你已被禁止再调用任何工具，必须立即基于以上工具结果用中文直接回答用户，0 工具调用。" });
        onTrace(`[dup] 检测到重复调用 ${duplicateStrikes} 次，已禁用后续工具调用`);
        if (duplicateStrikes >= 2) {
          const seen = [...seenCalls.values()].map((v) => v.firstResult).join("\n---\n").slice(0, 6000);
          const synth = `检测到重复调用已达 ${duplicateStrikes} 次，为避免空转，直接基于已有结果回答：\n\n${seen}`;
          messages.push({ role: "assistant", content: synth });
          const totalMs = Math.round(performance.now() - t0);
          onTrace(`[turn] 提前结束（重复阈值） 总计 ${totalMs}ms`);
          return { text: synth, model: lastModel || "local", provider: lastProvider, latency: lastLatency, usage: lastUsage, fallback: lastFallback, ok: true, totalMs };
        }
      }
      const toolsMs = Math.round(performance.now() - tTools);
      const loopMs = Math.round(performance.now() - tLoop);
      onTrace(`[loop ${loops}] 工具 ${toolsMs}ms · 本轮总 ${loopMs}ms · 累计 ${Math.round(performance.now() - turnStart)}ms`);
      loops++;
    }
    return { text: "（工具调用次数已达上限，已停止）", model: lastModel, latency: lastLatency, usage: lastUsage, fallback: lastFallback, fallbackGateway: lastFallbackGateway, ok: false };
  }

  return { runTurn, maybeCompress };
}
