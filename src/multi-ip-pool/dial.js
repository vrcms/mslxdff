// multi-ip-pool · 拨号与体检：候选队列 → 起一条隧道 → **打一个 hi 到上游要它 200** → 才算可用出口。
//
// 为什么"要 200"而不是"能连上就行"（用户 2026-10-25 定）：
//   这条池的唯一目的是**换新额度**。隧道起来了但那个 IP 已经没额度（429/403），拿它换出口等于白换——
//   所以判据必须是"这个出口现在真能出活"，即免费层 chat 打 `hi` 回 **200**。
//   请求形状复用 `v6pool/selftest.js`（`stream:true` + 五核心工具名 + 身份四件套）：缺任何一项上游回
//   **403 FreeTierError 而不是 429**，那测的是形状、不是额度（真机 2026-10-19 踩过）。
// 拆成独立模块的原因：装配（index）、拨号（本文件）、备选池（standby）三件事各自都要单测，混一起必超 10KB 门。
import { getUndici } from "../compat.js";
import { DEFAULT_PROBE_MODEL, probeUpstreamFrom } from "../v6pool/selftest.js";
import { candidateNodes, loadNodeCache, materializeNode } from "./nodes.js";
import { fetchNodes, probeExitIp } from "./nodes-fetch.js";
import { bringUpTunnel, tearDownTunnel } from "./tunnel.js";
import { AGENT_OPTIONS } from "./dispatch.js";
import { fmtExitIpFail, fmtHi, fmtNodePick, fmtNodes } from "./report.js";

/**
 * @param {{ cfg: object, baseUrl?: string, log?: Function, deps?: {
 *            bringUpTunnel?, tearDownTunnel?, materializeNode?, fetchNodes?, loadNodeCache?, probeExitIp?,
 *            probeHi?, agentFactory?, fetchImpl?, runCmdFn?, spawnFn?, wait?, authFile?, probeSession? } }} opts
 */
