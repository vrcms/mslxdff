import { probeModels } from "../../../bench/probe.js";
import { runOne } from "../../../bench/runner.js";
import { formatReport, formatViaReport } from "../../../bench/report.js";
import { defaultModelsPath, defaultChatPath } from "../../../state/provider-config.js";
import { isRefreshToken, clineHeaders } from "../../../providers/cline/headers.js";
import { refreshTokenForBase } from "../../../providers/cline/auth.js";
import { computeMetrics } from "../../../metrics.js";

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
  } finally { clearTimeout(timer); }
}

function parseBenchArgs(rest) {
  const opts = { json: false, prompt: "hi", maxTokens: 32, timeoutMs: 30000, via: false, includeOpencode: false, samples: 1 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json" || a === "-json") opts.json = true;
    else if (a === "--via" || a === "--bench-via") opts.via = true;
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
    if (auth?.enterpriseId) { h["X-Enterprise-Id"] = auth.enterpriseId; h["X-Tenant-Id"] = auth.enterpriseId; }
    return h;
  }
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

async function handleVia({ providerId, opts, fetchImpl, loadConfigs, loadKeys, loadAllowed, loadBaseUrl }) {
  const { getOnlinePeers, orchestrateVia, resolveIncludeOpencode } = await import("../../../bench/via.js");
  const peers = await getOnlinePeers();
  if (!peers.length) {
    const msg = "未加入组或无在线 peer，--via 无意义。先 mslxdff -group list / -addtogroup";
    if (opts.json) console.log(JSON.stringify({ meta: { at: new Date().toISOString(), samples: opts.samples, timeout: opts.timeoutMs, includeOpencode: false, peers: [], opencodeSkipped: true }, results: [], advice: msg }, null, 2));
    else console.log(msg);
    process.exit(0);
  }
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let includeOpencode = opts.includeOpencode;
  if (includeOpencode) {
    const confirmFn = async () => {
      const readline = await import("node:readline");
      return new Promise((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question("将消耗 B/C/D 的 opencode 额度，确认测 opencode via？y/N ", (ans) => { rl.close(); res(ans.trim().toLowerCase() === "y"); });
      });
    };
    const log = (s) => (opts.json ? console.error(s) : console.log(s));
    includeOpencode = await resolveIncludeOpencode({ includeOpencode, isTTY, confirmFn, log });
  }
  const { loadToken } = await import("../../../state.js");
  let token = "";
  try { token = (await loadToken()).token || ""; } catch {}
  // target providers
  let targetIds = [];
  const isAll = providerId === "bench" || providerId === "all";
  if (isAll) {
    const configs = loadConfigs();
    const ids = new Set(Object.keys(configs));
    ids.add("opencode"); ids.add("openrouter");
    try { const m = await import("../../../state.js"); const raw = m.loadProviderKeys ? null : null; } catch {}
    // collect from providerKeys via loadKeys probing? simple: iterate ids and keep those with allowed
    for (const pid of [...ids]) {
      const allowed = loadAllowed(pid) || [];
      if (allowed.length) targetIds.push(pid);
      else if (pid === "opencode" && !includeOpencode) continue;
    }
    // also check generic ids from state raw
    try {
      const { readFileSync } = await import("node:fs");
      const { defaultStateFile } = await import("../../../state.js");
      const raw = JSON.parse(readFileSync(defaultStateFile(), "utf8"));
      for (const k of Object.keys(raw.providerConfigs || {})) if (!targetIds.includes(k) && (loadAllowed(k) || []).length) targetIds.push(k);
      for (const k of Object.keys(raw.providerKeys || {})) if (!targetIds.includes(k) && (loadAllowed(k) || []).length) targetIds.push(k);
    } catch {}
    if (!targetIds.length) targetIds = ["openrouter", "workbuddy", "clinebot"].filter((p) => (loadAllowed(p) || []).length);
  } else {
    targetIds = [providerId];
  }
  const allResults = [];
  const viaLog = (s) => (opts.json ? console.error(s) : console.log(s));
  viaLog(`bench-via: direct vs via peers (samples=${opts.samples}, timeout=${opts.timeoutMs}ms, ${includeOpencode ? "opencode=included" : "opencode=skipped"}) peers=${peers.map((p) => p.id).join(",")}`);
  for (const pid of targetIds) {
    const cfg = (loadConfigs()[pid] || {});
    const keys = loadKeys(pid) || [];
    const allowed = loadAllowed(pid) || [];
    const baseUrl = (loadBaseUrl(pid) || cfg.baseUrl || "").trim();
    if (!allowed.length) {
      viaLog(`provider ${pid}: 无勾选模型，跳过`);
      continue;
    }
    if (!baseUrl && pid !== "opencode") { viaLog(`provider ${pid}: missing baseUrl 跳过`); continue; }
    if (!keys.length && pid !== "opencode") { viaLog(`provider ${pid}: 未配置 Key 跳过`); continue; }
    const chatPath = cfg.chatPath || defaultChatPath(pid);
    let auths = [];
    try { const m = await import("../../../state.js"); auths = m.loadProviderAuths ? m.loadProviderAuths(pid) : []; } catch {}
    const models = allowed.map((id) => ({ provider: pid, model: String(id), id: String(id) }));
    // directRunner per provider
    const directRunner = async ({ provider, model }) => {
      const p = provider || pid;
      const idx = models.findIndex((x) => x.model === model);
      const kIdx = idx >= 0 ? idx % (keys.length || 1) : 0;
      const aIdx = Math.min(kIdx, Math.max(auths.length - 1, 0));
      const key = keys[kIdx] || keys[0] || "";
      const auth = auths[aIdx] || auths[0] || null;
      const cKeys = keys.filter((k) => isRefreshToken(k, p));
      if (cKeys.length) {
        const normBase = String(baseUrl).replace(/\/+$/, "");
        const chatBase = normBase.endsWith("/api/v1") ? normBase.slice(0, -7) : normBase;
        const rt = cKeys[kIdx % cKeys.length];
        const at = await refreshTokenForBase({ refreshToken: rt, baseUrl: normBase, fetchImpl });
        if (!at) return { ok: false, label: "鉴权失败", error: "refresh failed", ttfbMs: null, totalMs: 0 };
        return clineBenchOne({ baseUrl: chatBase, model, accessToken: at, prompt: "hi", maxTokens: 5, timeoutMs: opts.timeoutMs, fetchImpl });
      }
      const headers = buildHeadersForProvider(p, key, auth);
      return runOne({ baseUrl: p === "opencode" ? (process.env.UPSTREAM_BASE_URL || "https://opencode.ai") : baseUrl, chatPath, model, providerId: p, apiKey: key || "public", headers, prompt: "hi", maxTokens: 5, timeoutMs: opts.timeoutMs, fetchImpl });
    };
    const { viaProbe } = await import("../../../bench/via-probe.js");
    const { joinUrl: _joinUrl } = await import("../../../providers/base.js");
    const viaProbeFn = async (args) => {
      // 纯中继：A 把 targetUrl+headers+body 发给 B，B 原样 fetch 到上游（不查 B 本地 providerConfigs）
      const { peerUrl, providerId, model } = args;
      const p = providerId || pid;
      const idx = models.findIndex((x) => x.model === model);
      const kIdx = idx >= 0 ? idx % (keys.length || 1) : 0;
      const aIdx = Math.min(kIdx, Math.max(auths.length - 1, 0));
      const key = keys[kIdx] || keys[0] || "";
      const auth = auths[aIdx] || auths[0] || null;
      const cKeys = keys.filter((k) => isRefreshToken(k, p));
      if (cKeys.length) {
        // cline refreshToken 需特殊流，暂走旧的 peer chat（peer 需自有 cline 配置）
        return viaProbe({ ...args, token, fetchImpl });
      }
      const rawModel = String(model).startsWith(`${p}/`) ? String(model).slice(p.length + 1) : String(model);
      const targetUrl = p === "opencode" ? `${process.env.UPSTREAM_BASE_URL || "https://opencode.ai"}/zen/v1/chat/completions` : `${String(baseUrl).replace(/\/+$/, "")}${chatPath}`;
      const headers = buildHeadersForProvider(p, key, auth);
      const body = { model: rawModel, stream: false, messages: [{ role: "user", content: "hi" }], max_tokens: 5 };
      // 用对端 peer.token 做 relay 鉴权（B 只认自己的 Bearer）
      const peer = peers.find((pe) => pe.url === peerUrl || (pe.name || pe.id) === peerUrl);
      const peerToken = peer?.token || token;
      return viaProbe({ peerUrl, token: peerToken, relayTarget: targetUrl, relayHeaders: headers, relayBody: body, timeoutMs: opts.timeoutMs, fetchImpl });
    };
    const part = await orchestrateVia({ models, peers, directRunner, viaProbeFn, includeOpencode, token, timeoutMs: opts.timeoutMs });
    allResults.push(...part);
    if (!opts.json) viaLog(`  ${pid}: ${part.length} 模型完成`);
  }
  const meta = { at: new Date().toISOString(), samples: opts.samples, timeout: opts.timeoutMs, includeOpencode, peers: peers.map((p) => p.id), opencodeSkipped: !includeOpencode };
  const report = formatViaReport(allResults, { peers, meta, json: opts.json });
  if (opts.json) console.log(report.text);
  else console.log("\n" + report.text);
  process.exit(0);
}

export async function handleProviderBench(id, sub, rest, args, deps = {}) {
  const _restArr = rest || [];
  const _hasVia = _restArr.includes("--via") || _restArr.includes("--bench-via");
  const _isBenchViaAll = (String(id) === "bench" || String(id) === "all") && _hasVia;
  const isBench = sub === "bench" || sub === "benchmark" || sub === "eval" || sub === "test" || _isBenchViaAll;
  if (!isBench) return false;
  const opts = parseBenchArgs(_restArr);
  // via branch
  if (opts.via) {
    const loadConfigs = deps.loadProviderConfigs || (await import("../../../state.js")).loadProviderConfigs;
    const loadKeys = deps.loadProviderKeys || (await import("../../../state.js")).loadProviderKeys;
    const loadAllowed = deps.loadProviderAllowedModels || (await import("../../../state.js")).loadProviderAllowedModels;
    const loadBaseUrl = deps.loadProviderBaseUrl || (await import("../../../state.js")).loadProviderBaseUrl;
    const viaPid = _isBenchViaAll ? "bench" : String(id || "").trim();
    if (!viaPid) { console.error("usage: mslxdff -provider <id> bench --via [--json] [--include-opencode]"); process.exit(1); }
    await handleVia({ providerId: viaPid, opts, fetchImpl: deps.fetchImpl || globalThis.fetch, loadConfigs, loadKeys, loadAllowed, loadBaseUrl });
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
  const log = (s) => (opts.json ? console.error(s) : console.log(s));
  log(`bench ${providerId}: 共 ${allowed.length} 个已勾选模型，逐个测速（串行，${opts.timeoutMs}ms 超时）...`);
  if (!opts.json) console.log(`prompt="${opts.prompt}" maxTokens=${opts.maxTokens}\n`);
  const chatPath = cfg.chatPath || defaultChatPath(providerId);
  const rtKeys = keys.filter((k) => isRefreshToken(k, providerId));
  const normBase = String(baseUrl).replace(/\/+$/, "");
  const clineChatBase = normBase.endsWith("/api/v1") ? normBase.slice(0, -7) : normBase;
  const results = [];
  for (let i = 0; i < allowed.length; i++) {
    const raw = allowed[i];
    const model = String(raw || "").trim();
    if (!opts.json) process.stdout.write(`  [${i + 1}/${allowed.length}] ${model} ... `);
    const kIdx = i % (keys.length || 1);
    const aIdx = Math.min(kIdx, Math.max(auths.length - 1, 0));
    const key = keys[kIdx];
    const auth = auths[aIdx] || auths[0] || null;
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
