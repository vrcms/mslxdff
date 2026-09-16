// daemon 生命周期留痕：启动 / 信号 / 顶层异常 / 退出 / 心跳。
// 目的：daemon "神秘消失"时，daemon.log 能直接区分四种死法——
//   被信号杀（有 `SIGTERM received` 行）、崩溃（有 uncaughtException 行）、
//   被 SIGKILL/任务管理器杀（只有未送达的 exit 行 → 看最后一条 heartbeat 定位死亡时刻）、
//   OOM 积累（heartbeat 的 rss 曲线）。
// 顶层异常只记录不退出（代理服务无持久状态，活着比干净退出更有价值；异常多为请求级漏网）。
import { appendEvent } from "../logs.js";

const HEARTBEAT_MS = Math.max(60_000, Number(process.env.MSLXDFF_HEARTBEAT_MS) || 30 * 60 * 1000);

function log(line) {
  try { console.log(line); } catch {}
}

// 纯函数：启动行（可测）
export function lifecycleStartLine({ version, pid, ppid, node, platform, cwd }) {
  return `[lifecycle] start pid=${pid} ppid=${ppid} version=${version} node=${node} platform=${platform} cwd=${cwd}`;
}

export function lifecycleHeartbeatLine({ pid, uptimeMin, rssMb }) {
  return `[lifecycle] heartbeat pid=${pid} uptime=${uptimeMin}m rss=${rssMb}mb`;
}

export function installLifecycleLog({ version, bus, logs } = {}) {
  const t0 = Date.now();
  const rssMb = () => Math.round((process.memoryUsage?.().rss ?? 0) / 1048576);
  const emit = (type, data) => {
    try { bus?.emit({ ts: Date.now(), type, ...data }); } catch {}
    try { logs?.appendEvent?.({ ts: Date.now(), type, ...data }); } catch {}
  };

  log(lifecycleStartLine({
    version,
    pid: process.pid,
    ppid: process.ppid,
    node: process.version,
    platform: process.platform,
    cwd: process.cwd(),
  }));
  emit("lifecycle-start", { pid: process.pid, ppid: process.ppid, version, node: process.version });

  process.on("uncaughtException", (e) => {
    const detail = String(e?.stack || e?.message || e).slice(0, 2000);
    log(`[lifecycle] uncaughtException (kept running): ${detail}`);
    emit("lifecycle-uncaught", { detail: detail.slice(0, 500) });
  });
  process.on("unhandledRejection", (r) => {
    const detail = String(r?.stack || r?.message || r).slice(0, 2000);
    log(`[lifecycle] unhandledRejection (kept running): ${detail}`);
    emit("lifecycle-unhandled-rejection", { detail: detail.slice(0, 500) });
  });
  process.on("exit", (code) => {
    const uptimeSec = Math.round((Date.now() - t0) / 1000);
    log(`[lifecycle] exit code=${code} uptime=${uptimeSec}s rss=${rssMb()}mb`);
  });
  process.on("SIGHUP", () => log(`[lifecycle] SIGHUP received (ignored, pid ${process.pid})`));

  const hb = setInterval(() => {
    // 心跳只落 daemon.log（不写 events.log：48 条/天，避免污染结构化事件流）
    log(lifecycleHeartbeatLine({ pid: process.pid, uptimeMin: Math.round((Date.now() - t0) / 60000), rssMb: rssMb() }));
  }, HEARTBEAT_MS);
  hb.unref?.();
  return { heartbeatMs: HEARTBEAT_MS };
}
