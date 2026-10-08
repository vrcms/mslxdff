// 上游错误分型：决定一次失败该「刷新」「换号」「原地重试」还是「直接报错」。
// 与国内版 `workbuddy/auth.js:20` 的关键区别：**403 不再一律当鉴权失败**。
// 国际版实测：11140（安全审核）、11128、11133、11101、11102 全是 403/400，refresh 对它们完全无用
// —— 而 CN 版把 403 当鉴权，等于每命中一次就白烧一次 token 刷新（`global-hi.js:221` 早已发现却从未回流 provider）。
// Note: 同一个业务码在两区含义不同（11128 在 CN=developer role 被拒、在国际版=缺首条 system），
//       所以判型只能「码 + 文案」一起看，且**绝不按码单独分支**。

/** 积分不足标记：英文小写形 + 中文原文（词表照参考仓库 upstream.ts:184-189）。 */
const HARD_CREDIT_MARKERS = [
  "insufficient credit", "no credit", "credit exhausted", "credits exhausted", "out of credit",
  "quota exceeded", "quota exhaust", "payment required", "credit not enough", "not enough credit",
  "积分不足", "额度不足", "余额不足", "积分用完", "额度用尽", "没有积分",
];

/** 会话失效措辞（403 时用于区分「真鉴权」与「业务拒绝」）。 */
const SESSION_MARKERS = [
  "unauthorized", "authenticate", "invalid token", "token expired", "token invalid",
  "access token", "login expired", "need login", "session expired", "未登录", "登录过期", "会话过期",
];

/** 安全审核类：11140 是伞形码（实测 displayMsg 既见「内容未通过安全审核」也见「访问受限」）。 */
const SAFETY_MARKERS = ["request illegal", "safety", "安全审核", "內容未通過", "访问受限"];

/** 参数类业务码（实测：11101 tool_choice 反序列化、11102 模型不存在、11128 首条/角色、11133 参数被模型拒）。 */
const PARAM_CODES = new Set(["11101", "11102", "11128", "11133"]);

function pickBusinessCode(text) {
  const m = String(text || "").match(/"code"\s*:\s*"?(\d{4,6})"?/);
  return m ? m[1] : "";
}

/** 提取 `displayMsg.zh` → `displayMsg.en` → `msg`（参考仓库 issue #58 的教训：别把整串 JSON 甩给用户）。 */
export function extractDisplayMessage(text) {
  let obj;
  try { obj = JSON.parse(String(text || "")); } catch { return ""; }
  if (!obj || typeof obj !== "object") return "";
  const dm = obj.displayMsg;
  if (dm && typeof dm === "object") {
    for (const key of ["zh", "en", "zh-hant"]) {
      if (typeof dm[key] === "string" && dm[key].trim()) return dm[key].trim();
    }
  }
  return typeof obj.msg === "string" ? obj.msg.trim() : "";
}

export function extErrorCode(text) {
  try {
    const obj = JSON.parse(String(text || ""));
    const code = obj?.extError?.code;
    return typeof code === "string" ? code : "";
  } catch { return ""; }
}

/**
 * 分型入口。返回 `{ kind, code, extCode, displayMsg, detail }`。
 * kind ∈ session_dead | hard_credit | safety | param | rate_limit | server | client | unknown
 */
export function classifyUpstreamError(status, bodyText) {
  const text = String(bodyText || "");
  const lower = text.toLowerCase();
  const code = pickBusinessCode(text);
  const extCode = extErrorCode(text);
  const out = { kind: "unknown", code, extCode, displayMsg: extractDisplayMessage(text), detail: text.slice(0, 200) };

  if (status === 401) { out.kind = "session_dead"; return out; }
  if (status === 402) { out.kind = "hard_credit"; return out; }
  if (status === 429) { out.kind = "rate_limit"; return out; }
  if (status >= 500) { out.kind = "server"; return out; }

  // 顺序即优先级：先排掉「刷了也没用」的三类，再谈鉴权。
  if (SAFETY_MARKERS.some((m) => lower.includes(m.toLowerCase()) || text.includes(m))) { out.kind = "safety"; return out; }
  if (HARD_CREDIT_MARKERS.some((m) => lower.includes(m.toLowerCase()) || text.includes(m))) { out.kind = "hard_credit"; return out; }
  if (PARAM_CODES.has(code) || (status === 400 && code && code !== "11140")) { out.kind = "param"; return out; }
  if (status === 403 && SESSION_MARKERS.some((m) => lower.includes(m))) { out.kind = "session_dead"; return out; }
  if (status === 400 && lower.includes("token")) { out.kind = "session_dead"; return out; }
  if (status >= 400 && status < 500) { out.kind = "client"; return out; }
  return out;
}

/** 只有这类才值得去刷 token。 */
export function isSessionDead(kind) { return kind === "session_dead"; }
/** 只有这类才该把该号冷却并换下一个号（刷 token 与重试都无救）。 */
export function isCreditExhausted(kind) { return kind === "hard_credit"; }
/** 这类是「随机拦截」，同请求体原地重试可救（`global-hi.js:229` 实测 11140 按 ~10-25% 概率出现）。 */
export function isRetryableSafety(kind) { return kind === "safety"; }

/**
 * 给人看的错误文案。
 * ⚠ 非鉴权类刻意**不写裸 `401`/`403` 数字**：下游宿主/适配器常按 `/\b(401|403)\b/` 直接判成
 *   "API Key 无效"，会把真实业务错误覆盖掉（参考仓库 issue #58 原封不动踩过这个坑）。
 */
export function friendlyMessage(kind, bodyText, providerId = "globalworkbuddy") {
  const display = extractDisplayMessage(bodyText);
  const code = pickBusinessCode(bodyText);
  const label = display || (code ? `code ${code}` : String(bodyText || "").slice(0, 160)) || "上游拒绝";
  const prefix = kind === "session_dead" ? `${providerId} 会话已失效` : `${providerId} 上游拒绝`;
  return code ? `${prefix}（${code}）：${label}` : `${prefix}：${label}`;
}
