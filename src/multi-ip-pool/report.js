// multi-ip-pool · 日志文案（判据来自 warp-pool/report.js 的同一套纪律）：
//   **「看完日志还需要的下一个命令，就是日志没写好的地方」**。
//   行首符号：▸步骤 / ✓正常 / ✗失败 / ⚠警告；每条失败行都要带「为什么 + 下一步」。
const SYM = { step: "▸", ok: "✓", bad: "✗", warn: "⚠" };
const TAG = "[multi-ip-pool]";

export function fmtConfig(cfg) {
  return `${TAG} ${SYM.step} 多出口池配置：隧道 ${cfg.count} 条｜备选 ${cfg.standby} 条（每 ${Math.round((cfg.standbyEveryMs || 0) / 60_000)} 分钟重拨一批）｜打 hi 用 ${cfg.probeModel || "缺省免费模型"}｜国家 ${cfg.countries.length ? cfg.countries.join("/") : "不限"}｜Score ≥ ${cfg.minScore}｜表号 ${cfg.baseTable}+｜目录 ${cfg.dir}｜openvpn ${cfg.openvpnBin}｜轮换 ${cfg.rotate ? "开" : "关"}`;
}

export function fmtDisabled() {
  return `${TAG} 出口池已关闭（MSLXDFF_MULTI_IP_POOL=0），请求走直连`;
}

export function fmtRoleSkip({ role, why }) {
  return `${TAG} ${SYM.step} 跳过：本节点角色=${role}（${why}）—— 出口池只由组长建，组员与单机都不建`;
}

export function fmtRoleOk({ role, why }) {
  return `${TAG} ${SYM.ok} 角色门通过：role=${role}（${why}）`;
}

export function fmtPlatformSkip({ platform, why }) {
  return `${TAG} ${SYM.step} 跳过：${why}（当前平台 ${platform}）—— 本功能要 Linux 的 tun 设备与 ip rule，其它平台请用 v6 池或 WARP 池`;
}

export function fmtNoRoot() {
  return `${TAG} ${SYM.step} 跳过：需要 root（要建 tun 设备 + 改策略路由 + 写 rp_filter）。下一步：sudo mslxdff -multi-ip-pool test（或让 root 起 daemon）`;
}

export function fmtNoOpenvpn({ bin, why }) {
  return `${TAG} ${SYM.step} 跳过：没找到可用的 ${bin}（${why}）。下一步：apt install openvpn（或 MSLXDFF_MULTI_IP_OPENVPN 指到全路径）`;
}

export function fmtNodes({ source, total, countries, minScore }) {
  return `${TAG} ${SYM.ok} 节点表来自 ${source}：共 ${total} 个节点（筛选：国家 ${countries.length ? countries.join("/") : "不限"}、Score ≥ ${minScore}）`;
}

export function fmtNodePick({ i, n, row, dev }) {
  return `${TAG} ${SYM.step} [${i}/${n}] 尝试 ${row.hostName}（${row.countryShort || "?"} ${row.ip} Score=${row.score} ping=${row.ping}ms）→ ${dev}`;
}

export function fmtSpawn({ dev, pid, host, port, country, table }) {
  return `${TAG} ${SYM.ok} ${dev} 隧道就绪（pid=${pid}，出口节点 ${host}:${port} ${country}，策略表 ${table}）`;
}

/** 实际执行的 openvpn 命令行（argv 原文）：真机排障第一问就是「你到底跑了什么」。 */
export function fmtArgv({ bin, args }) {
  return `${TAG} ${SYM.step} 执行：${bin} ${(args || []).join(" ")}`;
}

export function fmtTunAddrFail({ dev, out }) {
  return `${TAG} ${SYM.bad} ${dev} 起来了但读不到 tun 地址（ip -4 addr show dev ${dev} 的输出：${(out || "(空)").slice(0, 200)}）—— 隧道建不起来，这槽换下一个节点`;
}

export function fmtRuleFail({ dev, cmd, error }) {
  return `${TAG} ${SYM.bad} ${dev} 装策略路由失败：${cmd} → ${error}。下一步：ip rule show 看优先级、ip route show table all 看表号，是否被别人的规则/表号占了（可改 MSLXDFF_MULTI_IP_BASE_TABLE）`;
}

