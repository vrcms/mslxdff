// Cline 账号 × 模型额度周期统计。
// 目标：记录“额度恢复后到下一次限流”之间正常响应累计的 output/completion tokens。
// 不记录 token、邮箱、prompt、响应正文；账号只使用调用方传入的稳定哈希。
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { logDir } from "../../logs.js";
import { appendEvent } from "../../logs.js";

const FILE = "cline-usage.jsonl";
const states = new Map();
let loaded;

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


export async function recordOutput({ accountId, model, tokens, estimated = false } = {}) {
  const n = Number(tokens);
  if (!model || !Number.isFinite(n) || n <= 0) return null;
  await ensureLoaded();
  const now = Date.now();
  const s = stateFor(accountId, model, now);
  s.currentOutputTokens += n;
  const row = {
    type: "output", at: now, accountId: accountId || "unknown", model,
    outputTokens: n, estimated: !!estimated, cycleOutputTokens: s.currentOutputTokens,
    cycleStartAt: s.cycleStartAt, cycleCount: s.completedCycles + 1,
  };
  await append(row);
  event(row);
  return row;
}

export async function recordLimit({ accountId, model, reason = "daily_limit", status = 429, cooldownMs = 0 } = {}) {
  if (!model) return null;
  await ensureLoaded();
  const now = Date.now();
  const s = stateFor(accountId, model, now);
  if (s.limitedUntil && s.limitedUntil > now) return null;
  const row = {
    type: "limit", at: now, accountId: accountId || "unknown", model,
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
