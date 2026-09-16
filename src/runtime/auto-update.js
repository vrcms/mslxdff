import { closeSync, openSync } from "node:fs";
import { autoUpdateIntervalMs } from "../cli/policy.js";
import { errMsg, npmCmd, run } from "../cli/util.js";

// 升级后的重启委托：在 daemon 进程内直调 stopDaemon() 是自杀式 SIGTERM，
// 会打断紧随其后的 startDaemon()/waitForHealth()（2026-09-15 实测：0.1.124→0.1.125
// 自动升级后 daemon 反复抢占/静默消失 7 分钟）。改为 spawn 一个 CLI 子进程执行
// `-restart`（成熟路径：杀旧 + 起新 + health 二次确认），daemon 自己不再掌舵重启。
// env 必须剔除 MSLXDFF_DAEMON，否则子进程的 handleRestart 守卫会把 -restart 当 no-op。
export function spawnRestartViaCli({ spawnFn, nodePath, entry, logFd, env }) {
  const clean = { ...env };
  delete clean.MSLXDFF_DAEMON;
  delete clean.MSLXDFF_DEBUG;
  const child = spawnFn(nodePath, [entry, "-restart"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: clean,
  });
  child.unref();
  return child.pid;
}

export function setupAutoUpdate({ VERSION, bus, logs }) {
  const autoUpdateMs = autoUpdateIntervalMs();
  function emitAutoUpdate(type, data = {}) {
    const entry = { ts: Date.now(), type, ...data };
    try { bus?.emit(entry); } catch {}
    try { logs?.appendEvent?.(entry); } catch {}
    const line = `[auto-update] ${type} ${JSON.stringify(data)}`;
    console.log(line);
  }
  // debug 会话不自动升级：debug 前台会把自己的 pid 写入 daemon.pid，
  // auto-update 的 stopDaemon() 会把它自己停掉（现象：-debug 跑一会儿就"自己退出"）
  if (autoUpdateMs && process.env.MSLXDFF_DEBUG === "1") {
    console.log(`auto-update: skipped (debug session)`);
    emitAutoUpdate("auto-update-skipped", { intervalMs: autoUpdateMs, current: VERSION, reason: "debug" });
  } else if (autoUpdateMs) {
    console.log(`auto-update enabled: checking every ${Math.round(autoUpdateMs / 60000)}m`);
    emitAutoUpdate("auto-update-enabled", { intervalMs: autoUpdateMs, current: VERSION });
    setTimeout(() => {
      emitAutoUpdate("auto-update-check", { current: VERSION });
      checkAndAutoUpdate().catch((err) => {
        console.log(`auto-update check failed: ${errMsg(err)}`);
        emitAutoUpdate("auto-update-failed", { error: errMsg(err) });
      });
    }, 30_000).unref?.();
    const autoUpdateTimer = setInterval(() => {
      emitAutoUpdate("auto-update-check", { current: VERSION });
      checkAndAutoUpdate().catch((err) => {
        console.log(`auto-update check failed: ${errMsg(err)}`);
        emitAutoUpdate("auto-update-failed", { error: errMsg(err) });
      });
    }, autoUpdateMs);
    autoUpdateTimer.unref();
  } else {
    console.log(`auto-update disabled (set MSLXDFF_AUTO_UPDATE=1 to enable hourly)`);
    emitAutoUpdate("auto-update-disabled", { current: VERSION });
  }

  async function checkAndAutoUpdate() {
    emitAutoUpdate("auto-update-query", { current: VERSION });
    const info = await run(npmCmd(), ["view", "mslxdff", "dist-tags.latest", "--json"]);
    if (info.err) {
      emitAutoUpdate("auto-update-query-failed", { error: info.err.message || String(info.stderr || "").slice(0, 500) });
      throw new Error(info.err.message || String(info.stderr || "").slice(0, 500));
    }
    let latest = "";
    try {
      latest = JSON.parse(String(info.stdout || "").trim());
      if (Array.isArray(latest)) latest = latest[latest.length - 1];
      latest = String(latest || "").replace(/^v/, "").trim();
    } catch {
      const raw = String(info.stdout || "").trim();
      const m = raw.match(/(\d+\.\d+\.\d+[^\s'"]*)/);
      latest = m ? m[1] : raw.split(/\s+/).pop()?.replace(/['"]/g, "") || "";
    }
    latest = latest.replace(/['"]/g, "").trim();
    emitAutoUpdate("auto-update-queried", { current: VERSION, latest, stdout: String(info.stdout || "").trim().slice(0, 200) });
    if (!latest || latest === VERSION) {
      emitAutoUpdate("auto-update-noop", { current: VERSION, latest });
      return;
    }
    const { compareSemver } = await import("../cli/policy.js");
    if (compareSemver(latest, VERSION) <= 0) {
      emitAutoUpdate("auto-update-noop", { current: VERSION, latest, reason: "not newer" });
      return;
    }
    emitAutoUpdate("auto-update-found", { current: VERSION, latest });
    console.log(`auto-update: v${VERSION} -> v${latest}, installing...`);
    emitAutoUpdate("auto-update-installing", { current: VERSION, latest });
    const up = await run(npmCmd(), ["install", "-g", `mslxdff@${latest}`]);
    if (up.err) {
      emitAutoUpdate("auto-update-install-failed", { current: VERSION, latest, error: up.err.message || String(up.stderr || "").slice(0, 500) });
      throw new Error(up.err.message || String(up.stderr || "").slice(0, 500));
    }
    emitAutoUpdate("auto-update-installed", { current: VERSION, latest, stdout: String(up.stdout || "").slice(0, 500) });
    console.log(`auto-update: installed v${latest}, restarting daemon...`);
    emitAutoUpdate("auto-update-restarting", { current: VERSION, latest });
    const { daemonEntry, logFile } = await import("../daemon.js");
    const { spawn } = await import("node:child_process");
    const logFd = openSync(logFile(), "a", 0o600);
    let restarterPid = null;
    try {
      restarterPid = spawnRestartViaCli({ spawnFn: spawn, nodePath: process.execPath, entry: daemonEntry(), logFd, env: process.env });
    } finally {
      try { closeSync(logFd); } catch {}
    }
    // 不再自己 stopDaemon()/startDaemon()/waitForHealth()：-restart 会杀旧（我们）并起新版本；
    // 若它失败，本进程保持服务（下轮 60m 检查重试），绝不让重启半途变成"两个都死"。
    console.log(`auto-update: restart handed to CLI -restart (pid ${restarterPid})`);
    emitAutoUpdate("auto-update-restart-spawned", { current: VERSION, latest, pid: restarterPid });
  }
}
