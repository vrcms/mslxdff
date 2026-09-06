// 功能树一致性检查：锁定 docs/FEATURE_TREE.md 与 src/ 真实结构的双向一致。
// 用途：防止"改了代码/加了功能/新增了能力目录，却忘了同步功能树"。
// 运行：node scripts/check-feature-tree.js （失败退出码 1）; 也被 docs:check 调起。
// 语义：树是"能力入口级"导航 —— 只列能向用户述说的能力代表文件，支撑文件靠"目录锚定"自动归属。
//   因此反向校验是【目录级】：某目录若既无文件被树引用、其所有祖先目录也无 → 视为"新增能力域未登记"。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep, relative } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const treeFile = join(root, "docs", "FEATURE_TREE.md");
const srcDir = join(root, "src");

let failures = 0;
const fail = (msg) => { failures++; console.error(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);
const warn = (msg) => console.warn(`⚠ ${msg}`);

if (!existsSync(treeFile)) { fail("docs/FEATURE_TREE.md 不存在"); process.exit(1); }
if (!existsSync(srcDir)) { fail("src/ 不存在"); process.exit(1); }

// --- 收集真实 src js 文件（相对 src，正斜杠）---
const walkJs = (d, acc = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walkJs(p, acc);
    else if (e.name.endsWith(".js")) acc.push(p);
  }
  return acc;
};
const realFiles = walkJs(srcDir).map((p) => relative(srcDir, p).split(sep).join("/"));
const realDirs = new Set();
for (const f of realFiles) {
  const parts = f.split("/");
  for (let i = 1; i < parts.length; i++) realDirs.add(parts.slice(0, i).join("/"));
}

// --- 收集树显式引用的文件（展开 {a,b} 缩写，剥 src/ 前缀）---
const treeTxt = readFileSync(treeFile, "utf8");
const cited = new Set();
for (const m of treeTxt.matchAll(/src\/[A-Za-z0-9_./{}, -]+\.m?js/g)) {
  let s = m[0];
  const brace = s.match(/\{([^}]*)\}/);
  if (brace) {
    const pre = s.slice(0, brace.index);
    const post = s.slice(brace.index + brace[0].length);
    for (const a of brace[1].split(",")) cited.add((pre + a + post).replace(/^src\//, ""));
  } else cited.add(s.replace(/^src\//, ""));
}
// 去掉 .mjs/.js 外的杂项；只留可当作 src 相对路径的
const citedFiles = new Set([...cited].filter((c) => /^[A-Za-z0-9_./-]+\.js$/.test(c)));

// --- 1. 前向：树引用的每个文件必须真实存在 ---
let fwdMiss = 0;
for (const c of citedFiles) {
  if (!existsSync(join(srcDir, c))) { fwdMiss++; fail(`FEATURE_TREE 引用了不存在的 src 文件: ${c}`); }
}
if (fwdMiss === 0 && citedFiles.size) ok(`树引用文件存在性通过 (${citedFiles.size} 个)`);

// --- 2. 目录级孤儿：某目录及全部祖先都无树引用 = 新增能力域未登记 ---
const anchoredDir = (dir) => {
  const parts = dir.split("/");
  for (let i = parts.length; i >= 1; i--) {
    const sub = parts.slice(0, i).join("/");
    if ([...citedFiles].some((c) => c === sub || c.startsWith(sub + "/"))) return true;
  }
  return false;
};
let orphanDirs = [...realDirs].filter((d) => !anchoredDir(d)).sort();
// 文件孤儿（兜底，目录锚定时应为 0；仅软告警不拦）
const fileOrphans = realFiles.filter((f) => !citedFiles.has(f) && !anchoredDir(f));
if (orphanDirs.length) orphanDirs.forEach((d) => fail(`src 新增了树未锚定的能力目录（补 FEATURE_TREE 一片叶）：${d}/`));
else ok(`目录锚定覆盖通过（全部 ${realDirs.size} 个含 js 目录均被树锚定）`);
if (fileOrphans.length) fileOrphans.forEach((f) => warn(`支撑文件未显式入树（其目录已锚定，可不处理）：${f}`));

// --- 3. 汇总 ---
console.log(failures ? `\n${failures} 项功能树检查失败 — 补 docs/FEATURE_TREE.md 叶子（见该文件顶说明）` : "\n功能树一致性检查全部通过");
process.exit(failures ? 1 : 0);
