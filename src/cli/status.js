import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPid, readPidVersion, isPidAlive, pidFile } from "../daemon.js";
import { defaultStateFile, getPort, loadGroupsJoined, loadModelErrors, loadModelStats, loadModelPicks } from "../state.js";
import { resolvePort } from "../server.js";
import { loadProviderKeys, loadProviderAuths, loadProviderConfigs, loadProviderAllowedModels, loadProviderShareKeys, loadProviderBaseUrl } from "../state.js";
import { loadToken } from "../state.js";
import { logDir } from "../logs.js";
import { createGroupsService } from "../groups.js";
import { createPeersService } from "../peers.js";
import { refreshGroupMembers } from "../groups.js";
import { fmtShanghaiYMDHM } from "../time.js";
import { fmtStatus, fmtUptime, fmtTs } from "./format.js";
import { compareSemver } from "./policy.js";

export async function printStatus(VERSION) {
  const daemon = readPid();
  const alive = daemon ? isPidAlive(daemon) : false;
  const port = getPort() || resolvePort();
  const persisted = getPort();
  const portSrc = persisted != null ? "persisted" : (process.env.MSLXDFF_PORT ? "env MSLXDFF_PORT" : "default 8989");
  const stateFile = defaultStateFile();
  const dir = logDir();
  let upStr = "";
  if (daemon && alive) {
    try {
      const st = statSync(pidFile());
      const ms = Date.now() - st.mtimeMs;
      upStr = `, up ${fmtUptime(ms)}`;
    } catch {}
  }
  const verNote = daemon && alive ? (() => { const v = readPidVersion(); if (!v) return ""; if (v === VERSION) return "version ok"; const cmp = compareSemver(VERSION, v); if (cmp > 0) return `version ${v} → ${VERSION} (upgrade pending)`; if (cmp < 0) return `version ${v} (newer than local ${VERSION}, keeping)`; return "version ok"; })() : "";
  console.log(`mslxdff v${VERSION}`);
  console.log(`daemon:    ${daemon ? (alive ? `running (pid ${daemon}${upStr})` : `stale pid ${daemon} (not alive)`) : "not running"}${verNote ? `  [${verNote}]` : ""}`);
  let healthLine = "";
  try {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    const ms = Date.now() - t0;
    healthLine = r.ok ? `health ok ${ms}ms` : `health HTTP ${r.status} ${ms}ms`;
  } catch (e) {
    healthLine = daemon && alive ? `health fail (${String(e?.message || e).slice(0, 60)})` : "health — (daemon not running)";
  }
  console.log(`endpoint:  http://localhost:${port}/v1  ·  ${healthLine}`);
  console.log(`config:    port ${port} (${portSrc}) · state ${stateFile} · log ${dir}`);
  try {
    const host = process.env.MSLXDFF_HOST || process.env.MSLXDFF_BIND_HOST || "0.0.0.0";
    if (host !== "0.0.0.0") console.log(`bind:      ${host}`);
  } catch {}

  try {
    const configs = loadProviderConfigs();
    const upstreamBase = process.env.UPSTREAM_BASE_URL || "https://opencode.ai";
    const providerRows = [];
    const opAllowed = loadProviderAllowedModels("opencode");
    providerRows.push({ id: "opencode", enabled: true, baseUrl: upstreamBase, keys: [], allowed: opAllowed, share: false, note: "built-in, no key, cannot share" });
    const genericIds = new Set(Object.keys(configs).filter((id) => id !== "opencode"));
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8"));
      const pk = raw.providerKeys || {};
      for (const id of Object.keys(pk)) if (id !== "opencode") genericIds.add(id);
      const cfgRaw = raw.providerConfigs || {};
      for (const id of Object.keys(cfgRaw)) if (id !== "opencode") genericIds.add(id);
    } catch {}
    for (const k of Object.keys(process.env)) {
      const m = k.match(/^MSLXDFF_(.+)_KEY$/);
      if (m) {
        const id = m[1].toLowerCase().replace(/__/g, "-");
        if (id !== "opencode") genericIds.add(id);
      }
    }
    for (const gid of [...genericIds].sort()) {
      const cfg = configs[gid];
      const keys = loadProviderKeys(gid);
      const baseUrl = loadProviderBaseUrl(gid) || cfg?.baseUrl || (gid === "openrouter" ? "https://openrouter.ai/api/v1" : gid === "workbuddy" ? "https://copilot.tencent.com" : "");
      const share = loadProviderShareKeys(gid);
      const allowed = loadProviderAllowedModels(gid);
      let enabled = Boolean(baseUrl && keys.length) || (gid === "openrouter" && keys.length > 0);
      const auths = gid === "workbuddy" ? (loadProviderAuths(gid) || []) : [];
      let note = "";
      const isWorkbuddyStub = gid === "workbuddy" && (keys.includes("k-new") || baseUrl.includes("127.0.0.1") || (keys.length === 1 && keys[0].length < 20));
      if (isWorkbuddyStub) {
        enabled = false;
        note = "测试桩 (key=k-new, baseUrl=127.0.0.1) — 请重跑 node workbuddy-token-auto.js 写入真实 JWT";
      } else if (!enabled) {
        if (!baseUrl && !keys.length) note = "no baseUrl, no keys";
        else if (!baseUrl) note = "missing baseUrl";
        else if (!keys.length) note = "no keys";
      } else if (gid === "workbuddy" && auths.length && auths.length !== keys.length) {
        note = `${auths.length} auth(s) / ${keys.length} key(s) — 数量不一致请重跑 workbuddy-token-auto.js`;
      }
      providerRows.push({ id: gid, enabled, baseUrl: baseUrl || "(none)", keys, allowed, share, note, authCount: auths.length });
    }
    const enabledCount = providerRows.filter((r) => r.enabled).length;
    console.log(`\nupstream providers (${providerRows.length}, ${enabledCount} enabled)  —  mslxdff -providers list 查看详情`);
    for (const p of providerRows) {
      const dot = p.enabled ? "●" : "○";
      const state = p.enabled ? "enabled " : "disabled";
      let keysInfo;
      if (p.id === "opencode") keysInfo = "无需 key (内置)";
      else keysInfo = p.keys.length ? `${p.keys.length} key${p.keys.length > 1 ? "s" : ""} ${p.keys.map((k) => `${k.slice(0, 3)}…${k.slice(-3)}`).join(", ")}` : "0 keys";
      const authInfo = p.authCount ? ` ${p.authCount} acc` : "";
      const allowInfo = p.allowed.length ? `allow=${p.allowed.length}(${p.allowed.slice(0, 2).join(",")}${p.allowed.length > 2 ? "…" : ""})` : "allow=all";
      const shareInfo = p.id === "opencode" ? "cannot share" : `share=${p.share ? "ON" : "off"}`;
      const note = p.note ? `  (${p.note})` : "";
      console.log(`  ${dot} ${p.id.padEnd(12)} ${state}  ${keysInfo}${authInfo}  ${allowInfo.padEnd(18)}  baseUrl=${p.baseUrl}  ${shareInfo}${note}`);
    }
    if (enabledCount === 1 && providerRows.length === 1) {
      console.log(`  (仅 opencode 内置免费通道；按需加：mslxdff -provider add bai https://api.b.ai/v1 <key>  或  node workbuddy-token-auto.js)`);
    }
  } catch (e) {
    console.log(`\nupstream providers: (unavailable — ${String(e?.message || e).slice(0, 80)})`);
  }

  try {
    const statuses = loadModelErrors();
    const stats = loadModelStats();
    const picks = loadModelPicks();
    const { getPreferredModel: gpm } = await import("../auto.js");
    const preferred = gpm();
    const modelsFile = join(dir, "models.json");
    let freeIds = [];
    let cachedAt = null;
    let cacheErr = null;
    if (existsSync(modelsFile)) {
      try {
        const cached = JSON.parse(readFileSync(modelsFile, "utf8"));
        freeIds = (cached.data || []).map((m) => m.id).filter(Boolean);
        cachedAt = cached.cachedAt || null;
      } catch (err) { cacheErr = String(err?.message || err).slice(0, 60); }
    }
    const ageStr = cachedAt ? (() => { const ms = Date.now() - cachedAt; const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); return h ? `${h}h${m}m ago` : `${m}m ago`; })() : "";
    const cacheLine = freeIds.length ? `${freeIds.length} free${cachedAt ? ` (cached ${fmtShanghaiYMDHM(cachedAt)} · ${ageStr})` : ""}` : (cacheErr ? `cache unreadable (${cacheErr})` : "not cached yet (daemon 拉取后出现)");
    const prefStat = preferred ? (stats[preferred] || stats[`opencode/${preferred}`] || null) : null;
    const prefErr = preferred ? statuses[preferred] : null;
    const prefStatus = prefErr ? (typeof prefErr === "number" ? "error" : (prefErr?.status || "error")) : (prefStat ? "normal" : "");
    const prefLine = preferred ? `${preferred}${prefStatus ? ` [${prefStatus}]` : ""}` : "(none)";
    const picksLine = picks.length ? `${picks.length} (*${picks.slice(0, 4).join(", *")}${picks.length > 4 ? ` …+${picks.length - 4}` : ""})` : "(空=全量 auto)";
    console.log(`\nmodels: ${cacheLine}  —  mslxdff -model status 查看详情`);
    const prefTtfbDisp = prefStat ? (() => { const v = prefStat.avgTtfbMs ?? prefStat.emaTtfbMs; return v != null && v >= 10 ? `首字 ${v}ms` : (v != null && v < 10 ? "首字 — (测试数据)" : ""); })() : "";
    const prefTotDisp = prefStat?.avgTotalMs && prefStat.avgTotalMs >= 10 ? `总 ${prefStat.avgTotalMs}ms` : "";
    const prefTpsDisp = prefStat?.avgTps && prefStat.avgTps >= 1 ? `${prefStat.avgTps} tok/s` : "";
    const prefExtra = prefStat ? `  ${[prefTtfbDisp, prefTotDisp, prefTpsDisp].filter(Boolean).join("  ")}  ${prefStat.count || 0}次` : "";
    console.log(`  preferred: ${prefLine}${prefExtra}`);
    console.log(`  picks: ${picksLine}  ${picks.length ? "auto 仅在勾选内" : "auto 用全量免费池"}`);
    if (freeIds.length) {
      const ids = freeIds;
      console.log(`  free list:`);
      for (const id of ids) {
        const st = fmtStatus(id, statuses);
        const full = id.includes("/") ? id : `opencode/${id}`;
        const ms = stats[full] || stats[id];
        let extra = "";
        if (ms) {
          const v = ms.avgTtfbMs ?? ms.emaTtfbMs;
          const vStr = v != null ? (v >= 10 ? `avg首字 ${v}ms` : (v < 10 ? "avg首字 —" : "")) : "";
          const tpsStr = ms.avgTps && ms.avgTps >= 1 ? ` ${ms.avgTps} tok/s` : "";
          const cntStr = ms.count ? ` ${ms.count}次` : "";
          extra = `  ${vStr}${tpsStr}${cntStr}`;
        }
        console.log(`    ${id}${st ? `  [${st}]` : ""}${extra}`);
      }
    }
    const allStatIds = Object.keys(stats);
    if (allStatIds.length) {
      const sorted = allStatIds.map((full) => ({ full, s: stats[full] })).filter((x) => x.s && x.s.count).sort((a, b) => (b.s.count - a.s.count) || ((b.s.avgTps || 0) - (a.s.avgTps || 0))).slice(0, 7);
      if (sorted.length) {
        console.log(`  模型体检 Top${sorted.length}（样本>0, 按次数）：`);
        console.log(`    ${"模型".padEnd(28)}  ${"首字".padEnd(7)}  ${"总耗时".padEnd(7)}  ${"速度".padEnd(10)}  ${"啰嗦".padEnd(7)}  ${"样本".padEnd(5)}  状态`);
        for (const { full, s } of sorted) {
          const ttfb = s.avgTtfbMs ?? s.emaTtfbMs;
          const total = s.avgTotalMs ?? s.emaTotalMs;
          const tps = s.avgTps ?? s.emaTps;
          const verbose = s.avgCompTok != null ? `${s.avgCompTok}tok` : "—";
          const st = statuses[full] || statuses[full.split("/").slice(1).join("/")] || null;
          const statusStr = st ? (typeof st === "number" ? "error" : (st.status || "normal")) : "normal";
          const p95 = s.p95Ttfb && s.p95Ttfb >= 10 ? ` p95:${s.p95Ttfb}ms` : "";
          const ttfbStr = ttfb != null ? (ttfb >= 10 ? ttfb + "ms" : "—") : "—";
          const totalStr = total != null ? (total >= 10 ? total + "ms" : "—") : "—";
          const tpsStr = tps != null && tps >= 1 ? tps + " tok/s" : "—";
          console.log(`    ${full.padEnd(28)}  ${ttfbStr.padEnd(7)}  ${totalStr.padEnd(7)}  ${tpsStr.padEnd(10)}  ${verbose.padEnd(7)}  ${String(s.count).padEnd(5)}  ${statusStr}${p95}`);
        }
      }
    } else if (!freeIds.length) {
      console.log(`  (暂无模型样本 — 发一次 mslxdff -chat 后出现，100次后均值更稳)`);
    }
  } catch (e) {
    console.log(`\nmodels: (unavailable — ${String(e?.message || e).slice(0, 80)})`);
  }

  try {
    const { getAutostartStatus } = await import("../autostart.js");
    const a = await getAutostartStatus();
    const detail = a.detail || (a.enabled ? "已启用" : "未启用");
    const label = detail.startsWith("已启用") || detail.startsWith("未启用") ? detail : `${a.enabled ? "已启用" : "未启用"} · ${detail}`;
    console.log(`\nautostart: ${label}  —  mslxdff -autostart status`);
    if (a.taskToRun) console.log(`  task: ${a.taskToRun.slice(0, 120)}`);
    if (a.unit) console.log(`  unit: ${a.unit}`);
  } catch {}
  try {
    const { resolvePluginDirs, loadPlugins } = await import("../plugins.js");
    const pkgRoot2 = dirname(fileURLToPath(import.meta.url)) + "/../..";
    const dirs = resolvePluginDirs({ pkgRoot: pkgRoot2 });
    const { plugins, errors } = await loadPlugins({ dirs });
    if (plugins.length || errors.length) {
      console.log(`plugins: ${plugins.length} loaded${errors.length ? `, ${errors.length} error(s)` : ""}  —  mslxdff -plugins`);
      for (const p of plugins) console.log(`  ${p.name}${p.version ? `@${p.version}` : ""}  [${Object.keys(p.hooks || {}).join(", ") || "no hooks"}]`);
      for (const e of errors) console.log(`  ! ${e.file} — ${e.error}`);
    } else {
      console.log(`plugins: (none)  —  放 *.mjs 到 ${dirs[dirs.length - 1] || "~/.config/mslxdff/plugins"} 启用`);
    }
  } catch {}

  const groups = createGroupsService({});
  const joined = loadGroupsJoined();
  if (joined.length) {
    console.log(`\njoined groups (${joined.length}):`);
    const { token } = await loadToken();
    for (const g of joined) {
      const isLeader = !g.leaderUrl;
      console.log(`  ${g.name}  ${isLeader ? "(this node is the leader)" : `leader ${g.leaderUrl}`}`);
      let members = null;
      if (isLeader) {
        members = groups.list()[g.name]?.members ?? {};
      } else {
        const fetchImpl = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(1500) });
        try {
          members = await refreshGroupMembers(g.name, {
            leaderUrl: g.leaderUrl,
            memberName: g.memberName,
            url: g.myUrl,
            token,
            fetchImpl,
          });
        } catch {
          members = null;
        }
      }
      if (members === null) {
        console.log("    members: (unavailable — leader unreachable)");
      } else {
        const ids = Object.keys(members);
        if (!ids.length) {
          console.log("    members: (none yet)");
        } else {
          console.log(`    members (${ids.length}):`);
          for (const id of ids) {
            const m = members[id];
            const tags = [];
            if (id === "leader" && isLeader) tags.push("leader");
            if (m?.url && m.url === g.myUrl) tags.push("this node");
            if (m?.kind === "broadband") tags.push("broadband");
            if (m?.kind === "broadband" && m?.publicIp) tags.push(`ip=${m.publicIp}`);
            if (m?.kind === "broadband" && m?.lastSeen) {
              const ago = Math.round((Date.now() - m.lastSeen) / 1000);
              tags.push(ago < 90 ? `via leader ${ago}s ago` : "stale");
            }
            const tag = tags.length ? `  [${tags.join(", ")}]` : "";
            console.log(`      ${m?.url || id}${tag}`);
          }
        }
      }
    }
  } else {
    console.log("\njoined groups: (none — use -creategroup or -addtogroup)");
  }

  const peers = createPeersService({});
  const allPeers = peers.all();
  if (allPeers.length) {
    console.log(`\nfailover targets (${allPeers.length}):`);
    for (const p of allPeers) {
      const tags = [];
      if (peers.isCooling(p.url)) tags.push("cooling");
      if (peers.isHot(p.url)) tags.push("hot");
      const s = peers.stat(p.url);
      if (s?.latencyMs != null) tags.push(`${s.latencyMs}ms`);
      if (s?.fails) tags.push(`${s.fails} fail(s)`);
      const tag = tags.length ? `  [${tags.join(", ")}]` : "";
      console.log(`  ${p.name || p.url}  ${p.url}${tag}`);
    }
  } else {
    console.log(`\nfailover: (none — 加组后自动出现，mslxdff -group list)`);
  }

  const groupNames = Object.keys(groups.list());
  if (groupNames.length) {
    console.log(`\ngroups on this node (${groupNames.length}):`);
    for (const n of groupNames) console.log(`  ${n}`);
  }

  const { recentCalls, lastError } = await import("../logs.js");
  console.log("\nrecent calls: (gateway 持久化，最近5条，含首字/tok/s)");
  const calls = recentCalls(5);
  if (calls.length) {
    let sumDur = 0, sumTps = 0, tpsN = 0;
    for (const c of calls) {
      if (Number.isFinite(c.durationMs)) sumDur += c.durationMs;
      else if (Number.isFinite(c.totalMs)) sumDur += c.totalMs;
      if (Number.isFinite(c.tps)) { sumTps += c.tps; tpsN++; } else if (Number.isFinite(c.charsPerSec)) { sumTps += c.charsPerSec; tpsN++; }
    }
    const avgDur = calls.length ? Math.round(sumDur / calls.length) : null;
    const avgTps = tpsN ? Math.round(sumTps / tpsN) : null;
    console.log(`  avg ${avgDur ? avgDur + "ms" : "—"}${avgTps ? ` · ${avgTps} tok/s` : ""}  —  mslxdff -log 20 查看详情`);
    for (const c of calls) {
      const dur = c.totalMs ?? c.durationMs;
      const ttfb = c.ttfbMs != null ? ` 首字${c.ttfbMs}ms` : "";
      const tps = c.tps != null ? ` ${c.tps}tok/s` : (c.charsPerSec ? ` ${c.charsPerSec}ch/s` : "");
      const tok = c.usage?.completion_tokens != null ? ` tok${c.usage.completion_tokens}` : (c.chars ? ` ch${c.chars}` : "");
      const tm = fmtTs(c.ts);
      console.log(`  ${tm}  ${(c.model || "-").padEnd(28)}  ${String(c.status || "-").padEnd(4)}  ${dur ? dur + "ms" : ""}${ttfb}${tps}${tok}${c.auto ? "  auto" : ""}`);
    }
  } else {
    console.log("  (none yet — 发一次请求后出现，mslxdff -chat hi)");
  }

  console.log("\nlast error:");
  const err = lastError();
  if (err) {
    console.log(`  ${fmtTs(err.ts)}  ${err.model || "-"}  ${err.status}  ${err.message || ""}`);
    if (err.stack) console.log(`  ${String(err.stack).slice(0, 200)}`);
  } else {
    console.log("  (none — 暂无错误，挺好)");
  }

  const daemon2 = readPid();
  const alive2 = daemon2 ? isPidAlive(daemon2) : false;
  if (daemon2 && alive2) console.log(`\nauth token: use \`mslxdff -showtoken\`  ·  health: http://127.0.0.1:${port}/health`);
  else console.log(`\nnot running — start with: mslxdff -d  ·  查看日志 mslxdff -log 20`);
  console.log(`hints: mslxdff -providers list · mslxdff -model status · mslxdff -group list · mslxdff -autostart status`);
}
