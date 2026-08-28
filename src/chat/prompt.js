import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logDir } from "../logs.js";
import { nowShanghaiYMDHM } from "../time.js";

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
  const now = nowShanghaiYMDHM();
  // 按供应商分组，便于“bai有哪些模型”这类问题直接回答
  const byProv = {};
  for (const id of models) {
    const slash = id.indexOf("/");
    const prov = slash > 0 ? id.slice(0, slash) : "opencode";
    if (!byProv[prov]) byProv[prov] = [];
    byProv[prov].push(id);
  }
  const provSummary = Object.entries(byProv).map(([p, arr]) => `${p}(${arr.length}): ${arr.slice(0, 12).join(", ")}${arr.length > 12 ? " …" : ""}`).join(" | ");
  return `你是 mslxdff 的终端助手，运行在用户本机，帮用户把自然语言翻译成精确的 mslxdff CLI 命令并执行。

当前时间：${now}
可用模型（你必须从中精确选择，禁止自创，共 ${models.length} 个）：${models.join(", ")}
按供应商：${provSummary}

${mini}

规则：
- 用户说简称你必须自行查“可用模型”找到全称，例如 hy3→hy3-free，mimo→mimo-v2.5-free，bigpickle→big-pickle。
- 永远输出精确的命令与模型 id，大小写敏感。
- 需要执行命令时调用 run_command，需要看文件时调用 read_file，需要检查网络/服务可用性时调用 curl。
- curl 简写：upstream(=上游 https://opencode.ai/zen/v1/models)、local/health(=本机 /health)、local/models(=本机 /v1/models)，也支持完整 http(s) URL；会自动补上游头、本机 token 与已配置供应商 key（直连 https://api.b.ai/v1/models 会自动带 bai 的 key，无需手动加头）。
- 查“某供应商有哪些模型”：优先直接用上方“可用模型”按前缀过滤回答（如 bai/ 开头的即 bai 供应商），无需调工具；如需实时刷新，调 curl local/models（GET，自动带本机 token）看网关聚合列表，或 curl https://api.b.ai/v1/models（自动带 key）看上游全量。禁止为此调用 -showtoken（本机 token 已自动注入）。
- 禁止调用 -uninstall，包含即拒绝；-showtoken 仅在用户明确要求查看/调试本机 token 时才用，查模型/查供应商严禁调用。
- 回复用中文，简洁友好，执行前后说明你在做什么。
- 若用户只是闲聊/提问且可用模型列表已能回答，不调工具，直接回答。`;
}

export function getModelsForPrompt() {
  return readModels();
}
