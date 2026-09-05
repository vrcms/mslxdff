// readline 兼容层：`node:readline/promises` 需要 Node 17+，老 Node（如 VPS 的 16）
// 会 `ERR_UNKNOWN_BUILTIN_MODULE` 直接崩在 import 期，连人话报错都来不及打。
// 这里只用回调版 `node:readline`（Node 12+ 全有），把 `question` 包成 Promise；
// `prompt()/close()/for await` 回调版原生即有，对我们用到的部分行为一致。
import readline from "node:readline";

export function createInterface(opts) {
  const rl = readline.createInterface(opts);
  const ask = rl.question.bind(rl);
  rl.question = (query) => new Promise((resolve) => ask(query, (ans) => resolve(ans)));
  return rl;
}

export function nodeMajor() {
  return Number(String(process.versions?.node || "0").split(".")[0]) || 0;
}

// -chat 依赖 fetch（<18 由 src/compat.js 用 undici polyfill），低于 engines 下限
// 直接给一句人话。返回 true=通过，false=已打印升级指引。
export function assertChatNode({ min = 16 } = {}) {
  const major = nodeMajor();
  if (major >= min) return true;
  console.error(`Node 版本过旧（当前 v${process.versions.node}），-chat 需要 Node ${min}+（推荐 20+）。`);
  console.error("先升级 Node 再重试：nvm install 20 && nvm use 20，或到 https://nodejs.org/ 下 LTS。");
  return false;
}