export function createDialer({ cfg, baseUrl = "https://opencode.ai", log = () => {}, deps = {} } = {}) {
  const startSlot = deps.bringUpTunnel || bringUpTunnel;
  const stopSlot = deps.tearDownTunnel || tearDownTunnel;
  const materialize = deps.materializeNode || materializeNode;
  const probeExit = deps.probeExitIp || probeExitIp;
  const probeHi = deps.probeHi || probeUpstreamFrom;
  const { Agent } = getUndici();
  const agentFactory = deps.agentFactory || ((addr) => new Agent({ connect: { localAddress: addr }, ...AGENT_OPTIONS }));

  /** 本拨号器起过的所有隧道（含备用的）：退出钩子与 close 都从这儿收，一条都不许漏。 */
  const tunnels = new Set();
  const used = new Set(); // 已试过的节点（含正在用的）：绝不重复拨同一台
  let pending = [];
  let source = "(未取表)";
  let authFile = deps.authFile || "";

  function setAuthFile(f) {
    authFile = f || "";
  }

  /** 探额度用的免费模型（上游不同模型额度池可能独立，需要时可换）。 */
  function probeModel() {
    return cfg.probeModel || DEFAULT_PROBE_MODEL;
  }

  /**
   * 「打一个 hi，要 200」：一发请求同时拿两个读数——**有没有额度**（status）与**真实出口 IP**（取证）。
   * @returns {Promise<{ok: boolean, status: number, kind: string, ms: number, ip: string, error: string}>}
   */
  async function hiProbe(entry) {
    const r = await probeHi({
      addr: entry.tunIp,
      model: probeModel(),
      baseUrl,
      agentFactory,
      fetchImpl: deps.fetchImpl,
      session: deps.probeSession,
    });
    let ip = entry.exitIp || "";
    if (!ip) {
      const agent = agentFactory(entry.tunIp);
      try {
        const e = await probeExit({ agent, timeoutMs: cfg.probeTimeoutMs, fetchImpl: deps.fetchImpl });
        ip = e.ip || "";
      } finally {
        try {
          await agent.close?.();
        } catch {
          /* 一次性 Agent */
        }
      }
    }
    return { ok: Boolean(r.ok), status: Number(r.status) || 0, kind: r.kind || "", ms: Number(r.ms) || 0, ip, error: r.error || "" };
  }

  /** 取节点表 → 候选队列（按 Score 降序，剔除已用过的）；`force` = 绕过缓存重取（每小时刷新备选池用）。 */
  async function ensureCandidates({ force = false } = {}) {
    if (!force && pending.length) return pending.length;
    let rows = [];
    if (!force) {
      const cache = (deps.loadNodeCache || loadNodeCache)({ dir: cfg.dir, ttlMs: cfg.nodesTtlMs });
      if (cache?.rows?.length) {
        rows = cache.rows;
        source = cache.source || "(本地缓存)";
      }
    }
    if (!rows.length) {
      const got = await (deps.fetchNodes || fetchNodes)({ sources: cfg.sources, dir: cfg.dir, timeoutMs: cfg.probeTimeoutMs, log });
      rows = got.rows;
      source = got.source;
    }
    pending = candidateNodes({ rows, countries: cfg.countries, minScore: cfg.minScore, skip: used, scan: cfg.scan * (cfg.count + cfg.standby + 1) });
    log(fmtNodes({ source, total: rows.length, countries: cfg.countries, minScore: cfg.minScore }));
    return pending.length;
  }

  /** 拆一条隧道并忘掉它（先撤策略路由再收子进程，见 tunnel.js）。 */
  async function drop(entry, why = "") {
    if (!entry) return;
    tunnels.delete(entry);
    try {
      await stopSlot({ slot: entry, runCmdFn: deps.runCmdFn, log });
    } catch (e) {
      log(`[multi-ip-pool] ${entry.dev} 拆隧道没拆干净：${String(e?.message || e)}${why ? `（${why}）` : ""}`);
    }
  }

  /**
   * 开一个出口：按序试候选，每个都走「起隧道 → hi 要 200」，**不 200 当场拆掉换下一个**。
   * 为什么这道闸门必须有：隧道进程活着但转不动流量、或那个 IP 早已没额度时，把它塞进池等于
   * 把请求挂到超时或继续 429——比直连更糟（与 WARP 池 probeGate 同一纪律）。
   * @returns {Promise<null | { dev, table, priority, tunIp, pid, stop, node, exitIp }>}
   */
  async function openSlot(slotIndex, { dev = "", gate = true } = {}) {
    for (let attempt = 1; attempt <= cfg.scan; attempt++) {
      if (!pending.length) {
        try {
          await ensureCandidates();
        } catch (e) {
          log(`[multi-ip-pool] 取节点表失败：${String(e?.message || e)}`);
          return null;
        }
        if (!pending.length) return null;
      }
      const row = pending.shift();
      if (!row || used.has(row.hostName)) continue;
      used.add(row.hostName);
      log(fmtNodePick({ i: attempt, n: cfg.scan, row, dev }));
      let slot = null;
      try {
        let node = row;
        if (!node.conf) {
          node = materialize({ dir: cfg.dir, row });
          if (!node) throw new Error("节点配置解不开（base64 或 remote 缺失）");
        }
        slot = await startSlot({
          cfg,
          slotIndex,
          node,
          deps: { authFile, runCmdFn: deps.runCmdFn, spawnFn: deps.spawnFn, wait: deps.wait, log, onExit: () => tunnels.delete(slot) },
        });
        tunnels.add(slot);
        const p = await hiProbe(slot);
        log(fmtHi({ dev: slot.dev, model: probeModel(), ip: p.ip, ...p }));
        if (!p.ip) log(fmtExitIpFail({ dev: slot.dev, error: p.error || "出口取证无响应" }));
        if (gate && p.status !== 200) {
          await drop(slot, "hi 未回 200");
          continue;
        }
        return { ...slot, node, exitIp: p.ip || "" };
      } catch (e) {
        await drop(slot);
        log(`[multi-ip-pool] ${slot?.dev || `${cfg.devPrefix}${slotIndex}`} 起隧道失败：${String(e?.message || e)}`);
      }
    }
    return null;
  }

  return {
    tunnels,
    agentFactory,
    used,
    setAuthFile,
    probeModel,
    hiProbe,
    ensureCandidates,
    openSlot,
    drop,
    get sourceLabel() {
      return source;
    },
    get pendingCount() {
      return pending.length;
    },
  };
}