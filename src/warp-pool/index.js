// warp-pool · 装配入口。
//
// 定位（MODULES.md §0/§10）：WARP 池是**增量**出口，不是替代成员自身出口；缺省**开**，MSLXDFF_WARP_POOL=0 关。
import { resolveWarpConfig } from "./config.js";
import { createRotatingDispatcher } from "./rotate.js";
import { createHealthMonitor } from "./health.js";
import { ensureDir, loadNodes, removeNode, saveNode } from "./nodes.js";
import { registerWarpDevice } from "./register.js";
import { ensureBinary, probeTunnel, resolveAsset, startTunnel, writeTunnelConf } from "./wireproxy.js";
import { createReviver, labelExits, tailReason } from "./revive.js";
import { portInUse, reclaimPort } from "./ports.js";
import { wireRotation } from "./identity.js";

/** 重拨节流：连续失败指数退避。网络不通的机器绝不能让重注册把 CF 刷到 429。 */
const REDIAL_MIN_GAP_MS = 5 * 60_000;
const REDIAL_MAX_GAP_MS = 30 * 60_000;

/** 注册间隔（同类项目实测：密集注册会让设备落同一网段，且触发 CF 429）。 */
function gapMs(cfg, rnd = Math.random) {
  const span = Math.max(0, cfg.registerMaxGapMs - cfg.registerMinGapMs);
  return Math.round(cfg.registerMinGapMs + rnd() * span);
}

/** 注册响应 → 节点对象（bootstrap 与重拨共用，避免同一份字段表写两遍）。 */
function nodeFromReg(port, reg, now) {
  return { port, id: reg.id, token: reg.token, v4: reg.v4, v6: reg.v6, endpoint: reg.endpoint, peerKey: reg.peerKey, privateKey: reg.privateKey, registeredAt: new Date(now()).toISOString() };
}

/**
 * 建池。开关缺省关，故「未启用」= 未设 MSLXDFF_WARP_POOL=1 或 非 leader；那时返回 null，调用方据此不注入。
 * @returns {null | { dispatcher: object, ready: Promise<void>, close: () => Promise<void>, stats: () => object }}
 */
