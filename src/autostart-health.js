import { existsSync } from "node:fs";

/**
 * 开机自启注册项的「体检判据」—— 纯函数层，零 IO、不读 env（`exists` 由调用方注入）。
 *
 * 为什么单独一片文件：2026-10-26 真机的病状是「注册被清/注册里的路径搬走，但一切判据都说
 * 已启用」，于是 daemon 静默不再开机自启。修法要在 `src/autostart.js` 之外再长一层判断逻辑，
 * 而那份文件已经 19KB 贴着仓库 20KB 硬顶 —— 判据是纯函数，天然可拆、可单测（见
 * `test/autostart-keep.test.js`），IO 侧（schtasks/systemctl/注册表）留在 autostart.js。
 */

/**
 * 把注册下来的命令行切成 token：引号包裹的优先，其余按空白切。
 * Windows 的 `Task To Run` / Run 值常是「带空格路径加引号 + 裸脚本路径」混排，只按空白切会把
 * `C:\Program Files\nodejs\node.exe` 劈成两截，只取引号又会漏掉没引号的那半。
 */
export function splitCmdTokens(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || "")))) {
    const v = String(m[1] !== undefined ? m[1] : m[2]).trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * 从注册命令行里抠出真实路径（node 可执行 + mslxdff.js 脚本）。
 * 为什么非要看内容不可：老判据只问「任务/键在不在」，于是换 npm prefix、把仓库目录搬家、
 * 删掉全局包留着死键这三种情况下，`-status` 一路报「已启用」，而开机时 schtasks/systemd
 * 根本起不来 —— 静默失效。
 */
export function extractRegisteredPaths(commandLine) {
  const paths = [];
  for (const t of splitCmdTokens(commandLine)) {
    if (t.startsWith("-") || t.startsWith("=")) continue; // --daemon / ExecStart 的 flag
    if (!/[\\/]/.test(t) && !/\.(exe|js|mjs|cjs)$/i.test(t)) continue; // 无路径特征 = 服务名/参数
    paths.push(t);
  }
  return [...new Set(paths)];
}

/**
 * 体检一条注册项：`{ ok, reason, paths, missing }`。
 * 判不出路径时**不判死**（无凭据不误杀，同 `filterStalePicks` 的默认放行哲学）——
 * 否则一条格式意外的任务就能让自愈每轮白派一个 helper 进程。
 * Windows 侧调用方必须把 `taskStatus`（schtasks 的 `Status:`）带进来：任务被人工禁用
 * 也是「开机不起」，光看键在不在抓不到。
 */
export function assessRegistrationHealth({ status, exists = existsSync, platform = process.platform } = {}) {
  const win = platform === "win32";
  if (!status || !status.enabled) {
    return { ok: false, reason: win ? "未注册（任务计划与 HKCU Run 都没有）" : "未注册（无 systemd user unit 或未 enable）", paths: [], missing: [] };
  }
  if (win && status.taskStatus && /disabled|已禁用|已停止/i.test(status.taskStatus)) {
    return { ok: false, reason: `任务计划处于禁用态（${status.taskStatus.trim()}）`, paths: [], missing: [] };
  }
  const cmd = win ? String(status.taskToRun || "") : String(status.execStart || "");
  const paths = extractRegisteredPaths(cmd);
  if (!paths.length) return { ok: true, reason: "", paths: [], missing: [], unknown: true };
  const missing = paths.filter((p) => !exists(p));
  if (missing.length) return { ok: false, reason: `注册项里的路径已不存在：${missing.join("、")}`, paths, missing };
  return { ok: true, reason: "", paths, missing: [] };
}
