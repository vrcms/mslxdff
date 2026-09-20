// readline 统一走回调版 `node:readline`（question 包成 Promise），
// 顺带给 -chat 一个人话版本门（项目要求 Node >=18，ADR-0024）。
// 保留理由：回调版在 18+ 行为一致且无 import 期风险（`node:readline/promises`
// 若被误用于旧运行时会直接 ERR_UNKNOWN_BUILTIN_MODULE，连报错都来不及打）。
import readline from "node:readline";
import { MIN_NODE_MAJOR, nodeMajor } from "./compat.js";

export function createInterface(opts) {
  const rl = readline.createInterface(opts);
  const ask = rl.question.bind(rl);
  rl.question = (query) => new Promise((resolve) => ask(query, (ans) => resolve(ans)));
  return rl;
}

export { nodeMajor };

// -chat 版本门：项目要求 Node >=18（ADR-0024），不满足直接给人话 + 升级指引。
// 返回 true=通过，false=已打印升级指引。
export function assertChatNode({ min = MIN_NODE_MAJOR } = {}) {
  const major = nodeMajor();
  if (major >= min) return true;
  console.error(`Node 版本过旧（当前 v${process.versions.node}），-chat 需要 Node ${min}+（推荐 20+）。`);
  console.error("先升级 Node 再重试：nvm install 20 && nvm use 20，或到 https://nodejs.org/ 下 LTS。");
  return false;
}
