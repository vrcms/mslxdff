import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { performance } from "node:perf_hooks";
import { buildSystemPrompt, getModelsForPrompt } from "./prompt.js";
import { getToolDefs, execCommand, readFileTool, curlTool } from "./tools.js";
import { chatWithFallback, summarizeHistory } from "./upstream.js";
import { loadHistory, saveHistory, clearHistory, histPath, estimateChars, needsCompress } from "./store.js";
import { CHAT_KEEP_RECENT, CHAT_MAX_TOOL_LOOPS, CHAT_PREFERRED, CHAT_FALLBACK } from "./config.js";
import { formatBannerLines, formatStatsDetail, collectStats, probeGateway } from "./stats.js";
import { createSpinner } from "./spinner.js";
import { normalizeFullId } from "../providers/model-id.js";

const SLASH_HELP = `自然语言直接说，斜杠快捷：
  /help     本帮助
  /stats    详细统计（网关 -d 的请求/延迟/模型）
  /history  查看对话历史
  /clear    清空历史
  /exit     退出
示例：设置 hy3 为默认模型 / 查看组列表 / 看最近20条日志 / 读一下 src/logs.js`;

async function printBanner() {
  let probe = null;
  try {
    const s = collectStats();
    probe = await probeGateway(s.port, 800);
  } catch {}
  const { lines } = formatBannerLines(probe);
  for (const l of lines) console.log(l);
  if (probe && !probe.alive) {
    console.log(`\x1b[31m本地服务没有启动无法使用auto模式，请mslxdff -d 启动\x1b[0m`);
  }
  console.log(`\x1b[90m输入自然语言即可执行；/help 帮助，/stats 看网关统计，/exit 退出\x1b[0m`);
  console.log(`\x1b[90m历史：${histPath()} · 仅拦截 -uninstall · 数据来自网关 -d，非本会话计数\x1b[0m`);
}

function trace(line) {
  if (process.env.MSLXDFF_CHAT_TRACE === "0") return;
  console.log(`\x1b[90m· ${line}\x1b[0m`);
}



async function maybeCompress(messages) {
  if (!needsCompress(messages)) return [...messages];
  const sys = messages[0];
  const rest = messages.slice(1);
  if (rest.length <= CHAT_KEEP_RECENT + 2) return [...messages];
  const t0 = performance.now();
  const toSummarize = rest.slice(0, -CHAT_KEEP_RECENT);
  const keep = rest.slice(-CHAT_KEEP_RECENT);
  const chars = estimateChars(messages);
  trace(`[压缩] 触发 ${chars}字 > ${400000}阈值 · 待压 ${toSummarize.length}条 保留 ${keep.length}条`);
  const summary = await summarizeHistory(toSummarize);
  const dt = Math.round(performance.now() - t0);
  if (!summary) {
    trace(`[压缩] 失败/空 · ${dt}ms → 截断`);
    return [sys, ...keep];
  }
  const summaryMsg = { role: "system", content: summary };
  const next = [sys, summaryMsg, ...keep];
  trace(`[压缩] 完成 ${toSummarize.length}条→${summary.length}字 · ${dt}ms · 新总量约 ${estimateChars(next)}字`);
  return next;
}

