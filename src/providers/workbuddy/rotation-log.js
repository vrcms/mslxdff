import { appendFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fmtShanghaiYMDHMS } from "../../time.js";

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

// 裁剪保留比例（按字节）。阈值 `st.size` 是**字节**，原先的回退 `content.slice(-512*1024)` 是**字符** ——
// 量纲不匹配：中文（3 字节/字符）下保留后字节数浮动，且 slice 按字符切会**切在半行**上
// （实测开头得到 `"el=workbuddy/deepseek totalMs="`，下一行接上去就把日志结构毁了）。
// 与 logs.js / model-trace.js 同口径：按字节留 3/4，且不截半行。
const KEEP_RATIO = 3 / 4;

function keepTailByBytes(text, maxBytes) {
  const limit = Math.max(1, Math.floor(maxBytes * KEEP_RATIO));
  if (Buffer.byteLength(text) <= limit) return text;
  const lines = text.split("\n");
  let bytes = 0;
  let i = lines.length - 1;
  for (; i >= 0; i--) {
    const b = Buffer.byteLength(lines[i]) + 1;
    if (bytes + b > limit) break;
    bytes += b;
  }
  // 至少保留最后一条：单行超 limit 时否则返回空串 = 清空整个轮转日志。
  // 判据是「结果为空」——文件尾有换行时 split 的最后一个元素是空串，`i === lines.length-1` 判不到内容行。
  const kept = lines.slice(i + 1).join("\n");
  if (!kept) {
    const nonEmpty = lines.filter((l) => l !== "");
    if (nonEmpty.length) return nonEmpty[nonEmpty.length - 1];
  }
  return kept;
}

export function appendRotationLog({ uid, model, totalMs, balanceHit, error, clock = Date.now, fs: fsOverride, dirs: dirsOverride, maxBytes = 1024 * 1024 } = {}) {
  // 兼容旧调用：appendRotationLog({uid,model,totalMs,balanceHit,error}) 形式，clock/fs 可选
  const useFs = fsOverride || { appendFileSync, mkdirSync, readFileSync, writeFileSync, statSync, join };
  const useDirs = dirsOverride || defaultDirs();
  try {
    const line = `${fmtShanghaiYMDHMS(new Date(clock()))} uid=${uid} model=${model || "-"} totalMs=${totalMs} balanceHit=${balanceHit ? 1 : 0}${error ? ` error=${String(error).slice(0, 120)}` : ""}\n`;
    for (const dir of useDirs) {
      try {
        useFs.mkdirSync(dir, { recursive: true });
        const file = useFs.join ? useFs.join(dir, "workbuddy-rotation.log") : join(dir, "workbuddy-rotation.log");
        useFs.appendFileSync(file, line);
        try {
          const st = useFs.statSync(file);
          if (st.size > maxBytes) {
            // 按字节回退（不截半行），与 logs.js / model-trace.js 同口径。
            const kept = keepTailByBytes(useFs.readFileSync(file, "utf8"), maxBytes);
            useFs.writeFileSync(file, kept.endsWith("\n") || !kept ? kept : `${kept}\n`);
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
