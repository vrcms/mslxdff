// warp-pool · 身份轮换：换一台 WARP 设备身份来换出口 IP。
//
// 依据（他项目真机实测，非推测）：kyomufs/zen-router 的 internal/zen/errors.go:32-42 记录
//   同一身份连发 3 次 → 429 FreeUsageLimitError；身份一换，同一个请求立刻 200
//   （104.28.198.244 → 429 ×3，104.28.198.247 → 200）。
// 故「多名额」的正解不是「N 台设备同时在线」（真机实测同时注册会折叠成同一个出口），
// 而是**串行换身份**：换一台设备 ⇒ 换一个出口 ⇒ 换一份按 IP 计的名额。
//
// 与 zen-router 对齐的三条纪律：
// 1. 轮换后**必须实测确认出口真的变了**；没变就整个 cycle 重试（它用 4 次，这里同）。
//    「注册成功」不等于「出口换了」——不校验就会拿同一个桶反复撞 429。
// 2. 同端口并发轮换去重 + 最小间隔，防 429 风暴把 CF 注册刷到限流（同类项目事故）。
// 3. 只轮换、不销毁别的节点：轮换失败保持原节点可用，绝不把池打空。
import { probeTunnel } from "./wireproxy.js";
import { EXIT_PROBE_URL, parseExitIp } from "./revive.js";

/** 经隧道读该端口真实出口地址（CF trace）；取不到返回 ""，绝不抛。 */
export async function readExitIp({ port, fetchImpl, timeoutMs = 12_000 } = {}) {
  try {
    const res = await probeTunnel({ port, baseUrl: EXIT_PROBE_URL, path: "", fetchImpl, timeoutMs, wantText: true });
    return typeof res?.text === "string" ? parseExitIp(res.text) : "";
  } catch {
    return "";
  }
}

/**
 * 身份轮换器。
 * @param {{ register: Function, apply: (node:object)=>Promise<void>, readIp?: Function,
 *           maxAttempts?: number, settleMs?: number, sleep?: Function, now?: Function,
 *           log?: (s:string)=>void }} opts
 *   apply 由调用方注入：把新身份落盘并起隧道（含停掉旧隧道）。
 */
export function createIdentityRotator({
  register,
  apply,
  readIp = readExitIp,
  maxAttempts = 4,
  settleMs = 3000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  log = () => {},
} = {}) {
  /** @type {Map<number, {ip:string, at:number}>} 各端口已知出口 */
  const known = new Map();
  /** @type {Map<number, Promise<object>>} 在途轮换（同端口去重） */
  const inflight = new Map();

  async function cycle(port, oldIp) {
    for (let i = 1; i <= maxAttempts; i++) {
      let reg;
      try {
        reg = await register({ log });
      } catch (e) {
        log(`[warp-pool] :${port} 轮换 ${i}/${maxAttempts}：注册失败（${String(e?.message || e).slice(0, 120)}）`);
        await sleep(settleMs);
        continue;
      }
      try {
        await apply({ port, ...reg });
      } catch (e) {
        log(`[warp-pool] :${port} 轮换 ${i}/${maxAttempts}：起隧道失败（${String(e?.message || e).slice(0, 120)}）`);
      }
      await sleep(settleMs);
      const ip = await readIp({ port });
      if (ip && ip !== oldIp) {
        known.set(port, { ip, at: now() });
        log(`[warp-pool] :${port} 身份已轮换：出口 ${oldIp || "?"} → ${ip}（第 ${i}/${maxAttempts} 次）`);
        return { ok: true, ip, attempts: i };
      }
      log(`[warp-pool] :${port} 轮换 ${i}/${maxAttempts}：出口未变（仍取到 ${ip || "空"}），重试`);
    }
    return { ok: false, attempts: maxAttempts };
  }

  return {
    /** 记下入池时的实测出口（bootstrap 取证后调用）。 */
    note(port, ip) {
      if (ip) known.set(port, { ip, at: now() });
    },
    /** 该端口当前已知出口（"" = 未知）。 */
    ipOf(port) {
      return known.get(port)?.ip || "";
    },
    /**
     * 轮换某节点身份换出口。同端口在途时返回同一个 Promise；minGapMs 内重复请求被掐
     * （429 风暴时每个失败请求都触发一次轮换会把 CF 刷黑）。
     * @returns {Promise<{ok:boolean, ip?:string, attempts?:number, skipped?:boolean}>}
     */
    rotate(port, { minGapMs = 60_000, force = false } = {}) {
      const dup = inflight.get(port);
      if (dup) return dup;
      const prev = known.get(port);
      if (!force && prev && now() - prev.at < minGapMs) {
        return Promise.resolve({ ok: false, skipped: true });
      }
      const p = cycle(port, prev?.ip || "")
        .catch((e) => {
          log(`[warp-pool] :${port} 轮换异常：${String(e?.message || e)}`);
          return { ok: false };
        })
        .finally(() => inflight.delete(port));
      inflight.set(port, p);
      return p;
    },

    /** 入池取证结果（labelExits 的分组）批量记账：每个节点的出口 IP 都要记住，轮换才能比对「是否真变了」。 */
    noteExits(groups) {
      for (const g of groups || []) for (const p of g.nodes || []) if (g.ip) known.set(p, { ip: g.ip, at: now() });
    },
    /** 轮换进行中 = 该节点正在换出口（调用方可据此避开它）。 */
    busy(port) {
      return inflight.has(port);
    },
    stats() {
      return [...known.entries()].map(([port, v]) => ({ port, ip: v.ip, at: v.at }));
    },
  };
}

/**
 * 把「429 → 换身份换出口」接进一个已建好的池。轮换窗口内**先把该节点冷却**（端口已停，
 * 请求过去必失败），换好再放回。依赖全由调用方注入，本模块不反向依赖池。
 * @returns {{note:Function, noteExits:Function, ipOf:Function, rotate:Function, busy:Function, stats:Function}}
 */
export function wireRotation({ dispatcher, register, tunnels, bringUp, swap = () => {}, log = () => {}, ...rest } = {}) {
  return createIdentityRotator({
    register,
    apply: async (node) => {
      const idx = dispatcher.entries().find((e) => e.port === node.port)?.index;
      if (idx !== undefined) dispatcher.markFailure(idx); // 轮换窗口内先冷却：端口已停，请求过去必失败
      tunnels.get(node.port)?.stop();
      tunnels.delete(node.port);
      swap(node.port, node);
      await bringUp(node);
      if (idx !== undefined) dispatcher.markOk(idx);
    },
    log,
    ...rest,
  });
}
