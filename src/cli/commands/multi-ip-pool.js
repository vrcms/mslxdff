// mslxdff -multi-ip-pool [test|probe|status|fetch|help]
//   多出口池（VPNGate 免费 OpenVPN 节点当出口）：**组长**专属，只服务 opencode 免费层。
//
// 本文件只做「分发 + status + 用法」；test / fetch 两条取证流程在 ./multi-ip-pool-test.js
// （2026-10-25 起拆分：那边是全程 transcript 流水账，混在一起两边都顶过体积线）。
import { resolveMultiIpConfig, resolveRole } from "../../multi-ip-pool/config.js";
import { checkOpenvpn, isRoot, isSupportedPlatform } from "../../multi-ip-pool/tunnel.js";
import { loadGroupsJoined } from "../../state.js";
import { runFetch, runProbe } from "./multi-ip-pool-fetch.js";
import { runTest } from "./multi-ip-pool-test.js";

const FLAG = "-multi-ip-pool";

export async function handleMultiIpPool(args = []) {
  const at = args.findIndex((x) => x === FLAG || x.startsWith(`${FLAG}=`));
  if (at < 0) return false;
  const sub = (args[at].includes("=") ? args[at].split("=")[1] : args[at + 1] || "test").toLowerCase();
  if (["-h", "--help", "help"].includes(sub)) return printUsage();
  if (sub === "status") return await printStatus(args);
  if (sub === "probe" || sub === "ping") return await runProbe(args);
  if (sub === "fetch" || sub === "grab") return await runFetch(args);
  return await runTest(args);
}

/** status：只回答「开没开、为什么」。**不建池不拨号**，所以只能报告配置与门，报不了 daemon 内存里的池。 */
async function printStatus(args = []) {
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
  console.log(`  测网络可达性（不要 root）：mslxdff ${FLAG} probe [--probe N]`);
  process.exit(0);
  return true;
}

function printUsage() {
  console.log(`用法: mslxdff ${FLAG} [test|probe|status|fetch|help] [--count N] [--probe N] [--force] [--model <id>] [--out <路径>]`);
  console.log("");
  console.log("  test 在多出口池上做 A/B：直连打一条 free 层请求取基线，再逐条 VPN 隧道打同一条，");
  console.log("  对照判语：");
  console.log("    基线 429 + VPN 出口有 200 ⇒ 池有用（换 IP 换到新额度）");
  console.log("    基线 429 + VPN 出口也全 429 ⇒ 换 IP 抬不动（上游不按出口 IP 计额）");
  console.log("  test 每一步都编号打印并整份落盘（结尾给出 transcript 路径），失败即停在原地。");
  console.log("");
  console.log("  probe 只回答「这台机能连上表里几个节点」（按簇轮转取样 + 限并发 TCP 预检）：不拨号、不要 root、");
  console.log("  不碰 openvpn/内核、不看角色门，任何平台都能跑 —— 池值不值得继续用的先行问题。");
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
