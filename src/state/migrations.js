/**
 * 状态迁移运行器：按注册顺序执行（每个迁移自身幂等），供 daemon bootstrap
 * （src/runtime/providers-setup.js，实例化任何 provider 之前）与 CLI 单点调用。
 * 失败只收集不抛出：迁移不该拖垮 daemon 启动。
 */
import { defaultStateFile } from "./store.js";
import { clineUnifyMigration } from "./migrations/cline-unify.js";

export const STATE_MIGRATIONS = [
  { id: "cline-unify", run: (opts) => clineUnifyMigration(opts) },
];

/**
 * @param {{file?:string, dryRun?:boolean, backup?:boolean}} opts
 * @returns {Promise<{applied:string[], skipped:string[], errors:object[], details:object}>}
 */
export async function runStateMigrations({ file = defaultStateFile(), dryRun = false, backup = true } = {}) {
  const applied = [];
  const skipped = [];
  const errors = [];
  const details = {};
  for (const m of STATE_MIGRATIONS) {
    try {
      const r = await m.run({ file, dryRun, backup });
      details[m.id] = r;
      if (r?.applied) applied.push(m.id);
      else skipped.push(m.id);
    } catch (err) {
      errors.push({ id: m.id, error: String(err?.message || err) });
    }
  }
  return { applied, skipped, errors, details };
}