export function fmtRpf({ ok, skipped, changed = [], error = "" } = {}) {
  if (skipped) return `${TAG} ${SYM.warn} rp_filter 未改（MSLXDFF_MULTI_IP_SYSCTL=0）：若隧道通了但请求全挂住，先查这里`;
  if (ok && !changed.length) return `${TAG} ${SYM.ok} rp_filter 已是宽松模式（2），无需改动`;
  if (ok) return `${TAG} ${SYM.warn} 已把 rp_filter 改为 2（宽松）：${changed.map((c) => `${c.path}: ${c.from}→2`).join("，")}｜还原命令：sysctl -w net.ipv4.conf.all.rp_filter=1`;
  return `${TAG} ${SYM.warn} rp_filter 改不动（${error}）：可能隧道活着但请求挂住（不对称路由被内核丢了）。下一步：sysctl -w net.ipv4.conf.all.rp_filter=2`;
}

export function fmtProbe({ dev, url, ok, status, error, ms }) {
  if (ok) return `${TAG} ${SYM.ok} ${dev} 探活通过：${url} → HTTP ${status}（${ms}ms）`;
  return `${TAG} ${SYM.bad} ${dev} 探活不通：${url} → ${status ? `HTTP ${status}` : String(error || "无响应").slice(0, 120)}（${ms}ms）`;
}

export function fmtProbeGiveUp({ dev, attempts, url }) {
  return `${TAG} ${SYM.bad} ${dev} 连续 ${attempts} 次探活都不过，本槽不进池（${url}）—— 隧道进程活着但转不动流量时进池会把请求挂到超时，比直连更糟`;
}

export function fmtExitIp({ dev, ip, ms, prev }) {
  const what = prev ? (prev === ip ? `出口没变（仍是 ${ip}）` : `出口已换：${prev} → ${ip}`) : `出口 ${ip}`;
  return `${TAG} ${SYM.ok} ${dev} 出口取证：${what}（${ms}ms）`;
}

export function fmtExitIpFail({ dev, error }) {
  return `${TAG} ${SYM.bad} ${dev} 出口取证失败：${String(error || "").slice(0, 160)}—— 这条隧道的出口未知，不视为可用`;
}

export function fmtPool({ pooled, tried, exits }) {
  return `${TAG} ${SYM.ok} 出口池就绪：${pooled}/${tried} 槽可用｜出口 IP：${exits.length ? exits.join("，") : "(待取证)"}`;
}

export function fmtPoolEmpty({ tried, why }) {
  return `${TAG} ${SYM.bad} 出口池为空（试了 ${tried} 个节点都没起通）：${why}—— 请求继续走直连，不影响其它出口源`;
}

export function fmtSwap({ dev, from, to, status, kind, forced, swaps }) {
  return `${TAG} ${SYM.step} ${dev} 上游 ${status} 判为「${kind}」⇒ 换出口${forced ? "（强制，跳过冷却）" : ""}：${from} → ${to}（第 ${swaps} 次换）`;
}

export function fmtSwapFail({ dev, error }) {
  return `${TAG} ${SYM.bad} ${dev} 换出口失败：${String(error || "").slice(0, 200)}—— 原槽保持原状，不把池打空`;
}

export function fmtFirstOk({ dev, ip, swaps, counts }) {
  return `${TAG} ${SYM.ok} ${dev} 换出口后首个 200（出口 ${ip}，换过 ${swaps} 次，本轮状态分布 ${JSON.stringify(counts)}）—— 这就是「换 IP 有没有换来新额度」的直接证据`;
}

export function fmtNoRotate({ dev, status, kind }) {
  return `${TAG} ${SYM.warn} ${dev} 上游 ${status}（${kind}）—— 轮换开关关着（MSLXDFF_MULTI_IP_ROTATE=0），不换出口`;
}

export function fmtVerdictNo({ dev, status, kind, why }) {
  return `${TAG} ${SYM.step} ${dev} 上游 ${status} 判为「${kind}」⇒ 不换出口：${why}`;
}

