import { defaultChatPath } from "../../../state/provider-config.js";
import { isRefreshToken, clineHeaders } from "../../../providers/cline/headers.js";
import { refreshTokenForBase } from "../../../providers/cline/auth.js";
import { runOne } from "../../../bench/runner.js";
import { formatViaReport } from "../../../bench/report.js";
import { clineBenchOne } from "../../../bench/cline-bench.js";
import { workbuddyBenchOne } from "../../../bench/workbuddy-bench.js";

export function buildHeadersForProvider(providerId, apiKey, auth) {
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

// bench 取数口径：只测（allowlist ∩ 全局 picks）交集。
// 两套勾选会分叉（allowlist 管上游放行，picks 是用户 curated 集），直接测 allowlist 会打到未勾选模型、漏掉已勾选模型。
// picks 为空时原样通过（兼容纯 allowlist 用户）。
export function filterBenchModels({ providerId, allowed, picks, allowAny = false } = {}) {
  const pid = String(providerId ?? "");
  const isOpen = pid.toLowerCase() === "opencode";
  let list = [...new Set((Array.isArray(allowed) ? allowed : []).map((m) => String(m ?? "").trim()).filter(Boolean))];
  const all = [...new Set((Array.isArray(picks) ? picks : []).map((p) => String(p ?? "").trim()).filter(Boolean))];
  // opencode 默认 allowAny 且 allowlist 常空：候选即裸 picks
  if (!list.length && allowAny && isOpen && all.length) {
    list = [];
    for (const p of all) {
      if (!p.includes("/")) list.push(p);
      else if (p.toLowerCase().startsWith("opencode/")) list.push(p.slice(9));
    }
    list = [...new Set(list.map((m) => m.trim()).filter(Boolean))];
  }
  if (!all.length) return { models: list, skippedUnpicked: 0, pickedBlocked: [] };
  const hit = (m) => all.includes(`${pid}/${m}`) || (isOpen && (all.includes(m) || all.includes(`opencode/${m}`)));
  const models = list.filter(hit);
  const inAllowed = new Set(list);
  const pickedBlocked = all.filter((p) => {
    if (isOpen) return !p.includes("/") && !inAllowed.has(p);
    return p.startsWith(`${pid}/`) && !inAllowed.has(p.slice(pid.length + 1));
  });
  return { models, skippedUnpicked: list.length - models.length, pickedBlocked };
}

export async function handleVia({ providerId, opts, fetchImpl, loadConfigs, loadKeys, loadAllowed, loadBaseUrl, loadAllowAny, loadModelPicks, getOnlinePeersFn }) {
  const { getOnlinePeers, orchestrateVia, resolveIncludeOpencode } = await import("../../../bench/via.js");
  const peers = await (typeof getOnlinePeersFn === "function" ? getOnlinePeersFn() : getOnlinePeers());
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
  const stateMod = await import("../../../state.js");
  const { loadToken } = stateMod;
  let token = "";
  try { token = (await loadToken()).token || ""; } catch {}
  let picks = [];
  try {
    picks = typeof loadModelPicks === "function"
      ? (loadModelPicks() || [])
      : (typeof stateMod.loadModelPicks === "function" ? stateMod.loadModelPicks() || [] : []);
  } catch { picks = []; }
  const allowAnyOf = (pid) => {
    try {
      if (typeof loadAllowAny === "function") return loadAllowAny(pid);
      if (typeof stateMod.loadProviderAllowAnyModels === "function") return stateMod.loadProviderAllowAnyModels(pid);
    } catch {}
    return String(pid || "").toLowerCase() === "opencode";
  };
  let targetIds = [];
  const isAll = providerId === "bench" || providerId === "all";
  if (isAll) {
    const configs = loadConfigs();
    const ids = new Set(Object.keys(configs));
    ids.add("opencode"); ids.add("openrouter");
    for (const pid of [...ids]) {
      const allowed = loadAllowed(pid) || [];
      if (allowed.length) targetIds.push(pid);
    }
    try {
      const { readFileSync } = await import("node:fs");
      const { defaultStateFile } = await import("../../../state.js");
      const raw = JSON.parse(readFileSync(defaultStateFile(), "utf8"));
      for (const k of Object.keys(raw.providerConfigs || {})) if (!targetIds.includes(k) && (loadAllowed(k) || []).length) targetIds.push(k);
      for (const k of Object.keys(raw.providerKeys || {})) if (!targetIds.includes(k) && (loadAllowed(k) || []).length) targetIds.push(k);
    } catch {}
    if (!targetIds.length) targetIds = ["openrouter", "workbuddy", "clinebot"].filter((p) => (loadAllowed(p) || []).length);
    // opencode 默认 allowAny 但 allowlist 常空：有裸 picks 且确认包含 opencode 时纳入
    if (includeOpencode && !targetIds.includes("opencode") && picks.some((p) => !String(p).includes("/") || String(p).toLowerCase().startsWith("opencode/"))) {
      targetIds.push("opencode");
    }
  } else {
    targetIds = [providerId];
  }
  const allResults = [];
  const viaLog = (s) => (opts.json ? console.error(s) : console.log(s));
  viaLog(`bench-via: direct vs via peers (samples=${opts.samples}, timeout=${opts.timeoutMs}ms, ${includeOpencode ? "opencode=included" : "opencode=skipped"}) peers=${peers.map((p) => p.id).join(",")}  模式: 串行(直连→逐 peer)`);
  const delayMs = Number(process.env.MSLXDFF_BENCH_DELAY_MS || 120) || 0;
  for (const pid of targetIds) {
    const cfg = (loadConfigs()[pid] || {});
    const keys = loadKeys(pid) || [];
    const allowed = loadAllowed(pid) || [];
    const baseUrl = (loadBaseUrl(pid) || cfg.baseUrl || "").trim();
    const picked = filterBenchModels({ providerId: pid, allowed, picks, allowAny: allowAnyOf(pid) });
    if (!picked.models.length) {
      if (!allowed.length && !(pid === "opencode" && allowAnyOf(pid))) viaLog(`provider ${pid}: 无勾选模型，跳过`);
      else viaLog(`provider ${pid}: allowlist ${allowed.length} 个模型都不在全局 picks 中，跳过（如需测请 -model pick）`);
      if (picked.pickedBlocked.length) viaLog(`  已勾选但未进 allowlist（先 allowlist set）：${picked.pickedBlocked.join(" ")}`);
      continue;
    }
    if (picked.skippedUnpicked) viaLog(`provider ${pid}: 跳过 ${picked.skippedUnpicked} 个未勾选模型，只测 ${picked.models.length} 个已勾选`);
    if (!baseUrl && pid !== "opencode") { viaLog(`provider ${pid}: missing baseUrl 跳过`); continue; }
    if (!keys.length && pid !== "opencode") { viaLog(`provider ${pid}: 未配置 Key 跳过`); continue; }
    const chatPath = cfg.chatPath || defaultChatPath(pid);
    let auths = [];
    try { const m = await import("../../../state.js"); auths = m.loadProviderAuths ? m.loadProviderAuths(pid) : []; } catch {}
    const models = picked.models.map((id) => ({ provider: pid, model: String(id), id: String(id) }));
    const directRunner = async ({ provider, model }) => {
      const p = provider || pid;
      const idx = models.findIndex((x) => x.model === model);
      const kIdx = idx >= 0 ? idx % (keys.length || 1) : 0;
      const aIdx = Math.min(kIdx, Math.max(auths.length - 1, 0));
      const key = keys[kIdx] || keys[0] || "";
      const auth = auths[aIdx] || auths[0] || null;
      if (String(p).toLowerCase() === "workbuddy") {
        return workbuddyBenchOne({ baseUrl, chatPath, model, apiKey: key, auth, prompt: "hi", maxTokens: 5, timeoutMs: opts.timeoutMs, fetchImpl });
      }
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
    const viaProbeFn = async (args) => {
      const { peerUrl, providerId, model } = args;
      const p = providerId || pid;
      const idx = models.findIndex((x) => x.model === model);
      const kIdx = idx >= 0 ? idx % (keys.length || 1) : 0;
      const aIdx = Math.min(kIdx, Math.max(auths.length - 1, 0));
      const key = keys[kIdx] || keys[0] || "";
      const auth = auths[aIdx] || auths[0] || null;
      // workbuddy 强制 stream:true SSE 中继（与直连一致）
      if (String(p).toLowerCase() === "workbuddy") {
        const rawModel = String(model).startsWith(`${p}/`) ? String(model).slice(p.length + 1) : String(model);
        const targetUrl = `${String(baseUrl).replace(/\/+$/, "")}${chatPath}`;
        const headers = buildHeadersForProvider(p, key, auth);
        const body = { model: rawModel, stream: true, messages: [{ role: "user", content: "hi" }], max_tokens: 5 };
        const peer = peers.find((pe) => pe.url === peerUrl || (pe.name || pe.id) === peerUrl);
        const peerToken = peer?.token || token;
        return viaProbe({ peerUrl, token: peerToken, relayTarget: targetUrl, relayHeaders: headers, relayBody: body, timeoutMs: opts.timeoutMs, fetchImpl });
      }
      const cKeys = keys.filter((k) => isRefreshToken(k, p));
      if (cKeys.length) {
        const normBase = String(baseUrl).replace(/\/+$/, "");
        const chatBase = normBase.endsWith("/api/v1") ? normBase.slice(0, -7) : normBase;
        const rt = cKeys[0];
        const at = await refreshTokenForBase({ refreshToken: rt, baseUrl: normBase, fetchImpl });
        if (!at) return { ok: false, label: "鉴权失败", error: "refresh failed", ttfbMs: null, totalMs: 0 };
        const targetUrl = `${chatBase}/api/v1/chat/completions`;
        const headers = clineHeaders(`sess_bench_via_${Date.now()}`, at);
        const rawModel = String(model).startsWith(`${p}/`) ? String(model).slice(p.length + 1) : String(model);
        const body = { model: rawModel, messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 5, session_id: `sess_bench_via_${Date.now()}`, reasoning_effort: "high" };
        const peer = peers.find((pe) => pe.url === peerUrl || (pe.name || pe.id) === peerUrl);
        const peerToken = peer?.token || token;
        return viaProbe({ peerUrl, token: peerToken, relayTarget: targetUrl, relayHeaders: headers, relayBody: body, timeoutMs: opts.timeoutMs, fetchImpl });
      }
      const rawModel = String(model).startsWith(`${p}/`) ? String(model).slice(p.length + 1) : String(model);
      const targetUrl = p === "opencode" ? `${process.env.UPSTREAM_BASE_URL || "https://opencode.ai"}/zen/v1/chat/completions` : `${String(baseUrl).replace(/\/+$/, "")}${chatPath}`;
      const headers = buildHeadersForProvider(p, key, auth);
      const body = { model: rawModel, stream: false, messages: [{ role: "user", content: "hi" }], max_tokens: 5 };
      const peer = peers.find((pe) => pe.url === peerUrl || (pe.name || pe.id) === peerUrl);
      const peerToken = peer?.token || token;
      return viaProbe({ peerUrl, token: peerToken, relayTarget: targetUrl, relayHeaders: headers, relayBody: body, timeoutMs: opts.timeoutMs, fetchImpl });
    };
    if (!opts.json) viaLog(`\n[${pid}] 共 ${models.length} 个模型，串行测试中...`);
    else viaLog(`[${pid}] ${models.length} models sequential`);
    const onProgress = async ({ phase, provider, model, seq, total, peerId, result }) => {
      const short = String(model).length > 28 ? String(model).slice(0, 28) : String(model);
      const ms = result?.ttfbMs != null ? `${result.ttfbMs}ms` : result?.totalMs != null ? `${result.totalMs}ms` : "—";
      const okTag = result?.ok ? "成功" : (result?.label || "失败");
      const extra = result?.ok ? "" : result?.error ? ` (${String(result.error).slice(0, 40)})` : "";
      if (phase === "direct") viaLog(`  [${seq}/${total}] ${provider}/${short}  直连 ${ms} ${okTag}${extra} 完成`);
      else viaLog(`    ↳ via ${peerId}  ${ms} ${okTag}${extra}`);
    };
    const { orchestrateVia } = await import("../../../bench/via.js");
    const part = await orchestrateVia({ models, peers, directRunner, viaProbeFn, includeOpencode, token, timeoutMs: opts.timeoutMs, onProgress, delayMs });
    allResults.push(...part);
    if (!opts.json) viaLog(`  ${pid}: ${part.length} 模型完成 ✓`);
  }
  const meta = { at: new Date().toISOString(), samples: opts.samples, timeout: opts.timeoutMs, includeOpencode, peers: peers.map((p) => p.id), opencodeSkipped: !includeOpencode };
  const report = formatViaReport(allResults, { peers, meta, json: opts.json });
  if (opts.apply) {
    const { saveViaRoutes } = await import("../../../bench/via-routes.js");
    const saved = saveViaRoutes(allResults, { meta });
    const viaLog2 = (s) => (opts.json ? console.error(s) : console.log(s));
    viaLog2(`\nvia-routes 已落盘: ${saved.at} 共 ${Object.keys(saved.routes).length} 条 → ${saved.routes[Object.keys(saved.routes)[0]] ? "" : ""}${(await import("../../../bench/via-routes.js")).defaultViaRoutesFile()}`);
    for (const [m, e] of Object.entries(saved.routes)) {
      if (allResults.some((r) => r.model === m)) viaLog2(`  ${m} → ${e.best}${e.deltaMs ? ` (${e.deltaMs}ms)` : ""}`);
    }
  }
  if (opts.json) console.log(report.text);
  else console.log("\n" + report.text);
  process.exit(0);
}
