// Cline 账号 × 模型用量统计（双口径）。
// - free 模型：按「额度周期」统计——限额恢复后开始 → 再次到限额之间累计的 output tokens。
// - pass 模型：按「最近 24h 滚动窗口」统计 output tokens。
// Note: 双口径设计（isFreeModel + aggregateUsage）见 .agents/notes/implemented/feature/2026-09-24-cline-usage-dualwindow.md
// 不记录 token、邮箱、prompt、响应正文；账号只使用调用方传入的稳定哈希。
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { logDir, appendEvent } from "../../logs.js";

const FILE = "cline-usage.jsonl";
const states = new Map();
let loaded;

// free 模型判定：后缀 -free / 含 :free / 已知免费家族；否则视为 pass（付费）
const KNOWN_FREE_MODELS = ["muse-spark", "space-bunny-alpha", "solar-pro4", "laguna-s-2.1"];
export function isFreeModel(id) {
  const s = String(id || "").toLowerCase();
  if (s.startsWith("cline-pass/")) return false;
  if (s.startsWith("cline-free/")) return true;
  if (s.endsWith("-free") || s.includes(":free")) return true;
  if (KNOWN_FREE_MODELS.some((k) => s.includes(k))) return true;
  return false;
}
// pass 模型统计窗口：最近 24 小时
export const FREE_WINDOW = 24 * 3600 * 1000;

function keyOf(accountId, model) {
  return `${String(accountId || "unknown")}|${String(model || "unknown")}`;
}

function newState() {
  return {
    currentOutputTokens: 0,
    cycleStartAt: Date.now(),
    limitedUntil: 0,
    completedCycles: 0,
    lastCycleOutputTokens: 0,
    lastCycleStartAt: null,
    lastCycleEndAt: null,
    lastReason: null,
  };
}

async function ensureLoaded() {
  if (!loaded) {
    loaded = (async () => {
      let text = "";
      try { text = await readFile(join(logDir(), FILE), "utf8"); } catch { return; }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          const k = keyOf(row.accountId, row.model);
          const s = states.get(k) || newState();
          if (row.type === "output") {
            s.currentOutputTokens = Number(row.cycleOutputTokens) || 0;
            s.cycleStartAt = Number(row.cycleStartAt) || Number(row.at) || s.cycleStartAt;
            s.limitedUntil = 0;
          } else if (row.type === "limit") {
            s.completedCycles = Math.max(0, (Number(row.cycleCount) || 1) - 1);
            s.lastCycleOutputTokens = Number(row.cycleOutputTokens) || 0;
            s.lastCycleStartAt = Number(row.cycleStartAt) || null;
            s.lastCycleEndAt = Number(row.at) || null;
            s.lastReason = row.reason || null;
            s.currentOutputTokens = 0;
            s.cycleStartAt = 0;
            s.limitedUntil = Number(row.until) || 0;
          }
          states.set(k, s);
        } catch {}
      }
    })();
  }
  return loaded;
}

