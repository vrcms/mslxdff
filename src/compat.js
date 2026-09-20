// 运行时兼容层（项目要求 Node >=18，见 ADR-0024；源码里勿直接用裸 fetch/globalThis.fetch）。
// 仍保留本层的原因：① undici 是显式依赖（Agent 连接池/keep-alive 要用），
// 各家 fetch 实现统一从这里取，避免 globalThis.fetch 与 undici.fetch 混用；
// ② AbortSignal.timeout/structuredClone 在 18+ 已原生，这里的兜底只为可读报错，
// 不再承诺 <18 可用（<18 请走 assertMinNode 的人话提示）。
import { randomUUID } from "node:crypto";

let _undici = null;
try { _undici = await import("undici"); } catch {}

export function getUndici() {
  return _undici || {};
}

const _nativeFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;

export const compatFetch = _undici?.fetch || _nativeFetch || function noFetch() {
  throw new Error("当前环境没有可用的 fetch：Node <18 且 undici 未安装。请 npm i undici@^5 或升级 Node >=18。");
};

export function timeoutSignal(ms) {
  if (typeof AbortSignal?.timeout === "function") return AbortSignal.timeout(ms);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`aborted (timeout ${ms}ms)`)), ms);
  if (typeof t.unref === "function") t.unref();
  return ctl.signal;
}

export function clone(v) {
  if (typeof structuredClone === "function") return structuredClone(v);
  if (v === null || typeof v !== "object") return v;
  return JSON.parse(JSON.stringify(v));
}

export const uuid = () => randomUUID();

// ---- 运行环境门（强制）：项目要求 Node >=18（ADR-0024）----
// Node <18 缺 Response/Headers/ReadableStream/TransformStream 等 Web 全局，
// 上游适配层有 29 处裸用，跑起来必 ReferenceError；与其半途炸掉，不如入口给人话。
export const MIN_NODE_MAJOR = 18;

export function nodeMajor() {
  return Number(String(process.versions?.node || "0").split(".")[0]) || 0;
}

export function assertMinNode({ min = MIN_NODE_MAJOR, label = "mslxdff" } = {}) {
  const major = nodeMajor();
  if (major >= min) return true;
  console.error(`[运行环境不满足] ${label} 需要 Node ${min}+，当前 v${process.versions.node}。`);
  console.error("原因：Node <18 没有 Response/Headers/ReadableStream 等全局对象，上游转发必然失败。");
  console.error("升级方式：nvm install 20 && nvm use 20，或到 https://nodejs.org/ 装 LTS（推荐 20/22）。");
  return false;
}
