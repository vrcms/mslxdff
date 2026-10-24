// 覆盖式写 provider keys 前的最后一道闸（单一判据来源，keys.js 只管调用）。
//
// 事故原型 2026-10-15：`mslxdff -provider traework quota` 当时 traework 没有 quota 处理器，
// `quota` 一路掉进 keys.js 的「未知即当 key」兜底分支，把 providerConfigs.traework.keys[0]
// 那个 1004 字符的 accessToken 整组覆盖成字符串 "quota" —— auth 号型的 keys 就是 accessToken 本身，
// 等于当场废号；且 keys 与 auths 长度仍相等（1:1），绕过了 provider 侧「长度不配对才回填」的自愈判据。
import { normalizeProviderId } from "../../../providers/model-id.js";
import { AUTH_DOC_PROVIDER_IDS } from "../../../runtime/provider-gate.js";

// 保留子命令：这些词归 provider/ 下别的 handler 管，掉到 keys 兜底 = 该 provider 没接线。
// 名单 = 各 handler 实际比对的 sub 值全集（keys.js 自己认的 list/status/add/remove/clear 不在内）。
// 新增 handler 时同步这里；漏收的后果是那个词能被当 key 写盘。
/** 覆盖式写 keys 时，单个候选 token 的最小可信长度（闸 3 判据：真 key 都远长于此）。 */
export const MIN_KEY_CHARS = 11;
export const RESERVED_PROVIDER_SUBS = new Set([
  "login", "auth", "oauth", "checkin", "signin", "quota", "credits", "balance",
  "migrate", "free", "bench", "benchmark", "eval", "test",
  "models", "show-models", "list-models", "ls", "models-path", "chat-path",
  "set-url", "set-models-path", "set-chat-path", "url", "seturl", "setmodelspath", "setchatpath",
  "allowlist", "allow", "allowed", "allowany", "allow-any", "allow_any", "whitelist",
  "del", "delete", "rm", "remove-provider", "del-provider", "import", "import-desktop", "from-desktop",
  "help", "usage", "usage-all",
]);

/**
 * 判断这次「把参数当 keys 整组覆盖」要不要拦。
 * @returns null = 放行；string[] = 拒写，元素是给人看的报错行（调用方打印后 exit 1，且必须已改盘前退出）
 */
export function keysWriteDenial(id, sub, rest = []) {
  const pid = normalizeProviderId(id) || String(id || "").toLowerCase();
  const subLc = String(sub || "").toLowerCase();

  // 闸 1：verb 一律不当 key（无 --force 逃生阀，真要写这个词走 `add`）
  if (RESERVED_PROVIDER_SUBS.has(subLc)) {
    return [
      `✗ -provider ${id} ${sub}：该供应商没有这个子命令 —— 已拒绝写 keys，配置未改动`,
      `  拦截原因：落到 keys 分支会把 "${sub}" 当成 API key 覆盖 ${id} 现有 keys。`,
      `  ${id} 支持什么：mslxdff -provider ${id} list`,
      `  真要把某个词当 key（罕见）：mslxdff -provider ${id} add ${sub}`,
    ];
  }
  // 闸 2：auth 号型的 keys 由 login / account-store 派生、与 auths[] 按位序平行
  // （raccoon 更由 syncRaccoonKeys 覆盖式同步），手填必错且下次登录即被冲掉 → 只留 --force 逃生阀。
  if (AUTH_DOC_PROVIDER_IDS.includes(pid) && !rest.includes("--force")) {
    return [
      `✗ 已拒绝覆盖 ${pid} 的 keys（配置未改动）`,
      `  ${pid} 是 auth 号型供应商：keys 存的是 login 落盘的 accessToken，与 auths[] 按位序成对，手填等于废号。`,
      `  正确姿势: mslxdff -provider ${pid} login（登录后自动回填 keys/auths）`,
      `  确知自己在做什么 → 末尾加 --force 重跑`,
    ];
  }
  // 闸 3：形状闸。2026-10-24 复现同类事故 —— `mslxdff -provider codearts help` 里 `help` 既不是
  // 保留 verb（闸 1 名单里没有它），codearts 又不属于 auth 号型六家（闸 2 不管它），于是 `help` 一路
  // 掉进「未知即当 key」的兜底分支，把 providerConfigs.codearts.keys 的 2 条真凭据整组覆盖成 "help"。
  // 判据：真 key 的长度都远超 10 字符（openrouter ~73、traework accessToken 实测 1004、codearts blob
  // 上千），而 ≤10 字符的裸词几乎必然是打错位置的子命令/模型名/文件名 —— 覆盖式 set 写进去就是当场废号。
  // 逃生阀：`--force`，或改走只追加、不覆盖的 `add`。
  const shortTokens = rest
    .map((k) => String(k || "").trim())
    .filter((k) => k && !k.startsWith("-") && k.length < MIN_KEY_CHARS);
  if (shortTokens.length && !rest.includes("--force")) {
    return [
      `✗ -provider ${id} ${sub}：疑似把「${shortTokens.join("、")}」当 API key 覆盖 ${id} 现有 keys —— 已拒绝，配置未改动`,
      `  拦截原因：key 长度不足 ${MIN_KEY_CHARS} 字符（真 key 都远长于此），多半是子命令/模型名打错了位置。`,
      `  ${id} 支持什么：mslxdff -provider ${id} list`,
      `  确知是短 key（自建桩服务）→ 末尾加 --force 重跑，或走只追加的 mslxdff -provider ${id} add <key>`,
    ];
  }
  return null;
}
