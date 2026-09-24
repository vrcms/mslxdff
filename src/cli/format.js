import { fmtShanghai, fmtShanghaiHMS } from "../time.js";

export function fmtStatus(id, statuses) {
  const e = statuses[id];
  if (typeof e === "number") return `error ${fmtTs(e)}`;
  if (!e?.status || e.status === "normal") return "";
  const when = e.at ? ` ${fmtTs(e.at)}` : "";
  const code = e.code ? ` HTTP ${e.code}` : "";
  return `${e.status}${when}${code}`;
}

export function fmtDur(ms) {
  if (!Number.isFinite(ms)) return "?";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return `${d}d${h % 24}h`;
  if (h) return `${h}h${m % 60}m`;
  return `${m}m${s % 60}s`;
}

export function fmtEvent(e) {
  const t = e?.ts ? fmtShanghaiHMS(e.ts) : "--:--:--";
  const head = `[${t}]`;
  const m = (x) => x || "-";
  const fallbackTag = e.fallback?.fallback ? ` fallback=${e.fallback.requested_model || e.requested}->${e.fallback.actual_model || e.actual}(${e.fallback.reason || e.reason})` : "";
  switch (e?.type) {
    case "request":
      return `${head} request       client-> ${m(e.requested || e.model)}${e.auto ? " (auto)" : ""} raw=${m(e.rawModel)} lock=${m(e.lockModel)} hops=${e.hops} from ${e.ip || "?"}${e.stream ? " stream" : ""}${e.prompt ? ` content="${e.prompt}"` : ""} reqId=${e.reqId || ""}`;
    case "client-request":
      return `${head} client req    客户端请求 model=${m(e.requested)} raw=${m(e.rawModel)} lock=${m(e.lockModel)} ip=${e.ip || "?"}${e.stream ? " stream" : ""}`;
    case "ordered":
      return `${head} ordered       尝试顺序 [${(e.order||[]).join(" -> ")}] canFallback=${e.canFallback} useAuto=${e.useAuto}`;
    case "model-try":
      return `${head} model-try     尝试本地 model=${m(e.model)} idx=${e.idx} reqId=${e.reqId || ""}`;
    case "upstream-try":
      return `${head} upstream try  上游请求 model=${m(e.model)} attempt=${e.attempt || 1}`;
    case "upstream-done":
      return `${head} upstream ok   ${m(e.model)} HTTP ${e.status}${e.timing ? ` total=${e.timing.totalMs}ms` : ""}`;
    case "upstream-error":
      return `${head} upstream err  ${m(e.model)} ${e.status ? `HTTP ${e.status}` : "network"}: ${m(e.message)}`;
    case "upstream-preheat":
      if (e.skipped) return `${head} preheat       跳过 (MSLXDFF_PREHEAT disabled)`;
      return `${head} preheat       预热 opencode models ${e.ok ? "ok" : "fail"} ${e.status ? `HTTP ${e.status}` : e.error || ""} ${e.ms ? `${e.ms}ms` : ""}`;
    case "peer-race-start":
      return `${head} peer race     开始并发给组员 model=${m(e.model)} peers=${e.peers}`;
    case "peer-health":
      return `${head} peer check    ${e.peer} -> ${e.count ? e.healthy.join(", ") : "no healthy models"}${e.strict ? " (strict)" : ""}`;
    case "peer-request":
      return `${head} peer req      并发发出 peer=${e.peer} model=${m(e.model)} hops=${e.hops}`;
    case "peer-forward":
      return `${head} peer resp     收到响应 peer=${e.peer} model=${m(e.model)} ${e.ok ? "ok" : "fail"} ${e.latencyMs ? `${e.latencyMs}ms` : ""} hops=${e.hops}${e.retry ? " (retry)" : ""}`;
    case "peer-error":
      return `${head} peer err      ${e.peer} ${e.status ? `HTTP ${e.status}` : "network"}: ${m(e.message)} model=${m(e.model)}`;
    case "peer-race-win":
      return `${head} peer win      选中 peer=${e.winPeer} model=${m(e.winTarget)} latency=${e.latencyMs}ms`;
    case "peer-race-lose":
      return `${head} peer lose     组员全部失败 model=${m(e.model)}`;
    case "fallback":
      return `${head} fallback      ${m(e.from)} -> ${m(e.to)} reason=${m(e.reason)}`;
    case "fallback-notice":
      return `${head} fallback!     客户端请求 ${m(e.requested)} 实际返回 ${m(e.actual)} 原因=${m(e.reason)} via=${m(e.via)} notice=${m(e.notice)}`;
    case "relay-try":
      return `${head} relay try     给宽带中继请求 target=${e.target} model=${m(e.model)} via=${e.via}`;
    case "relay-fail":
      return `${head} relay fail    ${e.target} ${e.status ? `HTTP ${e.status}` : ""} ${m(e.message)}`;
    case "relay-ip-change":
      return `${head} relay ip      ${e.member || e.id || "?"} ${e.oldIp || "?"} -> ${e.newIp || e.publicIp || "?"} via leader`;
    case "relay-forward":
      return `${head} relay fwd     ${e.target || e.peer || "?"} via leader model=${m(e.model)} hops=${e.hops || 0}`;
    case "relay-heartbeat":
      return `${head} relay hb      ${e.member || "?"} ip=${e.ip || "?"} lastSeen=${e.lastSeen ? fmtShanghaiHMS(e.lastSeen) : "?"}`;
    case "client-abort":
      return `${head} client abort  ${m(e.model)} total=${fmtDur(e.totalMs)}`;
    case "result":
      return `${head} result        返回客户端 status=${e.status} model=${m(e.model)} via=${e.via} 响应耗时 ${fmtDur(e.durationMs)}${fallbackTag}`;
    case "client-response":
      return `${head} client res    返回客户端 客户端请求 ${m(e.requested)} 实际返回 ${m(e.actual)} via=${m(e.via)}${e.fallback?.fallback ? ` fallback=${e.fallback.requested_model}->${e.fallback.actual_model}(${e.fallback.reason})` : " 无fallback"} status=${e.status}`;
    case "auto-update-enabled":
      return `${head} auto-update   enabled every ${Math.round((e.intervalMs||0)/60000)}m current=${e.current}`;
    case "auto-update-disabled":
      return `${head} auto-update   disabled current=${e.current}`;
    case "auto-update-check":
      return `${head} auto-update   checking current=${e.current}`;
    case "auto-update-query":
      return `${head} auto-update   querying npm current=${e.current}`;
    case "auto-update-queried":
      return `${head} auto-update   queried current=${e.current} latest=${e.latest} raw=${(e.stdout||"").slice(0,80)}`;
    case "auto-update-noop":
      return `${head} auto-update   noop current=${e.current} latest=${e.latest}${e.reason?` reason=${e.reason}`:""}`;
    case "auto-update-found":
      return `${head} auto-update   NEW v${e.current} -> v${e.latest} 发现新版本`;
    case "auto-update-installing":
      return `${head} auto-update   installing v${e.latest}...`;
    case "auto-update-installed":
      return `${head} auto-update   installed v${e.latest}`;
    case "auto-update-restarting":
      return `${head} auto-update   restarting daemon to v${e.latest}...`;
    case "auto-update-restarted":
      return `${head} auto-update   restarted pid=${e.newPid} v${e.current} -> v${e.latest} 升级完成`;
    case "auto-update-failed":
    case "auto-update-query-failed":
    case "auto-update-install-failed":
      return `${head} auto-update   failed ${e.type} error=${e.error||""}`;
    case "cline-account-state": {
      // 限流是「账号 × 模型」维度：模型名打头，pool 表示该模型上的可用账号，
      // 避免把"这个模型的免费额度用尽"误读成"整池账号报废"。
      const p = e.pool ? ` acct-ready=${e.pool.ready}/${e.pool.total}` : "";
      const lm = e.limitedModel ? ` upstream=${e.limitedModel}` : "";
      const detail = [e.reason, e.status ? `HTTP ${e.status}` : "", e.cooldownMs ? `cool ${Math.round(e.cooldownMs / 1000)}s` : ""].filter(Boolean).join(" ");
      const hint = e.state === "pool-exhausted" ? " [该模型所有账号额度耗尽 → 换模型或等冷却]" : e.state === "switch" ? " [换号重试]" : e.state === "force-retry" ? " [全部号冷却中，强行取号重试]" : "";
      return `${head} cline acct    ${e.state} model=${m(e.model)}${lm} account=${m(e.accountId)}${e.from ? ` from=${e.from}` : ""}${detail ? ` ${detail}` : ""}${p}${hint}`;
    }
    case "cline-model-usage":
      return `${head} cline tokens  ${e.state === "limit" ? "限流封存" : "正常输出"}${e.estimated ? "(估算)" : ""} model=${m(e.model)} account=${m(e.accountId)} output=${m(e.outputTokens)} 周期累计=${m(e.cycleOutputTokens)}${e.cycleCount ? ` 第${e.cycleCount}周期` : ""}${e.reason ? ` reason=${e.reason}` : ""}`;
    case "provider-state":
      return `${head} provider      ${m(e.provider)} ${m(e.state)}${e.keys !== undefined ? ` keys=${e.keys}` : ""}${e.accounts !== undefined ? ` accounts=${e.accounts}` : ""}${e.baseUrl ? ` baseUrl=${e.baseUrl}` : ""}${e.error ? ` error=${e.error}` : ""}`;
    case "provider-model-state":
      return `${head} prov model    ${m(e.provider)} ${m(e.state)} model=${m(e.model)}${e.status ? ` HTTP ${e.status}` : ""}${e.error ? ` error=${e.error}` : ""}${e.durationMs !== undefined ? ` ${fmtDur(e.durationMs)}` : ""}`;
    default:
      return `${head} ${e?.type || "?"} ${JSON.stringify(e || {})}`;
  }
}

export function fmtTs(iso) {
  return fmtShanghai(iso);
}
