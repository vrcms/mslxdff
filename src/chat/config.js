export const CHAT_PREFERRED = "mimo-v2.5-free";
export const CHAT_FALLBACK = "big-pickle";
// 128k 上下文 *95% ≈ 121.6k tokens，按 ~3.3 字符/token 估算 ≈ 400k 字符
// 接近 95% 再压缩，避免频繁摘要
export const CHAT_HISTORY_MAX_CHARS = 400000;
export const CHAT_KEEP_RECENT = 40;
export const CHAT_SUMMARY_TRIGGER = 400000;
export const CHAT_MAX_TOOL_LOOPS = 6;
export const CHAT_TIMEOUT_MS = 30000;
export const FORBIDDEN = ["-uninstall", "--uninstall"];
