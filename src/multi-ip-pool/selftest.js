// multi-ip-pool · 出口额度对照测试：回答「这台机器的直连出口撞 429 时，换成 VPNGate 出口还有没有额度」。
//
// 这才是多出口池的**唯一价值判据**（opencode 免费层按**出口 IP** 计额，见 docs/domain-notes.md §5）：
//   基线（直连）429 而某个 VPN 出口 200 ⇒ 池有用；VPN 出口也全 429 ⇒ 换 IP 抬不动（上游按别的东西计额）。
// 对照纪律：**除"从哪里出网"外一切相同** —— 同 URL / 同 UA / 同身份四件套 header / 同模型 /
//   同 `stream:true` + 五核心工具名；整轮共用同一个 session（免费层按出口 IP 计额，共用 session 才测得干净）。
// 请求形状**直接复用** `v6pool/selftest.js`（同一份免费层契约，绝不在两处各写一遍）。
import { getUndici } from "../compat.js";
import { genId } from "../opencode-identity.js";
import { DEFAULT_PROBE_MODEL, probeUpstreamFrom } from "../v6pool/selftest.js";
import { classifyWarpSignal } from "../warp-pool/verdict.js";
import { resolveMultiIpConfig, resolveRole } from "./config.js";
import { candidateNodes, loadNodeCache, materializeNode, writeAuthFile } from "./nodes.js";
import { fetchNodes, probeExitIp } from "./nodes-fetch.js";
import { bringUpTunnel, checkOpenvpn, isRoot, isSupportedPlatform, tearDownTunnel } from "./tunnel.js";
import { fmtExitIp, fmtNodePick, fmtNodes, fmtProbe } from "./report.js";
import { loadGroupsJoined } from "../state.js";

/** 采样上限：VPNGate 免费节点起隧道是秒级操作，别把测试拖成十几分钟。 */
export const MITEST_MAX = 8;
export const MITEST_DEFAULT = 3;

/**
 * 跑一次出口对照测试（本模块不打印，结构化返回给 CLI 渲染）。
 *
 * @param {{ env?: object, count?: number, model?: string, baseUrl?: string,
 *           onProgress?: (ev: object) => void,
 *           deps?: { joined?, platform?, supported?, isRoot?, checkOpenvpn?, loadNodeCache?, fetchNodes?,
 *                    materializeNode?, bringUpTunnel?, tearDownTunnel?, agentFactory?, probeExitIp?,
 *                    probeUpstream?, fetchImpl?, session?, log? }, slots?: object[] }} opts
 */