async function runAgentTurn(userText, messages) {
  const tools = getToolDefs();
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
  // 同轮去重：同一工具+参数只真正执行一次，重复直接复用并提示 LLM
  const seenCalls = new Map(); // key -> { count, firstResult }
  let duplicateStrikes = 0;
  let forceNoTools = false;
  trace(`[turn] 开始 "${userText.slice(0, 60)}${userText.length > 60 ? "…" : ""}" · 历史 ${messages.length}条 约 ${estimateChars(messages)}字`);
  while (loops < CHAT_MAX_TOOL_LOOPS) {
    const tLoop = performance.now();
    const tComp = performance.now();
    const cur = await maybeCompress(messages);
    const compressMs = Math.round(performance.now() - tComp);
    if (compressMs > 50) trace(`[loop ${loops}] 压缩耗时 ${compressMs}ms`);
    messages.length = 0;
    for (const m of cur) messages.push(m);
    const tCall = performance.now();
    const spinnerLabel = loops === 0 ? "已发送给 AI，等待回复中" : forceNoTools ? "AI 整理回答中（已禁工具）" : "AI 正在整理回复中";
    const spinner = createSpinner(spinnerLabel);
    spinner.start();
    let res;
    try {
      const activeTools = forceNoTools ? [] : tools;
      res = await chatWithFallback({ messages, tools: activeTools });
      if (forceNoTools && res.ok && res.message?.tool_calls?.length) {
        // LLM 在禁工具模式下仍尝试调工具，视为违规，直接转文本
        trace(`[guard] 禁工具模式下仍收到 tool_calls，已拦截`);
        res.message.tool_calls = [];
        if (!res.message.content) res.message.content = "（已拦截违规工具调用，请基于已有结果直接回答）";
      }
    } finally {
      const ms = Math.round(performance.now() - tCall);
      spinner.stop(`\x1b[90m✓ AI 已回复 · ${ms}ms\x1b[0m`);
    }
    const llmMs = Math.round(performance.now() - tCall);
    trace(`[loop ${loops}] LLM ${llmMs}ms${compressMs > 50 ? ` (含压缩 ${compressMs}ms)` : ""} · ${estimateChars(messages)}字上下文`);
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
      if (lastFallbackGateway) note = "\n\x1b[90m[注：mimo/big-pickle 均不可用，已自动切本地网关 auto（:8989）]\x1b[0m";
      else if (lastFallback) note = "\n\x1b[90m[注：mimo 不可用，已用 big-pickle]\x1b[0m";
      trace(`[turn] 完成 总计 ${totalMs}ms · LLM ${lastLatency}ms · 0 工具${lastFallbackGateway ? " · gateway-fallback" : ""}`);
      return { text: text + note, model: lastModel, provider: lastProvider, latency: lastLatency, usage: lastUsage, fallback: lastFallback, fallbackGateway: lastFallbackGateway, ok: true, totalMs };
    }
    const calls = toolCalls.length ? toolCalls : [{ id: "fallback-1", function: { name: "run_command", arguments: JSON.stringify({ command: fallbackCmd }) } }];
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
    trace(`[tools] 本轮 ${calls.length} 个调用 ${calls.map((c) => c.function?.name).join(",")} · 并发执行`);
    const tTools = performance.now();
    const toolResults = await Promise.all(calls.map(async (c) => {
      const name = c.function?.name;
      let args = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch {}
      const t1 = performance.now();
      // 归一化 key：run_command 按命令去重（大小写+空白归一），curl 按 url+method+body，read_file 按 path
      let dedupKey = `${name}:${JSON.stringify(args)}`;
      if (name === "run_command") {
        const cmd = String(args.command || "").trim().toLowerCase().replace(/\s+/g, " ");
        // -provider list 与 -providers list 等价，归一
        const norm = cmd.replace(/^-+providers\b/, "-provider").replace(/\s+/g, " ").trim();
        dedupKey = `run_command:${norm}`;
      } else if (name === "curl") {
        const u = String(args.url || "").trim().toLowerCase();
        const m = String(args.method || "GET").toUpperCase();
        dedupKey = `curl:${m}:${u}:${String(args.body || "").slice(0, 200)}`;
      } else if (name === "read_file") {
        dedupKey = `read_file:${String(args.path || "").trim().toLowerCase()}`;
      }
      const seen = seenCalls.get(dedupKey);
      if (seen) {
        const dt = Math.round(performance.now() - t1);
        trace(`[tool] ${name} 重复调用已跳过 · ${dt}ms · 之前 ${seen.count} 次`);
        console.log(`\x1b[33m→ 跳过重复: ${name} ${JSON.stringify(args).slice(0, 120)}（本轮已执行过）\x1b[0m`);
        return {
          id: c.id,
          content: `SKIPPED_DUP: 此工具调用在本轮已执行过 ${seen.count} 次，结果相同请直接基于已有信息回答用户，不要再重复调用。\n--- 首次结果复用 ---\n${seen.firstResult.slice(0, 6000)}`,
        };
      }
      let result;
      if (name === "run_command") {
        const cmd = String(args.command || "").trim();
        console.log(`\x1b[90m→ 执行: mslxdff ${cmd}\x1b[0m`);
        const r = await execCommand(cmd);
        result = `${r.ok ? "OK" : "FAIL"}: ${r.output}`;
        // 查询类命令直接在结果里植入“立即回答”锚点，降低 LLM 再发一次的概率；若用户问模型，则 provider list 不算答案
        const lowCmd = cmd.toLowerCase().replace(/\s+/g, " ").trim();
        const asksModel = String(userText || "").toLowerCase().includes("模型");
        const isOnceAndDone =
          /^-+(showtoken|status|s|providers?\b|model\b|group\b|log\b|workbuddy\b|free\b|autostart\b|plugins\b)/.test(lowCmd) ||
          lowCmd === "-provider list" || lowCmd === "-providers list";
        if (isOnceAndDone && r.ok) {
          if (asksModel && lowCmd.includes("-provider")) {
            result += `\n\n[提示：此命令仅显示供应商配置，不包含模型列表。用户问的是“有哪些模型”，请用系统提示中的“可用模型”按前缀过滤回答，或调 curl local/models，不要再调 provider list]`;
          } else {
            result += `\n\n[系统提示：此查询已完成，结果即答案，请直接用中文回答用户，禁止再调用相同或同类查询工具]`;
          }
        }
        const dt = Math.round(performance.now() - t1);
        trace(`[tool] run_command "${cmd.slice(0, 40)}" · ${dt}ms · ${r.ok ? "OK" : "FAIL"} ${r.output.length}字`);
        console.log(r.ok ? `\x1b[32m${r.output.slice(0, 800)}\x1b[0m` : `\x1b[31m${r.output.slice(0, 800)}\x1b[0m`);
      } else if (name === "read_file") {
        const r = await readFileTool(args);
        result = `${r.ok ? "OK" : "FAIL"}: ${r.output.slice(0, 6000)}`;
        if (r.ok) result += `\n\n[系统提示：文件已读取，请直接基于内容回答，禁止重复读取同一文件]`;
        const dt = Math.round(performance.now() - t1);
        trace(`[tool] read_file ${args.path} · ${dt}ms · ${r.ok ? "OK" : "FAIL"} ${r.output.length}字`);
        console.log(`\x1b[90m→ 读取: ${args.path} ${r.ok ? "OK" : "FAIL"}\x1b[0m`);
      } else if (name === "curl") {
        const u = String(args.url || "").trim();
        console.log(`\x1b[90m→ 探活: ${u} ${args.method || "GET"}\x1b[0m`);
        const r = await curlTool(args);
        result = `${r.ok ? "OK" : "FAIL"}: ${r.output.slice(0, 6000)}`;
        const dt = Math.round(performance.now() - t1);
        trace(`[tool] curl ${u} · ${dt}ms`);
        console.log(r.ok ? `\x1b[32m${r.output.slice(0, 800)}\x1b[0m` : `\x1b[31m${r.output.slice(0, 800)}\x1b[0m`);
      } else {
        result = `unknown tool ${name}`;
      }
      // 记录首次结果供复用
      if (!seenCalls.has(dedupKey)) seenCalls.set(dedupKey, { count: 1, firstResult: result });
      else seenCalls.get(dedupKey).count++;
      // 若本轮首次执行后已累积 2 次以上相同调用，下次 LLM 再试会直接命中上面的 SKIPPED_DUP
      return { id: c.id, content: result };
    }));
    for (const tr of toolResults) messages.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
    // 若本轮有 SKIPPED_DUP，额外追加系统提示并禁用后续工具，强制直接回答
    if (toolResults.some((tr) => String(tr.content).startsWith("SKIPPED_DUP"))) {
      duplicateStrikes++;
      forceNoTools = true;
      messages.push({ role: "system", content: "系统提示：你已重复调用相同工具，工具侧已复用首次结果并跳过执行。你已被禁止再调用任何工具，必须立即基于以上工具结果用中文直接回答用户，0 工具调用。" });
      trace(`[dup] 检测到重复调用 ${duplicateStrikes} 次，已禁用后续工具调用`);
      if (duplicateStrikes >= 2) {
        const seen = [...seenCalls.values()].map((v) => v.firstResult).join("\n---\n").slice(0, 6000);
        const synth = `检测到重复调用已达 ${duplicateStrikes} 次，为避免空转，直接基于已有结果回答：\n\n${seen}`;
        messages.push({ role: "assistant", content: synth });
        const totalMs = Math.round(performance.now() - t0);
        trace(`[turn] 提前结束（重复阈值） 总计 ${totalMs}ms`);
        return { text: synth, model: lastModel || "local", provider: lastProvider, latency: lastLatency, usage: lastUsage, fallback: lastFallback, ok: true, totalMs };
      }
    }
    const toolsMs = Math.round(performance.now() - tTools);
    const loopMs = Math.round(performance.now() - tLoop);
    trace(`[loop ${loops}] 工具 ${toolsMs}ms · 本轮总 ${loopMs}ms · 累计 ${Math.round(performance.now() - turnStart)}ms`);
    loops++;
  }
  return { text: "（工具调用次数已达上限，已停止）", model: lastModel, latency: lastLatency, usage: lastUsage, fallback: lastFallback, fallbackGateway: lastFallbackGateway, ok: false };
}

