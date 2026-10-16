// traework 市场侧「伪设备身份」派生 —— 纯函数，不碰 fs/env。
//
// 为什么需要它（2026-10-15 现网取证）：UG 系接口（`checkin_credits/status|claim`、`pay/ide_user_ent_usage`）
// 要一整套 VSCode/market 请求头，其中三件是**按账号派生的设备身份**：
//   x-device-id      = 15 位十进制数字串
//   x-market-user-id = UUID v4 形态
//   vscode-sessionid = 64 位十六进制串
// 我们原先只发 5 个头、且把 OAuth 那个 32 位 hex 当 x-device-id 用 → `claim` 回
// `code=9004 The submitted order parameters are incorrect`；补齐后同一发回 `9074 当前参与用户太多`
// （已过参数校验，进到了排队/风控层）。
//
// 算法逐字对齐 NextAgentX/trae-workbuddy-switch `modules/trae/device.rs:59-151`
// （salt `devid`/`sess`/`market` 与 SHA256 计数器模式都不能改 —— 改了同 uid 会派生出另一套身份，
//  在风控眼里等同换设备）。落盘与 gen 自愈见 `account-store.js` 的 ensureMarketIdentity。
import { createHash, randomBytes } from "node:crypto";
import { MARKET_DEVICE_GEN } from "./constants.js";

/** 每号 x-device-id 的位数（真机形态：15 位十进制，不是 OAuth 的 32 位 hex）。 */
export const MARKET_DEVICE_ID_DIGITS = 15;
/** vscode-sessionid 位数（64 位 hex）。 */
export const MARKET_SESSION_HEX_LEN = 64;

/**
 * 确定性字节流：`SHA256("<salt>:<seed>" || u32BE(counter))` 逐块拼接后截断到 nbytes。
 * seed 为空返回 null —— 调用方必须显式处理「无种子」，不许悄悄退化成不可复现的随机值
 * （口径同参考实现 device.rs:59-79）。
 */
export function seededStream(seed, salt, nbytes) {
  const s = String(seed || "");
  if (!s || !(nbytes > 0)) return null;
  const prefix = Buffer.from(`${salt}:${s}`, "utf8");
  const out = [];
  let counter = 0;
  while (out.length < nbytes) {
    const h = createHash("sha256");
    h.update(prefix);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter >>> 0, 0);
    h.update(c);
    out.push(...new Uint8Array(h.digest()));
    counter = (counter + 1) >>> 0;
  }
  return Uint8Array.from(out.slice(0, nbytes));
}

/** 无种子时的兜底字节（仅在 uid 缺失的异常路径上用到；正常流程永远走确定性派生）。 */
function fallbackBytes(nbytes) {
  return new Uint8Array(randomBytes(nbytes));
}

/**
 * 生成 n 位十进制数字串（x-device-id 用）。
 * ⚠ 必须 `String(b % 10)` 出**单个数字字符**，不能写 `String(48 + (b % 10))` ——
 *   后者在 JS 里是"数字转十进制字符串"（码点 49 → 两个字符 `"49"`），会把 n 字节撑成 2n 位、
 *   且首位恒为 `4`/`5`。Rust 侧 `char::from(b'0' + b % 10)` 是码点→字符，语义即本行。
 *   （2026-10-15 移植时真踩过，靠形状断言 `^[0-9]{15}$` 才暴露。）
 * 每字节出一位，故 seededStream(n) 取 n 字节即得 n 位、无截断。
 */
export function marketDigits(seed, n = MARKET_DEVICE_ID_DIGITS) {
  const bytes = seededStream(seed, "devid", n) || fallbackBytes(n);
  let out = "";
  for (const b of bytes) out += String(b % 10);
  return out;
}

/** 按任意 salt 派生 n 位十六进制串（needed=ceil(n/2)，n 为偶数时截断是 no-op，奇数 n 靠 slice 截）。 */
export function marketHexSalted(n, salt, seed) {
  const needed = Math.ceil(n / 2);
  const bytes = seededStream(seed, salt, needed) || fallbackBytes(needed);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, n);
}

/** vscode-sessionid 专用（salt 固定 `sess`）。 */
export function marketSession(seed, n = MARKET_SESSION_HEX_LEN) {
  return marketHexSalted(n, "sess", seed);
}

/** 标准 UUID v4 形态（salt 固定 `market`），并置版本位 4 与 RFC4122 变体位，使输出与 uuid4() 一致。 */
export function marketUuid(seed) {
  const raw = seededStream(seed, "market", 16) || fallbackBytes(16);
  const b = Array.from(raw);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 按 uid 派生完整市场身份（不落盘）。`created` 只在**新生成**时盖时间戳，
 * 复用盘上旧值时由调用方保留原 created（换 created 不影响身份稳定性）。
 */
export function deriveMarketIdentity(uid) {
  const seed = String(uid || "").trim();
  return {
    deviceId: marketDigits(seed, MARKET_DEVICE_ID_DIGITS),
    marketUserId: marketUuid(seed),
    sessionId: marketSession(seed),
    created: new Date().toISOString(),
    gen: MARKET_DEVICE_GEN,
  };
}

/**
 * 校验一份存量 market 块是否可用：三件齐、形状对、gen 不小于当前算法版本。
 * 任一不满足都返回 false → 调用方重新派生并回写（对应参考实现的「gen 缺失按 1 处理，下次取用就地重建」）。
 */
export function marketUsable(m) {
  if (!m || typeof m !== "object") return false;
  if (Number(m.gen || 0) < MARKET_DEVICE_GEN) return false;
  if (!/^[0-9]{15}$/.test(String(m.deviceId || ""))) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(m.marketUserId || ""))) return false;
  if (!/^[0-9a-f]{64}$/.test(String(m.sessionId || ""))) return false;
  return true;
}
