import { autoUpdateIntervalMs } from "../cli/policy.js";
import { errMsg, npmCmd, run } from "../cli/util.js";
import { resolvePort } from "../server.js";

export function setupAutoUpdate({ VERSION, bus, logs }) {
  const autoUpdateMs = autoUpdateIntervalMs();
  function emitAutoUpdate(type, data = {}) {
    const entry = { ts: Date.now(), type, ...data };
    try { bus?.emit(entry); } catch {}
    try { logs?.appendEvent?.(entry); } catch {}
    const line = `[auto-update] ${type} ${JSON.stringify(data)}`;
    console.log(line);
  }
  if (autoUpdateMs) {
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
    const { stopDaemon, startDaemon } = await import("../daemon.js");
    try { stopDaemon(); } catch (e) { emitAutoUpdate("auto-update-stop-failed", { error: errMsg(e) }); }
    const { waitForHealth } = await import("../cli/policy.js");
    const newPid = startDaemon([]);
    await waitForHealth(resolvePort(), 8000);
    console.log(`auto-update: restarted as v${latest} (pid ${newPid})`);
    emitAutoUpdate("auto-update-restarted", { current: VERSION, latest, newPid });
  }
}