function printFooter({ model, provider, latency, usage, totalMs, fallback, fallbackGateway, viaGateway }) {
  const dim = "\x1b[90m";
  const rst = "\x1b[0m";
  let gw = null;
  try { gw = collectStats(); } catch {}
  const prov = provider && provider !== "opencode" ? `${provider}/` : "";
  const baseLabel = model ? `${prov}${model}` : "—";
  const via = provider && !baseLabel.startsWith(`${provider}/`) ? `: ${provider}` : "";
  const modelLabel = model ? (fallbackGateway || viaGateway ? `${baseLabel} (gateway auto${via})` : baseLabel) : "—";
  const latLabel = latency ? `${latency}ms` : "—";
  const totalLabel = totalMs ? ` · 总耗时 ${totalMs}ms` : "";
  const tokLabel = usage ? ` · tokens ${usage.prompt_tokens ?? "?"}→${usage.completion_tokens ?? "?"}` : "";
  const fbLabel = fallbackGateway || viaGateway ? " · gateway-fallback" : fallback ? " · fallback" : "";
  let gwLabel = "";
  let extra = "";
  if (gw) {
    const full = (() => { try { return normalizeFullId(model); } catch { return model; } })();
    const stat = gw.modelStats?.[full] || gw.modelStats?.[model] || null;
    const cnt = stat?.count ?? gw.latencies?.[model]?.count;
    const avgTtfb = stat?.avgTtfbMs ?? stat?.emaTtfbMs;
    const avgTps = stat?.avgTps ?? stat?.emaTps;
    const per = cnt ? ` · 网关该模型 ${cnt}次` : "";
    const ttfbLabel = avgTtfb ? ` 平均首字 ${avgTtfb}ms` : (gw.latencies?.[model]?.emaMs ? ` EMA ${gw.latencies[model].emaMs}ms` : "");
    const tpsLabel = avgTps ? ` · ${avgTps} tok/s` : "";
    const verbose = stat?.avgCompTok ? ` · 啰嗦 ${stat.avgCompTok}tok/次` : "";
    gwLabel = ` · 网关 总${gw.total} 成功${gw.success} 失败${gw.fail}${per}${ttfbLabel}${tpsLabel}${verbose}`;
    // 本次首字/tps（若本次有 usage，估算本次 tps）
    if (usage?.completion_tokens && latency) {
      const tpsNow = Math.round(usage.completion_tokens / (latency / 1000));
      if (Number.isFinite(tpsNow) && tpsNow > 0) extra = ` · 本次首字 ~${latency}ms · ${tpsNow} tok/s`;
    }
  }
  console.log(`${dim}─ ${modelLabel}  ${latLabel}${totalLabel}${tokLabel}${fbLabel}${gwLabel}${extra}${rst}`);
}

