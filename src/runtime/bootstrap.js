import { appendCall, appendError, appendEvent } from "../logs.js";
import { setupProviders } from "./providers-setup.js";
import { startServerLifecycle } from "./server-lifecycle.js";
import { startGroupSync } from "./group-sync.js";
import { startBroadband } from "./broadband.js";

const logs = { appendCall, appendError, appendEvent };

/**
 * daemon 启动门面 — 仅编排：组装世界 → 服务生命周期 → 群组同步 → 宽带中继 → 自更新。
 * 重活下沉 providers-setup / server-lifecycle / group-sync / broadband(-stream)。
 */
export async function startDaemonMain(VERSION) {
  const ctx = await setupProviders();
  const { srv, bus } = await startServerLifecycle({ VERSION, ...ctx, logs });
  void srv;
  startGroupSync({ peers: ctx.peers, groups: ctx.groups });
  startBroadband({ token: ctx.token, upstream: ctx.upstream });

  const { setupAutoUpdate } = await import("./auto-update.js");
  setupAutoUpdate({ VERSION, bus, logs });

  const { setupWorkbuddyCheckin } = await import("./workbuddy-checkin.js");
  void setupWorkbuddyCheckin({ bus, logs }).catch((e) => {
    try { logs.appendEvent({ ts: Date.now(), type: "workbuddy-checkin-setup-failed", error: String(e?.message || e).slice(0, 200) }); } catch {}
  });
}
