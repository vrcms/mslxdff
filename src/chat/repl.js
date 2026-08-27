import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { performance } from "node:perf_hooks";
import { buildSystemPrompt, getModelsForPrompt } from "./prompt.js";
import { getToolDefs, execCommand, readFileTool, curlTool } from "./tools.js";
import { chatWithFallback, summarizeHistory } from "./upstream.js";
import { loadHistory, saveHistory, clearHistory, histPath, estimateChars, needsCompress } from "./store.js";
import { CHAT_KEEP_RECENT, CHAT_MAX_TOOL_LOOPS, CHAT_PREFERRED, CHAT_FALLBACK } from "./config.js";
import { formatBannerLines, formatStatsDetail } from "./stats.js";

const SLASH_HELP = `自然语言直接说，斜杠快捷：
  /help     本帮助
  /stats    详细统计（模型/延迟/网关请求）
  /history  查看对话历史
  /clear    清空历史
  /exit     退出
示例：设置 hy3 为默认模型 / 查看组列表 / 看最近20条日志 / 读一下 src/logs.js`;

let sessionReq = 0;
let sessionOk = 0;
let sessionFail = 0;
let sessionTokensIn = 0;
let sessionTokensOut = 0;

function printBanner() {
  const { lines } = formatBannerLines();
  for (const l of lines) console.log(l);
  console.log(`\x1b[90m输入自然语言即可执行；/help 帮助，/stats 统计，/exit 退出\x1b[0m`);
  console.log(`\x1b[90m历史：${histPath()} · 仅拦截 -uninstall · 本会话独立，daemon 重启不影响\x1b[0m`);
}

async function maybeCompress(messages) {
  if (!needsCompress(messages)) return [...messages];
  const sys = messages[0];
  const rest = messages.slice(1);
  if (rest.length <= CHAT_KEEP_RECENT + 2) return [...messages];
  const toSummarize = rest.slice(0, -CHAT_KEEP_RECENT);
  const keep = rest.slice(-CHAT_KEEP_RECENT);
  const summary = await summarizeHistory(toSummarize);
  if (!summary) return [sys, ...keep];
  const summaryMsg = { role: "system", content: summary };
  const next = [sys, summaryMsg, ...keep];
  console.log(`\x1b[90m[压缩] 历史过长，已将 ${toSummarize.length} 条压缩为摘要（${summary.length} 字）\x1b[0m`);
  return next;
}

async function runAgentTurn(userText, messages) {
  const tools = getToolDefs();
  messages.push({ role: "user", content: userText });
  let loops = 0;
  let lastModel = null;
  let lastUsage = null;
  let lastFallback = false;
  let lastLatency = 0;
  const t0 = performance.now();
  while (loops < CHAT_MAX_TOOL_LOOPS) {
    const cur = await maybeCompress(messages);
    messages.length = 0;
    for (const m of cur) messages.push(m);
    const tCall = performance.now();
    const res = await chatWithFallback({ messages, tools });
    lastLatency = Math.round(performance.now() - tCall);
    if (!res.ok) {
      sessionReq++;
      sessionFail++;
      const err = `大模型暂不可用：${res.error}`;
      messages.push({ role: "assistant", content: err });
      return { text: err, model: null, latency: lastLatency, usage: null, fallback: false, ok: false };
    }
    lastModel = res.model;
    lastUsage = res.usage || null;
    lastFallback = !!res.fallback;
    if (lastUsage) {
      sessionTokensIn += Number(lastUsage.prompt_tokens || 0);
      sessionTokensOut += Number(lastUsage.completion_tokens || 0);
    }
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
      sessionReq++;
      sessionOk++;
      const totalMs = Math.round(performance.now() - t0);
      const note = lastFallback ? "\n\x1b[90m[注：mimo 不可用，已用 big-pickle]\x1b[0m" : "";
      return { text: text + note, model: lastModel, latency: lastLatency, usage: lastUsage, fallback: lastFallback, ok: true, totalMs };
    }
    const calls = toolCalls.length ? toolCalls : [{ id: "fallback-1", function: { name: "run_command", arguments: JSON.stringify({ command: fallbackCmd }) } }];
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
    for (const c of calls) {
      const name = c.function?.name;
      let args = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch {}
      let result;
      if (name === "run_command") {
        const cmd = String(args.command || "").trim();
        console.log(`\x1b[90m→ 执行: mslxdff ${cmd}\x1b[0m`);
        const r = await execCommand(cmd);
        result = `${r.ok ? "OK" : "FAIL"}: ${r.output}`;
        console.log(r.ok ? `\x1b[32m${r.output.slice(0, 800)}\x1b[0m` : `\x1b[31m${r.output.slice(0, 800)}\x1b[0m`);
      } else if (name === "read_file") {
        const r = await readFileTool(args);
        result = `${r.ok ? "OK" : "FAIL"}: ${r.output.slice(0, 6000)}`;
        console.log(`\x1b[90m→ 读取: ${args.path} ${r.ok ? "OK" : "FAIL"}\x1b[0m`);
      } else if (name === "curl") {
        const u = String(args.url || "").trim();
        console.log(`\x1b[90m→ 探活: ${u} ${args.method || "GET"}\x1b[0m`);
        const r = await curlTool(args);
        result = `${r.ok ? "OK" : "FAIL"}: ${r.output.slice(0, 6000)}`;
        console.log(r.ok ? `\x1b[32m${r.output.slice(0, 800)}\x1b[0m` : `\x1b[31m${r.output.slice(0, 800)}\x1b[0m`);
      } else {
        result = `unknown tool ${name}`;
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: result });
    }
    loops++;
  }
  sessionReq++;
  sessionFail++;
  return { text: "（工具调用次数已达上限，已停止）", model: lastModel, latency: lastLatency, usage: lastUsage, fallback: lastFallback, ok: false };
}

function printFooter({ model, latency, usage, totalMs, fallback }) {
  const dim = "\x1b[90m";
  const rst = "\x1b[0m";
  const modelLabel = model || "—";
  const latLabel = latency ? `${latency}ms` : "—";
  const totalLabel = totalMs ? ` · 总耗时 ${totalMs}ms` : "";
  const tokLabel = usage ? ` · tokens ${usage.prompt_tokens ?? "?"}→${usage.completion_tokens ?? "?"}` : "";
  const sessLabel = ` · 本会话 ${sessionReq}次 成功${sessionOk} 失败${sessionFail}`;
  const fbLabel = fallback ? " · fallback" : "";
  console.log(`${dim}─ ${modelLabel}  ${latLabel}${totalLabel}${tokLabel}${sessLabel}${fbLabel}${rst}`);
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
  printBanner();
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
      console.log(`\x1b[90m本会话：${sessionReq}次 成功${sessionOk} 失败${sessionFail}  tokens ${sessionTokensIn}→${sessionTokensOut}\x1b[0m`);
      rl.prompt();
      continue;
    }
    if (["/clear", "clear"].includes(low)) {
      clearHistory();
      messages = [{ role: "system", content: system }];
      sessionReq = sessionOk = sessionFail = sessionTokensIn = sessionTokensOut = 0;
      console.log("\x1b[90m[已清空历史与本会话计数]\x1b[0m");
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
      sessionReq++; sessionFail++;
    }
    saveHistory(messages.slice(1));
    if (needsCompress(messages)) {
      messages = await maybeCompress(messages);
      saveHistory(messages.slice(1));
    }
    rl.prompt();
  }
}
