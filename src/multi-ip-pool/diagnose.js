// multi-ip-pool · 诊断层：openvpn 输出归因 / 节点 TCP 预检 / 取证全程 transcript（argv 原文由 report.js:fmtArgv 出）。
//
// 为什么单独一份：2026-10-25 真机两轮都栽在「看得见结果、看不见环节」——openvpn 用法错误的末行恒是
// `Use --help`，真凶在它上面；而 selftest 的内部步骤日志在 CLI 里被接到了空函数上。
// 本文件把「哪一步出问题」变成一等信息：每一步都有编号、耗时、原文，并整份落盘可粘贴。
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import net from "node:net";
import { devNameFor, tableFor } from "./config.js";

/** 值得单独成行的报错关键词（openvpn 的用法/握手/认证/网络失败都在这里）。 */
const ERRORISH = /options error|unrecognized|missing or extra|fatal|error:|can ?not|cannot|denied|failed|refused|reset|auth failed|tls|write udp|bind|permission/i;

/**
 * openvpn 输出里挑「最能说明问题」的一行：用法错误的**末行恒是** `Use --help for more information.`，
 * 真凶（`Options error: …`）在它上面。只报末行等于把病因盖住。
 */
export function openvpnErrorLine(text, max = 240) {
  const lines = String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return "";
  const pick = lines.find((l) => ERRORISH.test(l));
  return (pick || lines[lines.length - 1]).slice(0, max);
}

/**
 * 一行内的**多行摘要**：真凶行 + 其余最多 3 行（用 ` ‖ ` 分隔）。
 * 单行是为了日志文件仍可 grep；多行是为了人眼一次看完，不必再翻 openvpn 自己的输出。
 */
export function openvpnErrorBrief(text, max = 620) {
  const lines = String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return "";
  const first = lines.find((l) => ERRORISH.test(l)) || "";
  const rest = lines.filter((l) => l !== first && !/^Use --help/i.test(l)).slice(-3);
  return [first || lines[lines.length - 1], ...rest].join(" ‖ ").slice(0, max);
}

/**
 * 节点 TCP 预检：拨号前先确认「这台机能不能连到 host:port」。
 * 判语口径：VPNGate 实测 91/97 是 `proto tcp`，TCP 连不上基本就是节点/防火墙问题；
 * `proto udp` 的节点这条只作参考（UDP 无握手，连不上不代表隧道必挂），**必须如实分开说**。
 */
export function probeTcp({ host, port, timeoutMs = 6_000, connectFn } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const done = (ok, extra) => resolve({ ok, ms: Date.now() - t0, host, port, ...extra });
    if (!host || !port) return done(false, { error: "缺 host/port" });
    if (connectFn) {
      return connectFn(host, port, timeoutMs)
        .then((r) => done(Boolean(r?.ok), { ...(r?.error ? { error: r.error } : {}) }))
        .catch((e) => done(false, { error: String(e?.message || e) }));
    }
    const s = net.connect({ host, port });
    const timer = setTimeout(() => { s.destroy(); done(false, { error: `连接超时（${timeoutMs}ms）` }); }, timeoutMs);
    s.once("connect", () => { clearTimeout(timer); s.destroy(); done(true, {}); });
    s.once("error", (e) => { clearTimeout(timer); done(false, { error: String(e?.code || e?.message || e) }); });
  });
}

/**
 * 取证全程 transcript：每行带 `[步骤号]` 与相对耗时，同时进屏幕与文件（0600）。
 * 落盘是为了「一次跑完贴一个文件给我」，不必复现；写文件失败绝不影响测试本体。
 */
export function createTranscript({ dir, out = (s) => console.log(s), now = () => Date.now(), fs = { mkdirSync, appendFileSync }, fileName = "" } = {}) {
  const t0 = now();
  let step = 0;
  const file = dir ? join(dir, fileName || `test-${new Date(t0).toISOString().replace(/[:.]/g, "-")}.log`) : "";
  const emit = (raw) => {
    const line = `[${String(step).padStart(2, "0")} +${((now() - t0) / 1000).toFixed(1)}s] ${raw}`;
    out(line);
    if (file) {
      try { fs.appendFileSync(file, line + "\n"); } catch { /* 落盘失败只影响存档，不影响取证 */ }
    }
  };
  try {
    if (file) { fs.mkdirSync(dirname(file), { recursive: true }); fs.appendFileSync(file, `# multi-ip-pool 取证 transcript（本文件可整份粘贴）\n`); }
  } catch { /* 同上 */ }
  return {
    file,
    /** 一条步骤行（自动编号）。 */
    step: (text) => { step += 1; emit(text); return step; },
    /** 归属当前步骤的明细行（不占编号）。 */
    say: (text) => emit(`      ${String(text).replace(/^\s+/, "")}`),
    /** 小节标题。 */
    section: (text) => { step += 1; emit(`—— ${text} ——`); return step; },
  };
}

/** 环境快照：一眼看清「机器/权限/二进制/配置/磁盘上有什么」，省掉一轮来回。 */
export function envSnapshotLines({ cfg, platform, root, openvpn, files = [], argvNode = "" } = {}) {
  return [
    `node ${argvNode || process.version}｜平台 ${platform}｜root ${root ? "是" : "否"}`,
    `openvpn ${openvpn?.ok ? `可用：${openvpn.version}` : `不可用：${openvpn?.why || "?"}`}`,
    `配置：隧道 ${cfg?.count} 条｜备胎 ${cfg?.standby} 条/每 ${Math.round((cfg?.standbyEveryMs || 0) / 60_000)} 分钟｜Score 下限 ${cfg?.minScore}｜国家 ${cfg?.countries?.length ? cfg.countries.join("/") : "不限"}｜策略 ${cfg?.strategy}`,
    `目录 ${cfg?.dir}：${files.length ? files.join(" ") : "（空，本轮第一次跑）"}`,
    `节点源（按序）：${(cfg?.sources || []).join(" → ")}`,
  ];
}

/** 每槽的「设备名/路由表/优先级」对照表：内核侧出问题时按这张表查。 */
export function slotPlanLines({ cfg, nodes = [] } = {}) {
  return nodes.map((n, i) => `  槽 ${i}：${n.hostName}（${n.countryShort || "?"}）→ ${n.host}:${n.port}｜proto ${n.proto || "?"}｜设备 ${devNameFor(cfg.devPrefix, i)}｜表 ${tableFor(cfg.baseTable, i)}`);
}

/** 跑完（尤其是中途失败）后给全善后命令：设备与路由残留必须能一眼查清。 */
export function residualHints() {
  return [
    "ip -brief addr show type tun",
    "ip link show | grep -E 'mltun|tun'",
    "ip rule show | grep -E 'from (10\\.|192\\.|172\\.)' | head",
    "ip route show table all | grep -E 'mltun' | head",
  ];
}
