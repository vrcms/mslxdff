import { savePreferredModel, loadModelPicks, saveModelPicks } from "../../../state.js";

/**
 * 勾选集分支：set / pick / unpick / picks / pick clear。
 * 命中返回 true（分支内 process.exit，不会实际返回）；未命中返回 false。
 */
export async function handlePicksCommand(args, idx, sub) {
  if (sub === "set" && args[idx + 2]) {
    const id = args[idx + 2];
    savePreferredModel(id);
    const picks = [...new Set([...loadModelPicks(), id])];
    saveModelPicks(picks);
    console.log(`default model set to: ${id} (daemon hot-reloads on next request)`);
    console.log(`picked: ${picks.join(", ") || "(none)"} (auto will pick within these)`);
    process.exit(0);
  }
  if (sub === "pick" && args[idx + 2] && args[idx + 2] !== "clear") {
    const picks = [...new Set([...loadModelPicks(), args[idx + 2]])];
    saveModelPicks(picks);
    console.log(`picked: ${picks.join(", ") || "(none)"} (auto will pick within these)`);
    process.exit(0);
  }
  if (sub === "pick" && args[idx + 2] === "clear") {
    saveModelPicks([]);
    console.log("picks cleared — auto uses the full model list again");
    process.exit(0);
  }
  if (sub === "unpick" && args[idx + 2]) {
    const picks = loadModelPicks().filter((x) => x !== args[idx + 2]);
    saveModelPicks(picks);
    console.log(`picked: ${picks.join(", ") || "(none)"}${picks.length === 0 ? " (auto uses full list)" : ""}`);
    process.exit(0);
  }
  if (sub === "picks") {
    const picks = loadModelPicks();
    if (!picks.length) {
      console.log("no picks — auto uses the full model list");
    } else {
      console.log(`${picks.length} picked model(s), auto only selects within these:`);
    }
    for (const id of picks) console.log(`  ${id}`);
    process.exit(0);
  }
  return false;
}
