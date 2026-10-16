// warp-pool · 复活与取证（真机事故后新增，2026-10-16）。
//
// 两件事，都来自组长 VPS 上暴露的缺陷：
//
// 1. `revive`: 隧道进程意外退出后**必须自愈**。原先 `onExit` 只把端口从表里删掉、打一行日志就完事，
//    而唯一的补拉路径 `onExhausted` 要求「全池不通」——3 条活着时探活一直成功，那条死隧道
//    就**再也不会被拉起**，池静默从 4 降到 3，直到 daemon 重启。（真机：:10800 死了就一直死。）
//    注意：复活走**磁盘上已有的 conf**（不重新注册）——进程挂了不代表设备失效，重注册只会白烧 CF 配额。
//
// 2. `labelExits`: 入池后实测各节点**真实出口地址**并标注撞车。WARP 的 IPv4 出口是共享 NAT，
//    「N 设备」很可能折叠成一个出口；没有这条读数就只能靠人手工 curl 才发现。
import { probeTunnel } from "./wireproxy.js";

/** 出口取证目标：Cloudflare 自己的 trace 端点，回 `ip=` 一行（不烧上游 token）。 */
export const EXIT_PROBE_URL = "https://cloudflare.com/cdn-cgi/trace";

/** 从 cdn-cgi/trace 正文里取出口地址；取不到返回 ""。 */
export function parseExitIp(text) {
  const m = String(text || "").match(/^\s*ip=(\S+)\s*$/m);
  return m ? m[1] : "";
}

/**
 * 按端口独立的退避复活器。
 * @param {{ revive: (port:number)=>Promise<boolean>, minGapMs?: number, maxGapMs?: number,
 *           now?: ()=>number, log?: (s:string)=>void }} opts
 */
export function createReviver({ revive, minGapMs = 30_000, maxGapMs = 10 * 60_000, now = Date.now, log = () => {} } = {}) {
  /** @type {Map<number, {attempts:number, nextAt:number, busy:boolean}>} */
  const state = new Map();

  function entry(port) {
    let s = state.get(port);
    if (!s) {
      s = { attempts: 0, nextAt: 0, busy: false };
      state.set(port, s);
    }
    return s;
  }

  return {
    /** 进程退出时调用。首次立即复活，之后按 30s→10min 指数退避。 */
    async onExit(port) {
      const s = entry(port);
      const wait = Math.max(0, s.nextAt - now());
      if (wait > 0) {
        log(`[warp-pool] :${port} 复活退避中（还剩 ${Math.round(wait / 1000)}s）`);
        return false;
      }
      if (s.busy) return false;
      s.busy = true;
      s.attempts += 1;
      const gap = Math.min(minGapMs * 2 ** (s.attempts - 1), maxGapMs);
      s.nextAt = now() + gap;
      let ok = false;
      try {
        ok = await revive(port);
      } catch (e) {
        log(`[warp-pool] :${port} 复活失败：${String(e?.message || e)}`);
      }
      s.busy = false;
      if (ok) {
        state.delete(port);
        log(`[warp-pool] :${port} 已复活`);
      } else {
        log(`[warp-pool] :${port} 复活未成功（第 ${s.attempts} 次，下次最早 ${Math.round(gap / 1000)}s 后）`);
      }
      return ok;
    },
    /** 探活成功时调用：清掉退避账，恢复正常节奏。 */
    noteHealthy(port) {
      state.delete(port);
    },
    stats() {
      return [...state.entries()].map(([port, s]) => ({
        port,
        attempts: s.attempts,
        nextAt: s.nextAt,
        cooldownMsLeft: Math.max(0, s.nextAt - now()),
      }));
    },
  };
}

/**
 * 入池后实测各节点真实出口地址并打日志（含撞车警告）。
 * 只读探测：打 Cloudflare 的 trace 端点，不碰上游配额。
 * @returns {Promise<{ ip: string, nodes: number[] }[]>} 按出口地址分组的节点清单
 */
export async function labelExits({ ports = [], fetchImpl, timeoutMs = 12_000, log = () => {} } = {}) {
  const byIp = new Map();
  let failed = 0;
  for (const port of ports) {
    let ip = "";
    try {
      const res = await probeTunnel({ port, baseUrl: EXIT_PROBE_URL, path: "", fetchImpl, timeoutMs, wantText: true });
      ip = typeof res?.text === "string" ? parseExitIp(res.text) : "";
    } catch {
      ip = "";
    }
    if (!ip) {
      failed += 1;
      continue;
    }
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(port);
  }

  const groups = [...byIp.entries()].map(([ip, nodes]) => ({ ip, nodes }));
  if (groups.length === 1) {
    log(`[warp-pool] ⚠ 出口不分散：${groups[0].nodes.length} 个节点共用同一个出口 ${groups[0].ip}（免费版 WARP 的 IPv4 是共享 NAT）`);
  } else if (groups.length > 1) {
    log(`[warp-pool] 出口分散：${groups.length} 个不同地址 / ${groups.reduce((a, g) => a + g.nodes.length, 0)} 个节点`);
  }
  if (failed) log(`[warp-pool] ${failed} 个节点出口取证失败（不影响其进池）`);
  return groups;
}
