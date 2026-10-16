// warp-pool · 装配入口。
//
// 定位（见 MODULES.md §0）：WARP 池是**增量**出口，不是替代成员自身出口；
// 开关缺省即开（MSLXDFF_WARP_POOL 缺省 1；设 0 则零副作用）；只有组长（MSLXDFF_WARP_MODE=leader）才真建池。
//
// 关键约束：bootstrap（注册设备 + 起隧道）很慢（注册有 6–15s 间隔、可能退避 60–120s），
// 因此**绝不阻塞 daemon 启动**——createWarpPool 同步返回，dispatcher 先是空池（直连兜底），
// bootstrap 完成后 setNodes() 换上真实出口。
import { resolveWarpConfig } from "./config.js";
import { createRotatingDispatcher } from "./rotate.js";
import { createHealthMonitor } from "./health.js";
import { ensureDir, loadNodes, removeNode, saveNode } from "./nodes.js";
import { registerWarpDevice } from "./register.js";
import { ensureBinary, probeTunnel, resolveAsset, startTunnel, writeTunnelConf } from "./wireproxy.js";
/** 重拨节流：连续失败指数退避。缺省开之后，网络不通的机器绝不能让重注册把 CF 刷到 429。 */
const REDIAL_MIN_GAP_MS = 5 * 60_000;
const REDIAL_MAX_GAP_MS = 30 * 60_000;

/** 注册间隔（同类项目实测：密集注册会让设备落同一网段，且触发 CF 429）。 */
function gapMs(cfg, rnd = Math.random) {
  const span = Math.max(0, cfg.registerMaxGapMs - cfg.registerMinGapMs);
  return Math.round(cfg.registerMinGapMs + rnd() * span);
}