export async function runMultiIpCompare({ env = process.env, count = MITEST_DEFAULT, model = DEFAULT_PROBE_MODEL, baseUrl = "https://opencode.ai", onProgress, deps = {}, slots = null } = {}) {
  const cfg = resolveMultiIpConfig(env);
  const tick = (ev) => { try { onProgress?.(ev); } catch { /* 渲染出错不打断测试 */ } };
  const log = deps.log || (() => {});

  if (!cfg.enabled) return { status: "skip", reason: "多出口池已关闭（MSLXDFF_MULTI_IP_POOL=0）", hint: "去掉该 env 或设为 1 再跑" };
  const role = resolveRole({ mode: cfg.mode, joined: deps.joined ?? loadGroupsJoined() });
  if (!role.active) return { status: "skip", reason: `本节点角色是 ${role.role}（${role.why}）`, hint: "本功能只给组长做取证；组员请用组长那条出口" };
  const platform = deps.platform || process.platform;
  if (!(deps.supported ?? isSupportedPlatform(platform))) {
    return { status: "skip", reason: `本功能需要 Linux 的 tun 设备与策略路由（当前平台 ${platform}）`, hint: "在 Linux VPS 上跑；其它平台用 mslxdff -v6-pool 或 WARP 池" };
  }
  if (!(deps.isRoot ?? isRoot)()) {
    return { status: "skip", reason: "需要 root（建 tun 设备 + 装策略路由 + 写 rp_filter）", hint: "sudo mslxdff -multi-ip-pool test" };
  }
  const openvpn = await (deps.checkOpenvpn || checkOpenvpn)(cfg.openvpnBin);
  if (!openvpn.ok) return { status: "skip", reason: `${cfg.openvpnBin} 不可用（${openvpn.why}）`, hint: "apt install openvpn" };

  const { Agent } = getUndici();
  const agentFactory = deps.agentFactory || ((addr) => new Agent({ connect: { localAddress: addr }, connections: 1, keepAliveTimeout: 5_000 }));
  const probe = deps.probeUpstream || probeUpstreamFrom;
  const session = deps.session || genId("ses_");
  const materialize = deps.materializeNode || materializeNode;
  const startSlot = deps.bringUpTunnel || bringUpTunnel;
  const stopSlot = deps.tearDownTunnel || tearDownTunnel;
  const exitProbe = deps.probeExitIp || probeExitIp;

  // 节点表：优先用缓存（不重复打 VPNGate），取不到再拉。
  const cache = (deps.loadNodeCache || loadNodeCache)({ dir: cfg.dir, ttlMs: cfg.nodesTtlMs });
  let rows = cache?.rows || [];
  let source = cache?.source || "(本地缓存)";
  if (!rows.length) {
    try {
      const got = await (deps.fetchNodes || fetchNodes)({ sources: cfg.sources, dir: cfg.dir, timeoutMs: cfg.probeTimeoutMs, maxAgeMs: cfg.maxTableAgeMs, log });
      rows = got.rows;
      source = got.source;
    } catch (e) {
      return { status: "skip", reason: `节点表取不到：${String(e?.message || e)}`, hint: "在能连的机器上跑 `mslxdff -multi-ip-pool fetch` 抓一份表带过来，或设 MSLXDFF_MULTI_IP_NODES_FILE / _SOURCES" };
    }
  }
  tick({ phase: "nodes", source, total: rows.length });
  log(fmtNodes({ source, total: rows.length, countries: cfg.countries, minScore: cfg.minScore }));

  // ① 基线：直连（系统默认出口）打一条免费层请求
  tick({ phase: "baseline-start", model });
  const baseline = await probe({ addr: "", model, baseUrl, agentFactory, fetchImpl: deps.fetchImpl, session });
  tick({ phase: "baseline-done", ...baseline });
  // 候选：调用方给了 `slots` 就用它——CLI 侧已经「按簇取样 + TCP 预检」过，拨的必须就是探通的那些；
  // 没给才自己按 Score 取（单测与旧路径）。两边各挑一次会让「探的」与「拨的」不是同一批，预检就白做了。

  const picked = (Array.isArray(slots) && slots.length) ? slots.slice(0, MITEST_MAX) : candidateNodes({ rows, countries: cfg.countries, minScore: cfg.minScore, scan: Math.max(1, Math.min(MITEST_MAX, Number(count) || MITEST_DEFAULT)) });
  if (!picked.length) return { status: "skip", reason: "没有满足条件的候选节点（国家/Score 过滤后为空）", hint: "放宽 MSLXDFF_MULTI_IP_MIN_SCORE 或去掉 MSLXDFF_MULTI_IP_COUNTRY" };
  // auth 文件必须先落到磁盘再把路径交给 openvpn。取证路径以前把 `deps.authFile`（undefined）直接传下去
  // ⇒ `--auth-user-pass` 拿到空参数 ⇒ openvpn 判「选项缺参数」，只留一句「Use --help」——2026-10-25 真机三条槽全挂在这。
  const authFile = deps.authFile || (deps.writeAuthFile || writeAuthFile)({ dir: cfg.dir, user: cfg.authUser, pass: cfg.authPass });

  const exits = [];
  try {
    for (let i = 0; i < picked.length; i++) {
      const row = picked[i];
      const dev = `${cfg.devPrefix}${i}`;
      tick({ phase: "exit-start", i: i + 1, n: picked.length, row });
      log(fmtNodePick({ i: i + 1, n: picked.length, row, dev }));
      let slot = null;
      try {
        const node = materialize({ dir: cfg.dir, row });
        if (!node) throw new Error("节点配置解不开（base64 或 remote 缺失）");
        slot = await startSlot({ cfg, slotIndex: i, node, deps: { authFile, runCmdFn: deps.runCmdFn, spawnFn: deps.spawnFn, wait: deps.wait, log } });
        const exit = await exitProbe({ agent: agentFactory(slot.tunIp), timeoutMs: cfg.probeTimeoutMs });
        if (exit.ok) log(fmtExitIp({ dev: slot.dev, ip: exit.ip, ms: exit.ms }));
        // 从这条隧道的出口打**同一条**免费层请求
        const r = await probe({ addr: slot.tunIp, model, baseUrl, agentFactory, fetchImpl: deps.fetchImpl, session });
        log(fmtProbe({ dev: slot.dev, url: `${baseUrl.replace(/\/+$/, "")}/zen/v1/chat/completions`, ok: r.ok, status: r.status, error: r.error, ms: r.ms }));
        const entry = { ...r, hostName: row.hostName, country: row.countryShort, dev: slot.dev, exitIp: exit.ip || "" };
        exits.push(entry);
        tick({ phase: "exit-done", i: i + 1, n: picked.length, ...entry });
      } catch (e) {
        const entry = { hostName: row.hostName, country: row.countryShort, dev, ok: false, status: 0, kind: "network", ms: 0, exitIp: "", error: String(e?.message || e) };
        exits.push(entry);
        tick({ phase: "exit-done", i: i + 1, n: picked.length, ...entry });
      } finally {
        if (slot) await stopSlot({ slot, runCmdFn: deps.runCmdFn, log }).catch(() => {});
      }
    }
  } catch (e) {
    return { status: "skip", reason: `测试中断：${String(e?.message || e)}`, hint: "看 daemon.log 里的 [multi-ip-pool] 行" };
  }

  // ③ 判语：对照基线（受限 = 有 HTTP 响应但拿不到额度；只有 status=0 才算"够不着"）
  const baseLimited = baseline.status === 429 || ["free-quota", "free-tier", "ip-limit"].includes(baseline.kind);
  const ok = exits.filter((r) => r.ok);
  const limited = exits.filter((r) => !r.ok && r.status);
  const net = exits.filter((r) => !r.status);
  let verdict;
  if (ok.length && ok.length === exits.length) verdict = "multi-ip-works";
  else if (limited.length === exits.length) verdict = "multi-ip-also-limited";
  else if (net.length === exits.length) verdict = "multi-ip-unreachable";
  else verdict = "mixed";

  return {
    status: "ok",
    source, model, baseUrl, session,
    baseLimited,
    baseline,
    exits,
    requested: picked.length,
    okCount: ok.length,
    limitedCount: limited.length,
    netCount: net.length,
    verdict,
  };
}

