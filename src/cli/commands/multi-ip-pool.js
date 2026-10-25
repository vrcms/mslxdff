// mslxdff -multi-ip-pool [test|status|help]
//   多出口池（VPNGate 免费 OpenVPN 节点当出口）：**组长/单机**专属，只服务 opencode 免费层。
//
// 为什么需要这条命令（用户要的"取证"）：换出口到底有没有换来新额度，只有实测能回答。
// 本命令做 A/B：直连打一条免费层请求取基线 → 逐条 VPN 隧道打**同一条**请求 → 对照判语。
import { join } from "node:path";
import { runMultiIpCompare, VERDICT_ZH, MITEST_DEFAULT, MITEST_MAX } from "../../multi-ip-pool/selftest.js";
import { fetchNodesToFile } from "../../multi-ip-pool/nodes-fetch.js";
import { resolveMultiIpConfig, resolveRole } from "../../multi-ip-pool/config.js";
import { checkOpenvpn, isRoot, isSupportedPlatform } from "../../multi-ip-pool/tunnel.js";
import { loadGroupsJoined } from "../../state.js";
import { argValue } from "../policy.js";

const FLAG = "-multi-ip-pool";

function flagValue(args, ...names) {
  for (const name of names) {
    const v = argValue(args, name);
    if (v !== null && v !== undefined && !String(v).startsWith("-")) return v;
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(eq.indexOf("=") + 1);
  }
  return null;
}

const kindZh = { "free-quota": "429 额度耗尽", "free-tier": "403 免费层资格", "ip-limit": "429 限流", "black-quota": "账号日配额", network: "网络不可达", none: "非额度信号" };
const line = (r) => {
  if (r.error) return `✗ 不可达（${String(r.error).replace(/\s+/g, " ").slice(0, 220)}）`;
  if (r.ok) return `✅ HTTP ${r.status} 有额度`;
  return `⛔ HTTP ${r.status} ${kindZh[r.kind] || r.kind}`;
};

export async function handleMultiIpPool(args = []) {
  const at = args.findIndex((x) => x === FLAG || x.startsWith(`${FLAG}=`));
  if (at < 0) return false;
  const sub = (args[at].includes("=") ? args[at].split("=")[1] : args[at + 1] || "test").toLowerCase();
  if (["-h", "--help", "help"].includes(sub)) return printUsage();
  if (sub === "status") return await printStatus(args);
  if (sub === "fetch" || sub === "grab") return await runFetch(args);
  return await runTest(args);
}

async function runTest(args) {
  const count = (() => { const v = flagValue(args, "--count", "-n"); return v === null ? MITEST_DEFAULT : Math.max(1, Math.min(MITEST_MAX, Number(v) || MITEST_DEFAULT)); })();
  const model = flagValue(args, "--model", "-m") || "";
  console.log("=".repeat(66));
  console.log("  多出口池取证 —— 「直连 429 时，换成 VPN 出口还有额度吗」");
  console.log("=".repeat(66));
  console.log("");
  console.log(`  探测模型 ${model || "(默认免费模型)"}｜采样 ${count} 条隧道｜只换出口，其余请求完全相同`);
  console.log("");

  const onProgress = (ev) => {
    if (ev.phase === "nodes") console.log(`  ▸ 节点表：${ev.source}（${ev.total} 个节点）`);
    else if (ev.phase === "baseline-start") console.log("  ▸ 基线：直连（系统默认出口）打一条免费层请求…");
    else if (ev.phase === "baseline-done") {
      console.log(`    基线结果：${line(ev)}${ev.body ? `（${String(ev.body).slice(0, 80).replace(/\s+/g, " ")}）` : ""}`);
      console.log("");
    } else if (ev.phase === "exit-start") console.log(`  [${String(ev.i).padStart(2)}/${ev.n}] ${ev.row.hostName}（${ev.row.countryShort || "?"}）…`);
    else if (ev.phase === "exit-done") console.log(`      ${line(ev)}${ev.exitIp ? `｜出口 IP ${ev.exitIp}` : ""}`);
  };

  let r;
  try {
    r = await runMultiIpCompare({ count, ...(model ? { model } : {}), onProgress });
  } catch (e) {
    console.log("");
    console.log(`❌ 测试执行出错：${e?.message ?? e}`);
    console.log(`   重试：mslxdff ${FLAG}`);
    process.exit(1);
    return true;
  }
  if (r.status === "skip") {
    console.log(`❌ 测不了：${r.reason}`);
    console.log(`   下一步：${r.hint}`);
    process.exit(1);
    return true;
  }

  console.log("");
  console.log("-".repeat(66));
  console.log(`  基线（直连）：${line(r.baseline)}`);
  console.log(`  VPN 出口：有额度 ${r.okCount}｜受限 ${r.limitedCount}｜不可达 ${r.netCount}（共 ${r.requested}）`);
  console.log("");
  const v = VERDICT_ZH[r.verdict] || { text: "未判定", next: "" };
  const mark = r.verdict === "multi-ip-works" ? "✅" : r.verdict === "mixed" ? "△" : "⛔";
  console.log(`  ${mark} ${v.text}：${r.okCount}/${r.requested} 条隧道拿到 200`);
  if (v.next) console.log(`   ${v.next}`);
  console.log("");
  console.log(`   重试：mslxdff ${FLAG} --count ${r.requested}${model ? ` --model ${model}` : ""}`);
  process.exit(r.verdict === "multi-ip-works" || r.verdict === "mixed" ? 0 : 1);
}

