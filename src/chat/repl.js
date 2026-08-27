import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { buildSystemPrompt, getModelsForPrompt } from "./prompt.js";
import { getToolDefs, execCommand, readFileTool, curlTool } from "./tools.js";
import { chatWithFallback, summarizeHistory } from "./upstream.js";
import { loadHistory, saveHistory, clearHistory, histPath, estimateChars, needsCompress } from "./store.js";
import { CHAT_KEEP_RECENT, CHAT_MAX_TOOL_LOOPS } from "./config.js";

const SLASH_HELP = `可用说法示例：
  设置 hy3 为默认模型  /  切到 big-pickle  /  查看组列表  /  看最近20条日志
  读一下 src/logs.js  /  同步到 WorkBuddy  /  加个 openrouter key
斜杠命令：/help /clear /exit /history`;

function banner() {
  console.log(`mslxdff chat — mimo-v2.5-free 优先，big-pickle 兜底`);
  console.log(`输入自然语言即可执行命令；/help 查看帮助，/exit 退出`);
  console.log(`历史持久化：${histPath()}  ·  仅拦截 -uninstall，daemon 重启不影响本会话`);
  console.log(`─`.repeat(56));
}

async function maybeCompress(messages) {
  if (!needsCompress(messages)) return [...messages];
  // 保留 system + 最近 K 条，其余压缩
  const sys = messages[0];
  const rest = messages.slice(1);
  if (rest.length <= CHAT_KEEP_RECENT + 2) return [...messages];
  const toSummarize = rest.slice(0, -CHAT_KEEP_RECENT);
  const keep = rest.slice(-CHAT_KEEP_RECENT);
  const summary = await summarizeHistory(toSummarize);
  if (!summary) {
    // 降级：直接截断
    return [sys, ...keep];
  }
  const summaryMsg = { role: "system", content: summary };
  const next = [sys, summaryMsg, ...keep];
  console.log(`[压缩] 历史过长，已将 ${toSummarize.length} 条压缩为摘要（${summary.length} 字）`);
  return next;
}

async function runAgentTurn(userText, messages) {
  const tools = getToolDefs();
  messages.push({ role: "user", content: userText });
  let loops = 0;
  let lastModel = null;
  while (loops < CHAT_MAX_TOOL_LOOPS) {
    const cur = await maybeCompress(messages);
    // 用压缩后替换
    messages.length = 0;
    for (const m of cur) messages.push(m);
    const res = await chatWithFallback({ messages, tools });
    if (!res.ok) {
      const err = `大模型暂不可用：${res.error}`;
      messages.push({ role: "assistant", content: err });
      return err;
    }
    lastModel = res.model;
    const msg = res.message;
    // 兼容无 tool_calls 时的 JSON 兜底：若 content 含 {"command":...} 也视为工具
    const toolCalls = msg.tool_calls || [];
    // 尝试从 content 解析潜在命令（模型未走 tool 时的 fallback）
    let fallbackCmd = null;
    if (!toolCalls.length && msg.content) {
      const m = String(msg.content).match(/\{[^}]*"command"\s*:\s*"([^"]+)"[^}]*\}/);
      if (m) fallbackCmd = m[1];
    }
    if (!toolCalls.length && !fallbackCmd) {
      const text = String(msg.content || "").trim() || "(空回复)";
      messages.push({ role: "assistant", content: text });
      if (res.fallback) return `${text}\n[注：mimo 不可用，已用 big-pickle]`;
      return text;
    }
    // 执行工具
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
    // 继续循环，让模型根据工具结果再回复；若模型下次无工具则会在下轮返回文本
  }
  return "（工具调用次数已达上限，已停止）";
}

export async function startRepl({ singleShot } = {}) {
  const models = getModelsForPrompt();
  const system = buildSystemPrompt({ modelsOverride: models });
  let messages = [{ role: "system", content: system }];
  // 恢复历史（排除 system，追加到 messages）
  const hist = loadHistory();
  if (hist.length) {
    for (const h of hist) messages.push(h);
    console.log(`[恢复] 已载入 ${hist.length} 条历史`);
  }
  if (singleShot) {
    const text = String(singleShot).trim();
    if (!text) return;
    const out = await runAgentTurn(text, messages);
    console.log(out);
    saveHistory(messages.slice(1));
    return;
  }
  banner();
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "mimo> " });
  rl.prompt();
  for await (const line of rl) {
    const raw = String(line || "").trim();
    if (!raw) { rl.prompt(); continue; }
    if (["/exit", "/quit", "exit", "quit", "退出"].includes(raw.toLowerCase())) {
      console.log("再见");
      saveHistory(messages.slice(1));
      rl.close();
      return;
    }
    if (["/help", "help", "/h", "?"].includes(raw.toLowerCase())) {
      console.log(SLASH_HELP);
      rl.prompt();
      continue;
    }
    if (["/clear", "clear"].includes(raw.toLowerCase())) {
      clearHistory();
      messages = [{ role: "system", content: system }];
      console.log("[已清空历史]");
      rl.prompt();
      continue;
    }
    if (["/history"].includes(raw.toLowerCase())) {
      console.log(`历史 ${messages.length - 1} 条，约 ${estimateChars(messages)} 字符`);
      for (const m of messages.slice(1).slice(-10)) console.log(`- ${m.role}: ${(m.content || "").slice(0, 120)}`);
      rl.prompt();
      continue;
    }
    try {
      const out = await runAgentTurn(raw, messages);
      if (out && !out.startsWith("OK") && !out.startsWith("FAIL")) console.log(out);
    } catch (e) {
      console.log(`[错误] ${String(e.message || e).slice(0, 800)}`);
      messages.push({ role: "assistant", content: `error: ${String(e.message || e)}` });
    }
    saveHistory(messages.slice(1));
    // 压缩检查在 runAgentTurn 内已做，这里额外兜底
    if (needsCompress(messages)) {
      messages = await maybeCompress(messages);
      saveHistory(messages.slice(1));
    }
    rl.prompt();
  }
}