/**
 * 建池。开关缺省即开，故「未启用」= 显式 MSLXDFF_WARP_POOL=0 或 非 leader；那时返回 null，调用方据此不注入。
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

  const dispatcher = createRotatingDispatcher({ nodes: [], strategy: cfg.strategy, cooldownMs: cfg.cooldownMs, log });
  /** @type {Map<number, {stop: () => void}>} */
  const tunnels = new Map();
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

  async function bringUp(node) {
    writeTunnelConf(cfg.dir, node);
    if (tunnels.has(node.port)) return;
    const t = start({
      binPath,
      dir: cfg.dir,
      port: node.port,
      log,
      onExit: ({ port, code }) => {
        tunnels.delete(port);
        log(`[warp-pool] 隧道 :${port} 退出（code=${code}）`);
      },
    });
    tunnels.set(node.port, t);
  }

  async function bootstrap() {
    if (closed) return;
    ensureDir(cfg.dir);
    try {
      binPath = await ensureBin({ dir: cfg.dir, bin: cfg.bin, autodownload: cfg.autodownload, log });
    } catch (e) {
      const why = !cfg.bin && !resolveAsset()
        ? `本平台（${process.platform}-${process.arch}）无预编译 wireproxy，如需启用请设 MSLXDFF_WARP_BIN`
        : String(e?.message || e);
      log(`[warp-pool] 出口池跳过：${why}`);
      return;
    }
    if (closed) return;

    // 1. 复用磁盘上已注册的节点
    let nodes = loadNodes(cfg.dir, cfg.ports);
    log(`[warp-pool] 已有节点 ${nodes.length}/${cfg.count}`);

    // 2. 补足：逐个注册（拉长间隔，避免 CF 注册限流与同网段撞车）
    const used = new Set(nodes.map((n) => n.port));
    const free = cfg.ports.filter((p) => !used.has(p));
    for (const port of free) {
      if (closed) return;
      if (nodes.length >= cfg.count) break;
      try {
        if (nodes.length > 0) await wait(gapMs(cfg, rnd));
        const reg = await register({ log });
        const node = {
          port,
          id: reg.id,
          token: reg.token,
          v4: reg.v4,
          v6: reg.v6,
          endpoint: reg.endpoint,
          peerKey: reg.peerKey,
          privateKey: reg.privateKey,
          registeredAt: new Date(now()).toISOString(),
        };
        saveNode(cfg.dir, node);
        nodes.push(node);
        log(`[warp-pool] 注册节点 :${port}（v6=${reg.v6}）`);
      } catch (e) {
        log(`[warp-pool] 注册节点 :${port} 失败：${String(e?.message || e)}`);
      }
    }

    // 3. 起隧道
    for (const n of nodes) {
      try {
        await bringUp(n);
      } catch (e) {
        log(`[warp-pool] 起隧道 :${n.port} 失败：${String(e?.message || e)}`);
      }
    }

    // 4. **入池前实测探活**：只判「进程还活着」不够——WARP 握手不通时 wireproxy 进程照样在跑却转不动流量
    //    （实测经它 curl 挂到超时，不是快速失败）。那种节点一旦进池，dispatcher 会把**所有** opencode
    //    请求派给它 ⇒ opencode 整体被黑洞而非直连兜底。探活打上游 models 路径，不烧 token。
    const live = [];
    for (const n of nodes) {
      if (!tunnels.has(n.port)) continue;
      const r = await probe({ port: n.port, baseUrl, path: cfg.probePath });
      if (r.ok) live.push(n);
      else log(`[warp-pool] 节点 :${n.port} 隧道未通（${r.status || r.error || "?"}），不进池`);
    }
    if (live.length) {
      await dispatcher.setNodes(live.map((n) => ({ port: n.port, uri: `http://127.0.0.1:${n.port}` })));
      log(`[warp-pool] 出口池就绪：${live.length} 个节点`);
    } else {
      log("[warp-pool] 无可用节点，保持直连");
    }
  }

  const monitor = createHealthMonitor({
    dispatcher,
    baseUrl,
    probePath: cfg.probePath,
    log,
    onExhausted: async () => {
      // 重拨 = 重新注册 = 换新出口 IP（代价与限流见 MODULES.md）。
      // 隧道全活却探活全挂 ⇒ 网络路径问题（实测墙内到 CF 的 UDP 被选择性屏蔽），
      // 重注册换不来出路，只会把 CF 注册接口刷到 429 拉黑——故必须过 redialPlan 这道门。
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
          saveNode(cfg.dir, {
            port,
            id: reg.id,
            token: reg.token,
            v4: reg.v4,
            v6: reg.v6,
            endpoint: reg.endpoint,
            peerKey: reg.peerKey,
            privateKey: reg.privateKey,
            registeredAt: new Date(now()).toISOString(),
          });
          await bringUp({ port, ...reg });
        } catch (e) {
          log(`[warp-pool] 重拨 :${port} 失败：${String(e?.message || e)}`);
        }
        await wait(gapMs(cfg, rnd));
      }
      if (!closed && [...tunnels.keys()].length) {
        // 重拨确实把隧道拉起来了 ⇒ 退避复位，别让一次网络抖动永久拖慢恢复。
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
      };
    },
  };
}


/**
 * 只取轮换 dispatcher 的便捷入口（隧道进程由模块内的 process exit 钩子兜底清理）。
 * 未启用（开关关 / 非 leader）时返回 undefined —— 调用方直接透传即是"关闭态"。
 */
export function createWarpDispatcher(opts) {
  return createWarpPool(opts)?.dispatcher;
}

/**
 * 重拨门（纯函数，便于单测）：只有「有隧道进程已死」且「距上次重拨超过当前退避间隔」才放行。
 * 隧道全活却探活全挂 ⇒ 网络路径问题（实测：墙内到 CF 的 UDP 被选择性屏蔽），
 * 此时重拨换不来出路，只会把 CF 注册接口刷到 429 拉黑。
 * @returns {{ dead: number[], reason: "ok" | "all-alive" | "throttled" }}
 */
export function redialPlan({ ports = [], alivePorts = [], lastRedialAt = 0, redialGapMs = REDIAL_MIN_GAP_MS, now = Date.now } = {}) {
  const alive = new Set(alivePorts);
  const dead = ports.filter((p) => !alive.has(p));
  if (!dead.length) return { dead, reason: "all-alive" };
  if (now() - lastRedialAt < redialGapMs) return { dead, reason: "throttled" };
  return { dead, reason: "ok" };
}