export function exactOutputTokens(usage) {
  const n = Number(usage?.completion_tokens ?? usage?.completionTokens ?? usage?.output_tokens ?? usage?.outputTokens);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 上游有时不给 usage（本次真实 Cline 响应就是如此）；按输出正文估算并明确标记 estimated。
function parseOutput(text) {
  const s = String(text || "");
  let parsed = null;
  try { parsed = JSON.parse(s); } catch {}
  if (parsed) {
    const exact = exactOutputTokens(parsed?.usage || parsed);
    if (exact) return { tokens: exact, estimated: false };
    const output = parsed?.choices?.[0]?.message || parsed?.choices?.[0]?.delta || parsed?.output || parsed;
    return { tokens: Math.ceil(JSON.stringify(output || "").length / 4), estimated: true };
  }
  let usage = null;
  let output = "";
  for (const line of s.split("\n")) {
    const t = line.trim();
    // transport 的 stream() 已剥掉 "data:" 前缀；SDK/原生流则带前缀。两种都认。
    const raw = t.startsWith("data:") ? t.slice(5).trim() : t;
    if (!raw || raw === "[DONE]") continue;
    try {
      const j = JSON.parse(raw);
      if (j?.usage) usage = j.usage;
      const piece = j?.choices?.[0]?.delta || j?.choices?.[0]?.message;
      if (piece) output += JSON.stringify(piece);
    } catch {}
  }
  const exact = exactOutputTokens(usage);
  return exact ? { tokens: exact, estimated: false } : { tokens: Math.ceil(output.length / 4), estimated: true };
}

async function append(row) {
  try {
    await mkdir(logDir(), { recursive: true });
    await appendFile(join(logDir(), FILE), JSON.stringify(row) + "\n");
  } catch {}
}

function event(row) {
  try { appendEvent({ ...row, type: "cline-model-usage" }); } catch {}
}

// free 模型才走「限额恢复 → 再次限额」的周期开关；pass 模型不开新周期（其统计由 aggregateUsage 按 24h 窗口切片）。
function stateFor(accountId, model, now) {
  const k = keyOf(accountId, model);
  const s = states.get(k) || newState();
  if (s.limitedUntil && now >= s.limitedUntil) {
    s.limitedUntil = 0;
    s.currentOutputTokens = 0;
    s.cycleStartAt = now;
  }
  states.set(k, s);
  return s;
}

// 在消费终点直接记账（比包装 Response 可靠：streamToNonStream 已解析出 usage/正文，网关透传已有累积 bytes）。
export function usageFromData(data) {
  const exact = exactOutputTokens(data?.usage);
  if (exact) return { tokens: exact, estimated: false };
  const msg = data?.choices?.[0]?.message;
  const text = String(msg?.content || "") + String(msg?.reasoning || "");
  if (!text) return { tokens: 0, estimated: false };
  return { tokens: Math.ceil(text.length / 4), estimated: true };
}


export async function recordOutput({ accountId, model, tokens, outputTokens, estimated = false } = {}) {
  // computeOutputRow 回的是 outputTokens，track/非流式路径传的是 tokens：两边都认，
  // 否则 relay 旁路组合调用静默记不上（2026-09-25 gemini 流式零记账实测）。
  const n = Number(tokens ?? outputTokens);
  if (!model || !Number.isFinite(n) || n <= 0) return null;
  await ensureLoaded();
  const now = Date.now();
  const free = isFreeModel(model);
  const s = stateFor(accountId, model, now);
  s.currentOutputTokens += n;
  const row = {
    type: "output", at: now, accountId: accountId || "unknown", model, modelType: free ? "free" : "pass",
    outputTokens: n, estimated: !!estimated, cycleOutputTokens: s.currentOutputTokens,
    cycleStartAt: s.cycleStartAt, cycleCount: s.completedCycles + 1,
  };
  await append(row);
  event(row);
  return row;
}

// 仅 free 模型会因 daily_limit 被封周期；pass 若收到 limit 也建 limit 行留痕，但不影响其 24h 窗口统计。
export async function recordLimit({ accountId, model, reason = "daily_limit", status = 429, cooldownMs = 0 } = {}) {
  if (!model) return null;
  await ensureLoaded();
  const now = Date.now();
  const s = stateFor(accountId, model, now);
  if (s.limitedUntil && s.limitedUntil > now) return null;
  const row = {
    type: "limit", at: now, accountId: accountId || "unknown", model, modelType: isFreeModel(model) ? "free" : "pass",
    cycleOutputTokens: s.currentOutputTokens, cycleStartAt: s.cycleStartAt,
    cycleEndAt: now, until: now + Math.max(0, Number(cooldownMs) || 0),
    reason, status, cycleCount: s.completedCycles + 1,
  };
  s.completedCycles += 1;
  s.lastCycleOutputTokens = s.currentOutputTokens;
  s.lastCycleStartAt = s.cycleStartAt;
  s.lastCycleEndAt = now;
  s.lastReason = reason;
  s.currentOutputTokens = 0;
  s.cycleStartAt = 0;
  s.limitedUntil = row.until;
  await append(row);
  event({ ...row, state: "limit" });
  return row;
}

/**
 * 纯聚合：把 cline-usage.jsonl 的行数组算成「每账号×模型」的双口径统计。无 IO，可直接单测。
 * - free：currentCycleTokens = 最近一次限额恢复后到此刻的累计；completedCycles = 已封存周期数；
 *          lastCompletedCycleTokens = 上一完整周期产出；totalTokens = 全时段总和。
 * - pass：last24hTokens = 窗口内 (at > now-FREE_WINDOW) 的 output 之和；totalTokens = 全时段总和。
 * @param {Array<{type:string,at:number,accountId:string,model:string,outputTokens:number,cycleOutputTokens?:number,cycleCount?:number,until?:number}>} rows
 * @param {number} [now]
 * @returns {Map<string,{accountId:string,model:string,modelType:"free"|"pass",currentCycleTokens:number,completedCycles:number,lastCompletedCycleTokens:number,last24hTokens:number,totalTokens:number}>}
 */
export function aggregateUsage(rows, now = Date.now()) {
  const out = new Map();
  const windowStart = now - FREE_WINDOW;
  // 先按 key 分组，组内按时间升序处理，保证「周期/窗口」判定稳定。
  const grouped = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.model) continue;
    const k = keyOf(r.accountId, r.model);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(r);
  }
  for (const [k, list] of grouped) {
    list.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    const model = list[0].model;
    const accountId = list[0].accountId || "unknown";
    const free = isFreeModel(model);
    let totalTokens = 0;
    let last24hTokens = 0;
    // free 周期游标
    let cycleTokens = 0;
    let completedCycles = 0;
    let lastCompletedCycleTokens = 0;
    for (const r of list) {
      const at = Number(r.at) || 0;
      const n = Number(r.outputTokens) || 0;
      if (r.type === "output") {
        totalTokens += n;
        if (at > windowStart) last24hTokens += n;
        if (free) cycleTokens += n;
      } else if (r.type === "limit" && free) {
        // 封存当前周期
        completedCycles += 1;
        lastCompletedCycleTokens = cycleTokens;
        cycleTokens = 0;
      }
    }
    out.set(k, {
      accountId, model, modelType: free ? "free" : "pass",
      currentCycleTokens: free ? cycleTokens : 0,
      completedCycles: free ? completedCycles : 0,
      lastCompletedCycleTokens: free ? lastCompletedCycleTokens : 0,
      last24hTokens,
      totalTokens,
    });
  }
  return out;
}

