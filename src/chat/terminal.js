import { createInterface } from "../readline-compat.js";
import { stdin, stdout } from "node:process";
import { formatBannerLines, formatStatsDetail, collectStats, probeGateway } from "./stats.js";
import { createSpinner } from "./spinner.js";
import { normalizeFullId } from "../providers/model-id.js";
import { loadHistory, saveHistory, clearHistory, histPath, estimateChars } from "./store.js";

export const SLASH_HELP = `自然语言直接说，斜杠快捷：
  /help     本帮助
  /stats    详细统计（网关 -d 的请求/延迟/模型）
  /history  查看对话历史
  /clear    清空历史
  /exit     退出
示例：设置 hy3 为默认模型 / 查看组列表 / 看最近20条日志 / 读一下 src/logs.js`;

export async function printBanner() {
  let probe = null;
  try {
    const s = collectStats();
    probe = await probeGateway(s.port, 800);
  } catch {}
  const { lines } = formatBannerLines(probe);
  for (const l of lines) console.log(l);
  if (probe && !probe.alive) console.log(`\x1b[31m本地服务没有启动无法使用auto模式，请mslxdff -d 启动\x1b[0m`);
  console.log(`\x1b[90m输入自然语言即可执行；/help 帮助，/stats 看网关统计，/exit 退出\x1b[0m`);
  console.log(`\x1b[90m历史：${histPath()} · 仅拦截 -uninstall · 数据来自网关 -d，非本会话计数\x1b[0m`);
}

export function printFooter({ model, provider, latency, usage, totalMs, fallback, fallbackGateway, viaGateway }) {
  const dim = "\x1b[90m";
  const rst = "\x1b[0m";
  let gw = null;
  try { gw = collectStats(); } catch {}
  const prov = provider && provider !== "opencode" ? `${provider}/` : "";
  const baseLabel = model ? `${prov}${model}` : "—";
  const via = provider && !baseLabel.startsWith(`${provider}/`) ? `: ${provider}` : "";
  const modelLabel = model ? (fallbackGateway || viaGateway ? `${baseLabel} (gateway auto${via})` : baseLabel) : "—";
  const latLabel = latency ? `${latency}ms` : "—";
  const totalLabel = totalMs ? ` · 总耗时 ${totalMs}ms` : "";
  const tokLabel = usage ? ` · tokens ${usage.prompt_tokens ?? "?"}→${usage.completion_tokens ?? "?"}` : "";
  const fbLabel = fallbackGateway || viaGateway ? " · gateway-fallback" : fallback ? " · fallback" : "";
  let gwLabel = "";
  let extra = "";
  if (gw) {
    const full = (() => { try { return normalizeFullId(model); } catch { return model; } })();
    const stat = gw.modelStats?.[full] || gw.modelStats?.[model] || null;
    const cnt = stat?.count ?? gw.latencies?.[model]?.count;
    const avgTtfb = stat?.avgTtfbMs ?? stat?.emaTtfbMs;
    const avgTps = stat?.avgTps ?? stat?.emaTps;
    const per = cnt ? ` · 网关该模型 ${cnt}次` : "";
    const ttfbLabel = avgTtfb ? ` 平均首字 ${avgTtfb}ms` : (gw.latencies?.[model]?.emaMs ? ` EMA ${gw.latencies[model].emaMs}ms` : "");
    const tpsLabel = avgTps ? ` · ${avgTps} tok/s` : "";
    const verbose = stat?.avgCompTok ? ` · 啰嗦 ${stat.avgCompTok}tok/次` : "";
    gwLabel = ` · 网关 总${gw.total} 成功${gw.success} 失败${gw.fail}${per}${ttfbLabel}${tpsLabel}${verbose}`;
    if (usage?.completion_tokens && latency) {
      const tpsNow = Math.round(usage.completion_tokens / (latency / 1000));
      if (Number.isFinite(tpsNow) && tpsNow > 0) extra = ` · 本次首字 ~${latency}ms · ${tpsNow} tok/s`;
    }
  }
  console.log(`${dim}─ ${modelLabel}  ${latLabel}${totalLabel}${tokLabel}${fbLabel}${gwLabel}${extra}${rst}`);
}

export function handleSlash(line, ctx) {
  const raw = String(line || "").trim();
  const low = raw.toLowerCase();
  if (["/help", "help", "/h", "?"].includes(low)) {
    console.log(SLASH_HELP);
    return { handled: true };
  }
  if (["/stats", "/status", "stats", "status"].includes(low)) {
    console.log(formatStatsDetail());
    return { handled: true };
  }
  if (["/clear", "clear"].includes(low)) {
    clearHistory();
    ctx.messages = [{ role: "system", content: ctx.system }];
    console.log("\x1b[90m[已清空历史]\x1b[0m");
    return { handled: true, messages: ctx.messages };
  }
  if (["/history"].includes(low)) {
    console.log(`\x1b[90m历史 ${ctx.messages.length - 1} 条，约 ${estimateChars(ctx.messages)} 字符 · ${histPath()}\x1b[0m`);
    for (const m of ctx.messages.slice(1).slice(-10)) console.log(`- ${m.role}: ${(m.content || "").slice(0, 120)}`);
    return { handled: true };
  }
  if (["/exit", "/quit", "exit", "quit", "退出"].includes(low)) {
    return { handled: true, exit: true };
  }
  return { handled: false };
}

export function createReadline(promptStr) {
  return createInterface({ input: stdin, output: stdout, prompt: promptStr });
}

export { createSpinner, loadHistory, saveHistory, histPath, estimateChars };
