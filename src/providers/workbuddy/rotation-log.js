import { appendFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

function defaultDirs() {
  const dirs = new Set();
  try {
    const sf = process.env.MSLXDFF_STATE_FILE;
    if (sf) {
      const cut = Math.max(sf.lastIndexOf("/"), sf.lastIndexOf("\\"));
      if (cut > 0) dirs.add(sf.slice(0, cut));
    }
  } catch {}
  const envDir = process.env.MSLXDFF_DAEMON_DIR || process.env.MSLXDFF_LOG_DIR;
  if (envDir) dirs.add(envDir);
  dirs.add(process.cwd());
  dirs.add(join(process.cwd(), "logs"));
  return [...dirs];
}

export function appendRotationLog({ uid, model, totalMs, balanceHit, error, clock = Date.now, fs: fsOverride, dirs: dirsOverride, maxBytes = 1024 * 1024 } = {}) {
  // 兼容旧调用：appendRotationLog({uid,model,totalMs,balanceHit,error}) 形式，clock/fs 可选
  const useFs = fsOverride || { appendFileSync, mkdirSync, readFileSync, writeFileSync, statSync, join };
  const useDirs = dirsOverride || defaultDirs();
  try {
    const line = `${new Date(clock()).toISOString()} uid=${uid} model=${model || "-"} totalMs=${totalMs} balanceHit=${balanceHit ? 1 : 0}${error ? ` error=${String(error).slice(0, 120)}` : ""}\n`;
    for (const dir of useDirs) {
      try {
        useFs.mkdirSync(dir, { recursive: true });
        const file = useFs.join ? useFs.join(dir, "workbuddy-rotation.log") : join(dir, "workbuddy-rotation.log");
        useFs.appendFileSync(file, line);
        try {
          const st = useFs.statSync(file);
          if (st.size > maxBytes) {
            const content = useFs.readFileSync(file, "utf8");
            useFs.writeFileSync(file, content.slice(-512 * 1024));
          }
        } catch {}
      } catch {}
    }
  } catch {}
}

export function createRotationLogger({ fs, clock = Date.now, dirs, maxBytes } = {}) {
  return {
    append(opts) {
      return appendRotationLog({ ...opts, clock, fs, dirs, maxBytes });
    },
  };
}

// 供旧代码直接调用的默认 logger
export const defaultLogger = {
  append: (opts) => appendRotationLog(opts),
};
