import { probeModels } from "../../../bench/probe.js";
import { runOne } from "../../../bench/runner.js";
import { formatReport } from "../../../bench/report.js";
import { defaultModelsPath, defaultChatPath } from "../../../state/provider-config.js";
import { isRefreshToken } from "../../../providers/cline/headers.js";
import { refreshTokenForBase } from "../../../providers/cline/auth.js";
import { clineBenchOne } from "../../../bench/cline-bench.js";
import { workbuddyBenchOne } from "../../../bench/workbuddy-bench.js";
import { buildHeadersForProvider, filterBenchModels, handleVia } from "./bench-via.js";

function parseBenchArgs(rest) {
  const opts = { json: false, prompt: "hi", maxTokens: 32, timeoutMs: 30000, via: false, includeOpencode: false, samples: 1, apply: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json" || a === "-json") opts.json = true;
    else if (a === "--via" || a === "--bench-via") opts.via = true;
    else if (a === "--apply" || a === "--write" || a === "--save") opts.apply = true;
    else if (a === "--include-opencode") opts.includeOpencode = true;
    else if (a === "--samples" && rest[i + 1]) opts.samples = Number(rest[++i]) || 1;
    else if (a.startsWith("--samples=")) opts.samples = Number(a.split("=")[1]) || 1;
    else if (a === "--prompt" && rest[i + 1]) opts.prompt = rest[++i];
    else if (a.startsWith("--prompt=")) opts.prompt = a.slice(9);
    else if (a === "--max-tokens" && rest[i + 1]) opts.maxTokens = Number(rest[++i]) || 32;
    else if (a.startsWith("--max-tokens=")) opts.maxTokens = Number(a.split("=")[1]) || 32;
    else if (a === "--timeout" && rest[i + 1]) opts.timeoutMs = Number(rest[++i]) || 30000;
    else if (a.startsWith("--timeout=")) opts.timeoutMs = Number(a.split("=")[1]) || 30000;
  }
  return opts;
}

