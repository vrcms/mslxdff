// 终局上游判决分类器（纯函数，零 IO）：上游把「这个模型你别想用」写死在错误里时的判据。
//
// 立此判据的现网取证（~/.config/mslxdff/deepseek-v4.1-flash-free.log，req=mv9m1d2v-n2y5）：
//   22:04:41 上游 6s 就回 403 FreeTierError（"OpenCode's free tier can only be used from within OpenCode"），
//   网关仍把这条拒绝继续丢给 4 个组员接力 → 组员撞的是同一堵墙（组员 149.13.91.10 回**同一个**
//   FreeTierError，其余是 30s abort / fetch failed），客户端 22:05:46 才拿到 502 "peers failed"，
//   total=72752ms——真相（403 + 原文）被接力产物彻底埋掉，人只看到「一直转圈圈」。
//
// 边界（重要）：只判「换节点也不会变」的拒绝。一切可能随号/随额度/随时间恢复的都**不算**终局，
// 接力与 failover 照常：401/402/429/5xx、fetch 异常，以及坏号型 403（zcode `security_reject`
// 「安全校验拒绝」、qoder 限流裹 403、`isQueued`/`serviceAvailable` 这类换号就能过的）。
// 本仓自己的 allowlist 403 在 serial-trial 更前面已短路，不经此处。
//
// ⚠ 喂进来的文本必须是**未截成 400 字符**的原文（调用方给 ≤4KB）：TRANSIENT 护栏是唯一的反向刹车，
// 它命中的字样若落在截断之外，就会把「换个组员可能就能用」的失败误判成终局、静默停掉组网兜底
// （多 provider 明细体如 OpenRouter 的 `metadata.raw[]` 正是这种排列）。

// 上游身份/资格闸门：文案是具名判决（FreeTierError），4xx 任意码都算终局——不锁死 403，
// 防上游把同一判决挪到 400/404 就失明。
const FREE_TIER_PATTERNS = [
  /FreeTierError/i,
  // ⚠ `FreeUsageLimitError` 曾列在此（BUG-8 于 2026-10-16 加入）**现已移除**（2026-10-17 纠正）：
  // 它是**限额/限流**判决，不是身份闸门。三条独立实证都证明「换出口/换组员就恢复」⇒ 属可接力：
  //   ① 本仓自测记录（原 warp-pool/verdict.js:9-10，该模块已随 ADR-0073 移除）：同一身份连发 3 次 429 FreeUsageLimitError，
  //      **身份一换、同一个请求立刻 200**（限额按出口 IP 计）；
  //   ② 原 warp-pool 的决策表（verdict.js:62）对 429 FreeUsage 明写「强制换出口、跳过冷却」（该模块已随 ADR-0073 移除）；
  //   ③ 原 v6 池（v6pool-claim-rotate.test.js:140）同样据它换源地址（已随 ADR-0073 移除）。
  // 更根本：ADR-0058 §2 本就把「401/402/**429**/5xx」明列为**可恢复、接力照常**；本文件头 :9-11 也是
  // 同一口径。BUG-8 把 429 的具名文案判成终局，偏离了本模块自己写下的边界 —— 现网代价是
  // 组员额度还在、仍被 `peersSkipped:true` 一刀跳过（2026-10-18 events.log 满屏实证）。
  // 改由 TRANSIENT_MARKERS 显式排除（不依赖 message 里偶然出现的 "rate limit"）。
  // 具名资格判决：上游明说「你没订阅这个模型套餐」。它比 free 层判决更硬——免费层判决还可能随
  // 上游口径变化，套餐缺失则是**换号换节点都不会变**的判决，属本判据射程内却曾被漏判。
  // 实测（errors.log，2026-10-17 两次逐字相同，cline/cline-pass/deepseek-v4.1-flash）：
  // `{"error":{"code":"ENTITLEMENT_ERROR","message":"Error 403: the user is not subscribed to required model plan"}}`
  // ⇒ 旧版 classifyTerminalUpstream 返回 {terminal:false}，被误当普通 403 照跑组员接力收场。
  // 文案兜底另收一条：防上游改 code 名后只保留人类可读的 message。
  /ENTITLEMENT_ERROR/i,
  /not subscribed to required model plan/i,
  /free tier can only be used/i,
  /免费(?:层|额度).{0,12}(?:只能|仅限|不可)/,
];

// 「模型不存在/不可用」：每条 pattern 自身就含 model 语义，故不再另设 `\bmodel\b` 独立单词门
// （那道门既挡死自己的 `model_not_found`/`ProviderModelNotFoundError`，又被 `"param":"model"`
// 这类 JSON 键名随手推开，纯属自相矛盾的假安全）。中英文都收：中文上游目录只有中文文案。
const MODEL_GONE_PATTERNS = [
  /model not found/i,
  /providermodelnotfounderror/i,
  /model is unavailable/i,
  /model_not_found/i,
  /no such model/i,
  /unknown model/i,
  /requested model\b[\s\S]{0,60}\b(not available|not found|does not exist|is not supported)/i,
  /模型(?:不存在|未找到|不可用|已下线|已下架|无法访问)/,
  /(?:没有|无)权限访问(?:该|此)?模型/,
];

