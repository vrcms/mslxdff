// v6pool · 装配入口（MODULES.md §0/§1）。
//
// 定位：**自动判断**本机有没有可用的 IPv6 池；有就启用（出口 = 池里的源地址），
// 没有就诚实跳过一行日志（行为与今天完全一致）。缺省开，MSLXDFF_V6_POOL=0 关。
//
// 与 WARP 池的关系：v6 池可用 ⇒ 不建 WARP 池（v6 严格更优：地址无限、零子进程、换址成本≈0）；
// 检测通过但探活全失败 ⇒ 池为空 ⇒ dispatcher 走直连兜底，日志点名 MSLXDFF_V6_POOL=0 可恢复 WARP。
import { getUndici } from "../compat.js";
import { resolveV6Config } from "./config.js";
import { detectPool } from "./detect.js";
import { createClaimer } from "./claim.js";
import { createV6Dispatcher } from "./rotate.js";
import { probeFrom } from "./probe.js";
import { randomAddress } from "./prefix.js";
import { fmtClose, fmtConfig, fmtDetect, fmtDisabled, fmtPool, fmtPoolEmpty, fmtProbe, fmtReadyFail, fmtSkip } from "./report.js";
import { createWarpDispatcher } from "../warp-pool/index.js";
import { createMultiIpDispatcher } from "../multi-ip-pool/index.js";

/** 每槽 Agent 的连接池参数。注入 dispatcher 后 transport 不建自带池（transport/index.js L28），所以必须自带。 */
export const AGENT_OPTIONS = { connections: 4, pipelining: 1, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 };

/** 初始地址集的去重重试上限（前缀足够大时一次就成）。 */
export const DISTINCT_TRIES = 16;

/**
 * 建池。检测不过 / 平台不支持 / 无权限 / undici 缺失 ⇒ 返回 null（调用方据此不注入、退回原行为）。
 * @returns {null | { dispatcher: object, ready: Promise<void>, config: object, detect: object,
 *                    close: () => Promise<void>, stats: () => object }}
 */
export function createV6Pool({ env = process.env, baseUrl = "https://opencode.ai", log = (m) => console.error(m), deps = {} } = {}) {
  const cfg = resolveV6Config(env);
  if (!cfg.enabled) {
    log(fmtDisabled());
    return null;
  }
  log(fmtConfig(cfg));

  const d = deps.detect ? deps.detect(cfg) : detectPool({ cfg, env });
  if (!d.ok) {
    log(fmtSkip(d));
    return null;
  }
  log(fmtDetect(d));

  const { Agent } = getUndici();
  if (typeof Agent !== "function") {
    log(fmtReadyFail({ error: "undici Agent 不可用（未安装 undici 且 Node <18）" }));
    return null;
  }

  const prefix = { addr: d.addr, bits: d.bits };
  const mine = new Set(d.mine || []);
  const agentFactory = deps.agentFactory || ((addr) => new Agent({ connect: { localAddress: addr }, ...AGENT_OPTIONS }));
  const claimer = deps.claimer ? deps.claimer(d) : createClaimer({ iface: d.iface, mode: d.mode, dir: cfg.dir, log });
  const probe = deps.probe || probeFrom;

  /** 挑一个池内地址：避开本机自己的全局地址（别把机器正在用的地址当"新"地址）。 */
  function pickAddress() {
    for (let i = 0; i < DISTINCT_TRIES; i++) {
      const a = randomAddress(prefix);
      if (!mine.has(a)) return a;
    }
    return randomAddress(prefix);
  }

  const dispatcher = createV6Dispatcher({
    addrs: [],
    strategy: cfg.strategy,
    retireMs: cfg.retireMs,
    rotate: cfg.rotate,
    debug: cfg.debug,
    log,
    claimer,
    pickAddress,
    agentFactory,
  });

  let closed = false;
  const ready = (async () => {
    try {
      await claimer.sweepStale();
      const addrs = [];
      const taken = new Set();
      for (let i = 0; i < cfg.count; i++) {
        if (closed) return;
        let a = pickAddress();
        for (let k = 0; k < DISTINCT_TRIES && taken.has(a); k++) a = pickAddress();
        await claimer.ensure(a);
        taken.add(a);
        addrs.push(a);
      }
      // 逐个实证探活：内核接受了地址 ≠ 机房把整段路由到本机。探不通的当场释放，绝不进池。
      const passed = [];
      for (let i = 0; i < addrs.length; i++) {
        if (closed) return;
        const r = await probe({ addr: addrs[i], baseUrl, path: cfg.probePath, agentFactory });
        log(fmtProbe({ addr: addrs[i], i: i + 1, n: addrs.length, ...r }));
        if (r.ok) passed.push(addrs[i]);
        else await claimer.release(addrs[i]);
      }
      if (!passed.length) {
        log(fmtPoolEmpty({ tried: addrs.length }));
        return;
      }
      dispatcher.setAddresses(passed);
      log(fmtPool({ prefix: d.prefix, addrs: passed, claimed: addrs.length, mode: d.mode }));
    } catch (e) {
      log(fmtReadyFail({ error: String(e?.message || e) }));
    }
  })();

  // 退出钩子：`process.on("exit")` 里只能跑同步代码，但地址必须清——加进网卡的地址会改变内核的
  // 默认源地址选择，影响同机其它服务（本轮手工实测踩过）。清不掉就交给下次启动的 sweepStale。
  if (deps.exitHook !== false) {
    process.once("exit", () => {
      try {
        claimer.releaseAllSync?.();
      } catch {
        /* 清残留兜底见 claim.js 的 sweepStale */
      }
    });
  }

  return {
    dispatcher,
    ready,
    config: cfg,
    detect: d,
    async close() {
      if (closed) return;
      closed = true;
      await dispatcher.close();
      const released = await claimer.releaseAll();
      log(fmtClose({ released }));
    },
    stats() {
      return { enabled: true, mode: d.mode, prefix: d.prefix, iface: d.iface, claimed: claimer.claimed(), ...dispatcher.stats() };
    },
  };
}

/**
 * 出口池三选一（唯一接线点用）：v6 池 → 多出口池 → WARP 池。
 * 三者都只产出一个 dispatcher 对象，注入点与契约完全一致（见 MODULES.md §1）。
 * 放在这里而不是 providers-setup：那里是 10KB 硬门下的文件，多一行都是风险。
 */
export function createPreferredDispatcher({ baseUrl = "https://opencode.ai", env = process.env, log, deps = {} } = {}) {
  const pool = createV6Pool({ env, baseUrl, log, deps });
  if (pool) return pool.dispatcher;
  // 次选：多出口池（VPNGate 免费 OpenVPN 节点当出口，只组长/单机建）——它给的是**另一批真实出口 IP**，
  // 而 v6 只是本机自带的那段地址，所以 v6 优先、它次之。任一不可用都安静跳过（各自打自己的日志）。
  const multi = createMultiIpDispatcher({ env, baseUrl, log, deps: deps.multiIp });
  if (multi) return multi;
  // 单向依赖：warp-pool 不 import v6pool（见 MODULES.md §2「已知耦合」）。
  return createWarpDispatcher({ baseUrl, env, log });
}

