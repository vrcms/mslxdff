import { runAutoRace } from "./auto-race.js";
import { runSerialTrial } from "./serial-trial.js";

/**
 * ExecutionEngine（薄编排）— auto 并发择优 → 串行 trial。
 * 重活下沉 auto-race.js / serial-trial.js，本文件仅做顺序编排。
 */
export function createEngine(deps = {}) {
  const { raceDeps, serialDeps } = deps;
  async function run(_plan, state) {
    const race = await runAutoRace(state, raceDeps);
    if (race.done) return;
    await runSerialTrial({ ...state, order: race.order }, serialDeps);
  }

  return { run };
}
