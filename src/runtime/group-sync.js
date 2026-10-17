import { groupSyncIntervalMs } from "../cli/policy.js";
import { errMsg } from "../cli/util.js";

// 连续失败升级阈值（BUG-23）。单次失败是常态——现网实测 1.2%（349 次里 288 次是 15s 同步超时
// aborted、61 次 fetch failed），每次都喊只会把 errors.log 也刷成噪声（BUG-5 的教训）。
// 但连续失败意味着 `peers` 静默停在上一次成功的结果——"组员列表变旧"而用户侧零信号，
// 这才是要报的。连续 ≥N 次升一条 errors.log，恢复时再补一条收尾。
// 0/off = 关闭升级（只留 console.log）。
const DEFAULT_FAIL_ALERT_STREAK = 3;
function failAlertStreak() {
  const raw = process.env.MSLXDFF_GROUP_SYNC_FAIL_ALERT;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_FAIL_ALERT_STREAK;
  const s = String(raw).trim().toLowerCase();
  if (s === "0" || s === "off" || s === "false" || s === "no") return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FAIL_ALERT_STREAK;
}

/**
 * 造一个带「连续失败去抖」的结果上报器（纯函数，便于单测——不碰定时器）。
 *
 * 同一段连续失败**只喊一次**：阈值到的第一条写 errors.log，之后每分钟只走 console.log
 * （轨迹仍在，但不再往 errors.log 灌重复行）；恢复时补一条「已恢复」，闭合事件。
 * @param {object} opts
 * @param {{appendError?: Function}} [opts.logs] 日志设施（errors.log 写入口）
 * @param {number} [opts.alertAt] 连续失败阈值，0=不升级
 * @param {(s: string) => void} [opts.log] 行日志出口（默认 console.log，经 log-stamp 带前缀）
 * @returns {(results: Array<{name: string, error?: string, total?: number, added?: number}>, opts?: {verbose?: boolean}) => void}
 */
export function createGroupSyncReporter({ logs, alertAt = failAlertStreak(), log = console.log } = {}) {
  const streaks = new Map(); // name -> { fails, alerted }
  const appendError = (entry) => { try { logs?.appendError?.(entry); } catch { /* 日志失败不该拖垮同步 */ } };
  return (results, { verbose = false } = {}) => {
    for (const r of results || []) {
      const st = streaks.get(r.name) || { fails: 0, alerted: false };
      if (r.error) {
        st.fails += 1;
        const hit = alertAt > 0 && st.fails >= alertAt && !st.alerted;
        if (hit) {
          st.alerted = true;
          log(`group sync ${r.name}: failed — ${r.error}（已连续 ${st.fails} 次，成员列表停在上一次成功的结果）`);
          appendError({
            api: "group-sync", status: 0, group: r.name, fails: st.fails,
            message: `group sync ${r.name} 连续 ${st.fails} 次失败，成员列表已停留在上一次成功的结果：${r.error}`,
          });
        } else {
          log(`group sync ${r.name}: failed — ${r.error}`);
        }
      } else {
        if (st.alerted) {
          log(`group sync ${r.name}: 已恢复（此前连续失败 ${st.fails} 次），${r.total} member(s), ${r.added} peer(s)`);
          appendError({
            api: "group-sync", status: 200, group: r.name, fails: st.fails,
            message: `group sync ${r.name} 已恢复：此前连续失败 ${st.fails} 次`,
          });
        } else if (verbose || r.added) {
          log(`group sync ${r.name}: ${r.total} member(s), ${r.added} peer(s)`);
        }
        st.fails = 0;
        st.alerted = false;
      }
      streaks.set(r.name, st);
    }
  };
}

/**
 * 群组成员同步 — 首拉 + 定时器（fire-and-forget，原语义）。
 * 失败的去抖告警见 createGroupSyncReporter。
 */
export async function startGroupSync({ peers, groups, logs }) {
  const { syncAllJoinedGroups } = await import("../cli/group-helpers.js");
  const report = createGroupSyncReporter({ logs });
  // 整个同步抛错（读 state、令牌等基建问题）没有组名，归一成一个伪结果走同一套去抖
  const reportThrow = (err) => report([{ name: "(all)", error: errMsg(err) }], { verbose: true });
  syncAllJoinedGroups({ peers, groups }).then((results) => report(results, { verbose: true })).catch(reportThrow);
  const groupSyncTimer = setInterval(() => {
    syncAllJoinedGroups({ peers, groups }).then((results) => report(results)).catch(reportThrow);
  }, groupSyncIntervalMs());
  groupSyncTimer.unref();
}
