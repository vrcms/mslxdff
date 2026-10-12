// 思考档位词表的单一来源（change: fix-thinking-effort-passthrough）。
// 入站翻译层保留档位字段后，各家供应商整形器都从这里读，避免像过去那样五处各写各的映射。
// 契约：
//  - effortFromBody(body)：按固定优先级取出客户端声明的档位原始串（不解释语义）。
//  - isEffortOff(v)：单个值是否表示"关思考"。
//  - isReasoningEnabled(effort, fallback)：布尔家（qoder/qwenwork 系）的推导。
//  - effortLevelFromBody(body)：只取「真档位载体」（reasoning_effort ＞ reasoningEffort ＞ effort），不含 thinking.type 开关。
// 关断值（off/none/disabled，大小写不敏感）**最高优先**：误开思考烧 token 不可逆，误关只是少想一点。

const OFF_VALUES = new Set(["off", "none", "disabled"]);

/** 单个档位值是否表示"关思考"。非字符串/空串/null 一律不算关。 */
export function isEffortOff(v) {
  return OFF_VALUES.has(String(v ?? "").trim().toLowerCase());
}

/** 取对象里的字符串档位值（非字符串返回空串）。 */
function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

/** 取 thinking 对象的 type（非对象返回空串）。 */
function thinkingType(th) {
  return th && typeof th === "object" ? str(th.type) : "";
}

/**
 * 客户端声明的思考档位，优先级：
 *   extra_body.thinking.type > reasoning_effort > reasoningEffort > effort > thinking.type
 * 任一候选是关断值即返回该值（关断最高优先）；否则返回首个非空候选；全空返回 ""。
 */
export function effortFromBody(body) {
  const b = body && typeof body === "object" ? body : {};
  const candidates = [
    thinkingType(b.extra_body?.thinking),
    str(b.reasoning_effort),
    str(b.reasoningEffort),
    str(b.effort),
    thinkingType(b.thinking),
  ];
  for (const c of candidates) if (c && isEffortOff(c)) return c;
  return candidates.find((c) => c) || "";
}

/**
 * 布尔家推导：有档位时"关断→false、其余→true"；无档位时回退到调用方给的默认（如模型目录结论）。
 */
export function isReasoningEnabled(effort, fallback = false) {
  const v = str(effort);
  if (!v) return fallback === true;
  return !isEffortOff(v);
}

const LEVEL_KEYS = ["reasoning_effort", "reasoningEffort", "effort"];

/**
 * 只从「真档位载体」取级别串（不含 `thinking.type` 这类开关载体——它的 "enabled"/"disabled" 不是档位级别，
 * 拿去当 `reasoning_effort` 发上游必被拒）。空串/纯空白一律不算声明。全空返回 ""。
 */
export function effortLevelFromBody(body) {
  const b = body && typeof body === "object" ? body : {};
  for (const k of LEVEL_KEYS) {
    const v = str(b[k]);
    if (v) return v;
  }
  return "";
}
