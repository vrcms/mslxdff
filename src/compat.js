// 老 Node 兼容层（engines >=16）：Node 16 缺 globalThis.fetch（18+）、
// AbortSignal.timeout（17.3+）、structuredClone（17+）；裸全局 crypto 是
// WebCrypto，其 randomUUID 要 19+，只有 node:crypto 的 14.17+ 可用。
// undici 8 需 Node 22+，依赖已锁 5.x（老 Node 可跑，API 兼容我们用到的面）。
// 统一从这里取，源码里勿直接用这些全局。
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
