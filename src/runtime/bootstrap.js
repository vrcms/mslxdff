import { appendCall, appendError, appendEvent, appendTimeline } from "../logs.js";
import { setupProviders } from "./providers-setup.js";
import { startServerLifecycle } from "./server-lifecycle.js";
import { appendModelTrace } from "../model-trace.js";
import { startGroupSync } from "./group-sync.js";
import { startBroadband } from "./broadband.js";
import { installLogStamp } from "./log-stamp.js";

const logs = { appendCall, appendError, appendEvent, appendTimeline, appendModelTrace };

/**
 * daemon 启动门面 — 仅编排：组装世界 → 服务生命周期 → 群组同步 → 宽带中继 → 自更新。
 * 重活下沉 providers-setup / server-lifecycle / group-sync / broadband(-stream)。
 */
export async function startDaemonMain(VERSION) {
  // 每行带 [时间 pid]：一份 daemon.log 被多进程/多版本写过时，这是唯一能回答「谁写的、哪一轮」的东西
  if (process.env.MSLXDFF_DAEMON === "1") installLogStamp();
  const { installLifecycleLog } = await import("./lifecycle-log.js");
  installLifecycleLog({ version: VERSION, logs });
  // 接管：内存里若还有旧的 mslxdff daemon，先请它退出。它不在 daemon.pid 里（-restart 结构性碰不到它），
  // 两个 daemon 会互抢 warp-pool 的端口（真机 2026-10-17：旧 daemon 活了一整天，日志只显示「起一条死一条」）。
  // 必须早于 setupProviders —— 那一步才建池抢端口。debug 前台有自己的收口逻辑，不在这里抢。
  if (process.env.MSLXDFF_DAEMON === "1" && process.env.MSLXDFF_DEBUG !== "1") {
    try {
      const { takeoverOlderDaemons } = await import("../daemon.js");
      const r = await takeoverOlderDaemons({ log: (m) => console.log(m) });
      if (!r.killed.length && !r.skipped.length && !r.remaining.length) {
        console.log("[daemon] 内存里没有别的 mslxdff daemon（扫过一遍 /proc）—— 本进程独占出口池端口");
      }
    } catch (e) {
      console.log(`[daemon] 接管旧 daemon 失败（不阻断启动）：${String(e?.message || e)}`);
    }
  }
  const ctx = await setupProviders();
  const { srv, bus } = await startServerLifecycle({ VERSION, ...ctx, logs });
  void srv;
  startGroupSync({ peers: ctx.peers, groups: ctx.groups, logs });
  startBroadband({ token: ctx.token, upstream: ctx.upstream });

  const { setupAutoUpdate } = await import("./auto-update.js");
  setupAutoUpdate({ VERSION, bus, logs });

  const { setupWorkbuddyCheckin } = await import("./workbuddy-checkin.js");
  void setupWorkbuddyCheckin({ bus, logs }).catch((e) => {
    try { logs.appendEvent({ ts: Date.now(), type: "workbuddy-checkin-setup-failed", error: String(e?.message || e).slice(0, 200) }); } catch {}
  });

  const { setupTraeworkCheckin } = await import("./traework-checkin.js");
  void setupTraeworkCheckin({ bus, logs }).catch((e) => {
    try { logs.appendEvent({ ts: Date.now(), type: "traework-checkin-setup-failed", error: String(e?.message || e).slice(0, 200) }); } catch {}
  });

  const { setupQoderCheckin } = await import("./qoder-checkin.js");
  void setupQoderCheckin({ bus, logs }).catch((e) => {
    try { logs.appendEvent({ ts: Date.now(), type: "qoder-checkin-setup-failed", error: String(e?.message || e).slice(0, 200) }); } catch {}
  });

  const { setupRaccoonCheckin } = await import("./raccoon-checkin.js");
  void setupRaccoonCheckin({ bus, logs }).catch((e) => {
    try { logs.appendEvent({ ts: Date.now(), type: "raccoon-checkin-setup-failed", error: String(e?.message || e).slice(0, 200) }); } catch {}
  });

  const { setupWorkbuddyGrowth } = await import("./workbuddy-growth.js");
  void setupWorkbuddyGrowth({ bus, logs }).catch((e) => {
    try { logs.appendEvent({ ts: Date.now(), type: "workbuddy-growth-setup-failed", error: String(e?.message || e).slice(0, 200) }); } catch {}
  });
}