/**
 * `-multi-ip-pool fetch [路径]`：在**能连节点源**的机器上抓一份 VPNGate 表落成文件，scp 到受限网络的组长机，
 * 那边设 `MSLXDFF_MULTI_IP_NODES_FILE=<路径>` 即可完全跳过取表网络请求（2026-10-25 真机：华为云 ECS 上 vpngate.net 不可达）。
 */
async function runFetch(args) {
  const cfg = resolveMultiIpConfig(process.env);
  const out = flagValue(args, "--out", "-o") || join(cfg.dir, "vpngate.csv");
  console.log(`  节点源（按序试）：${cfg.sources.join("\n              ")}`);
  console.log("");
  try {
    const got = await fetchNodesToFile({ sources: cfg.sources, out, timeoutMs: cfg.probeTimeoutMs });
    const usable = got.rows.filter((r) => r.config).length;
    console.log(`  ✅ ${got.rows.length} 个节点（${usable} 个配置可解码）已写入：${out}`);
    console.log(`     来源：${got.source}`);
    console.log("");
    console.log("  带到受限网络的机器上：");
    console.log(`     scp ${out} root@<组长机>:/root/.config/mslxdff/multi-ip-pool/vpngate.csv`);
    console.log("     export MSLXDFF_MULTI_IP_NODES_FILE=/root/.config/mslxdff/multi-ip-pool/vpngate.csv");
    console.log("     （之后取表零网络请求；表会旧，免费节点掉得快，建议隔几天重抓一次）");
    process.exit(0);
  } catch (e) {
    console.log(`  ❌ 一个源都没取到：${String(e?.message || e)}`);
    console.log("     下一步：换网络重试，或 MSLXDFF_MULTI_IP_SOURCES=<你自己能连的镜像/本地路径> 再跑一次");
    process.exit(1);
  }
  return true;
}

