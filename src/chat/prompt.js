import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logDir } from "../logs.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readMini() {
  try {
    const p = join(pkgRoot, "docs/cli_help_mini.md");
    return readFileSync(p, "utf8");
  } catch { return ""; }
}

function readModels() {
  try {
    const cache = join(logDir(), "models.json");
    if (existsSync(cache)) {
      const j = JSON.parse(readFileSync(cache, "utf8"));
      const ids = (j.data || []).map((m) => m.id).filter(Boolean);
      if (ids.length) return ids;
    }
  } catch {}
  // 兜底：硬编码常见 free 模型，供离线时参考
  return ["mimo-v2.5-free", "big-pickle", "deepseek-v4-flash-free", "hy3-free", "laguna-free", "kimi-k2-free", "nemotron-3-nano-free", "big-pickle"];
}

export function buildSystemPrompt({ modelsOverride } = {}) {
  const mini = readMini();
  const models = modelsOverride || readModels();
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `你是 mslxdff 的终端助手，运行在用户本机，帮用户把自然语言翻译成精确的 mslxdff CLI 命令并执行。

当前时间：${now}
可用模型（你必须从中精确选择，禁止自创）：${models.join(", ")}

${mini}

规则：
- 用户说简称你必须自行查“可用模型”找到全称，例如 hy3→hy3-free，mimo→mimo-v2.5-free，bigpickle→big-pickle。
- 永远输出精确的命令与模型 id，大小写敏感。
- 需要执行命令时调用 run_command，需要看文件时调用 read_file。
- 禁止调用 -uninstall，包含即拒绝。
- 回复用中文，简洁友好，执行前后说明你在做什么。
- 若用户只是闲聊/提问，不调工具，直接回答。`;
}

export function getModelsForPrompt() {
  return readModels();
}