// 反向护栏：形状像终局但语义是「这个号/这一发不行」，换号换节点可能就好——绝不终局。
// 只认明确凭据/限流语义词，不收裸 `token`：`max_tokens` 之类的参数报错会被它误判成可接力。
const TRANSIENT_MARKERS = [
  // 限额/限流具名判决 ⇒ **可恢复**（换出口换组员就恢复，见 FREE_TIER_PATTERNS 上方三条实证）。
  // 显式列出而非指望 message 里的 "rate limit" 字样：上游改文案时这层不能跟着失明
  // （`FreeUsageLimitError` 的类名比它的 message 稳定得多）。
  // GoUsageLimitError 与它同族（原 warp-pool/verdict.js:25 把两者并列），同族同判。
  /FreeUsageLimitError|GoUsageLimitError/i,
  /security_reject/i,
  /安全校验拒绝/,
  /isQueued/i,
  /serviceAvailable["\s:]*false/i,
  /rate.?limit|too many requests|over.?quota|retry after/i,
  /invalid (api )?key|missing api key|unauthorized|expired (token|key)|no credentials|鉴权失败|无有效(?:账号|凭据|key)/i,
];

/**
 * 有界读一份失败响应的正文供判决（串行 trial 与 auto 竞速两条出口共用同一口径）：
 *  1s 上限防流式错误体拖慢、≤4KB 防大 body 把正则拖成长扫描，读不到就返回空串——
 *  判据见空串一律**不判终局**（保守回退到「照跑接力」的旧行为，绝不因读不到就停兜底）。
 * 取的是 `clone()`：原响应必须留给收场出口 relay 原字节。
 */
export async function readVerdictText(res, { timeoutMs = 1000, maxChars = 4000 } = {}) {
  try {
    return String(await Promise.race([
      res.clone().text(),
      new Promise((r) => { const t = setTimeout(() => r(""), timeoutMs); t.unref?.(); }),
    ])).slice(0, maxChars);
  } catch {
    return "";
  }
}

function firstHit(list, text) {
  for (const re of list) if (re.test(text)) return re.source;
  return null;
}

/**
 * 上游这条失败响应是不是「换节点也不会变」的终局判决。
 * @param {number} status 上游 HTTP 状态
 * @param {string} bodyText 上游错误体原文（≤4KB，未被日志摘要截成 400 字的那份；见文件头 ⚠）
 * @returns {{terminal: boolean, kind?: string, marker?: string, notice?: string}}
 */
export function classifyTerminalUpstream(status, bodyText = "") {
  const code = Number(status);
  const text = typeof bodyText === "string" ? bodyText : "";
  if (!Number.isInteger(code) || code < 400 || code > 499 || !text.trim()) return { terminal: false };
  // 顺序即优先级：① 先认「上游把免费层说死」——它的文案里也可能带 quota/limit 字样，反过来排会
  // 把终局判成可接力；② 再排坏号/凭据/限流类可恢复拒绝；③ 最后才判模型 id 不存在。
  const freeHit = firstHit(FREE_TIER_PATTERNS, text);
  if (freeHit) {
    return { terminal: true, kind: "free-tier-blocked", marker: freeHit, notice: "上游免费层资格判决（组员同源），已跳过接力" };
  }
  if (firstHit(TRANSIENT_MARKERS, text)) return { terminal: false };
  const goneHit = firstHit(MODEL_GONE_PATTERNS, text);
  if (goneHit) {
    return { terminal: true, kind: "model-gone", marker: goneHit, notice: `上游不认这个模型 id（status=${code}），已跳过接力` };
  }
  return { terminal: false };
}

/**
 * 逃生阀：`MSLXDFF_TERMINAL_SHORTCIRCUIT=0`（含 `false`/`off`/`no`）关掉终局短路，
 * 恢复「任何失败都照跑组员接力」的旧行为。缺省=开（终局判决不接力）。
 * 上游哪天改了文案导致误判/漏判时不停机回退（同 `MSLXDFF_FREE_LANE=0` 的先例：开关方向与名字同向，
 * 别再写一个「设 1 表示关掉」的反向旋钮）。
 */
export function terminalShortcircuitOff(env = process.env) {
  const raw = env.MSLXDFF_TERMINAL_SHORTCIRCUIT;
  if (raw === undefined || raw === null || raw === "") return false;
  const s = String(raw).trim().toLowerCase();
  return s === "0" || s === "false" || s === "off" || s === "no";
}
