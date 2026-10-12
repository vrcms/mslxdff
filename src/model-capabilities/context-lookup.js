// 模型上下文窗口的四级解析（ADR-0054）：/v1/models 富化时唯一真相源。
// 旧状：顶层 context_length（provider 自报）与 capabilities.context（models.dev）两套并行可能矛盾，
// 且四层全空时什么都不报；本模块把优先级收死，并保证"双层同源同值"。
// 纯函数 + env，无 IO 无网络（L1/L2/L4 不依赖目录，冷缓存/目录挂掉照常生效）。
// L4 方向沿上游 workbuddy2api-hub："未知报 1M——高估比低估安全"（只作元数据，网关转发不读它）。

export const DEFAULT_CONTEXT_FALLBACK = 1_000_000;

/** L4 兜底值：`MSLXDFF_MODEL_CONTEXT_FALLBACK` 覆盖；0/负数 = 关闭兜底（回"未知不报"旧口径）；非法值按默认 1M。 */
export function contextFallback() {
  const raw = String(process.env.MSLXDFF_MODEL_CONTEXT_FALLBACK ?? "").trim();
  if (raw === "") return DEFAULT_CONTEXT_FALLBACK;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CONTEXT_FALLBACK;
  if (n <= 0) return 0;
  const f = Math.floor(n);
  return f > 0 ? f : DEFAULT_CONTEXT_FALLBACK; // (0,1) 被.floor 成 0 会静默变"关兜底"，按非法回默认
}

function positiveInt(v) {
  if (typeof v !== "number" && typeof v !== "string") return null; // boolean/数组/对象 = 未自报，不猜
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** L1 条目自报（first-party 最准）。键序覆盖现网全部自报形状；非数字/0/负数 = 未自报，丢弃而非钳制。 */
export function firstPartyContextOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  for (const v of [entry.context_length, entry.maxInputTokens, entry.max_input_tokens]) {
    const n = positiveInt(v);
    if (n) return n;
  }
  const cw = entry.contextWindow;
  return positiveInt(cw && typeof cw === "object" ? cw.defaultLength : cw);
}

// L2 内置知识表：给"provider 目录不自报窗口、且值有官方/上游文档出处"的模型补一手。
// 准入红线（评审过：无据值不得进表——traework 硬编码 131072 正是反面教材，本次已删）：
//   - key = **实际传入解析器的条目 id 小写**（现网含裸 id 与 `-free` 后缀形态；填表前必须按此对键，
//     跨 provider 撞名靠带前缀的 id 天然区分），别照 ADR 初稿的 `prov/raw` canonical 形去猜；
//   - 每条必须带 source 出处注释（文档/上游字段 + 核对日期），给不出出处就让它落 L4 兜底。
// 首期为空是盘点结论：raccoon/qoder/codearts/workbuddy/globalworkbuddy/qwenwork 系的有据值全部已被 L1 覆盖，
// 把 L1 复制进表只会制造第二个真相源。等出现"只回 id 的极简目录 provider"之类的真缺口再填。
export const KNOWN_CONTEXT = Object.freeze({});

/** L2 查表（按条目 id 小写）；未命中或值非法返回 null。`table` 为测试注入口（缺省用内置表）。 */
export function knownContextOf(id, table = KNOWN_CONTEXT) {
  const e = table[String(id || "").trim().toLowerCase()];
  return e ? positiveInt(e.context) : null;
}

/**
 * 四级解析：L1 自报 > L2 内置表 > L3 models.dev caps > L4 兜底。
 * 返回正整数；env 关闭兜底且 L1–L3 全空时返回 null（调用方两层都不写）。
 * `knownTable` 仅供测试注入假表锁 L2>L3 顺序，生产调用方不传。
 */
export function resolveContextLength({ entry, id, caps, knownTable } = {}) {
  const fp = firstPartyContextOf(entry);
  if (fp) return fp;
  const known = knownContextOf(id, knownTable);
  if (known) return known;
  const c = positiveInt(caps?.context);
  if (c) return c;
  return contextFallback() || null;
}
