// 空转（EMPTY_MODEL_RESPONSE：上游 200 但零正文零工具调用）重试策略：阶梯等待 + 抬额度 + 末次追问。
// 本模块只做「配置解析 + 载荷改写」的纯决策，不碰 HTTP 与下游响应；执行编排在 serial-trial.js。
// 拆出原因：serial-trial.js 承载串行换人/hedge/peer/broadband 编排，再加政策面即破 20KB 硬门。
import { extractRetryAfterSec } from "../routes/stream-scan.js"; // 限流窗口解析：与 relay 的「错误包络暂扣」同源，不复制第二份正则

// 空转重试阶梯（用户定：网络质量差 → 2s→8s→30s；末档对齐实测 retryAfterSeconds=30 的限流窗口）。
// MSLXDFF_EMPTY_TURN_RETRY_STEPS: JSON 数组(ms)。未设 = 用默认阶梯 [2000,8000,30000]；显式 "[]" = 逃生阀，回旧式固定延迟。
// MSLXDFF_EMPTY_TURN_RETRIES: 重试上限。未设 = 阶梯档数（默认 3）；0 = 关闭重试（空转直接换候选/终结）。
// 非法值（语法错/非正数）→ 每进程告警一次并按默认阶梯跑：绝不因配置手滑把重试整体关掉。
export const DEFAULT_EMPTY_TURN_STEPS = Object.freeze([2000, 8000, 30000]);

let stepsWarned = false;
function warnBadSteps(raw) {
  if (stepsWarned) return;
  stepsWarned = true;
  try { console.warn(`[mslxdff] MSLXDFF_EMPTY_TURN_RETRY_STEPS 非法(${String(raw).slice(0, 60)}) → 改用默认阶梯 [${DEFAULT_EMPTY_TURN_STEPS.join(",")}]`); } catch {}
}

export function emptyRetryCfg() {
  // 空串/纯空白 = 未设（.env 里 `MSLXDFF_EMPTY_TURN_RETRIES=` 是常见手滑，Number("")===0 会把整条恢复静默清零）
  const rawMax = String(process.env.MSLXDFF_EMPTY_TURN_RETRIES ?? "").trim();
  const r = rawMax === "" ? NaN : Number(rawMax);
  const resolveMax = (fallback) => (Number.isInteger(r) && r >= 0 ? r : fallback);
  const raw = process.env.MSLXDFF_EMPTY_TURN_RETRY_STEPS;
  const s = raw == null ? "" : String(raw).trim();
  // 逃生阀：显式空数组 → 旧式固定延迟（MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS，默认 2s、最多 2 次）
  if (s === "[]") {
    const d = Number(process.env.MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS);
    return { max: resolveMax(2), delayMs: Number.isFinite(d) && d >= 0 ? d : 2000, steps: null };
  }
  let steps = DEFAULT_EMPTY_TURN_STEPS;
  if (s !== "") {
    let parsed = null;
    try { parsed = JSON.parse(s); } catch { warnBadSteps(s); }
    if (Array.isArray(parsed) && parsed.length && parsed.every((v) => Number.isFinite(Number(v)) && Number(v) > 0)) {
      steps = parsed.map(Number);
    } else if (parsed !== null) {
      warnBadSteps(s); // 语法过了但形状不对（非数组/空数组元素/含非正数）
    }
  }
  return { max: resolveMax(steps.length), steps };
}

// retryAfterSeconds 来自上游可控文本，不设顶就会被拿捏：`retryAfterSeconds: 3600` → 单档挂 1 小时；
// 且 ms 数超过 setTimeout 上限时 Node 会钳成 1ms 并告警 → 对刚限流的上游连开三枪，正是要防的事。
// 顶只约束「上游能 imposed 多少」；用户自己配的更大阶梯档照办（那是显式意愿），仅保留 setTimeout 硬安全顶。
const SET_TIMEOUT_CEILING_MS = 2_147_483_647;
export function emptyTurnMaxWaitMs() {
  const v = Number(process.env.MSLXDFF_EMPTY_TURN_MAX_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, SET_TIMEOUT_CEILING_MS) : 60_000;
}

