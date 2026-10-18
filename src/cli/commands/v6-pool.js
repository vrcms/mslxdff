// mslxdff -v6-pool [test|help] —— IPv6 出口额度对照测试（在 VPS 上验证 v6 池值不值得用）。
//
// 目的（用户 2026-10-18 明确）：**当这台 VPS 的 IPv4 出口撞 429 时，对比测一下 IPv6 出口还有没有额度**。
// 所以本命令做 A/B：
//   ① 直连（IPv4/系统默认出口）打一条免费层请求，记下额度状态作基线；
//   ② 从 v6 段里随机采 N 个源地址，各打**同一条**请求（同 UA/模型/stream/tools，只换源地址）；
//   ③ 对照两者：v6 有 200 ⇒ 池有用（换 IP 换到新额度）；v6 全 429 ⇒ 换 IP 抬不动。
//
// 纯可逆：自造的 /128 用完即撤（bind 模式不碰网卡）。非 Linux 如实跳过。
import { runV6PoolCompare, V6TEST_DEFAULT, DEFAULT_PROBE_MODEL } from "../../v6pool/selftest.js";
import { argValue } from "../policy.js";

const FLAG = "-v6-pool";

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
  if (r.error) return `✗ 不可达（${String(r.error).slice(0, 50)}）`;
  if (r.ok) return `✅ HTTP ${r.status} 有额度`;
  return `⛔ HTTP ${r.status} ${kindZh[r.kind] || r.kind}`;
};

export async function handleV6Pool(args = []) {
  const at = args.findIndex((x) => x === FLAG || x.startsWith(`${FLAG}=`));
  if (at < 0) return false;
  const sub = (args[at].includes("=") ? args[at].split("=")[1] : args[at + 1] || "test").toLowerCase();
  if (["-h", "--help", "help"].includes(sub)) return printUsage();

  const count = (() => { const v = flagValue(args, "--count", "-n"); return v === null ? V6TEST_DEFAULT : Math.max(1, Math.min(64, Number(v) || V6TEST_DEFAULT)); })();
  const model = flagValue(args, "--model", "-m") || DEFAULT_PROBE_MODEL;

  console.log("=".repeat(66));
  console.log("  IPv6 出口额度对照 —— 「IPv4 撞 429 时，IPv6 还有额度吗」");
  console.log("=".repeat(66));
  console.log("");
  console.log(`  探测模型 ${model}｜采样 ${count} 个 v6 源地址｜只换源地址，其余请求完全相同`);
  console.log("");

  const onProgress = (ev) => {
    if (ev.phase === "baseline-start") console.log(`  ▸ 基线：直连（IPv4 / 系统默认出口）打一条免费层请求…`);
    else if (ev.phase === "baseline-done") {
      console.log(`    基线结果：${line(ev)}${ev.body ? `（${String(ev.body).slice(0, 80).replace(/\s+/g, " ")}）` : ""}`);
      console.log("");
    } else if (ev.phase === "v6-start") process.stdout.write(`  [${String(ev.i).padStart(2)}/${ev.n}] ${ev.addr}  … `);
    else if (ev.phase === "v6-done") process.stdout.write(`${line(ev)}\n`);
  };

  let r;
  try {
    r = await runV6PoolCompare({ count, model, onProgress });
  } catch (e) {
    console.log("");
    console.log(`❌ 测试执行出错：${e?.message ?? e}`);
    console.log(`   重试：mslxdff ${FLAG}`);
    process.exit(1);
    return true;
  }

  if (r.status === "skip") {
    console.log(`❌ 无法测 v6 出口：${r.reason}`);
    console.log(`   下一步：${r.hint}`);
    process.exit(1);
    return true;
  }

  console.log("");
  console.log("-".repeat(66));
  console.log(`  基线（IPv4/直连）：${line(r.baseline)}`);
  console.log(`  v6 采样：有额度 ${r.v6OkCount}｜429 ${r.v6LimitedCount}｜不可达 ${r.v6NetCount}（共 ${r.requested}）`);
  console.log("");
  const verdicts = {
    "v6-works": {
      mark: "✅",
      text: `IPv6 **能换到新额度**：${r.v6OkCount}/${r.requested} 个 v6 出口拿到 200`,
      next: `   结论：v6 池对这台机器**有用** —— IPv4 耗尽时换 v6 出口能续。daemon 建池时会自动启用。`,
    },
    "v6-also-limited": {
      mark: "⛔",
      text: `IPv6 **也全 429**：换 IP 没换到新额度`,
      next: `   结论：v6 池对这台机器**无意义**（要么上游不按出口 IP 计额，要么该段没真路由出去）。建议 MSLXDFF_V6_POOL=0。`,
    },
    "v6-unreachable": {
      mark: "❌",
      text: `IPv6 源地址**全都够不着上游**（段没路由到本机）`,
      next: `   结论：本机这段 v6 不能用作出口。查机房是否把该段 routed 过来，或用 MSLXDFF_V6_PREFIX 指更准的段。`,
    },
    mixed: {
      mark: "△",
      text: `部分可用：${r.v6OkCount}/${r.requested} 个 v6 出口有额度`,
      next: `   结论：v6 池**部分可用**（可能有些 /128 被沿途丢弃）。够用即可开着。`,
    },
  }[r.verdict] || { mark: "?", text: "未判定", next: "" };
  console.log(`  ${verdicts.mark} ${verdicts.text}`);
  if (verdicts.next) console.log(verdicts.next);
  console.log("");
  console.log(`   重试：mslxdff ${FLAG} --count ${r.requested}${model !== DEFAULT_PROBE_MODEL ? ` --model ${model}` : ""}`);
  process.exit(r.verdict === "v6-works" || r.verdict === "mixed" ? 0 : 1);
}

function printUsage() {
  console.log(`用法: mslxdff ${FLAG} [test] [--count N] [--model <id>]`);
  console.log("");
  console.log("  在 Linux VPS 上做 A/B：直连（IPv4）打一条 free 层请求取基线，");
  console.log("  再从 v6 段随机采 N 个源地址各打同一条，对照 IPv6 出口还有没有额度。");
  console.log("    基线 429 + v6 有 200 ⇒ 池有用（换 IP 换到新额度）");
  console.log("    基线 429 + v6 也 429 ⇒ 换 IP 抬不动（上游不按出口 IP 计额 / 段没路由过来）");
  console.log("");
  console.log("相关 env（与 daemon 建池同源）：");
  console.log("    MSLXDFF_V6_PREFIX=<段>/<位数>   显式指定池前缀（缺省取本机全局地址前缀）");
  console.log("    MSLXDFF_V6_IFACE=<网卡>        指定网卡");
  console.log("    MSLXDFF_V6_CLAIM=auto|bind|add 认领方式（bind 需 ip_nonlocal_bind=1；add 需 root）");
  process.exit(0);
  return true;
}
