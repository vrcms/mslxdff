// mslxdff -multi-ip-pool 的 `fetch`（抓表落盘）与 `probe`（只测节点可达性），加上 `test` 也要用的
// 「表准备 + ③ 取样预检」——这三件事都不打隧道，故与 test 的六步流水分开放。
//
// 为什么独立成一份（2026-10-25 真机第三轮）：`test` 已顶到 11.3KB；而「这台机到底能连上表里几个节点」
// 是判断多出口池值不值得继续的**先行问题**——它不要 root、不要 openvpn、不碰内核，
// 任何平台都能几十秒给出答案，不该被塞进「要 Linux + root + 隧道」的取证流程里。
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveMultiIpConfig } from "../../multi-ip-pool/config.js";
import { countCandidates, loadNodeCache, probeTargetOf, sampleCandidates } from "../../multi-ip-pool/nodes.js";
import { fetchNodes, fetchNodesToFile } from "../../multi-ip-pool/nodes-fetch.js";
import { createTranscript, probeBatch, probeSummaryLines } from "../../multi-ip-pool/diagnose.js";
import { argValue } from "../policy.js";

const FLAG = "-multi-ip-pool";

/** 取样条数：够看出「哪一片不通」，又不至于把流程拖成几分钟（限并发 6、单条最多 6s ⇒ 最坏约 15s）。 */
export const PROBE_DEFAULT = 12;

/** `--flag value` 与 `--flag=value` 两种写法都认；认不到返回 null（`-` 开头的不当值）。 */
export function flagValue(args, ...names) {
  for (const name of names) {
    const v = argValue(args, name);
    if (v !== null && v !== undefined && !String(v).startsWith("-")) return v;
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(eq.indexOf("=") + 1);
  }
  return null;
}

/** 目录里已经有什么（auth.txt/nodes.json/node-*.conf）——很多失败就是这里少一个文件。 */
export function dirNotes(dir) {
  try {
    const names = readdirSync(dir);
    const size = (f) => { try { return `${statSync(join(dir, f)).size}B`; } catch { return "?"; } };
    const files = names.slice(0, 12).map((n) => `${n}(${size(n)})`);
    files.push(names.length > 12 ? `…共 ${names.length} 个` : "");
    files.push(`auth.txt ${names.includes("auth.txt") ? "在" : "**缺失**（拨号必挂，看第 4 步）"}`);
    return files.filter(Boolean);
  } catch (e) {
    return [`目录读不到：${String(e?.code || e?.message || e)}`];
  }
}

/** 取表（缓存优先，取不到就逐源试并把每个源的死因摆出来）。 */
export async function ensureRows(cfg, t) {
  const cache = loadNodeCache({ dir: cfg.dir, ttlMs: cfg.nodesTtlMs });
  if (cache?.rows?.length) {
    t.say(`命中本地缓存：${cache.rows.length} 个节点（表源 ${cache.source}，缓存龄 ${Math.round((Date.now() - Number(cache.fetchedAt || 0)) / 1000)}s）`);
    return cache.rows;
  }
  t.say("缓存没有或已过期 ⇒ 逐源取表（每源失败原因都会列出来）");
  const got = await fetchNodes({ sources: cfg.sources, dir: cfg.dir, timeoutMs: cfg.probeTimeoutMs, log: (m) => t.say(m) });
  t.say(`取到：${got.source} → ${got.rows.length} 个节点`);
  return got.rows;
}

/** 一条预检结果的判语（UDP 节点必须如实标注「无握手，仅供参考」）。 */
function nodeLine(r, minScore = 0) {
  const n = r.node || {};
  const proto = String(n.proto || "").toLowerCase();
  const how = r.ok ? `✓ TCP 通（${r.ms}ms）` : `✗ TCP 不通（${String(r.error || "?").replace(/\s+/g, " ").slice(0, 60)}，${r.ms}ms）`;
  const low = Number(n.score || 0) < minScore ? "（Score 低于下限，仅作可达性参考）" : "";
  return `  ${r.ok ? "✓" : "✗"} ${n.hostName}（${n.countryShort || "?"}）${n.host}:${n.port}｜${n.proto || "?"}｜Score ${n.score}${low} → ${how}`
    + (proto === "udp" ? "　※ UDP 无握手，此探测仅供参考" : "");
}

