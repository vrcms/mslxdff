import { probeModels } from "../../../bench/probe.js";
import { runOne } from "../../../bench/runner.js";
import { formatReport } from "../../../bench/report.js";
import { defaultModelsPath, defaultChatPath } from "../../../state/provider-config.js";
import { isRefreshToken, clineHeaders } from "../../../providers/cline/headers.js";
import { refreshTokenForBase } from "../../../providers/cline/auth.js";
import { computeMetrics } from "../../../metrics.js";

// Cline 免费通道（deepseek/z-ai 等）非流式会被上游限流 500 empty response content，
// 必须 stream:true + SSE 聚合后测速
async function clineBenchOne({ baseUrl, model, accessToken, prompt, maxTokens, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  const t0 = performance.now();
  let ttfbMs = null;
  let content = "";
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: { ...clineHeaders(`sess_bench_${Date.now()}`, accessToken), Accept: "text/event-stream" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true, max_tokens: maxTokens, session_id: `sess_bench_${Date.now()}`, reasoning_effort: "high" }),
      signal: controller.signal,
    });
    if (res instanceof Error) throw res;
    if (!res.ok) {
      let txt = "";
      try { txt = await res.text(); } catch {}
      const low = txt.toLowerCase();
      const label = res.status === 401 ? "鉴权失败" : res.status === 429 ? "限流" : res.status >= 500 ? `上游错误 ${res.status}` : `HTTP ${res.status}`;
      return { id: model, ok: false, status: res.status, label, error: txt.slice(0, 300), ttfbMs, totalMs: Math.round(performance.now() - t0), tps: null, charsPerSec: null, tokens: null };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const firstChunkAt = performance.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfbMs === null) ttfbMs = Math.round(performance.now() - firstChunkAt);
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const c = j?.choices?.[0]?.delta?.content || j?.choices?.[0]?.message?.content || "";
          if (typeof c === "string") content += c;
        } catch {}
      }
    }
    const totalMs = Math.round(performance.now() - t0);
    const chars = content.length;
    const { tps, charsPerSec } = computeMetrics({ ttfbMs, totalMs, promptTokens: null, completionTokens: null, chars });
    return { id: model, ok: true, status: 200, label: "成功", ttfbMs, totalMs, tps, charsPerSec, tokens: null, chars };
  } catch (e) {
    const msg = e?.message || String(e);
    return { id: model, ok: false, label: /timeout|abort/i.test(msg) ? "超时" : "网络错误", error: msg.slice(0, 300), ttfbMs, totalMs: Math.round(performance.now() - t0), tps: null, charsPerSec: null, tokens: null };
  } finally {
    clearTimeout(timer);
  }
}

function parseBenchArgs(rest) {
  const opts = { json: false, prompt: "hi", maxTokens: 32, timeoutMs: 30000 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json" || a === "-json") opts.json = true;
    else if (a === "--prompt" && rest[i + 1]) opts.prompt = rest[++i];
    else if (a.startsWith("--prompt=")) opts.prompt = a.slice(9);
    else if (a === "--max-tokens" && rest[i + 1]) opts.maxTokens = Number(rest[++i]) || 32;
    else if (a.startsWith("--max-tokens=")) opts.maxTokens = Number(a.split("=")[1]) || 32;
    else if (a === "--timeout" && rest[i + 1]) opts.timeoutMs = Number(rest[++i]) || 30000;
    else if (a.startsWith("--timeout=")) opts.timeoutMs = Number(a.split("=")[1]) || 30000;
  }
  return opts;
}

