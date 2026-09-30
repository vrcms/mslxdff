// 指令文档分层体积检查：AGENTS.md 是每会话注入的常驻层，长文必须下沉到按需层。
// 口径来源：GitHub repository-wide vs path-specific instructions、Anthropic
// 「CLAUDE.md 每轮加载 → 只放普遍适用内容，偶发知识走 skills」、Sentry agents-md（索引化、行数上限）。
// 运行：node scripts/check-agent-docs.js （失败 exit 1）；也被 npm run docs:check 调起。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ? import.meta.dirname : ".", "..");

// 常驻层：每轮都进上下文 → 严格
const ROOT_LIMITS = { bytes: 12 * 1024, lines: 120, bullet: 900 };
// 就近层：按路径命中才读 → 可放宽，但仍不许长段落化
const NESTED_LIMITS = { bytes: 12 * 1024, lines: 70, bullet: 1400 };

let fails = 0;
const err = (m) => { console.error(`✗ ${m}`); fails++; };

function checkFile(label, abs, { bytes, lines, bullet }) {
  if (!existsSync(abs)) return null;
  const text = readFileSync(abs, "utf8");
  const size = Buffer.byteLength(text);
  const list = text.split(/\r?\n/);
  if (size > bytes) err(`${label} ${size}B > ${bytes}B — 长内容必须下沉到 nested AGENTS.md / docs/（见 AGENTS.md「常驻文件纪律」）`);
  if (list.length > lines) err(`${label} ${list.length} 行 > ${lines} 行 — 常驻层只放「每轮必用规则 + 任务路由」`);
  list.forEach((l, i) => {
    if (!/^\s*[-*] /.test(l) && !/^\s*\|/.test(l)) return;
    if (l.length > bullet) err(`${label}:${i + 1} 单行 ${l.length} 字符 > ${bullet} — 拆条目或下沉到按需层（超长行在上下文中段最易被忽略）`);
  });
  return { size, lines: list.length };
}

const root = checkFile("AGENTS.md", join(ROOT, "AGENTS.md"), ROOT_LIMITS) || { size: 0, lines: 0 };

// 就近层：仓库内所有非根 AGENTS.md（跳过 vendored 目录与 openspec 变更区）
const SKIP = new Set(["node_modules", "9router", "hermes-agent", ".git", ".backup", ".scratch", "openspec", "backup"]);
const nested = [];
(function walk(dir) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === "AGENTS.md" && p !== join(ROOT, "AGENTS.md")) { nested.push(p); continue; }
    if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) walk(p);
  }
})(ROOT);

let nestedCount = 0;
for (const f of nested) {
  if (checkFile(f.slice(ROOT.length + 1), f, NESTED_LIMITS)) nestedCount++;
}

// 指针完整性：常驻层引用的具体文档必须存在（防「指针腐烂」）。
// 只认真实路径：含 `*` 的是通配写法（如 `src/**/AGENTS.md`），不当文件指针。
const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
const referenced = new Set(
  [...agents.matchAll(/`((?:src|test|docs|scripts|\.agents)\/[^`\s]+\.md)`/g)]
    .map((m) => m[1])
    .filter((p) => !p.includes("*"))
);
const missing = [...referenced].filter((p) => {
  try { return !statSync(join(ROOT, p)).isFile(); } catch { return true; }
});
if (missing.length) err(`AGENTS.md 引用了不存在的指令文档: ${missing.join(", ")}`);

if (!agents.includes("任务路由")) err("AGENTS.md 缺「任务路由」章节 — 常驻层必须是规则+索引，不是知识堆");

if (fails) {
  console.error(`\n${fails} 项指令文档检查失败 — 分层规范见 docs/adr/0040-agent-instruction-layering.md`);
  process.exit(1);
}
console.log(`✓ 指令文档分层检查通过（AGENTS.md ${(root.size / 1024).toFixed(1)}KB/${root.lines} 行 · nested ${nestedCount} 份 · 指针 ${referenced.size} 个全部可解析）`);
