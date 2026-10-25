// mslxdff -multi-ip-pool 的 test 流程：全程 transcript（屏幕 + 文件），每步编号带耗时。
//
// 为什么要写成流水账（用户 2026-10-25 明确要求）：真机两轮排障都卡在「只看到最终判语、看不到环节」——
// openvpn 的 argv、它的 stderr 原文、节点端口通不通、tun 地址有没有拿到、路由装没装上，
// 每一项都必须是**一行一条**摆在屏幕上，并且整份落盘，贴一个文件就能定位。
// fetch / probe 两条「不打隧道」的流程、以及本文件也要用的「表准备 + ③ 取样预检」在 ./multi-ip-pool-fetch.js。
import { runMultiIpCompare, VERDICT_ZH, MITEST_DEFAULT, MITEST_MAX } from "../../multi-ip-pool/selftest.js";
import { resolveMultiIpConfig, resolveRole } from "../../multi-ip-pool/config.js";
import { checkOpenvpn, isRoot, isSupportedPlatform } from "../../multi-ip-pool/tunnel.js";
import { createTranscript, envSnapshotLines, residualHints, slotPlanLines } from "../../multi-ip-pool/diagnose.js";
import { loadGroupsJoined } from "../../state.js";
import { PROBE_DEFAULT, dirNotes, ensureRows, flagValue, surveyCandidates } from "./multi-ip-pool-fetch.js";

const FLAG = "-multi-ip-pool";

const kindZh = { "free-quota": "429 额度耗尽", "free-tier": "403 免费层资格", "ip-limit": "429 限流", "black-quota": "账号日配额", network: "网络不可达", none: "非额度信号" };

/** 探活结果 → 一行判语（基线与逐槽结果共用同一份口径）。 */
const line = (r) => {
  if (r.error) return `✗ 不可达（${String(r.error).replace(/\s+/g, " ").slice(0, 300)}）`;
  if (r.ok) return `✅ HTTP ${r.status} 有额度`;
  return `⛔ HTTP ${r.status} ${kindZh[r.kind] || r.kind}`;
};

/**
 * `-multi-ip-pool test`：五道门 → 取表 → **按簇取样 + 批量 TCP 预检（只拨探通的）** → 基线 → 逐槽起隧道取证 → 判语 → 善后。
 * 任何一步失败都会停在那一步并说清「下一步做什么」，不会攒到最后给你一个 unreachable。
 * @param {string[]} args 认 `--count N`（拨几条）、`--probe N`（取样几条）、`--force`（一条都不通也真拨留证据）、`--model <id>`
 */
export async function runTest(args = []) {
  const cfg = resolveMultiIpConfig(process.env);
  const count = (() => { const v = flagValue(args, "--count", "-n"); return v === null ? MITEST_DEFAULT : Math.max(1, Math.min(MITEST_MAX, Number(v) || MITEST_DEFAULT)); })();
  const probeN = (() => { const v = flagValue(args, "--probe", "-p"); return v === null ? PROBE_DEFAULT : Math.max(1, Math.min(64, Number(v) || PROBE_DEFAULT)); })();
  const force = args.includes("--force");
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
    console.log(`   下一步：mslxdff ${FLAG} status（逐门给人话结论）｜只想测网络可达性用 ${FLAG} probe（不要 root）`);
    console.log(`   完整 transcript：${t.file}`);
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
  }

  t.step("③ 取样与 TCP 预检（按簇摊开取样；探不通的一律不拨，省掉几分钟白等）");
  const survey = await surveyCandidates({ cfg, rows, t, limit: probeN, timeoutMs: Math.min(6_000, cfg.probeTimeoutMs), concurrency: 6 });
  if (!survey.sample.length) {
    t.say(`Score≥${cfg.minScore} 且国家匹配的候选为 0（表里共 ${rows.length} 个节点）`);
    console.log(`\n❌ 没有可用候选`);
    console.log("   下一步：放宽 MSLXDFF_MULTI_IP_MIN_SCORE 或去掉 MSLXDFF_MULTI_IP_COUNTRY 再跑");
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
  }
  const tcpResults = survey.results.filter((r) => String(r.node?.proto || "").toLowerCase() !== "udp");
  if (!survey.live.length && tcpResults.length && !force) {
    t.say(`⛔ 取样里 ${tcpResults.length} 条 TCP 节点**一条都连不上** ⇒ 这台机到这一片节点整体不通（网络层，不是本模块配错）`);
    t.say("下一步：① 换网络/换出口——云厂商安全组、运营商对境外 VPN 端口的限制都在这一层");
    t.say(`        ② 加大取样再看一次：mslxdff ${FLAG} test --probe 40（或去掉国家白名单 MSLXDFF_MULTI_IP_COUNTRY=）`);
    t.say(`        ③ 只测可达性、不要 root：mslxdff ${FLAG} probe --probe 40`);
    t.say(`        ④ 一定要看真拨的证据：mslxdff ${FLAG} test --force`);
    console.log(`\n❌ 取样里 ${tcpResults.length} 条 TCP 节点一条都连不上`);
    console.log("   这不是本模块的配置错，是这台机到这些免费节点（这一片机房）的网络不通");
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
  }
  const dialRows = (survey.live.length ? survey.live : survey.nodes).slice(0, count);
  for (const l of slotPlanLines({ cfg, nodes: dialRows })) t.say(l);
  t.say(`拨号计划：${dialRows.length} 条${survey.live.length ? "（取自上面探通的）" : "（没有探通的 ⇒ 按取样顺序强拨，只为留证据）"}`);

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
    r = await runMultiIpCompare({ count: dialRows.length || count, slots: dialRows, ...(model ? { model } : {}), onProgress, deps: { log: (m) => t.say(m) } });
  } catch (e) {
    t.say(`测试执行抛错：${String(e?.stack || e?.message || e)}`);
    console.log(`\n❌ 测试执行出错：${e?.message ?? e}`);
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
  }
  if (r.status === "skip") {
    t.say(`跳过：${r.reason}`);
    console.log(`\n❌ 测不了：${r.reason}`);
    console.log(`   下一步：${r.hint}`);
    console.log(`   完整 transcript：${t.file}`);
    process.exit(1);
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
}