#!/usr/bin/env node
// 按模块跑测试：只跑「依赖到本次改动」的测试文件，公共模块才回退全量。
//
// 目标（用户 2026-10-20）：改什么模块就测什么模块；公共模块则全局测试。
//
// 实现：**依赖图反向查找**，不靠文件名猜——
//   1) 扫 src/**/*.js，解析各自 import，建「文件 → 被谁 import」的反向图；
//   2) 从改动文件出发做反向 BFS，得到「所有直接/间接依赖它的 src 文件」；
//   3) 扫 test/*.test.js，凡 import 到这些 src 文件之一 → 纳入；
//   4) 文件名匹配做补充兜底（测试名里含模块名）；
//   5) 公共模块（被依赖数超阈值，或命中 FOUNDATION 名单）→ 直接全量。
//
// 用法：
//   node scripts/test-scoped.js                # 按工作区改动；干净则用最近一次提交
//   node scripts/test-scoped.js src/peers.js   # 指定改动文件
//   node scripts/test-scoped.js --list         # 只看会跑哪些，不执行
//   node scripts/test-scoped.js --all          # 强制全量
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const TEST_DIR = join(ROOT, "test");

// 改到这些「地基」模块，影响面无法收敛 —— 直接全量。宁可慢，不可漏。
const FOUNDATION = new Set([
  "compat", "state", "transport", "logs", "time", "plugins", "events",
  "helpers", "server", "daemon", "readline-compat",
]);
// 被依赖数达到这个量级就算公共模块（影响面太广，逐文件推导没意义）
const PUBLIC_DEP_THRESHOLD = 25;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

function listTests() {
  return readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.js")).sort();
}

// 静态解析 import 的相对路径 → 绝对路径（.js 省略补全；目录则补 index.js）
function importsOf(file) {
  let src = "";
  try { src = readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] || m[2];
    if (!spec || !spec.startsWith(".")) continue;
    let p = resolve(dirname(file), spec);
    for (const cand of [p, `${p}.js`, join(p, "index.js")]) {
      try { if (statSync(cand).isFile()) { out.push(cand); break; } } catch { /* 下一个 */ }
    }
  }
  return [...new Set(out)];
}

function gitFiles(args) {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean).map((p) => resolve(ROOT, p.trim()));
  } catch { return []; }
}

function changedFiles() {
  const dirty = gitFiles(["status", "--porcelain"]).map((p) => p); // 已是绝对路径
  const fromStatus = (() => {
    try {
      const out = execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" });
      return out.split(/\r?\n/).filter(Boolean)
        .map((l) => resolve(ROOT, l.slice(3).trim()))
        .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
    } catch { return []; }
  })();
  if (fromStatus.length) return { files: fromStatus, source: "工作区改动" };
  const last = gitFiles(["diff", "--name-only", "HEAD~1", "HEAD"]);
  if (last.length) return { files: last, source: "最近一次提交" };
  return { files: dirty, source: "无改动" };
}

const moduleLeaf = (f) => {
  const rel = relative(SRC, f);
  const parts = rel.split(/[\\/]/);
  return parts[parts.length - 1].replace(/\.js$/, "");
};

// 单复数/连字符容错：peers ↔ peer-standby、codearts ↔ codearts-concurrency
function nameMatches(testBase, mod) {
  const t = testBase.toLowerCase();
  const m = mod.toLowerCase();
  if (m.length < 3) return false;
  if (t.includes(m)) return true;
  const stem = m.replace(/s$/, "");           // peers → peer
  return stem.length >= 3 && t.includes(stem);
}

function buildReverseGraph() {
  const rev = new Map(); // 被 import 的文件 → Set(import 它的文件)
  const depCount = new Map();
  for (const f of walk(SRC)) {
    const deps = importsOf(f);
    depCount.set(f, 0);
    for (const d of deps) {
      if (!rev.has(d)) rev.set(d, new Set());
      rev.get(d).add(f);
      depCount.set(d, (depCount.get(d) || 0) + 1);
    }
  }
  return { rev, depCount };
}

