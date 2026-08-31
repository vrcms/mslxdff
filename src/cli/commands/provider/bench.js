import { probeModels } from "../../../bench/probe.js";
import { runOne } from "../../../bench/runner.js";
import { formatReport } from "../../../bench/report.js";
import { defaultModelsPath, defaultChatPath } from "../../../state/provider-config.js";

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
  console.log(`bench ${providerId}: 共 ${allowed.length} 个已勾选模型，逐个测速（串行，${opts.timeoutMs}ms 超时）...`);
  if (!opts.json) console.log(`prompt="${opts.prompt}" maxTokens=${opts.maxTokens}\n`);
  const chatPath = cfg.chatPath || defaultChatPath(providerId);
  const results = [];
  for (let i = 0; i < allowed.length; i++) {
    const raw = allowed[i];
    const model = String(raw || "").trim();
    if (!opts.json) process.stdout.write(`  [${i + 1}/${allowed.length}] ${model} ... `);
    // 轮询 key/auth：按索引取，超长循环
    const kIdx = i % keys.length;
    const aIdx = Math.min(kIdx, auths.length - 1);
    const key = keys[kIdx];
    const auth = auths[aIdx] || auths[0] || null;
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