/**
 * ③ 取样与 TCP 预检（test 与 probe 共用一份，保证「探的」与「拨的」永远是同一批）：
 * 按簇轮转取样 → 限并发探一遍 → 逐条打印 + 小结 + 簇分布。
 * @returns {Promise<{ sample: object[], nodes: object[], results: object[], live: object[] }>}
 */
export async function surveyCandidates({ cfg, rows = [], t, limit = PROBE_DEFAULT, timeoutMs = 5_000, concurrency = 6 } = {}) {
  const strict = sampleCandidates({ rows, countries: cfg.countries, minScore: cfg.minScore, limit });
  // 达下限的候选不够取样条数时补低分节点——**只作可达性参考**（Score 低不等于连不上，先别急着排除它）
  const skip = new Set(strict.map((r) => r.hostName));
  const sample = strict.length < limit
    ? [...strict, ...sampleCandidates({ rows, countries: cfg.countries, minScore: 0, limit: limit - strict.length, skip })]
    : strict;
  const matched = countCandidates({ rows, countries: cfg.countries, minScore: cfg.minScore });
  t.say(`候选池：表 ${rows.length} 个 → 国家/Score 达标 ${matched} 个 → 取样 ${sample.length} 个（按簇轮转：同一机房不占满取样，免得一片不通就判整表不通）`);
  const nodes = sample
    .map((row) => { const target = probeTargetOf(row); return target ? { ...row, host: target.host, port: target.port, proto: target.proto } : null; })
    .filter(Boolean);
  if (!nodes.length) return { sample, nodes, results: [], live: [] };
  const low = nodes.filter((n) => Number(n.score || 0) < cfg.minScore).length;
  t.say(`预检：限并发 ${Math.min(concurrency, nodes.length)}、单条 ${timeoutMs}ms${low ? `（其中 ${low} 条 Score 低于下限，仅作参考）` : ""}`);
  const results = await probeBatch({ nodes, timeoutMs, concurrency });
  for (const r of results) t.say(nodeLine(r, cfg.minScore));
  for (const l of probeSummaryLines({ results, minScore: cfg.minScore })) t.say(l);
  return { sample, nodes, results, live: results.filter((r) => r.ok).map((r) => r.node) };
}

/**
 * `-multi-ip-pool probe [--probe N]`：只回答「这台机能连上表里几个节点」。
 * 不建隧道、不要 root、不碰 openvpn/内核、不看角色门 ⇒ 任何平台都能跑：这是「池值不值得继续」的先行问题。
 */