async function printStatus(args) {
  const cfg = resolveMultiIpConfig(process.env);
  const role = resolveRole({ mode: cfg.mode, joined: loadGroupsJoined() });
  const platform = process.platform;
  const root = isRoot();
  const openvpn = await checkOpenvpn(cfg.openvpnBin);
  console.log("=".repeat(66));
  console.log("  多出口池状态（不做任何隧道动作，只回答「开没开、为什么」）");
  console.log("=".repeat(66));
  console.log("");
  console.log(`  开关       ${cfg.enabled ? "开（MSLXDFF_MULTI_IP_POOL 缺省开）" : "关（MSLXDFF_MULTI_IP_POOL=0）"}`);
  console.log(`  角色门     role=${role.role} ⇒ ${role.active ? "通过" : "不建池"}（${role.why}）`);
  console.log(`  平台门     ${isSupportedPlatform(platform) ? "通过（Linux）" : `不通过（${platform}：没有 tun + ip rule）`}`);
  console.log(`  权限门     ${root ? "通过（root）" : "不通过（需要 root 才能建 tun 与策略路由）"}`);
  console.log(`  openvpn    ${openvpn.ok ? `可用（${openvpn.version}）` : `不可用（${openvpn.why}）`}`);
  console.log(`  隧道数     ${cfg.count}｜国家 ${cfg.countries.length ? cfg.countries.join("/") : "不限"}｜Score ≥ ${cfg.minScore}｜表号 ${cfg.baseTable}+`);
  console.log(`  备选池     配 ${cfg.standby} 条（每 ${Math.round((cfg.standbyEveryMs || 0) / 60_000)} 分钟重拨一批；入池标准是 hi 回 200，不是"隧道起来了"）`);
  console.log(`             实际就绪几条**只有 daemon 知道**（本命令不建池、不拨号）→ 看 mslxdff -log 里的 [multi-ip-pool] 备选池 行`);
  console.log(`  目录       ${cfg.dir}`);
  console.log(`  节点源     ${cfg.nodesFile ? `本地表优先：${cfg.nodesFile}（其后 ${cfg.sources.length - 1} 个网络源）` : cfg.sources.join("，")}`);
  console.log("");
  console.log(`  下一步：mslxdff ${FLAG} test（真机取证：换出口到底有没有换来新额度）`);
  process.exit(0);
  return true;
}

function printUsage() {
  console.log(`用法: mslxdff ${FLAG} [test|status|fetch|help] [--count N] [--model <id>] [--out <路径>]`);
  console.log("");
  console.log("  在多出口池上做 A/B：直连打一条 free 层请求取基线，再逐条 VPN 隧道打同一条，");
  console.log("  对照判语：");
  console.log("    基线 429 + VPN 出口有 200 ⇒ 池有用（换 IP 换到新额度）");
  console.log("    基线 429 + VPN 出口也全 429 ⇒ 换 IP 抬不动（上游不按出口 IP 计额）");
  console.log("");
  console.log("  前置：Linux + root + openvpn（tun 设备与策略路由必需）。非 Linux 如实跳过。");
  console.log("");
  console.log("相关 env（与 daemon 建池同源）：");
  console.log("    MSLXDFF_MULTI_IP_POOL=0|1          关 / 开（缺省开）");
  console.log("    MSLXDFF_MULTI_IP_MODE=auto|leader|member  角色门（缺省 auto：**只有组长**建池；组员与单机都不建，强开=leader）");
  console.log("    MSLXDFF_MULTI_IP_COUNT=N            并行隧道数（缺省 2）");
  console.log("    MSLXDFF_MULTI_IP_COUNTRY=JP,KR      国家白名单（缺省不限）");
  console.log(`    MSLXDFF_MULTI_IP_MIN_SCORE=N        节点 Score 下限（缺省 1000000）`);
  console.log("    MSLXDFF_MULTI_IP_SOURCES=url,url    节点表来源（缺省 VPNGate 官方 https+http，末位挂 aimili 仓库内镜像兜墙）");
  console.log("    MSLXDFF_MULTI_IP_NODES_FILE=<路径>   本地表文件（排在最前，设了就不打网；配合 -multi-ip-pool fetch 生成）");
  console.log("    MSLXDFF_MULTI_IP_BASE_TABLE=N       策略路由表起始号（缺省 210）");
  console.log("    MSLXDFF_MULTI_IP_SYSCTL=0|1         是否放宽 rp_filter（缺省 1）");
  console.log("    MSLXDFF_MULTI_IP_STANDBY=N          备选出口条数（缺省 5，**上限 5**，0=关）");
  console.log("    MSLXDFF_MULTI_IP_STANDBY_EVERY_MS=N  备选池刷新周期（缺省 3600000＝每小时重拨一批）");
  console.log("    MSLXDFF_MULTI_IP_STRATEGY=session    会话粘出口（request＝每请求换出口，会撞冷启动）");
  console.log("    MSLXDFF_MULTI_IP_PROBE_MODEL=<id>     打 hi 探额度用的免费模型（空＝同款缺省）");
  process.exit(0);
  return true;
}