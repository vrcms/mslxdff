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
 * `supports1m===true` 的行（--1m 裁决产物，decideRows1m 打标）追加官方成对键
 * `supports1m+prefer1m`（= 菜单单条、新会话直接 1M 窗口，ADR-0056）；
 * 键序恒为 name→labelOverride→supports1m→prefer1m→maxEffort —— 幂等按原文比对，键序必须稳定。
 */
export function toInferenceModels(rows = [], { maxEffort } = {}) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const e = { name: String(r.slot), labelOverride: String(r.label || r.model) };
    if (r.supports1m === true) { e.supports1m = true; e.prefer1m = true; }
    if (maxEffort) e.maxEffort = String(maxEffort);
    return e;
  });
}

/** `--1m` auto 模式阈值：/v1/models 已裁决窗口 ≥ 此值才打标（ADR-0056）。 */
export const ONE_M_THRESHOLD = 1_000_000;

/**
 * `-setto claude-desktop --1m <值>` 的纯函数解析：
 * `off|auto|all` 保留字（大小写不敏感）、空值缺省 auto；其余非空值一律按列表处理（单条即长度 1）——
 * 列表值不与行集做存在性预校验，未命中经 decideRows1m 的 unmatched 以 ⚠ 呈现而非硬拒（spec《--1m 参数解析》）。
 * 仅 trim 后为空/纯分隔符（`,,`）判 invalid，CLI 须在写盘前拒绝。
 */
export function parseOneMMode(raw) {
  const s = String(raw ?? "").trim();
  const low = s.toLowerCase();
  if (s === "" || low === "auto") return { mode: "auto", list: [] };
  if (low === "off") return { mode: "off", list: [] };
  if (low === "all") return { mode: "all", list: [] };
  const list = s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return { mode: "invalid" };
  return { mode: "list", list };
}

/**
 * --1m 裁决（纯函数，不改入参）：rows → { rows, unmatched, preserved }。
 * `oneM` 为 parseOneMMode 产物；`contexts` 为证据 Adapter 的 Map<小写 id, 窗口数>；
 * `preserve` 为盘上既有 1M 标 Map<小写槽位, true>。auto 语义：有证据且 ≥1M 才新增标、
 * 有证据且 <1M 才清标；**无证据（整体失败或该行不在目录）≠ 负面证据 —— 保留既有标**，
 * 网关停机的一轮不得静默抹掉上次写好的（评审 1 P1-2）。
 */
export function decideRows1m({ rows = [], oneM = { mode: "off", list: [] }, contexts = null, preserve = null } = {}) {
  const mode = oneM && oneM.mode ? oneM.mode : "off";
  const list = (Array.isArray(oneM && oneM.list) ? oneM.list : []).map((x) => String(x).toLowerCase());
  const matched = new Set();
  const preserved = [];
  const out = (Array.isArray(rows) ? rows : []).map((r) => {
    let mark = false;
    if (mode === "all") {
      mark = true;
    } else if (mode === "list") {
      const slot = String(r?.slot || "").toLowerCase();
      const model = String(r?.model || "").toLowerCase();
      const hitSlot = slot && list.includes(slot);
      const hitModel = model && list.includes(model);
      if (hitSlot || hitModel) {
        mark = true;
        if (hitSlot) matched.add(slot);
        if (hitModel) matched.add(model);
      }
    } else if (mode === "auto") {
      const key = String(r?.model || "").toLowerCase();
      const n = contexts ? contexts.get(key) : undefined; // 短路写 `&&` 会把整体失败喂成 null → 误走「清标」分支（全量测试抓到）
      if (n === undefined) {
        mark = Boolean(preserve && preserve.get(String(r?.slot || "").toLowerCase()));
        if (mark) preserved.push(String(r?.slot || "").toLowerCase());
      } else {
        mark = n >= ONE_M_THRESHOLD;
      }
    }
    return mark ? { ...r, supports1m: true } : { ...r };
  });
  const unmatched = mode === "list" ? list.filter((v) => !matched.has(v)) : [];
  return { rows: out, unmatched, preserved };
}