export async function handleProviderBench(id, sub, rest, args, deps = {}) {
  const _restArr = rest || [];
  const _hasVia = _restArr.includes("--via") || _restArr.includes("--bench-via");
  const _isBenchViaAll = (String(id) === "bench" || String(id) === "all") && _hasVia;
  const isBench = sub === "bench" || sub === "benchmark" || sub === "eval" || sub === "test" || _isBenchViaAll;
  if (!isBench) return false;
  const opts = parseBenchArgs(_restArr);
  if (opts.via) {
    const stateMod = await import("../../../state.js");
    const loadConfigs = deps.loadProviderConfigs || stateMod.loadProviderConfigs;
    const loadKeys = deps.loadProviderKeys || stateMod.loadProviderKeys;
    const loadAllowed = deps.loadProviderAllowedModels || stateMod.loadProviderAllowedModels;
    const loadBaseUrl = deps.loadProviderBaseUrl || stateMod.loadProviderBaseUrl;
    const viaPid = _isBenchViaAll ? "bench" : String(id || "").trim();
    if (!viaPid) { console.error("usage: mslxdff -provider <id> bench --via [--json] [--include-opencode]"); process.exit(1); }
    await handleVia({ providerId: viaPid, opts, fetchImpl: deps.fetchImpl || globalThis.fetch, loadConfigs, loadKeys, loadAllowed, loadBaseUrl, loadAllowAny: deps.loadProviderAllowAnyModels || stateMod.loadProviderAllowAnyModels, loadModelPicks: deps.loadModelPicks, getOnlinePeersFn: deps.getOnlinePeers });
    return true;
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const loadConfigs = deps.loadProviderConfigs || (await import("../../../state.js")).loadProviderConfigs;
  const loadKeys = deps.loadProviderKeys || (await import("../../../state.js")).loadProviderKeys;
  const loadAllowed = deps.loadProviderAllowedModels || (await import("../../../state.js")).loadProviderAllowedModels;
  const loadAllowAny = deps.loadProviderAllowAnyModels || (await import("../../../state.js")).loadProviderAllowAnyModels;
  const loadBaseUrl = deps.loadProviderBaseUrl || (await import("../../../state.js")).loadProviderBaseUrl;
  const providerId = String(id || "").trim();
  if (!providerId) { console.error("usage: mslxdff -provider <id> bench [--json] [--prompt hi] [--max-tokens 32]"); process.exit(1); }
  const configs = loadConfigs();
  const cfg = configs[providerId] || {};
  const keys = loadKeys(providerId) || [];
  const allowed = loadAllowed(providerId) || [];
  const allowAny = loadAllowAny(providerId);
  let picks = [];
  try {
    const m = await import("../../../state.js");
    picks = typeof deps.loadModelPicks === "function" ? (deps.loadModelPicks() || []) : (typeof m.loadModelPicks === "function" ? m.loadModelPicks() || [] : []);
  } catch { picks = []; }
  const picked = filterBenchModels({ providerId, allowed, picks, allowAny });
  const baseUrl = (loadBaseUrl(providerId) || cfg.baseUrl || "").trim();
  let auths = [];
  try { const m = await import("../../../state.js"); auths = m.loadProviderAuths ? m.loadProviderAuths(providerId) : []; } catch {}
  if (!baseUrl) { console.error(`provider ${providerId}: missing baseUrl — 先设置: mslxdff -provider ${providerId} set-url https://api.example.com/v1`); process.exit(1); }
  if (!keys.length) { console.error(`provider ${providerId}: 未配置 Key — 先设置: mslxdff -provider ${providerId} <key>`); process.exit(1); }
  if (!allowed.length) {
    const modelsPath = cfg.modelsPath || defaultModelsPath(providerId);
    console.log(`provider ${providerId}: 未设置 allowlist（allowAny=${allowAny ? "ON" : "OFF"}），不发起测速，仅探活模型列表...`);
    console.log(`尝试：GET ${baseUrl}${modelsPath} → GET ${baseUrl}/v1/models → GET ${baseUrl}/models`);
    const headers = buildHeadersForProvider(providerId, keys[0], auths[0]);
    const probed = await probeModels({ baseUrl, modelsPath, headers, fetchImpl, timeoutMs: 8000 });
    if (!probed.ok) { console.error(`探活失败：${probed.error}`); console.error(`已尝试：${probed.tried.join(", ")}`); console.error(`请手动设置 allowlist：mslxdff -provider ${providerId} allowlist set <model>`); if (opts.json) console.log(JSON.stringify({ ok: false, error: probed.error, tried: probed.tried }, null, 2)); process.exit(1); }
    const list = probed.data || [];
    if (!list.length) { console.log("探活成功但返回空列表，请确认上游是否暴露 /v1/models"); if (opts.json) console.log(JSON.stringify({ ok: true, data: [] }, null, 2)); process.exit(0); }
    console.log(`\n发现 ${list.length} 个模型：`);
    for (const m of list.slice(0, 30)) console.log(`  - ${m.id || m.model || m.name || JSON.stringify(m).slice(0, 80)}`);
    if (list.length > 30) console.log(`  ... 还有 ${list.length - 30} 个未展示`);
    console.log(`\n下一步：勾选后再测（只测勾选，避免扣费）`);
    console.log(`  mslxdff -provider ${providerId} allowlist set ${list.slice(0, 2).map((m) => m.id).join(" ")}`);
    console.log(`  mslxdff -provider ${providerId} bench${opts.json ? " --json" : ""}`);
    if (opts.json) console.log(JSON.stringify({ ok: true, data: list, hint: `pick then bench` }, null, 2));
    process.exit(0);
  }
  if (picks.length && !picked.models.length) {
    console.log(`provider ${providerId}: allowlist ${allowed.length} 个模型都不在全局 picks 中，不测速（只测勾选）。`);
    if (picked.pickedBlocked.length) console.log(`已勾选但未进 allowlist：${picked.pickedBlocked.join(" ")} → mslxdff -provider ${providerId} allowlist set <model>`);
    else console.log(`先勾选：mslxdff -model pick ${providerId}/<model>`);
    process.exit(0);
  }
  const log = (s) => (opts.json ? console.error(s) : console.log(s));
  log(`bench ${providerId}: 共 ${picked.models.length} 个已勾选模型，逐个测速（串行，${opts.timeoutMs}ms 超时）...`);
  if (picked.skippedUnpicked) log(`跳过 ${picked.skippedUnpicked} 个未勾选模型`);
  if (!opts.json) console.log(`prompt="${opts.prompt}" maxTokens=${opts.maxTokens}\n`);
  const chatPath = cfg.chatPath || defaultChatPath(providerId);
  const rtKeys = keys.filter((k) => isRefreshToken(k, providerId));
  const normBase = String(baseUrl).replace(/\/+$/, "");
  const clineChatBase = normBase.endsWith("/api/v1") ? normBase.slice(0, -7) : normBase;
  const results = [];
  const benchModels = picked.models;
  for (let i = 0; i < benchModels.length; i++) {
    const raw = benchModels[i];
    const model = String(raw || "").trim();
    if (!opts.json) process.stdout.write(`  [${i + 1}/${benchModels.length}] ${model} ... `);
    const kIdx = i % (keys.length || 1);
    const aIdx = Math.min(kIdx, Math.max(auths.length - 1, 0));
    const key = keys[kIdx];
    const auth = auths[aIdx] || auths[0] || null;
    if (String(providerId).toLowerCase() === "workbuddy") {
      const r = await workbuddyBenchOne({ baseUrl, chatPath, model, apiKey: key, auth, prompt: opts.prompt, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs, fetchImpl });
      results.push(r);
      if (!opts.json) { if (r.ok) console.log(`OK  TTFB ${r.ttfbMs}ms  总 ${r.totalMs}ms  ${r.tps != null ? `${r.tps} t/s` : r.charsPerSec != null ? `${r.charsPerSec} 字/秒` : "—"}`); else console.log(`FAIL ${r.label} ${r.error ? `(${r.error.slice(0, 60)})` : ""}`); }
      continue;
    }
    if (rtKeys.length) {
      const rt = rtKeys[kIdx % rtKeys.length];
      const at = await refreshTokenForBase({ refreshToken: rt, baseUrl: normBase, fetchImpl });
      if (!at) { const r = { id: model, ok: false, error: "refreshToken 换 accessToken 失败", label: "鉴权失败", ttfbMs: null, totalMs: 0, tps: null, charsPerSec: null, tokens: null }; results.push(r); if (!opts.json) console.log(`FAIL ${r.label} (${r.error})`); continue; }
      const r = await clineBenchOne({ baseUrl: clineChatBase, model, accessToken: at, prompt: opts.prompt, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs, fetchImpl });
      results.push(r);
      if (!opts.json) { if (r.ok) console.log(`OK  TTFB ${r.ttfbMs}ms  总 ${r.totalMs}ms  ${r.tps != null ? `${r.tps} t/s` : r.charsPerSec != null ? `${r.charsPerSec} 字/秒` : "—"}`); else console.log(`FAIL ${r.label} ${r.error ? `(${r.error.slice(0, 60)})` : ""}`); }
      continue;
    }
    const headers = buildHeadersForProvider(providerId, key, auth);
    const r = await runOne({ baseUrl, chatPath, model, providerId, apiKey: key, headers, prompt: opts.prompt, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs, fetchImpl });
    results.push(r);
    if (!opts.json) { if (r.ok) console.log(`OK  TTFB ${r.ttfbMs}ms  总 ${r.totalMs}ms  ${r.tps != null ? `${r.tps} t/s` : r.charsPerSec != null ? `${r.charsPerSec} 字/秒` : "—"}`); else console.log(`FAIL ${r.label} ${r.error ? `(${r.error.slice(0, 60)})` : ""}`); }
  }
  const report = formatReport(results, { json: opts.json });
  console.log("\n" + report.text);
  const failed = results.filter((r) => !r.ok).length;
  if (failed && !opts.json) console.log(`\n提示：失败 ${failed} 个多为 402余额不足/429限流/超时，可清冷却或换 Key 后重试`);
  process.exit(failed ? 2 : 0);
}