export async function startRepl({ singleShot } = {}) {
  const models = getModelsForPrompt();
  const system = buildSystemPrompt({ modelsOverride: models });
  let messages = [{ role: "system", content: system }];
  const hist = loadHistory();
  if (hist.length) {
    for (const h of hist) messages.push(h);
    console.log(`\x1b[90m[恢复] 已载入 ${hist.length} 条历史\x1b[0m`);
  }
  if (singleShot) {
    const text = String(singleShot).trim();
    if (!text) return;
    const r = await runAgentTurn(text, messages);
    console.log(r.text);
    if (r.model) printFooter(r);
    saveHistory(messages.slice(1));
    return;
  }
  await printBanner();
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: `\x1b[36m${CHAT_PREFERRED.split("-")[0]}>\x1b[0m ` });
  rl.prompt();
  for await (const line of rl) {
    const raw = String(line || "").trim();
    if (!raw) { rl.prompt(); continue; }
    const low = raw.toLowerCase();
    if (["/exit", "/quit", "exit", "quit", "退出"].includes(low)) {
      console.log("再见");
      saveHistory(messages.slice(1));
      rl.close();
      return;
    }
    if (["/help", "help", "/h", "?"].includes(low)) {
      console.log(SLASH_HELP);
      rl.prompt();
      continue;
    }
    if (["/stats", "/status", "stats", "status"].includes(low)) {
      console.log(formatStatsDetail());
      rl.prompt();
      continue;
    }
    if (["/clear", "clear"].includes(low)) {
      clearHistory();
      messages = [{ role: "system", content: system }];
      console.log("\x1b[90m[已清空历史]\x1b[0m");
      rl.prompt();
      continue;
    }
    if (["/history"].includes(low)) {
      console.log(`\x1b[90m历史 ${messages.length - 1} 条，约 ${estimateChars(messages)} 字符 · ${histPath()}\x1b[0m`);
      for (const m of messages.slice(1).slice(-10)) console.log(`- ${m.role}: ${(m.content || "").slice(0, 120)}`);
      rl.prompt();
      continue;
    }
    try {
      const r = await runAgentTurn(raw, messages);
      if (r.text && !r.text.startsWith("OK") && !r.text.startsWith("FAIL")) console.log(r.text);
      if (r.model || r.latency) printFooter(r);
    } catch (e) {
      console.log(`\x1b[31m[错误] ${String(e.message || e).slice(0, 800)}\x1b[0m`);
      messages.push({ role: "assistant", content: `error: ${String(e.message || e)}` });
    }
    saveHistory(messages.slice(1));
    if (needsCompress(messages)) {
      messages = await maybeCompress(messages);
      saveHistory(messages.slice(1));
    }
    rl.prompt();
  }
}
