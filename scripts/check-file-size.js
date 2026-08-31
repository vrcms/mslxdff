// 检查 src/**/*.js 单文件体积：>20KB 报错，>10KB 警告
// 供 npm run docs:check 集成，CI 强制拦大文件，防“先挤后拆”
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ? import.meta.dirname : ".", "..");
const SRC = join(ROOT, "src");
const WARN = 10 * 1024;
const FAIL = 20 * 1024;

let warns = 0;
let fails = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      const sz = statSync(p).size;
      const rel = p.replace(ROOT + "\\", "").replace(ROOT + "/", "");
      if (sz > FAIL) {
        console.error(`✗ ${rel} ${(sz/1024).toFixed(1)}KB >20KB 必须拆分`);
        fails++;
      } else if (sz > WARN) {
        console.warn(`⚠ ${rel} ${(sz/1024).toFixed(1)}KB >10KB 建议拆分`);
        warns++;
      }
    }
  }
}

if (readdirSync(SRC, { withFileTypes: true }).length) walk(SRC);

if (fails) {
  console.error(`\n${fails} 个文件超 20KB — 按 AGENTS.md 必须先拆后写（见 .opencode/skills/preflight-split/SKILL.md）`);
  process.exit(1);
}
if (warns) console.log(`\n${warns} 个文件超 10KB（警告，不阻塞）— 建议按职责拆深模块`);
else console.log("✓ 体积检查通过：所有 src/**/*.js ≤10KB 理想阈");
