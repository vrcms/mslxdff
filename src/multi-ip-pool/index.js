// multi-ip-pool · 装配入口（MODULES.md §0/§2）：只做「门 + 接线 + 生命周期」，
// 拨号与体检在 dial.js、备选池在 standby.js、选槽与换槽在 dispatch.js（每件事各自可单测）。
//
// 定位：**只有组长启用的第三.种出口源**——用 VPNGate 免费 OpenVPN 节点换出口 IP，专供 opencode 免费层。
// 用户 2026-10-25 的四条裁决（本文件的形状就是这四条）：
//   ① 只有组长建池（组员与没带组的单机都不建，强开需显式 MODE=leader）；
//   ② 只有 Linux（tun 设备 + ip rule）；
//   ③ 定时预拨**不多于 5** 条备选 IP（缺省每小时重拨一批），429 一到立即启用备胎，不现场拨号；
//   ④ 启用备用 IP 时**打一个 hi 到 opencode.ai，要它 200** —— 没 200 的出口不算可用，也不配当备用。
//
// 门（任一不过 ⇒ 返回 null，调用方据此不注入，行为与未启用完全一致）：
//   开关 → 角色 → 平台 → root → openvpn 可执行（最后一条在 bootstrap 里判，绝不阻塞启动）。
import { resolveMultiIpConfig, resolveRole } from "./config.js";
import { createDialer } from "./dial.js";
import { createStandby } from "./standby.js";
import { createMultiIpDispatcher as createDispatcher } from "./dispatch.js";
import { writeAuthFile } from "./nodes.js";
import { checkOpenvpn, isRoot, isSupportedPlatform } from "./tunnel.js";
import { fmtClose, fmtConfig, fmtDisabled, fmtNoOpenvpn, fmtNoRoot, fmtPlatformSkip, fmtPool, fmtPoolEmpty, fmtRoleOk, fmtRoleSkip } from "./report.js";
import { loadGroupsJoined } from "../state.js";

/**
 * @param {{ env?: object, baseUrl?: string, log?: (s: string) => void,
 *           deps?: { joined?, platform?, supported?, isRoot?, checkOpenvpn?, authFile?, schedule?, cancel?,
 *                    bringUpTunnel?, tearDownTunnel?, materializeNode?, fetchNodes?, loadNodeCache?,
 *                    probeExitIp?, probeHi?, agentFactory?, fetchImpl?, runCmdFn?, spawnFn?, wait?, exitHook? } }} [opts]
 * @returns {null | { dispatcher, standby, ready, config, role, close, stats }}
 */