export function fmtDirect({ reason }) {
  return `${TAG} ${SYM.warn} 全部槽都在冷却/换出口中，本发走直连兜底：${reason}`;
}

export function fmtExit({ dev, code, signal, pid, aliveMs, tail }) {
  return `${TAG} ${SYM.warn} ${dev} 隧道进程退出（code=${code} signal=${signal} pid=${pid}${aliveMs ? ` 存活 ${Math.round(aliveMs / 1000)}s` : ""}）：${tail || "(无输出)"}`;
}

export function fmtClose({ closed, failed = 0 }) {
  return `${TAG} ${SYM.step} 收摊：已关 ${closed} 条隧道${failed ? `，${failed} 条没关干净（下次启动查残留：ip link show | grep ${""}mltun）` : ""}`;
}

export function fmtResidual({ dev }) {
  return `${TAG} ${SYM.warn} 发现上一代留下的设备 ${dev}（上次 daemon 被强杀时子进程不会自己退）：下一步 ip link del ${dev}`;
}

/** 免费层判决的人话名（与 `warp-pool/verdict.js` 的 kind 一一对应，不自造一套）。 */
const KIND_ZH = { "free-quota": "429 额度耗尽", "free-tier": "403 免费层资格", "ip-limit": "429 限流", "black-quota": "账号日配额", network: "网络不可达", none: "非额度信号" };

/** 「打一个 hi 到上游、要它 200」的读数行：只有 200 才算"这个出口此刻真有额度"。 */
export function fmtHi({ dev, model, status, kind, ip, ms, error } = {}) {
  const who = `${dev}${ip ? `（出口 ${ip}）` : ""}`;
  if (status === 200) return `${TAG} ${SYM.ok} ${who} 打 hi 通过：${model} → HTTP 200（${ms}ms）—— 这个出口有额度`;
  return `${TAG} ${SYM.bad} ${who} 打 hi 未通：${model} → ${status ? `HTTP ${status}（${KIND_ZH[kind] || kind || "?"}）` : String(error || "无响应").slice(0, 120)}（${ms}ms）—— 没额度的出口不当备用，换下一个`;
}

/** 备用出口收下：一条已验通（hi 200）的隧道躺在备选池里等 429。 */
export function fmtStandbyAdd({ dev, node, exitIp, tunIp, have, want } = {}) {
  return `${TAG} ${SYM.ok} 备选池 +1：${dev} ${node || "?"}（tun ${tunIp}，出口 ${exitIp || "未取证"}）→ 现有 ${have}/${want} 条待命`;
}

/** 补位结论行（每小时一次，也是"这轮找到几个新 IP"的读数）。 */
export function fmtStandbyRefill({ added, have, want, dialed } = {}) {
  return `${TAG} ${SYM.step} 备选池补位：本轮拨 ${dialed} 条、收下 ${added} 条 → ${have}/${want} 待命（标准是 hi 回 200，不是"隧道起来了"）`;
}

/** 取用备用出口那一刻的读数（429 后"立即启用"的证据）。 */
export function fmtStandbyUse({ dev, tunIp, exitIp, node, left } = {}) {
  return `${TAG} ${SYM.ok} 启用备用出口：${dev} ${node || "?"}（tun ${tunIp}，出口 ${exitIp || "未取证"}）→ 剩余备用 ${left} 条`;
}

/** 备用出口被丢弃的原因（复验没过 200 = 这一小时里那个 IP 的额度被别人吃光了）。 */
export function fmtStandbyDrop({ dev, node, status, kind, error } = {}) {
  return `${TAG} ${SYM.warn} 丢弃备用出口 ${dev} ${node || "?"}：复验 hi → ${status ? `HTTP ${status}（${KIND_ZH[kind] || kind || "?"}）` : String(error || "无响应").slice(0, 120)}—— 宁缺毋滥，不把没额度的 IP 交给请求`;
}

/** 备选池这轮没干成事（取不到候选 / 拨号异常）：必须留一行，否则"为什么没有备胎"无从判断。 */
export function fmtStandbySkip({ why } = {}) {
  return `${TAG} ${SYM.warn} 备选池本轮跳过：${why}—— 429 时若备胎为空只能现场拨号（慢），原因就是这条`;
}