// warp-pool · 复活与取证（真机事故后新增，2026-10-16）。
//
// 三件事，都来自组长 VPS 上暴露的缺陷：
//
// 1. 隧道退出后必须自愈：原先只有「全池不通」才补拉，一条死隧道会让池静默从 4 降到 3，直到 daemon 重启。
// 2. 入池后必须实测各节点真实出口：WARP 的 IPv4 出口是共享 NAT，「N 设备」很可能折叠成一个出口。
// 3. 复活必须**真的活下来**（2026-10-16 组长 VPS 事故）：`tunnels.has(port)` 只证明「spawn 被调用了」，
//    wireproxy 起一条死一条（端口被上一代孤儿进程占着 ⇒ bind 失败 ⇒ 退出码 1），旧逻辑次次判「已复活」
//    ⇒ 下一次退出立刻再复活 ⇒ 无限重启刷屏，该端口永远起不来。
//
// 复活只走**磁盘上已有的 conf**：进程挂了 ≠ 设备失效，重注册只会白烧 CF 配额。
import { probeTunnel } from "./wireproxy.js";

/** 出口取证目标：Cloudflare 自己的 trace 端点，回 `ip=` 一行（不烧上游 token）。 */
export const EXIT_PROBE_URL = "https://cloudflare.com/cdn-cgi/trace";

/** 从 cdn-cgi/trace 正文里取出口地址；取不到返回 ""。 */
export function parseExitIp(text) {
  const m = String(text || "").match(/^\s*ip=(\S+)\s*$/m);
  return m ? m[1] : "";
}

/** 子进程末行输出当退出原因（wireproxy 的真实报错都在 stderr）；没有输出返回 ""。 */
export function tailReason(tail, max = 300) {
  const lines = String(tail || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, max) : "";
}

/**
 * 按端口独立的退避复活器。
 * @param {{ revive: (port:number)=>Promise<boolean>, isAlive?: (port:number)=>boolean, minGapMs?: number,
 *           maxGapMs?: number, settleMs?: number, now?: ()=>number, sleep?: Function,
 *           schedule?: Function, cancel?: Function, log?: (s:string)=>void }} opts
 * 复活是否算数由 `isAlive` 在 `settleMs` 后复查；失败按指数退避并**自己用定时器安排下一次重试**。
 */
export function createReviver({ revive, isAlive, minGapMs = 30_000, maxGapMs = 10 * 60_000, settleMs = 1_200, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), schedule = (fn, ms) => setTimeout(fn, ms), cancel = (h) => clearTimeout(h), log = () => {} } = {}) {
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

  /** @type {Map<number, object>} 每端口最多一个待触发的重试定时器 */
  const timers = new Map();

  /** 安排「到点自动重试」；没有它，日志里那句「N s 后自动再试」就是空话。 */
  function armRetry(port, ms) {
    if (timers.has(port)) return;
    const h = schedule(() => {
      timers.delete(port);
      void attempt(port);
    }, Math.max(0, ms));
    if (h && typeof h.unref === "function") h.unref();
    timers.set(port, h);
  }

  /**
   * 复活一次：首次立即复活，失败按 30s→10min 指数退避并自己安排下一次重试。
   * 复活算不算数由 `isAlive` 在 `settleMs` 后复查——不许拿「spawn 被调用了」冒充「活下来了」。
   */
  async function attempt(port) {
    const s = entry(port);
    if (s.busy) return false;
    const wait = Math.max(0, s.nextAt - now());
    if (wait > 0) {
      log(`[warp-pool] :${port} 距上次复活不足退避间隔，${Math.ceil(wait / 1000)}s 后再试（防抖动刷屏，不是故障）`);
      armRetry(port, wait);
      return false;
    }
    s.busy = true;
    s.attempts += 1;
    const gap = Math.min(minGapMs * 2 ** (s.attempts - 1), maxGapMs);
    let ok = false;
    try {
      ok = await revive(port);
    } catch (e) {
      log(`[warp-pool] :${port} 复活抛出异常：${String(e?.message || e)}`);
    }
    if (ok && isAlive) {
      if (settleMs > 0) await sleep(settleMs);
      ok = isAlive(port);
      if (!ok) log(`[warp-pool] :${port} 复活后进程立刻又退出 —— 不认这次复活（原因见上面那条「意外退出」）`);
    }
    s.busy = false;
    if (ok) {
      const n = s.attempts;
      s.attempts = 0;
      s.nextAt = now() + minGapMs; // 稳定期：期间再退出先等一轮，防「起一条死一条」把日志刷爆
      log(`[warp-pool] :${port} 已复活（第 ${n} 次尝试成功）；${Math.round(minGapMs / 1000)}s 内若又退出会先等一轮再重启`);
      return true;
    }
    s.nextAt = now() + gap;
    const hint = s.attempts >= 3 ? ` 排查：ss -ltnp | grep :${port}；或前台跑隧道二进制 -c node-${port}.conf 看真实报错` : "";
    log(`[warp-pool] :${port} 复活未成功（第 ${s.attempts} 次），${Math.round(gap / 1000)}s 后自动再试。${hint}`);
    armRetry(port, gap);
    return false;
  }

  return {
    onExit: (port) => attempt(port),
    /** 探活成功时调用：清掉退避账与待触发定时器，恢复正常节奏。 */
    noteHealthy(port) {
      const h = timers.get(port);
      if (h) {
        try { cancel(h); } catch {}
        timers.delete(port);
      }
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

    /** 池关闭时调用：别再有定时器去打复活。 */
    stop() {
      for (const h of timers.values()) {
        try { cancel(h); } catch {}
      }
      timers.clear();
      state.clear();
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
    log(`[warp-pool] ⚠ 出口不分散：${groups[0].nodes.length} 条隧道同时在线只有 1 个出口地址（${groups[0].ip}）：免费版 WARP 的 IPv4 是共享 NAT，多开隧道换不到多份名额；多份名额靠撞 429 时的身份轮换`);
  } else if (groups.length > 1) {
    log(`[warp-pool] 出口分散：${groups.length} 个出口地址 / ${groups.reduce((a, g) => a + g.nodes.length, 0)} 条隧道同时在线（同时在线就有 ${groups.length} 份上游名额）`);
  }
  if (failed) log(`[warp-pool] ${failed} 个节点出口取证失败（不影响进池，只影响轮换时「出口到底变没变」的比对）`);
  return groups;
}