/** 判语 → 人话（CLI 与测试共用一份，避免两处口径漂移）。 */
export const VERDICT_ZH = {
  "multi-ip-works": {
    text: "VPN 出口**能换到新额度**",
    next: "结论：多出口池对这台机器**有用**——直连出口耗尽时换隧道就能续。daemon 侧缺省已开。",
  },
  "multi-ip-also-limited": {
    text: "VPN 出口**也全受限**（换 IP 没换来新额度）",
    next: "结论：换出口治不了（要么上游不按出口 IP 计额，要么节点出口本身已被大量共用到撞额）。建议 MSLXDFF_MULTI_IP_POOL=0。",
  },
  "multi-ip-unreachable": {
    text: "VPN 出口**全都够不着上游**（隧道没转起来）",
    next: "结论：这些节点起不通或上游被墙。查 rp_filter / 节点可用性，或换 MSLXDFF_MULTI_IP_SOURCES / 加国家白名单。",
  },
  mixed: {
    text: "部分可用（有的出口有额度、有的没有）",
    next: "结论：池**部分可用**（免费节点质量参差，属正常）。够用即可开着。",
  },
};

/** 判语里的免费层分类（与生产判决同源：warp-pool/verdict.js）。 */
export function classifyOf(status, text = "") {
  return classifyWarpSignal({ status, text });
}