import { createInterface } from "../readline-compat.js";
import { normalizeLeaderUrl, joinGroupCore } from "./join-core.js";
import { compatFetch, timeoutSignal } from "../compat.js";
import { errMsg } from "./util.js";

const PROBE_TIMEOUT_MS = 6000;
const SERVICE_HEALTH_TIMEOUT_MS = 6000;
const MAX_ATTEMPTS = 3;

export function isTermux(env = process.env) {
  return Boolean(env?.TERMUX_VERSION) || String(env?.PREFIX || "").includes("com.termux");
}

export function createAskSession() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  // 逐行异步迭代而非 rl.question：question 回调在管道/多行同 chunk 时会丢行（绑定前的行被 emit 掉），
  // 且 stdin 结束（管道 EOF / Ctrl+D）时 pending 的 question 永不 resolve，会让顶层 await 悬挂退出（exit 13）。
  const it = rl[Symbol.asyncIterator]();
  return {
    ask: async (q) => {
      process.stdout.write(q);
      const { value, done } = await it.next();
      return done ? null : value;
    },
    close: () => {
      try { rl.close(); } catch {}
    },
  };
}

/** 出口 IP：组长侧 clientIp() 视角（ADR-0006：不靠 ifconfig.me）。 */
export async function probeExitIp({ leaderUrl, token, group }) {
  try {
    const res = await compatFetch(`${leaderUrl}/v1/groups/relay/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: group, group }),
      signal: timeoutSignal(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return j?.ip || null;
  } catch {
    return null;
  }
}

/** 确保后台服务在跑：已在跑则复用；否则启动并等 health（daemon 的 10s ensure 会自动接上长连）。 */
export async function ensureServiceRunning() {
  const { readPid, isPidAlive, startDaemon } = await import("../daemon.js");
  const { waitForHealth, effectivePort } = await import("./policy.js");
  const pid = readPid();
  if (pid && isPidAlive(pid)) return { pid, started: false };
  const newPid = startDaemon([]);
  await waitForHealth(effectivePort([]), SERVICE_HEALTH_TIMEOUT_MS);
  return { pid: newPid, started: true };
}

/**
 * 手机宽带接入向导：问组长地址 → 问组名 → 宽带入组 → 报出口 IP → 确保服务运行 → 保活指引。
 * 依赖全可注入（session/join/probeIp/ensureService/out/env），便于单测与复用。
 * // Note: 为什么默认 broadband、为何用 iterator 而非 rl.question — 见 .agents/notes/implemented/feature/2026-09-16-mobile-broadband-join-wizard.md
 */
export async function runJoinWizard(opts = {}) {
  const out = opts.out || ((line) => console.log(line));
  const env = opts.env || process.env;
  const session = opts.session || createAskSession();
  const ask = opts.ask || ((q) => session.ask(q));
  const join = opts.join || joinGroupCore;
  const ensureService = opts.ensureService || ensureServiceRunning;
  const probeIp = opts.probeIp || probeExitIp;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;

  out("");
  out("  手机宽带接入 — 让这台设备成为组内出口（不占端口，只出站）");
  out("");

  let leaderUrl = null;
  let name = String(opts.groupName ?? "").trim();

  try {
    if (opts.leaderInput) {
      const norm = normalizeLeaderUrl(opts.leaderInput);
      if (!norm.ok) {
        out(`✗ 组长地址无效：${norm.reason}`);
        out("  重试：mslxdff -addtogroup");
        return { ok: false, error: norm.reason };
      }
      leaderUrl = norm.url;
    } else {
      for (let i = 0; i < maxAttempts; i++) {
        const raw = await ask("1/2 组长地址（ip:端口，如 149.13.91.10:8989）: ");
        if (raw === null) {
          out("· 已取消（输入结束）");
          return { ok: false, error: "cancelled" };
        }
        const norm = normalizeLeaderUrl(raw);
        if (norm.ok) {
          leaderUrl = norm.url;
          break;
        }
        out(`  ✗ ${norm.reason}`);
      }
      if (!leaderUrl) {
        out("✗ 组长地址始终无效，已退出。重试：mslxdff -addtogroup");
        return { ok: false, error: "invalid leader input" };
      }
    }

    if (!name) {
      for (let i = 0; i < maxAttempts; i++) {
        const raw = await ask("2/2 组名: ");
        if (raw === null) {
          out("· 已取消（输入结束）");
          return { ok: false, error: "cancelled" };
        }
        const v = String(raw).trim();
        if (v) {
          name = v;
          break;
        }
        out("  ✗ 组名不能为空");
      }
      if (!name) {
        out("✗ 未填写组名，已退出。重试：mslxdff -addtogroup");
        return { ok: false, error: "empty group name" };
      }
    }
  } finally {
    session.close();
  }

  out(`→ 正在连接组长 ${leaderUrl} ...`);
  const r = await join({ leaderHost: leaderUrl, name, isBroadband: true });
  if (!r?.ok) {
    out(`✗ 加入失败：${r?.error || "未知错误"}`);
    out("  检查：① 地址与端口是否正确 ② 组长服务是否在跑 ③ 手机网络是否可达");
    out("  重试：mslxdff -addtogroup");
    return { ok: false, leaderUrl, error: r?.error || "join failed" };
  }
  out(`✓ 已加入组「${name}」（宽带成员 ${r.myUrl}）`);
  if (r.syncError) out(`  ⚠ 组员列表同步失败（不影响出口贡献）：${r.syncError}`);

  out("→ 正在确认出口 IP ...");
  const exitIp = await probeIp({ leaderUrl: r.leaderUrl || leaderUrl, token: r.token, group: name }).catch(() => null);
  if (exitIp) out(`✓ 出口 IP: ${exitIp}（组长视角，上游分流按这个 IP）`);
  else out("· 出口 IP 待确认（组长暂时不可达，恢复后自动重试）");

  out("→ 正在启动后台服务 ...");
  const service = await ensureService().catch((err) => ({ error: errMsg(err) }));
  if (service?.error) {
    out(`✗ 后台服务启动失败：${service.error}`);
    out("  手动启动：mslxdff -d      查看日志：mslxdff -log 50");
  } else if (service?.started) {
    out(`✓ 后台服务已启动（pid ${service.pid}）`);
  } else {
    out(`✓ 后台服务已在运行（pid ${service.pid}），已自动接入`);
  }

  out("");
  out("保持在线：");
  if (isTermux(env)) {
    out("  • termux-wake-lock    防止系统休眠杀进程（强烈建议）");
  } else {
    out("  • 关机/断网后需重跑本命令");
  }
  out("  • mslxdff -status     查看组与出口状态");
  out("  • mslxdff -stop       停止贡献");
  out("");
  return { ok: true, leaderUrl, name, myUrl: r.myUrl, exitIp, service };
}
