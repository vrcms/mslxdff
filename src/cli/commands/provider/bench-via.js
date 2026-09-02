import { defaultChatPath } from "../../../state/provider-config.js";
import { isRefreshToken, clineHeaders } from "../../../providers/cline/headers.js";
import { refreshTokenForBase } from "../../../providers/cline/auth.js";
import { runOne } from "../../../bench/runner.js";
import { formatViaReport } from "../../../bench/report.js";
import { clineBenchOne } from "../../../bench/cline-bench.js";

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

export async function handleVia({ providerId, opts, fetchImpl, loadConfigs, loadKeys, loadAllowed, loadBaseUrl }) {
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
    if (!allowed.length) { viaLog(`provider ${pid}: 无勾选模型，跳过`); continue; }
    if (!baseUrl && pid !== "opencode") { viaLog(`provider ${pid}: missing baseUrl 跳过`); continue; }
    if (!keys.length && pid !== "opencode") { viaLog(`provider ${pid}: 未配置 Key 跳过`); continue; }
    const chatPath = cfg.chatPath || defaultChatPath(pid);
    let auths = [];
    try { const m = await import("../../../state.js"); auths = m.loadProviderAuths ? m.loadProviderAuths(pid) : []; } catch {}
    const models = allowed.map((id) => ({ provider: pid, model: String(id), id: String(id) }));
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
    const viaProbeFn = async (args) => {
      const { peerUrl, providerId, model } = args;
      const p = providerId || pid;
      const idx = models.findIndex((x) => x.model === model);
      const kIdx = idx >= 0 ? idx % (keys.length || 1) : 0;
      const aIdx = Math.min(kIdx, Math.max(auths.length - 1, 0));
      const key = keys[kIdx] || keys[0] || "";
      const auth = auths[aIdx] || auths[0] || null;
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
  if (opts.json) console.log(report.text);
  else console.log("\n" + report.text);
  process.exit(0);
}
