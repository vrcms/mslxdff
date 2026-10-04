// vendor 自 src/providers/qwenwork/http.js（只保留本 provider 用得上的部分；CORS/preflight 属原项目的边缘层，不带）。
export function cleanErrorText(value) {
  let s = String(value === undefined || value === null ? "" : value);
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\S ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

export function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// globalqwenwork 变体：国际站 gateway.qwenwork.ai，协议与 cn 逐字同构（2026-10-01 现网取证），仅命名空间与常量不同 — 见 docs/adr/0041-globalqwenwork-international-provider.md