// 本次重试实际该等多久：按档取阶梯（超出档数循环复用），再按上游 retryAfterSeconds 抬到不低于该窗口。
// 限流没到点就重拉等于白烧一发（实测 2s 重拉撞 retryAfterSeconds=30 → 连 2/2 全灭，正是本次改动起因）。
export function computeNextDelay(stepIndex, steps, lastErr) {
  const base = Number(process.env.MSLXDFF_EMPTY_TURN_RETRY_DELAY_MS);
  let delayMs = Number.isFinite(base) && base >= 0 ? base : 2000;
  if (Array.isArray(steps) && steps.length && Number.isInteger(stepIndex) && stepIndex >= 0) {
    delayMs = steps[stepIndex % steps.length];
  }
  const after = extractRetryAfterSec(lastErr?.message || "");
  if (after != null) delayMs = Math.max(delayMs, Math.min(after * 1000, emptyTurnMaxWaitMs()));
  return Math.min(Math.round(delayMs), SET_TIMEOUT_CEILING_MS);
}

// 空转重试抬额度：思考型模型常把 max_tokens 全花在 reasoning 上（实测 8192 刷满 → 零正文
// finish_reason=length），同参重拉必然复现 → 重试前把额度翻倍抬到顶，给模型"想完还能说话"的空间。
// 只加不减、有顶；客户端没设额度时由调用方决定是否兜底发明一次（floor 参数，见 emptyTurnMinRaiseTo；floor=0 回旧口径不发明）。
// MSLXDFF_EMPTY_TURN_RAISE_TOKENS=0 关闭抬额；默认顶 16384。
export function emptyRaiseCap() {
  const c = Number(process.env.MSLXDFF_EMPTY_TURN_RAISE_TOKENS);
  return Number.isInteger(c) && c >= 0 ? c : 16384;
}

// 空转重试抬额度（含兜底）：现网三类空轮里最多的是「思考吃满 max_tokens、零正文」
// （events.log：reasoningChars 10290/22652、wroteFrames 1972/2573、finish=length）。客户端设过额度 → 翻倍抬到 cap；
// 客户端根本没设额度 → 同参重拉必然复现，故用 MIN_RAISE_TO 兜底发明一次上限（=0 关，回旧口径「不替它发明」）。
export function emptyTurnMinRaiseTo() {
  const v = Number(process.env.MSLXDFF_EMPTY_TURN_MIN_RAISE_TO);
  if (v === 0 || (Number.isFinite(v) && v < 0)) return 0;
  return Number.isInteger(v) && v > 0 ? v : 16384;
}

export function withRaisedMaxTokens(payload, cap, floor = 0) {
  if (!payload || typeof payload !== "object") return payload;
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    const cur = Number(payload[key]);
    if (Number.isFinite(cur) && cur > 0) {
      if (!cap || cur >= cap) return payload;       // 已到顶：只剩同参重拉（赌偶发空轮）
      return { ...payload, [key]: Math.min(cap, cur * 2) };
    }
  }
  if (floor) return { ...payload, max_tokens: Math.min(floor, cap || floor) }; // 客户端没设额度：兜底发明一次
  return payload;
}
// 空转追问：最后一次空转重试前追加一句 user 兜底（content 空轮大概率是模型“收尾犹豫”，
// 追问把它逼出一句“任务完成了”即可终结；前面重试仍原样重拉，防改写正常对话）。
// MSLXDFF_EMPTY_NUDGE=0 关闭；MSLXDFF_EMPTY_NUDGE_TEXT 改话术。
export function emptyNudgeCfg() {
   const off = process.env.MSLXDFF_EMPTY_NUDGE;
   if (off === "0" || String(off || "").toLowerCase() === "off" || String(off || "").toLowerCase() === "false") return { enabled: false, text: "" };
   const custom = String(process.env.MSLXDFF_EMPTY_NUDGE_TEXT || "").trim();
   return { enabled: true, text: custom || "如果你完成任务了，请简短的说：任务完成了。" };
}
export function withEmptyNudge(payload, text) {
   const t = String(text || "").trim();
   if (!t || !payload || !Array.isArray(payload.messages) || !payload.messages.length) return payload;
   const last = payload.messages[payload.messages.length - 1];
   if (last && last.role === "user" && String(last.content || "").includes(t)) return payload;
   return { ...payload, messages: [...payload.messages, { role: "user", content: t }] };
}

// 请求级空轮等待预算：阶梯是「每发候选」独立算的，多候选串起来最坏 = N×(2+8+30)，
// 客户端只是在等一个永远空白的回复。预算封顶「这一次请求最多白等多久」，超限直接收场。
// MSLXDFF_EMPTY_TURN_BUDGET_MS 覆盖（<=0 或未设 = 默认 45s：够装下一整个阶梯 + 一发换候选）。
export function emptyTurnBudgetMs() {
  const v = Number(process.env.MSLXDFF_EMPTY_TURN_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? v : 45_000;
}
