/**
 * Claude Desktop on 3P 的「角色槽」纯函数层（零 IO、零网络，可单测）。
 *
 * 为什么需要这一层：桌面端（Chat/Cowork/Code 三 tab 同一个 3P profile）**只接受三档角色 ID 形态的模型名**
 * （`claude-sonnet-*` / `claude-opus-*` / `claude-haiku-*`，旧式 `claude-3-5-sonnet-*` 亦被拒），
 * 而本仓池子里是 `qwenwork/flash`、`traework/kimi-k3` 这类 id —— 直接写进 `inferenceModels` 会被 App 拒。
 * 解法与社区工具（cc-switch「模型映射」）同构，但**不另起常驻路由**：桌面端看到槽位 id，
 * 槽位 → 真模型 的翻译交给网关自己的 alias 表（`src/providers/model-id.js`，入站在
 * `src/chat-pipeline/policy.js:20-24` 生效，未命中即热读文件 → 加别名不用重启 daemon）。
 *
 * 槽位清单不凭空发明：只允许 App 自带签名模型目录里出现过的 id
 * （`%LOCALAPPDATA%/Claude-3p/model-catalog/published.json` 的 `surfaces.*.model_selector_state`，
 * 本机实测 version 1905 = 12 个 id）。目录被 App 换版时，`-claude-desktop slots` 会读实况并比对。
 */

/** 槽位优先级：前三档是硬需求，顺序不可随意调。 */
export const ROLE_SLOTS = [
  // 1) App 的默认模型 + Test connection 探针固定用它（实测 502 就卡在这）
  "claude-sonnet-5",
  // 2) 高质量档：用户在 Code tab 里手动挑「Opus」时走它
  "claude-opus-5",
  // 3) 便宜快档：子 agent / 会话标题 / prompt 建议等后台小调用只认 Haiku，缺它这些调用全挂
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-sonnet-4-6",
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
];

/** 槽位所属角色（仅用于给人话说明，不参与路由）。 */
export function slotRole(slot) {
  const s = String(slot || "");
  if (s.includes("haiku")) return "haiku";
  if (s.includes("opus")) return "opus";
  if (s.includes("fable")) return "fable";
  if (s.includes("sonnet")) return "sonnet";
  return "unknown";
}

export function isRoleSlot(id) {
  return ROLE_SLOTS.includes(String(id || "").trim());
}

/**
 * 把勾选集摊到角色槽上。
 * @param {{picks?: string[], preferred?: string, max?: number}} p
 * @returns {{rows: {slot:string, model:string, label:string}[], overflow: number, dropped: string[]}}
 * @throws 勾选集为空时抛错（**绝不兜底 preferredModel** —— 它可能是一个早已失效的 id，见 ADR-0047 D13）
 */
export function planSlots({ picks = [], preferred = "", max } = {}) {
  const list = [...new Set((Array.isArray(picks) ? picks : []).map((x) => String(x || "").trim()).filter(Boolean))];
  if (!list.length) {
    throw new Error("没有可写入的模型：先跑 mslxdff -model pick 勾选，或直接 mslxdff -setto claude-desktop <modelId> ...");
  }
  const pref = String(preferred || "").trim();
  const ordered = pref && list.includes(pref) ? [pref, ...list.filter((x) => x !== pref)] : list;
  const cap = Math.max(1, Math.min(Number(max) > 0 ? Number(max) : ROLE_SLOTS.length, ROLE_SLOTS.length));
  const rows = ordered.slice(0, cap).map((model, i) => ({ slot: ROLE_SLOTS[i], model, label: model }));
  const dropped = ordered.slice(cap);
  return { rows, overflow: Math.max(0, ordered.length - cap), dropped };
}

/** rows → alias 表条目（槽位 id → 真模型 id）。 */
export function aliasPairs(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.slot && r.model && r.slot !== r.model)
    .map((r) => [String(r.slot), String(r.model)]);
}

/**
 * 桌面端 profile 的 `inferenceModels` 形状（官方 models 页：条目可为 id 字符串或对象，
 * 对象里 `name` 是发给 provider 的真 id、`labelOverride` 是菜单显示名）。
 * 显示名带上真模型名，用户在 App 下拉里能认出「这条其实是 qwenwork/pro」。
 */
export function toInferenceModels(rows = [], { maxEffort } = {}) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const e = { name: String(r.slot), labelOverride: String(r.label || r.model) };
    if (maxEffort) e.maxEffort = String(maxEffort);
    return e;
  });
}
