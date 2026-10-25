// mslxdff -multi-ip-pool 的 test / fetch 两条流程：全程 transcript（屏幕 + 文件），每步编号带耗时。
//
// 为什么要写成流水账（用户 2026-10-25 明确要求）：真机两轮排障都卡在「只看到最终判语、看不到环节」——
// openvpn 的 argv、它的 stderr 原文、节点端口通不通、tun 地址有没有拿到、路由装没装上，
// 每一项都必须是**一行一条**摆在屏幕上，并且整份落盘，贴一个文件就能定位。
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runMultiIpCompare, VERDICT_ZH, MITEST_DEFAULT, MITEST_MAX } from "../../multi-ip-pool/selftest.js";
import { resolveMultiIpConfig, resolveRole } from "../../multi-ip-pool/config.js";
import { candidateNodes, loadNodeCache, materializeNode } from "../../multi-ip-pool/nodes.js";
import { fetchNodes, fetchNodesToFile } from "../../multi-ip-pool/nodes-fetch.js";
import { checkOpenvpn, isRoot, isSupportedPlatform } from "../../multi-ip-pool/tunnel.js";
import { createTranscript, envSnapshotLines, probeTcp, residualHints, slotPlanLines } from "../../multi-ip-pool/diagnose.js";
import { loadGroupsJoined } from "../../state.js";
import { argValue } from "../policy.js";

const FLAG = "-multi-ip-pool";

const kindZh = { "free-quota": "429 额度耗尽", "free-tier": "403 免费层资格", "ip-limit": "429 限流", "black-quota": "账号日配额", network: "网络不可达", none: "非额度信号" };

function flagValue(args, ...names) {
  for (const name of names) {
    const v = argValue(args, name);
    if (v !== null && v !== undefined && !String(v).startsWith("-")) return v;
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(eq.indexOf("=") + 1);
  }
  return null;
}

const line = (r) => {
  if (r.error) return `✗ 不可达（${String(r.error).replace(/\s+/g, " ").slice(0, 300)}）`;
  if (r.ok) return `✅ HTTP ${r.status} 有额度`;
  return `⛔ HTTP ${r.status} ${kindZh[r.kind] || r.kind}`;
};