function pickTests(changed, { rev, depCount }) {
  const tests = listTests();

  // ① 公共模块判定：地基名单，或依赖它的源文件足够多
  for (const f of changed) {
    const leaf = moduleLeaf(f);
    if (FOUNDATION.has(leaf)) return { all: true, why: `改到地基模块 ${leaf}（公共层，影响全局）` };
    const n = depCount.get(f) || 0;
    if (n >= PUBLIC_DEP_THRESHOLD) return { all: true, why: `${relative(ROOT, f)} 被 ${n} 个源文件依赖（公共模块）` };
  }

  // ② 反向 BFS：找到所有间接依赖改动文件的 src 文件
  const affected = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const cur = queue.shift();
    for (const up of rev.get(cur) || []) {
      if (!affected.has(up)) { affected.add(up); queue.push(up); }
    }
  }

  // ③ 测试文件：import 命中受影响集合，或文件名含模块名
  const chosen = new Map(); // test → 依据
  const mods = changed.map(moduleLeaf);
  for (const t of tests) {
    const tp = join(TEST_DIR, t);
    const base = t.replace(/\.test\.js$/, "");
    const imps = importsOf(tp);
    const importHit = imps.some((p) => affected.has(p));
    if (importHit) { chosen.set(t, "import 依赖链"); continue; }
    if (mods.some((m) => nameMatches(base, m))) chosen.set(t, "文件名匹配");
  }
  return { all: false, tests: [...chosen.keys()].sort(), reasons: chosen };
}

function runTests(files) {
  const args = files.length ? ["--test", "--test-concurrency=1", ...files] : [];
  try {
    execFileSync("node", args, { cwd: ROOT, stdio: "inherit" });
    process.exit(0);
  } catch (e) { process.exit(e.status ?? 1); }
}

function runAll(why) {
  const all = listTests().map((t) => join("test", t));
  console.log(`[scoped] ⚠ 全量测试（${all.length} 个文件）：${why}`);
  runTests(all);
}

function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const paths = args.filter((a) => !a.startsWith("--"));

  if (flags.includes("--all")) return runAll("用户指定 --all");

  let files, source;
  if (paths.length) {
    files = paths.map((p) => resolve(ROOT, p));
    source = "命令行指定";
  } else {
    ({ files, source } = changedFiles());
  }
  if (!files.length) return runAll("没有可推导的改动文件");

  // 只看 src/ 下的源文件（改测试/脚本文件本身不必再推导）
  const srcOnly = files.filter((f) => f.startsWith(SRC + sep));
  if (!srcOnly.length) {
    // 只有测试/脚本/文档改动 → 什么都不用跑（不是"推导失败"，是"没有生产代码变动"）
    const touchedSrc = files.some((f) => f.startsWith(SRC + sep));
    if (!touchedSrc) {
      console.log(`[scoped] 没有 src/ 源文件改动（${files.length} 个文件：${files.map((f) => relative(ROOT, f)).join(", ")}）→ 无需跑测试`);
      process.exit(0);
    }
    return runAll(`改动里没有 src/ 源文件（${files.length} 个文件）`);
  }

  const graph = buildReverseGraph();
  const picked = pickTests(srcOnly, graph);
  if (picked.all) return runAll(picked.why);
  if (!picked.tests.length) {
    return runAll(`改动 ${srcOnly.length} 个源文件，但没有任何测试依赖它们`);
  }

  const shown = srcOnly.map((f) => relative(ROOT, f).split(sep).join("/"));
  if (flags.includes("--list")) {
    console.log(`[${source}] 改动 ${srcOnly.length} 个源文件 → ${picked.tests.length}/${listTests().length} 个测试文件`);
    console.log(`  改动: ${shown.join(", ")}`);
    for (const t of picked.tests) console.log(`  · ${t}  (${picked.reasons.get(t)})`);
    return;
  }

  console.log(`[scoped] ${source}：${shown.join(", ")}`);
  console.log(`[scoped] → 跑 ${picked.tests.length}/${listTests().length} 个测试文件（跳过 ${listTests().length - picked.tests.length} 个无关的）`);
  runTests(picked.tests.map((t) => join("test", t)));
}

main();
