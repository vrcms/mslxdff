// 引擎模式解析（纯函数，零依赖）：缺省 sdk，legacy/关闭词回退原实现。
// 供应商级开关未设置时继承全局总闸，使 MSLXDFF_UPSTREAM_ENGINE=legacy 成为一键熔断。
// defaultMode：调用方可自定缺省（一般无需传，保持 sdk）；显式 env（供应商级或全局）始终优先。
// 供 upstream-engine/index.js（opencode 上游）与 providers/workbuddy/chat.js 共用。
// 见 docs/adr/0017。
const ENGINE_OFF_WORDS = new Set(["0", "off", "false", "no", "disable", "disabled"]);

export function resolveEngineMode(env = process.env, varName = "MSLXDFF_UPSTREAM_ENGINE", defaultMode = "sdk") {
  const pick = (name) => String(env?.[name] ?? "").trim().toLowerCase();
  let raw = pick(varName);
  if (!raw && varName !== "MSLXDFF_UPSTREAM_ENGINE") raw = pick("MSLXDFF_UPSTREAM_ENGINE");
  if (raw === "legacy" || ENGINE_OFF_WORDS.has(raw)) return "legacy";
  if (raw) return "sdk";
  return defaultMode === "legacy" ? "legacy" : "sdk";
}