/** 目录里已经有什么（auth.txt/nodes.json/node-*.conf）——很多失败就是这里少一个文件。 */
function dirNotes(dir) {
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
async function ensureRows(cfg, t) {
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

/**
 * `-multi-ip-pool test`：五道门 → 取表 → 每槽 TCP 预检 → 基线 → 逐槽起隧道取证 → 判语 → 善后。
 * 任何一步失败都会停在那一步并说清「下一步做什么」，不会攒到最后给你一个 unreachable。
 */
export async function runTest(args = []) {
  const cfg = resolveMultiIpConfig(process.env);
  const count = (() => { const v = flagValue(args, "--count", "-n"); return v === null ? MITEST_DEFAULT : Math.max(1, Math.min(MITEST_MAX, Number(v) || MITEST_DEFAULT)); })();
  const model = flagValue(args, "--model", "-m") || "";
  const t = createTranscript({ dir: cfg.dir });
  console.log("=".repeat(70));
  console.log("  多出口池取证 —— 全程 transcript（每一步都印，失败即停在原地）");
  console.log("=".repeat(70));

  t.step("① 环境快照");
  const role = resolveRole({ mode: cfg.mode, joined: loadGroupsJoined() });
  const root = isRoot();
  const supported = isSupportedPlatform();
  const openvpn = await checkOpenvpn(cfg.openvpnBin);
  for (const l of envSnapshotLines({ cfg, platform: process.platform, root, openvpn, files: dirNotes(cfg.dir) })) t.say(l);
  t.say(`角色门 role=${role.role} ⇒ ${role.active ? "通过" : "不建池"}（${role.why}）`);
  if (!cfg.enabled || !role.active || !supported || !root || !openvpn.ok) {
    t.say("五道门有不过的 ⇒ 后面不再动作（否则只会被 openvpn/内核报一堆看不懂的错）");
    console.log(`\n❌ 前置不足：开关=${cfg.enabled} 角色=${role.active} Linux=${supported} root=${root} openvpn=${openvpn.ok}`);
    console.log(`   下一步：mslxdff ${FLAG} status（逐门给人话结论）｜完整 transcript：${t.file}`);
    process.exit(1);
  }

  t.step("② 节点表");
  let rows = [];
  try {
    rows = await ensureRows(cfg, t);
  } catch (e) {
    t.say(String(e?.message || e));
    console.log(`\n❌ 取不到节点表（原因见上一行）`);
    console.log("   下一步：在能连的机器上 `mslxdff -multi-ip-pool fetch` 抓一份表带过来，");
    console.log("          再 export MSLXDFF_MULTI_IP_NODES_FILE=<路径> 重跑 test");
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
    return true;
  }

  t.step(`③ 选槽与 TCP 预检（拨号前先确认端口通不通，省掉 3×20s 的瞎等）`);
  const picked = candidateNodes({ rows, countries: cfg.countries, minScore: cfg.minScore, scan: count });
  if (!picked.length) {
    t.say(`Score≥${cfg.minScore} 且国家匹配的候选为 0（表里共 ${rows.length} 个节点）`);
    console.log(`\n❌ 没有可用候选`);
    console.log("   下一步：放宽 MSLXDFF_MULTI_IP_MIN_SCORE 或去掉 MSLXDFF_MULTI_IP_COUNTRY 再跑");
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
    return true;
  }
  const nodes = picked.map((row) => materializeNode({ dir: cfg.dir, row, name: `pre${picked.indexOf(row)}` })).filter(Boolean);
  for (const l of slotPlanLines({ cfg, nodes })) t.say(l);
  let reachable = 0;
  for (const n of nodes) {
    const p = await probeTcp({ host: n.host, port: n.port, timeoutMs: Math.min(6_000, cfg.connectTimeoutMs) });
    const verdict = p.ok ? `✓ TCP 通（${p.ms}ms）` : `✗ TCP 不通（${p.error || "?"}，${p.ms}ms）`;
    t.say(`  ${n.hostName} ${n.host}:${n.port} proto=${n.proto || "?"} → ${verdict}${String(n.proto).toLowerCase() === "udp" ? "　※ UDP 节点无握手，此探测仅供参考" : ""}`);
    if (p.ok) reachable++;
  }
  if (!reachable) t.say("全部候选 TCP 都不通 ⇒ 多半是本机到公网节点被限制（不是本模块的配置问题），下面仍会真拨一次以留证据");

  t.step("④ 基线 + 逐槽起隧道取证");
  const onProgress = (ev) => {
    if (ev.phase === "nodes") t.say(`（selftest 用的表：${ev.source}，${ev.total} 个节点）`);
    else if (ev.phase === "baseline-start") t.say("基线：直连（系统默认出口）打一条免费层请求…");
    else if (ev.phase === "baseline-done") t.say(`基线：${line(ev)}${ev.body ? ` ${String(ev.body).slice(0, 90).replace(/\s+/g, " ")}` : ""}`);
    else if (ev.phase === "exit-start") t.say(`槽 ${ev.i}/${ev.n}：${ev.row.hostName}（${ev.row.countryShort || "?"}）开始`);
    else if (ev.phase === "exit-done") t.say(`槽 ${ev.i}/${ev.n} 结果：${line(ev)}${ev.exitIp ? `｜出口 IP ${ev.exitIp}` : ""}`);
  };
  let r;
  try {
    r = await runMultiIpCompare({ count, ...(model ? { model } : {}), onProgress, deps: { log: (m) => t.say(m) } });
  } catch (e) {
    t.say(`测试执行抛错：${String(e?.stack || e?.message || e)}`);
    console.log(`\n❌ 测试执行出错：${e?.message ?? e}`);
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
    return true;
  }
  if (r.status === "skip") {
    t.say(`跳过：${r.reason}`);
    console.log(`\n❌ 测不了：${r.reason}`);
    console.log(`   下一步：${r.hint}`);
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
    return true;
  }

  t.step("⑤ 判语");
  console.log("-".repeat(70));
  console.log(`  基线（直连）：${line(r.baseline)}`);
  console.log(`  VPN 出口：有额度 ${r.okCount}｜受限 ${r.limitedCount}｜不可达 ${r.netCount}（共 ${r.requested}）`);
  const v = VERDICT_ZH[r.verdict] || { text: "未判定", next: "" };
  const mark = r.verdict === "multi-ip-works" ? "✅" : r.verdict === "mixed" ? "△" : "⛔";
  console.log(`  ${mark} ${v.text}：${r.okCount}/${r.requested} 条隧道拿到 200`);
  if (v.next) console.log(`   ${v.next}`);
  for (const e of r.exits || []) console.log(`   · ${e.hostName}（${e.country || "?"}）${e.exitIp ? `出口 ${e.exitIp}｜` : ""}${line(e)}`);

  t.step("⑥ 善后与存档");
  t.say(`隧道由本命令自造自拆；若中途 Ctrl+C，按下面几条查残留：`);
  for (const h of residualHints()) t.say(`  ${h}`);
  console.log("");
  console.log(`  完整 transcript（贴这一个文件就够）：${t.file}`);
  console.log(`  重试：mslxdff ${FLAG} test --count ${r.requested}${model ? ` --model ${model}` : ""}`);
  process.exit(r.verdict === "multi-ip-works" || r.verdict === "mixed" ? 0 : 1);
  return true;
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
    process.exit(0);
  } catch (e) {
    t.say(`❌ ${String(e?.message || e)}`);
    console.log("     下一步：换网络重试，或 MSLXDFF_MULTI_IP_SOURCES=<你自己能连的镜像/本地路径> 再跑一次");
    process.exit(1);
  }
  return true;
}