export function createWarpPool({
  env = process.env,
  baseUrl = "https://opencode.ai",
  log = (m) => console.error(m),
  register = registerWarpDevice,
  ensureBin = ensureBinary,
  start = startTunnel,
  probe = probeTunnel,
  now = Date.now,
  rnd = Math.random,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const cfg = resolveWarpConfig(env);
  if (!cfg.active) return null;

  /** 身份轮换器：429 时换一台 WARP 设备换出口 IP（串行换身份，见 identity.js 头注）。 */
  let rotator = null;

  const dispatcher = createRotatingDispatcher({ nodes: [], strategy: cfg.strategy, cooldownMs: cfg.cooldownMs, log, onStatus: (status, port) => { if (status === 429 && cfg.rotate && rotator) void rotator.rotate(port); } });
  /** @type {Map<number, {stop: () => void}>} */
  const tunnels = new Map();

  /** 复活：用磁盘已有 conf 重起，不重注册（进程挂了 ≠ 设备失效，省 CF 配额）。 */
  async function reviveTunnel(port) {
    if (closed) return false;
    const node = loadNodes(cfg.dir, [port])[0];
    if (!node) {
      log(`[warp-pool] :${port} 放弃复活：磁盘上没有该节点的身份（node-${port}.json 缺失或缺私钥）`);
      return false;
    }
    try {
      await bringUp(node);
    } catch (e) {
      log(`[warp-pool] :${port} 复活起隧道失败：${String(e?.message || e)}`);
      return false;
    }
    return true; // 真活没活由 createReviver 在 settleMs 后用 isAlive 复查，这里不许冒充成功
  }
  const reviver = createReviver({ revive: reviveTunnel, isAlive: (port) => { const t = tunnels.get(port); return !!t && t.alive !== false; }, log });
  let binPath = "";
  let closed = false;
  let lastRedialAt = 0;
  let redialGapMs = REDIAL_MIN_GAP_MS;

  // 兜底清理：Node 退出不会回收 spawn 的子进程，daemon 突然退出时同步杀掉隧道。
  process.once("exit", () => {
    for (const t of tunnels.values()) {
      try {
        t.stop();
      } catch {}
    }
  });

  /** 起一条隧道的完整动作：清残留 → 写 conf → 确认端口真空着 → spawn → 记表。 */
  async function bringUp(node) {
    await reclaimPort({ dir: cfg.dir, port: node.port, log }); // 清上一代孤儿（daemon 被强杀时子进程不会自己退）
    writeTunnelConf(cfg.dir, node);
    if (tunnels.has(node.port)) return;
    if (await portInUse(node.port)) {
      throw new Error(`端口 :${node.port} 已被非本池进程占用，拒绝再起（硬起只会 bind 失败、无限重启刷屏）`);
    }
    const t = start({
      binPath,
      dir: cfg.dir,
      port: node.port,
      log,
      onExit: ({ port, code, signal, tail }) => {
        tunnels.delete(port);
        const why = tailReason(tail) || "进程没留下任何输出";
        log(`[warp-pool] :${port} 隧道意外退出（退出码 ${code}${signal ? `，信号 ${signal}` : ""}）：${why}`);
        void reviver.onExit(port);
      },
    });
    tunnels.set(node.port, t);
    log(`[warp-pool] :${node.port} 隧道已起：HTTP 代理 http://127.0.0.1:${node.port} → 经 WARP 出网（pid ${t.pid ?? "?"}）`);
  }

  // 429 ＝ 上游按出口 IP 计的名额耗尽 ⇒ 换一台设备的身份换出口（换身份＝换桶）。
  rotator = wireRotation({
    dispatcher,
    register,
    tunnels,
    bringUp,
    swap: (port, node) => { removeNode(cfg.dir, port); saveNode(cfg.dir, node); },
    log,
  });

  async function bootstrap() {
    if (closed) return;
    ensureDir(cfg.dir);
    try {
      binPath = await ensureBin({ dir: cfg.dir, bin: cfg.bin, autodownload: cfg.autodownload, log });
    } catch (e) {
      const why = !cfg.bin && !resolveAsset()
        ? `本平台（${process.platform}-${process.arch}）无预编译 wireproxy，如需启用请设 MSLXDFF_WARP_BIN`
        : String(e?.message || e);
      log(`[warp-pool] 出口池本次跳过（不启用，请求走直连）：${why}`);
      return;
    }
    if (closed) return;

    // 1. 复用磁盘上已注册的节点
    let nodes = loadNodes(cfg.dir, cfg.ports);
    log(`[warp-pool] 复用磁盘上已注册的身份 ${nodes.length}/${cfg.count} 个（端口 ${cfg.ports.join(", ")}；缺的现场注册）`);

    // 2. 补足：逐个注册（拉长间隔，避免 CF 注册限流与同网段撞车）
    const used = new Set(nodes.map((n) => n.port));
    const free = cfg.ports.filter((p) => !used.has(p));
    for (const port of free) {
      if (closed) return;
      if (nodes.length >= cfg.count) break;
      try {
        if (nodes.length > 0) await wait(gapMs(cfg, rnd));
        const reg = await register({ log });
        const node = nodeFromReg(port, reg, now);
        saveNode(cfg.dir, node);
        nodes.push(node);
        log(`[warp-pool] 注册新身份 :${port} 成功（设备 v6=${reg.v6}，WireGuard 密钥对在本地生成）`);
      } catch (e) {
        log(`[warp-pool] :${port} 注册身份失败，本轮跳过这个端口：${String(e?.message || e)}`);
      }
    }

    // 3. 起隧道
    for (const n of nodes) {
      try {
        await bringUp(n);
      } catch (e) {
        log(`[warp-pool] :${n.port} 起隧道失败，这个端口本轮不可用：${String(e?.message || e)}`);
      }
    }

    // 入池前实测探活：WARP 握手不通时 wireproxy 进程照样在跑却转不动流量（挂到超时），那种节点进池会黑洞全部请求
    const live = [];
    for (const n of nodes) {
      if (!tunnels.has(n.port)) continue;
      const r = await probe({ port: n.port, baseUrl, path: cfg.probePath });
      if (r.ok) live.push(n);
      else log(`[warp-pool] :${n.port} 隧道没探通（${r.status || r.error || "?"}），不进池：进池会把请求挂到超时，比直连更糟`);
    }
    if (live.length) {
      await dispatcher.setNodes(live.map((n) => ({ port: n.port, uri: `http://127.0.0.1:${n.port}` })));
      log(`[warp-pool] 出口池就绪：${live.length} 条隧道可用（选路策略 ${cfg.strategy}${cfg.rotate ? "，撞 429 会自动换身份换出口" : ""}）`);
    } else {
      log("[warp-pool] 没有一条隧道探通 ⇒ 池为空，全部请求照旧直连（不影响可用性，只是没多出口）");
    }

    // 5. 出口取证：把每台设备的真实出口地址打进日志（免费版 WARP 的 IPv4 是共享 NAT，N 台设备很可能折叠成同一个出口）
    if (live.length) rotator.noteExits(await labelExits({ ports: live.map((n) => n.port), log }));
  }

  const monitor = createHealthMonitor({
    dispatcher,
    baseUrl,
    probePath: cfg.probePath,
    log,
    onExhausted: async () => {
      // 重拨 = 重新注册换出口。只重拨「进程已死」的隧道：全活却全挂 = 网络路径问题，重注册只会把 CF 刷到 429
      const plan = redialPlan({ ports: cfg.ports, alivePorts: [...tunnels.keys()], lastRedialAt, redialGapMs, now });
      if (plan.reason === "all-alive") {
        log("[warp-pool] 隧道均存活但全池不通，判定为网络路径问题，跳过重拨");
        return;
      }
      if (plan.reason === "throttled") {
        log(`[warp-pool] 距上次重拨不足 ${Math.round(redialGapMs / 1000)}s，跳过本轮`);
        return;
      }
      const dead = plan.dead;
      lastRedialAt = now();
      redialGapMs = Math.min(redialGapMs * 2, REDIAL_MAX_GAP_MS);
      log(`[warp-pool] ${dead.length} 条隧道已死，重拨（下次最短间隔 ${Math.round(redialGapMs / 1000)}s）`);
      for (const port of dead) {
        if (closed) return;
        try {
          tunnels.get(port)?.stop();
          tunnels.delete(port);
          removeNode(cfg.dir, port);
          const reg = await register({ log });
          saveNode(cfg.dir, nodeFromReg(port, reg, now));
          await bringUp({ port, ...reg });
        } catch (e) {
          log(`[warp-pool] 重拨 :${port} 失败：${String(e?.message || e)}`);
        }
        await wait(gapMs(cfg, rnd));
      }
      if (!closed && [...tunnels.keys()].length) {
        // 重拨确实把隧道拉起来了 ⇒ 退避复位
        redialGapMs = REDIAL_MIN_GAP_MS;
        await dispatcher.setNodes([...tunnels.keys()].map((port) => ({ port, uri: `http://127.0.0.1:${port}` })));
      }
    },
  });

  const ready = bootstrap()
    .then(() => {
      if (!closed) monitor.start();
    })
    .catch((e) => log(`[warp-pool] bootstrap 失败：${String(e?.message || e)}`));

  return {
    dispatcher,
    ready,
    config: cfg,
    async close() {
      if (closed) return;
      closed = true;
      monitor.stop();
      reviver.stop();
      for (const t of tunnels.values()) {
        try {
          t.stop();
        } catch {}
      }
      tunnels.clear();
      await dispatcher.close();
    },
    stats() {
      return {
        enabled: true,
        mode: cfg.mode,
        strategy: cfg.strategy,
        dir: cfg.dir,
        tunnels: tunnels.size,
        nodes: dispatcher.stats(),
        exits: rotator ? rotator.stats() : [],
      };
    },
  };
}

/** 只取轮换 dispatcher 的便捷入口；未启用时返回 undefined（调用方直接透传即"关闭态"）。 */
/** 隧道进程由模块内的 process exit 钩子兜底清理。 */
export function createWarpDispatcher(opts) {
  return createWarpPool(opts)?.dispatcher;
}

/**
 * 重拨门（纯函数，便于单测）：只「有隧道进程已死」且「距上次重拨超过退避间隔」才放行——全活却全挂是网络问题。
 * @returns {{ dead: number[], reason: "ok" | "all-alive" | "throttled" }}
 */
export function redialPlan({ ports = [], alivePorts = [], lastRedialAt = 0, redialGapMs = REDIAL_MIN_GAP_MS, now = Date.now } = {}) {
  const alive = new Set(alivePorts);
  const dead = ports.filter((p) => !alive.has(p));
  if (!dead.length) return { dead, reason: "all-alive" };
  if (now() - lastRedialAt < redialGapMs) return { dead, reason: "throttled" };
  return { dead, reason: "ok" };
}
