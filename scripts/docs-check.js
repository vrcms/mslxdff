// 文档就绪检查：验证 ARCHITECTURE.md 声明与仓库实际一致。
// 用途：防止"改了代码/加了功能，却忘了同步架构文档"。
// 运行：npm run docs:check  （失败退出码 1）
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const archFile = join(root, "docs", "ARCHITECTURE.md");
const adrDir = join(root, "docs", "adr");
const agFile = join(root, "AGENTS.md");

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`✗ ${msg}`);
};
const ok = (msg) => console.log(`✓ ${msg}`);

// 0. 基础文件存在
if (!existsSync(archFile)) fail("docs/ARCHITECTURE.md 不存在");
if (!existsSync(agFile)) fail("AGENTS.md 不存在");

// 1. ARCHITECTURE.md 引用的每个模块文件必须存在
if (existsSync(archFile)) {
  const arch = readFileSync(archFile, "utf8");
  const refs = [...arch.matchAll(/\b(?:src|bin|scripts|docs)\/[a-zA-Z0-9_./{}-]+\.m?js/g)].map((m) => m[0]);
  const unique = [...new Set(refs)];
  let pending = unique.length;
  for (const ref of unique) {
    const clean = ref.includes("{") ? ref.split("{")[0].replace(/\/+$/, "") : ref;
    const abs = join(root, clean);
    if (existsSync(abs) || /{.*}/.test(ref)) pending--;
    else fail(`ARCHITECTURE.md 引用了不存在的模块: ${ref}`);
  }
  if (pending === 0) ok(`模块引用检查通过 (${unique.length} 个文件引用)`);
}

// 2. ADR 索引必须与 docs/adr/ 目录一致（索引不能漏登，目录不能有未登记文件）
if (existsSync(adrDir) && existsSync(archFile)) {
  const arch = readFileSync(archFile, "utf8");
  const indexed = [...arch.matchAll(/ADR[ -]?(\d{4})|^\|\s*(\d{4})\s*\|/gm)].map((m) => (m[1] ?? m[2]));
  const files = readdirSync(adrDir).filter((f) => f.endsWith(".md"));
  const fileNums = files.map((f) => f.match(/^(\d{4})-/)?.[1]).filter(Boolean);
  const missingInDir = indexed.filter((n) => !fileNums.includes(n));
  const unindexed = fileNums.filter((n) => !indexed.includes(n));
  if (missingInDir.length) fail(`ARCHITECTURE.md 索引了但 docs/adr/ 无对应文件: ${missingInDir.join(", ")}`);
  if (unindexed.length) fail(`docs/adr/ 有未在 ARCHITECTURE.md 索引登记的条目: ${unindexed.join(", ")}`);
  if (!missingInDir.length && !unindexed.length) ok(`ADR 目录与索引双向一致 (${fileNums.length} 条)`);
}

// 3. 变更契约在 AGENTS.md 中有钩子（防止 AI 下次改代码不知道要更文档）
if (existsSync(agFile)) {
  const ag = readFileSync(agFile, "utf8");
  if (ag.includes("ARCHITECTURE.md") && ag.includes("docs:check")) ok("AGENTS.md 已声明文档变更契约与检查命令");
  else fail("AGENTS.md 未声明 ARCHITECTURE.md 变更契约或 npm run docs:check");
}

console.log(failures ? `\n${failures} 项检查失败 — 请同步文档（见 docs/ARCHITECTURE.md §1 变更契约）` : "\n文档就绪检查全部通过");
process.exit(failures ? 1 : 0);