// 读取 JSONL 全量并聚合（供 CLI / 报表消费）。IO 失败返回空 Map，不影响调用方。
export async function loadAndAggregate(now = Date.now()) {
  let text = "";
  try { text = await readFile(join(logDir(), FILE), "utf8"); } catch { return new Map(); }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return aggregateUsage(rows, now);
}
// Note: 流式记账走 computeOutputRow（纯函数）+ recordOutput；reqId 登记表方案已否决（多一跳、无消费方），不保留。

/**
 * 从 relay-done 的流结果算 cline 专属 output tokens（纯函数，无 IO）。
 * usage 有 completion_tokens → 记精确（estimated=false）；否则按 detail.chars 估算（estimated=true）。
 * @param {{model:string, accountId?:string, usage?:object, chars?:number|null}} opts
 * @returns {{accountId:string, model:string, outputTokens:number, estimated:boolean}|null} 零/负 token 返回 null（跳过）
 */
export function computeOutputRow({ model, accountId, usage, chars } = {}) {
  if (!model) return null;
  const exact = exactOutputTokens(usage);
  const n = exact > 0 ? exact : (Number(chars) > 0 ? Math.ceil(Number(chars) / 4) : 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { accountId: accountId || "unknown", model, outputTokens: n, estimated: exact <= 0 };
}