function buildHeadersForProvider(providerId, apiKey, auth) {
  const h = {};
  if (String(providerId).toLowerCase() === "workbuddy") {
    h["Content-Type"] = "application/json";
    h["Accept"] = "text/event-stream";
    h["User-Agent"] = "CLI/2.115.0 WorkBuddy/2.115.0";
    h["Origin"] = "https://www.codebuddy.cn";
    h["Referer"] = "https://www.codebuddy.cn/";
    h["X-Product"] = "SaaS";
    if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
    if (auth?.uid) h["X-User-Id"] = auth.uid;
    h["X-Domain"] = auth?.domain || "www.codebuddy.cn";
    if (auth?.enterpriseId) {
      h["X-Enterprise-Id"] = auth.enterpriseId;
      h["X-Tenant-Id"] = auth.enterpriseId;
    }
    return h;
  }
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

export async function handleProviderBench(id, sub, rest, args, deps = {}) {
  const isBench = sub === "bench" || sub === "benchmark" || sub === "eval" || sub === "test";
  if (!isBench) return false;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const loadConfigs = deps.loadProviderConfigs || (await import("../../../state.js")).loadProviderConfigs;
  const loadKeys = deps.loadProviderKeys || (await import("../../../state.js")).loadProviderKeys;
  const loadAllowed = deps.loadProviderAllowedModels || (await import("../../../state.js")).loadProviderAllowedModels;
  const loadAllowAny = deps.loadProviderAllowAnyModels || (await import("../../../state.js")).loadProviderAllowAnyModels;
  const loadBaseUrl = deps.loadProviderBaseUrl || (await import("../../../state.js")).loadProviderBaseUrl;
  const loadAuths = deps.loadProviderAuths || (async () => { try { const m = await import("../../../state.js"); return m.loadProviderAuths ? m.loadProviderAuths(id) : []; } catch { return []; } }) && (await import("../../../state.js")).loadProviderAuths;

  const providerId = String(id || "").trim();
  if (!providerId) {
    console.error("usage: mslxdff -provider <id> bench [--json] [--prompt hi] [--max-tokens 32]");
    process.exit(1);
  }
  const opts = parseBenchArgs(rest || []);
  const configs = loadConfigs();
  const cfg = configs[providerId] || {};
  const keys = loadKeys(providerId) || [];
  const allowed = loadAllowed(providerId) || [];
  const allowAny = loadAllowAny(providerId);
  const baseUrl = (loadBaseUrl(providerId) || cfg.baseUrl || "").trim();
  let auths = [];
  try { const m = await import("../../../state.js"); auths = m.loadProviderAuths ? m.loadProviderAuths(providerId) : []; } catch {}
  if (!baseUrl) {
    console.error(`provider ${providerId}: missing baseUrl — 先设置: mslxdff -provider ${providerId} set-url https://api.example.com/v1`);
    process.exit(1);
  }
  if (!keys.length) {
    console.error(`provider ${providerId}: 未配置 Key — 先设置: mslxdff -provider ${providerId} <key>`);
    process.exit(1);
  }
  // 空勾选 → 不发 chat，仅探活模型列表并提示
  if (!allowed.length) {
    const modelsPath = cfg.modelsPath || defaultModelsPath(providerId);
    console.log(`provider ${providerId}: 未设置 allowlist（allowAny=${allowAny ? "ON" : "OFF"}），不发起测速，仅探活模型列表...`);
    console.log(`尝试：GET ${baseUrl}${modelsPath} → GET ${baseUrl}/v1/models → GET ${baseUrl}/models`);
    const headers = buildHeadersForProvider(providerId, keys[0], auths[0]);
    const probed = await probeModels({ baseUrl, modelsPath, headers, fetchImpl, timeoutMs: 8000 });
    if (!probed.ok) {
      console.error(`探活失败：${probed.error}`);
      console.error(`已尝试：${probed.tried.join(", ")}`);
      console.error(`请手动设置 allowlist：mslxdff -provider ${providerId} allowlist set <model>`);
      if (opts.json) console.log(JSON.stringify({ ok: false, error: probed.error, tried: probed.tried }, null, 2));
      process.exit(1);
    }
    const list = probed.data || [];
    if (!list.length) {
      console.log("探活成功但返回空列表，请确认上游是否暴露 /v1/models");
      if (opts.json) console.log(JSON.stringify({ ok: true, data: [] }, null, 2));
      process.exit(0);
    }
    console.log(`\n发现 ${list.length} 个模型：`);
    for (const m of list.slice(0, 30)) {
      console.log(`  - ${m.id || m.model || m.name || JSON.stringify(m).slice(0, 80)}`);
    }
    if (list.length > 30) console.log(`  ... 还有 ${list.length - 30} 个未展示`);
    console.log(`\n下一步：勾选后再测（只测勾选，避免扣费）`);
    console.log(`  mslxdff -provider ${providerId} allowlist set ${list.slice(0, 2).map((m) => m.id).join(" ")}`);
    console.log(`  mslxdff -provider ${providerId} bench${opts.json ? " --json" : ""}`);
    if (opts.json) console.log(JSON.stringify({ ok: true, data: list, hint: `pick then bench` }, null, 2));
    process.exit(0);
  }

  // 有勾选 → 逐个测
  const log = (s) => (opts.json ? console.error(s) : console.log(s));
  log(`bench ${providerId}: 共 ${allowed.length} 个已勾选模型，逐个测速（串行，${opts.timeoutMs}ms 超时）...`);
  if (!opts.json) console.log(`prompt="${opts.prompt}" maxTokens=${opts.maxTokens}\n`);
  const chatPath = cfg.chatPath || defaultChatPath(providerId);
  // Cline 新链：keys 含 refreshToken 时走 refresh→workos token + 指纹头（绕 403/401），
  // 且 chat 固定拼 https://<host>/api/v1/chat/completions（剥掉 baseUrl 里可能带的 /api/v1）
  const rtKeys = keys.filter((k) => isRefreshToken(k));
  const normBase = String(baseUrl).replace(/\/+$/, "");
  const clineChatBase = normBase.endsWith("/api/v1") ? normBase.slice(0, -7) : normBase;
  const results = [];
  for (let i = 0; i < allowed.length; i++) {
    const raw = allowed[i];
    const model = String(raw || "").trim();
    if (!opts.json) process.stdout.write(`  [${i + 1}/${allowed.length}] ${model} ... `);
    // 轮询 key/auth：按索引取，超长循环
    const kIdx = i % (keys.length || 1);
    const aIdx = Math.min(kIdx, Math.max(auths.length - 1, 0));
    const key = keys[kIdx];
    const auth = auths[aIdx] || auths[0] || null;

    if (rtKeys.length) {
      const rt = rtKeys[kIdx % rtKeys.length];
      const at = await refreshTokenForBase({ refreshToken: rt, baseUrl: normBase, fetchImpl });
      if (!at) {
        const r = { id: model, ok: false, error: "refreshToken 换 accessToken 失败", label: "鉴权失败", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null };
        results.push(r);
        if (!opts.json) console.log(`FAIL ${r.label} (${r.error})`);
        continue;
      }
      const r = await clineBenchOne({ baseUrl: clineChatBase, model, accessToken: at, prompt: opts.prompt, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs, fetchImpl });
      results.push(r);
      if (!opts.json) {
        if (r.ok) console.log(`OK  TTFB ${r.ttfbMs}ms  总 ${r.totalMs}ms  ${r.tps != null ? `${r.tps} t/s` : r.charsPerSec != null ? `${r.charsPerSec} 字/秒` : "—"}`);
        else console.log(`FAIL ${r.label} ${r.error ? `(${r.error.slice(0, 60)})` : ""}`);
      }
      continue;
    }

    const headers = buildHeadersForProvider(providerId, key, auth);
    const r = await runOne({ baseUrl, chatPath, model, providerId, apiKey: key, headers, prompt: opts.prompt, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs, fetchImpl });
    results.push(r);
    if (!opts.json) {
      if (r.ok) console.log(`OK  TTFB ${r.ttfbMs}ms  总 ${r.totalMs}ms  ${r.tps != null ? `${r.tps} t/s` : r.charsPerSec != null ? `${r.charsPerSec} 字/秒` : "—"}`);
      else console.log(`FAIL ${r.label} ${r.error ? `(${r.error.slice(0, 60)})` : ""}`);
    }
  }
  const report = formatReport(results, { json: opts.json });
  console.log("\n" + report.text);
  if (opts.json) {
    // json 已在 text 中输出一次（report.text 是 JSON），无需重复
  }
  const failed = results.filter((r) => !r.ok).length;
  if (failed && !opts.json) {
    console.log(`\n提示：失败 ${failed} 个多为 402余额不足/429限流/超时，可清冷却或换 Key 后重试`);
  }
  process.exit(failed ? 2 : 0);
}
