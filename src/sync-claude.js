import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

/**
 * -setto claude：把本机网关写进 Claude Code 的用户设置文件。
 * 键面依据 code.claude.com/docs/en/settings-reference（model / modelPicker / env 三节）：
 *  - `ANTHROPIC_BASE_URL` **不带 /v1** —— 客户端自己拼 `/v1/messages`（参考仓库 README 写 /v1 是它的错）
 *  - `env.ANTHROPIC_MODEL` 必须删 —— 它压过顶层 `model` 键，留着会让设置失效
 *  - `CLAUDE_CODE_ATTRIBUTION_HEADER=0` —— 我们把 system 折叠成单条，归因块必须在客户端就不发
 *  - `modelPicker.options[].behavesAs` 实测必需 —— 见下方 DEFAULT_BEHAVES_AS 注释
 * 只动上述键，其余键与键序原样保留；解析失败一律拒写（那是用户手写的 hooks/permissions）。
 */

const OUR_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL", // 只删不写
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
];

// 本机 Claude Code 对「不认识且无 behavesAs 映射」的 model id 直接拒跑，连请求都不发
// （实测 2026-10-09：`"big-pickle" isn't described by this version's model catalog; …map it with
// behavesAs on a modelPicker row`，加 behavesAs 后 `claude -p` 正常走通工具往返）。
// behavesAs 只改客户端的**本地能力推断**（effort / auto-compact 口径），不改变发给上游的模型；
// 上游不认的字段由 messagesToChatBody 统一丢，所以锚一个通用已知 id 即可。`--behaves-as ""` 可关。
const DEFAULT_BEHAVES_AS = "claude-sonnet-5";

/** Claude Code 用户设置文件路径（`CLAUDE_CONFIG_DIR` 优先，与 Claude Code 自身口径一致）。 */
export function claudeSettingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (typeof dir === "string" && dir.trim()) return join(dir.trim(), "settings.json");
  return join(os.homedir(), ".claude", "settings.json");
}

/** 纯函数：existing 对象 + 上下文 → 新对象。除我们的键外一律原样保留（含键序，JSON 键序随插入顺序）。 */
export function buildClaudeSettings(existing, ctx = {}) {
  const out = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  const env = { ...(out.env && typeof out.env === "object" && !Array.isArray(out.env) ? out.env : {}) };
  env.ANTHROPIC_BASE_URL = String(ctx.baseUrl || "");
  env.ANTHROPIC_AUTH_TOKEN = String(ctx.token || "");
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  delete env.ANTHROPIC_MODEL;
  out.env = env;
  out.model = String(ctx.model || "");
  const picks = Array.isArray(ctx.picks) && ctx.picks.length ? ctx.picks : [ctx.model];
  const behavesAs = ctx.behavesAs == null ? DEFAULT_BEHAVES_AS : String(ctx.behavesAs);
  out.modelPicker = {
    options: picks.filter(Boolean).map((m) => {
      const row = { model: String(m), label: String(m) };
      if (behavesAs) row.behavesAs = behavesAs;
      return row;
    }),
  };
  return out;
}

// 归一化用于幂等比较（忽略换行符与首尾空白差异）
function norm(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

/**
 * 写盘。返回 { action, file, id, backup, changed, rows }。
 * @param {{id?:string, token?:string, port?:number, picks?:string[], file?:string, baseUrl?:string, behavesAs?:string}} p
 */
export function syncToClaude(p = {}) {
  const targetFile = p.file || claudeSettingsPath();
  const model = String(p.id ?? p.model ?? "").trim();
  if (!model) throw new Error("claude settings: model id required");
  const token = String(p.token || "");
  if (!token) throw new Error("claude settings: token required（先跑 mslxdff -showtoken）");
  const baseUrl = p.baseUrl || `http://127.0.0.1:${Number(p.port) || 8989}`;
  const picks = Array.isArray(p.picks) && p.picks.length ? p.picks : [model];

  let existed = false;
  let originalText = "";
  try {
    originalText = readFileSync(targetFile, "utf8");
    existed = true;
  } catch {
    existed = false;
  }
  let originalObj = null;
  if (existed) {
    try {
      originalObj = JSON.parse(originalText);
    } catch {
      throw new Error(`claude settings 解析失败，拒绝覆盖：${targetFile}`);
    }
  }

  const next = buildClaudeSettings(originalObj, { baseUrl, token, model, picks, behavesAs: p.behavesAs });
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (existed && norm(originalText) === norm(nextText)) {
    return { action: "updated", file: targetFile, id: model, backup: null, changed: false, rows: next.modelPicker.options.length };
  }

  // 备份只保留「mslxdff 首次接管前」那一份：已存在就不覆盖（代价：用户后来手改的内容不进备份）
  let backup = null;
  if (existed) {
    const backupFile = join(dirname(targetFile), "settings.pre-mslxdff.json");
    if (!existsSync(backupFile)) {
      try { copyFileSync(targetFile, backupFile); backup = backupFile; } catch { /* 复制失败不阻塞写入，但绝不谎报「已备份」 */ }
    }
    // 只在**本次真复制过**时返回路径（spec R6「打印备份路径（若本次生成）」）；已有旧备份时返回 null，
    // 由 CLI 换成「已存在更早的备份」提示 —— 免得用户拿首份旧备份去覆盖自己后来的手改。
  }

  mkdirSync(dirname(targetFile), { recursive: true });
  const tmp = `${targetFile}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  // 凭据落地红线：文件里有明文 token → 0600（mode 只在新建时生效，故存量补 chmod）
  let written = false;
  let tmpLeftover = null;
  // 半截 tmp 里带明文 token：unlink 也可能被占用（Windows 上正是 rename 失败的同因），
  // 所以先擦内容再试一次；仍清不掉就把路径如实交出去，让 CLI 告警，绝不静默。
  const sweepTmp = () => {
    if (!existsSync(tmp)) return;
    try { unlinkSync(tmp); return; } catch { /* 占用，走擦除 */ }
    try { writeFileSync(tmp, "", { encoding: "utf8" }); } catch { /* 擦不动也继续试删 */ }
    try { unlinkSync(tmp); } catch { tmpLeftover = tmp; }
  };
  try {
    try { writeFileSync(tmp, nextText, { encoding: "utf8", mode: 0o600 }); } catch { writeFileSync(tmp, nextText, "utf8"); }
    try { chmodSync(tmp, 0o600); } catch { /* Windows 无 posix mode，忽略 */ }
    try {
      renameSync(tmp, targetFile);
      written = true;
    } catch {
      // rename 失败多见于目标被别的进程占用（Windows 常态）：退回直写；仍失败就报错，绝不谎报「已同步」
      try { writeFileSync(targetFile, nextText, { encoding: "utf8", mode: 0o600 }); written = true; } catch { /* 交给下面的 throw */ }
    }
  } finally {
    sweepTmp();
  }
  if (!written) {
    throw new Error(`无法写入 ${targetFile}（文件可能被其他进程占用）——配置未更新；原文见同目录 settings.pre-mslxdff.json${tmpLeftover ? `；另有清理失败的临时文件 ${tmpLeftover}（内含明文 token，请手动删除）` : ""}`);
  }
  try { chmodSync(targetFile, 0o600); } catch { /* ignore */ }
  return { action: existed ? "updated" : "inserted", file: targetFile, id: model, backup, changed: true, rows: next.modelPicker.options.length, tmpLeftover };
}

export { OUR_ENV_KEYS, DEFAULT_BEHAVES_AS };