export async function runProbe(args = []) {
  const cfg = resolveMultiIpConfig(process.env);
  const limit = (() => { const v = flagValue(args, "--probe", "-p"); return v === null ? PROBE_DEFAULT : Math.max(1, Math.min(64, Number(v) || PROBE_DEFAULT)); })();
  const t = createTranscript({ dir: cfg.dir, fileName: `probe-${new Date().toISOString().replace(/[:.]/g, "-")}.log` });
  console.log("=".repeat(70));
  console.log("  多出口池 · 节点可达性（只测能不能连上：不拨号、不要 root、不动内核、不看角色门）");
  console.log("=".repeat(70));

  t.step("① 环境快照");
  t.say(`node ${process.version}｜平台 ${process.platform}`);
  t.say(`配置：取样 ${limit} 条｜Score 下限 ${cfg.minScore}｜国家 ${cfg.countries.length ? cfg.countries.join("/") : "不限"}｜目录 ${cfg.dir}`);
  t.say(`节点源（按序）：${cfg.sources.join(" → ")}`);

  t.step("② 节点表");
  let rows = [];
  try {
    rows = await ensureRows(cfg, t);
  } catch (e) {
    t.say(String(e?.message || e));
    console.log("\n❌ 取不到节点表（原因见上一行）");
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
  }

  t.step("③ 取样与 TCP 预检");
  const survey = await surveyCandidates({ cfg, rows, t, limit, timeoutMs: Math.min(6_000, cfg.probeTimeoutMs), concurrency: 6 });
  if (!survey.sample.length) {
    t.say(`Score≥${cfg.minScore} 且国家匹配的候选为 0（表里共 ${rows.length} 个节点）`);
    console.log(`\n❌ 没有可用候选（放宽 MSLXDFF_MULTI_IP_MIN_SCORE 或去掉 MSLXDFF_MULTI_IP_COUNTRY 再跑）`);
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
  }
  const tcpResults = survey.results.filter((r) => String(r.node?.proto || "").toLowerCase() !== "udp");
  const tcpLive = tcpResults.filter((r) => r.ok);

  t.step("④ 结论");
  if (tcpLive.length) {
    t.say(`✅ 取样里 ${tcpLive.length}/${tcpResults.length} 条 TCP 节点可连 ⇒ 这台机能用多出口池（能不能换来新额度另说：跑 test）`);
  } else {
    t.say(`⛔ 取样里 ${tcpResults.length} 条 TCP 节点一条都连不上 ⇒ 这台机到这些免费节点整体不通（网络层，不是本模块配错）`);
    t.say("下一步：① 换网络/换出口（云厂商安全组、运营商对境外 VPN 端口的限制都在这一层）；② 加大取样 --probe 40 或去掉国家白名单再确认一次");
  }
  console.log("");
  console.log(tcpLive.length ? `  ✅ 取样 ${tcpResults.length} 条 TCP 节点里有 ${tcpLive.length} 条可连` : `  ⛔ 一条 TCP 节点都连不上（探了 ${tcpResults.length} 条）`);
  console.log(`  完整 transcript（贴这一个文件就够）：${t.file}`);
  console.log(`  下一步：mslxdff ${FLAG} test（真机取证：换出口到底有没有换来新额度）`);
  process.exit(tcpLive.length ? 0 : 1);
}

/**
 * `-multi-ip-pool fetch [路径]`：在**能连节点源**的机器上抓一份表落成文件，scp 到受限网络的组长机，
 * 那边设 `MSLXDFF_MULTI_IP_NODES_FILE=<路径>` 即可完全跳过取表网络请求（2026-10-25 真机：华为云 ECS 到 vpngate.net 不通）。
 */
export async function runFetch(args = []) {
  const cfg = resolveMultiIpConfig(process.env);
  const out = flagValue(args, "--out", "-o") || join(cfg.dir, "vpngate.csv");
  const t = createTranscript({ dir: cfg.dir, fileName: "fetch.log" });
  t.step("逐源取表（失败原因逐条列出）");
  t.say(`源列表：${cfg.sources.join(" → ")}`);
  try {
    const got = await fetchNodesToFile({ sources: cfg.sources, out, timeoutMs: cfg.probeTimeoutMs, log: (m) => t.say(m) });
    const usable = got.rows.filter((r) => r.config).length;
    t.say(`✅ ${got.rows.length} 个节点（${usable} 个配置可解码）→ ${out}`);
    console.log("");
    console.log("  带到受限网络的机器上：");
    console.log(`     scp ${out} root@<组长机>:/root/.config/mslxdff/multi-ip-pool/vpngate.csv`);
    console.log("     export MSLXDFF_MULTI_IP_NODES_FILE=/root/.config/mslxdff/multi-ip-pool/vpngate.csv");
    console.log("     （之后取表零网络请求；表会旧，免费节点掉得快，建议隔几天重抓一次）");
    console.log(`     先在那台机上跑 mslxdff ${FLAG} probe：能连上几个节点，比真拨一遍快得多`);
    process.exit(0);
  } catch (e) {
    t.say(`❌ ${String(e?.message || e)}`);
    console.log("     下一步：换网络重试，或 MSLXDFF_MULTI_IP_SOURCES=<你自己能连的镜像/本地路径> 再跑一次");
    process.exit(1);
  }
}