export function createMultiIpPool({ env = process.env, baseUrl = "https://opencode.ai", log = (m) => console.error(m), deps = {} } = {}) {
  const cfg = resolveMultiIpConfig(env);
  if (!cfg.enabled) {
    log(fmtDisabled());
    return null;
  }
  // ① 角色门：只有组长（裁决 2026-10-25，从"组长或单机"收紧为"只有组长"）
  const role = resolveRole({ mode: cfg.mode, joined: deps.joined ?? loadGroupsJoined() });
  if (!role.active) {
    log(fmtRoleSkip(role));
    return null;
  }
  // ② 平台门：只有 Linux
  const platform = deps.platform || process.platform;
  if (!(deps.supported ?? isSupportedPlatform(platform))) {
    log(fmtPlatformSkip({ platform, why: "本功能只在 Linux 上可用" }));
    return null;
  }
  // ③ 权限门
  if (!(deps.isRoot ?? isRoot)()) {
    log(fmtNoRoot());
    return null;
  }
  log(fmtConfig(cfg));
  log(fmtRoleOk(role));

  const dialer = createDialer({ cfg, baseUrl, log, deps });
  const standby = createStandby({ cfg, log, dialer, schedule: deps.schedule, cancel: deps.cancel, now: deps.now });
  let closed = false;

  const dispatcher = createDispatcher({
    slots: [],
    strategy: cfg.strategy,
    cooldownMs: cfg.cooldownMs,
    rotate: cfg.rotate,
    log,
    agentFactory: dialer.agentFactory,
    /**
     * 换出口（429 路径）：**先用备选池里已验通的备胎**（裁决③的"立即启用"），
     * 备胎为空才现场拨一条新的（拨号内部同样要过 hi 200 闸门）。
     * 旧隧道在拿到新出口**之后**才拆：换出口全程都有一条能用的出口，不把池打空。
     */
    rebuild: async (index, prev) => {
      const spare = cfg.standby ? await standby.take() : null;
      const opened = spare || (await dialer.openSlot(index, { dev: prev?.dev || "" }));
      if (!opened) throw new Error("备选池为空且候选节点都没通过 hi 验，本槽暂时没有出口");
      if (prev) await dialer.drop(prev, "换出口后拆旧隧道");
      return opened;
    },
  });

  async function bootstrap() {
    if (closed) return;
    const openvpn = await (deps.checkOpenvpn || checkOpenvpn)(cfg.openvpnBin, { runCmdFn: deps.runCmdFn });
    if (!openvpn.ok) {
      log(fmtNoOpenvpn({ bin: cfg.openvpnBin, why: openvpn.why }));
      return;
    }
    dialer.setAuthFile(deps.authFile || writeAuthFile({ dir: cfg.dir, user: cfg.authUser, pass: cfg.authPass }));

    try {
      await dialer.ensureCandidates();
    } catch (e) {
      log(fmtPoolEmpty({ tried: 0, why: `节点表取不到：${String(e?.message || e)}` }));
      return;
    }

    const slots = [];
    for (let i = 0; i < cfg.count; i++) {
      if (closed) return;
      const opened = await dialer.openSlot(i);
      if (!opened) break;
      slots.push(opened);
    }
    if (slots.length) {
      await dispatcher.setSlots(slots);
      log(fmtPool({ pooled: slots.length, tried: dialer.used.size, exits: slots.map((s) => s.exitIp || "(未取证)") }));
    } else {
      log(fmtPoolEmpty({ tried: dialer.used.size, why: "候选节点都没起通、或起来后 hi 拿不到 200（可能被墙 / 节点已下线 / 额度被同出口的其他人吃光）" }));
    }

    // ③ 备选池：正式槽成没成都要起（备胎本身就是"下一次 429 的出口"），并按小时刷新
    if (cfg.standby) {
      standby.start();
      void standby.refill({ force: true }).catch((e) => log(`[multi-ip-pool] 备选池首轮补位失败：${String(e?.message || e)}`));
    }
  }

  // 退出兜底：daemon 被强杀时 `exit` 钩子仍会跑；这里只能做同步事——把每条隧道的子进程都收掉
  // （openvpn 子进程留着 = 白占 tun 设备与策略路由表，下次启动还得人工清）。
  if (deps.exitHook !== false) {
    process.once("exit", () => {
      closed = true;
      for (const t of dialer.tunnels) {
        try {
          t.stop?.();
        } catch {
          /* 已经退了 */
        }
      }
    });
  }

  const ready = bootstrap().catch((e) => log(`[multi-ip-pool] bootstrap 失败：${String(e?.message || e)}`));

  return {
    dispatcher,
    standby,
    ready,
    config: cfg,
    role,
    async close() {
      if (closed) return;
      closed = true;
      await standby.stop().catch(() => {}); // 先停定时器，免得收摊路上又补出一批
      let failed = 0;
      const all = [...dialer.tunnels];
      for (const t of all) {
        try {
          await dialer.drop(t, "收摊");
        } catch {
          failed += 1;
        }
      }
      await dispatcher.close();
      log(fmtClose({ closed: all.length - failed, failed }));
    },
    stats() {
      return {
        enabled: true,
        role: role.role,
        count: cfg.count,
        standbyWant: cfg.standby,
        tunnels: dialer.tunnels.size,
        dir: cfg.dir,
        standby: standby.stats(),
        ...dispatcher.stats(),
      };
    },
  };
}

/** 只取 dispatcher 的便捷入口；未启用时返回 undefined（调用方直接透传即"关闭态"）。 */
export function createMultiIpDispatcher(opts) {
  return createMultiIpPool(opts)?.dispatcher;
}