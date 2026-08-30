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
- 查“某供应商有哪些模型”**优先用 CLI 直查**：若上方“可用模型”已能回答，直接前缀过滤回答（如 workbuddy/ 即 workbuddy）；需实时拉取时调用 run_command: "-provider <id> models"（如 -provider workbuddy models）或 "-model list --provider <id>"，按 allowlist 过滤，--json 供脚本。**禁止**调 -provider <id> list（这是查配置，不是查模型！）。**错误示例**：workbuddy有哪些模型 → 调 -provider workbuddy list → 错。**正确**：-provider workbuddy models。禁止为此调用 -showtoken。
- 严禁幻觉命令：mslxdff "hi" --model X / mslxdff --model X "hi" / mslxdff -chat --model X 都不存在，输出只会是 status 页。探活任意模型（含 clinebot/*、workbuddy/*、bai/*）必须用 curl POST http://localhost:8989/v1/chat/completions，body 为 {"model":"<前缀/模型>","messages":[{"role":"user","content":"hi"}],"stream":false}，成功 200 + x-mslxdff-via:local 即通；401 代表本机 token 陈旧需提示 mslxdff -stop && mslxdff；403 + x-mslxdff-allowlist:1 代表白名单未放行需 allowlist add。
- **禁止重复调用（最高优先级）**：同一 run_command/curl/read_file 在本轮只执行一次，重复会被工具侧 SKIPPED_DUP 拦截；查询类（-showtoken/-status/-provider list/-providers list/-model list/-group list/-log 等）**调用一次即答案**，拿到 OK 结果后必须**立即用中文直接回答用户**，禁止再发起任何工具调用。收到 SKIPPED_DUP 或“请直接回答/禁止再调用”提示时，必须 0 工具直接回答。
- 禁止调用 -uninstall，包含即拒绝；-showtoken 仅在用户明确要求查看/调试本机 token 时才用，查模型/查供应商严禁调用。
- 回复用中文，简洁友好，执行前后说明你在做什么。
- 若用户只是闲聊/提问且可用模型列表已能回答，不调工具，直接回答。`;
}

export function getModelsForPrompt() {
  return readModels();
}
