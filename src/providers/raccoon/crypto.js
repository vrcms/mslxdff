// raccoon 登录参数加密（手机号 / 密码）—— 单一源。
//
// 取证（2026-10-18：app.asar webpack module 68284 原文 + 本机真实账号实测）：
//   官方登录页拿到输入后先调 `U.yv()` 再拼 body，而 `yv` 的真身就是这段：
//     function c(e, t = "senseraccoon2023") {
//       const a = CryptoJS.enc.Utf8.parse(t);
//       const i = CryptoJS.lib.WordArray.random(16);                    // 随机 IV
//       const r = CryptoJS.AES.encrypt(e, a, { iv: i, mode: CFB, padding: NoPadding });
//       return i.concat(r.ciphertext).toString(CryptoJS.enc.Base64);
//     }
//   即 **key 与模式都硬编码在前端**：AES-128-CFB、key = "senseraccoon2023"、无 padding，
//   输出 Base64(IV(16 字节) ‖ 密文)。手机号与密码走的是同一个函数 —— 两个字段都要加密。
//
// 为什么必须加密（否则极难自查）：明文发送时服务端解得空串再去比对，一律回
// `AUTH_ACCOUNT_OR_PASSWORD_INVALID`（"手机号或密码不正确"）—— 用「密码错」的口径
// 掩盖了「格式错」。本机用真实账号取证：明文 → 401；按本算法加密 → 200。
// 且只加密手机号、密码留明文也是 401，可证**两个字段都加密**。
//
// ⚠ 这个 key 是**上游公开常量**（打包进任意客户端），不是本项目的机密；照抄它只为对齐协议，
//   不代表传输具备保密性 —— 真正的保护来自 HTTPS，以及本项目「密码不落盘/不打印」的纪律。
import { createCipheriv, randomBytes } from "node:crypto";
import { RACCOON_PASSWORD_ENC_KEY } from "./const.js";

const IV_BYTES = 16;

/**
 * 加密单个登录字段（手机号或密码）→ Base64(IV ‖ AES-128-CFB 密文)。
 *
 * 与上游前端**逐位对齐**：同 key、同模式（CFB128，对齐 CryptoJS 的 `mode.CFB`）、
 * 同 padding（NoPadding —— CFB 是流模式，密文长度恒等于明文长度）、同拼接顺序。
 * 每次调用生成新的随机 IV（上游亦然）：同一输入两次调用密文不同，这是正确行为。
 */
export function raccoonEncryptField(plain, keyStr = RACCOON_PASSWORD_ENC_KEY) {
  const key = Buffer.from(String(keyStr ?? ""), "utf8");
  if (key.length !== 16) throw new Error("raccoon: 登录加密 key 必须是 16 字节（AES-128）");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-128-cfb", key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(String(plain ?? ""), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([iv, body]).toString("base64");
}
