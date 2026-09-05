import { buildSystemPrompt, getModelsForPrompt } from "./prompt.js";
import { getToolDefs, execCommand, readFileTool, curlTool } from "./tools.js";
import { chatWithFallback, summarizeHistory } from "./upstream.js";
import { loadHistory, saveHistory, histPath } from "./store.js";
import { CHAT_PREFERRED } from "./config.js";
import { createEngine } from "./engine.js";
import { printBanner, printFooter, handleSlash, createReadline, createSpinner, estimateChars } from "./terminal.js";
import { assertChatNode } from "../readline-compat.js";

function trace(line) {
  if (process.env.MSLXDFF_CHAT_TRACE === "0") return;
  console.log(`\x1b[90m· ${line}\x1b[0m`);
}

export async function startRepl({ singleShot } = {}) {
  if (!assertChatNode()) process.exit(1);
  const models = getModelsForPrompt();
  const system = buildSystemPrompt({ modelsOverride: models });
  let messages = [{ role: "system", content: system }];
  const hist = loadHistory();
  if (hist.length) {
    for (const h of hist) messages.push(h);
    console.log(`\x1b[90m[恢复] 已载入 ${hist.length} 条历史\x1b[0m`);
  }
  const engine = createEngine({
    chatWithFallback,
    summarizeHistory,
    getToolDefs,
    execCommand,
    readFileTool,
    curlTool,
    onTrace: trace,
  });

  if (singleShot) {
    const text = String(singleShot).trim();
    if (!text) return;
    const spinner = createSpinner("已发送给 AI，等待回复中");
    spinner.start();
    let r;
    try { r = await engine.runTurn(text, messages); } finally { spinner.stop(`\x1b[90m✓ AI 已回复\x1b[0m`); }
    console.log(r.text);
    if (r.model) printFooter(r);
    saveHistory(messages.slice(1));
    return;
  }

  await printBanner();
  const rl = createReadline(`\x1b[36m${CHAT_PREFERRED.split("-")[0]}>\x1b[0m `);
  rl.prompt();
  for await (const line of rl) {
    const raw = String(line || "").trim();
    if (!raw) { rl.prompt(); continue; }
    const slash = handleSlash(raw, { messages, system });
    if (slash.handled) {
      if (slash.exit) { console.log("再见"); saveHistory(messages.slice(1)); rl.close(); return; }
      if (slash.messages) messages = slash.messages;
      rl.prompt();
      continue;
    }
    try {
      const spinner = createSpinner("已发送给 AI，等待回复中");
      spinner.start();
      let r;
      try { r = await engine.runTurn(raw, messages); }
      finally { spinner.stop(`\x1b[90m✓ AI 已回复\x1b[0m`); }
      if (r.text && !r.text.startsWith("OK") && !r.text.startsWith("FAIL")) console.log(r.text);
      if (r.model || r.latency) printFooter(r);
    } catch (e) {
      console.log(`\x1b[31m[错误] ${String(e.message || e).slice(0, 800)}\x1b[0m`);
      messages.push({ role: "assistant", content: `error: ${String(e.message || e)}` });
    }
    saveHistory(messages.slice(1));
    if (messages.length > 2) {
      const maybe = await engine.maybeCompress(messages);
      if (maybe.length !== messages.length) { messages = maybe; saveHistory(messages.slice(1)); }
    }
    rl.prompt();
  }
}
