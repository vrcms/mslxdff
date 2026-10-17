// warp-pool · 日志与自检报告（2026-10-16 四轮返工后新增；2026-10-17 七次修订补「同机其它 daemon」）。
//
// 为什么单独一个模块（五轮返工的教训）：日志若只说「失败了」、不说「谁干的、为什么」，就只能靠猜——
// 第 1 轮猜孤儿占端口、第 2 轮分不清旧 daemon 子进程与刚被杀还没释放的套接字、第 3 轮分不清握手未完成与上游拒绝、
// 第 4~5 轮对着「退出 / 已复活」循环完全看不出真凶是**同机另一个 daemon**（两边都把对方的活隧道当残留杀）。
// 故把可判定信息一次摆全：配置快照、**同机其它 daemon**、端口占用者（pid+ppid+命令行+本池残留/别人的活隧道/僵尸）、
// 身份文件、每条隧道完整生命周期（清理→写配置→spawn pid→探活耗时/状态/错误→退出码/信号/存活时长/末行）、池子结论与「下一步敲什么命令」。
import { fmtAlive } from "../runtime/proc-info.js";
export const MARK = { step: "▸", ok: "✓", fail: "✗", warn: "⚠" };

const KB = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

/** 人类可读时长：412ms / 1.8s / 2m3s。 */
export function dur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60_000)}m${Math.round((n % 60_000) / 1000)}s`;
}

/** 配置快照：一行说清这次到底按什么参数在跑。 */
export function fmtConfig(cfg) {
  return `[warp-pool] ${MARK.step} 启动自检：开关=${cfg.enabled ? "开" : "关"} 模式=${cfg.mode} 端口=${cfg.ports.join(",")} 策略=${cfg.strategy} 轮换=${cfg.rotate ? "开" : "关"} 冷却=${Math.round(cfg.cooldownMs / 1000)}s`;
}

/** 目录与二进制（带体积，顺手能看出二进制是不是被下坏了）。 */
export function fmtEnv({ dir, binPath, binSize }) {
  const bin = binPath ? `${binPath}（${binSize ? KB(binSize) : "体积未知"}）` : "未就绪";
  return `[warp-pool] ${MARK.step} 目录=${dir} 二进制=${bin}`;
}

/** 身份文件盘点：哪个端口有 id+token+私钥，哪个缺。 */
export function fmtIdentities(nodes, ports) {
  const have = new Set(nodes.map((n) => n.port));
  const parts = ports.map((p) => `:${p}${have.has(p) ? " ✓" : " ✗缺"}`);
  return `[warp-pool] ${MARK.step} 身份文件 ${nodes.length}/${ports.length}：${parts.join(" ")}（✓=有 id+token+私钥，✗缺=现场注册）`;
}

/** 「另一个 daemon(pid 1558055，已运行 6h12m) 的活隧道 pid 33」——两个 daemon 互杀这类事故唯一能一眼看出结论的读数。 */
export function fmtForeign(foreign = []) {
  return (foreign || []).map((f) => `另一个 daemon(pid ${f.ppid}${f.aliveSec != null ? `，已运行 ${fmtAlive(f.aliveSec)}` : ""}) 的活隧道 pid ${f.pid}`).join("；");
}

/** 单端口占用者：区分「本池残留」「另一个 daemon 的活隧道」「僵尸」「别人的进程」「空闲」——两轮返工缺的就是这一行。 */
export function fmtPortState({ port, busy, ours = [], zombies = [], foreign = [], others = [] }) {
  if (!busy) return `[warp-pool]     :${port} 空闲`;
  if (foreign.length) return `[warp-pool]     :${port} 被 ${fmtForeign(foreign)} 占着：那是**别人的活隧道**，本进程不碰它（清了就是和另一个 daemon 互杀）`;
  if (ours.length) return `[warp-pool]     :${port} 被 pid ${ours.join(",")} 占：本池 wireproxy 残留（上一代 daemon 留下的孤儿）→ 起隧道前清理`;
  if (zombies.length) return `[warp-pool]     :${port} 有本池僵尸 pid ${zombies.join(",")}（已死等收尸：kill 无效，也不再占端口）`;
  const who = others.length ? others.map((o) => `pid ${o.pid} ${o.name}`).join("、") : "未知进程";
  return `[warp-pool]     :${port} 被 ${who} 占：非本池进程 → 不碰它，这个端口本轮跳过（查明：ss -ltnp | grep :${port}）`;
}

/** 清理残留的结果：扫了多少进程、命中谁、等了多久、清掉没、以及「另一个 daemon 占着」这种不该动的情形。 */
export function fmtReclaim({ port, scanned, killed = [], zombies = [], foreign = [], waitedMs = 0, gone = true }) {
  const parts = [`扫 ${scanned} 个进程`];
  if (killed.length) parts.push(`命中本池残留 pid ${killed.join(",")} → ${gone ? "已清掉" : "清不掉（SIGTERM/SIGKILL 都试过）"}`);
  else parts.push("无本池残留");
  if (zombies.length) parts.push(`僵尸 pid ${zombies.join(",")}（已死等收尸，kill 无效）`);
  if (foreign.length) parts.push(`${MARK.warn} ${fmtForeign(foreign)}——不碰它（清了就是和另一个 daemon 互杀）`);
  const wait = killed.length ? `（等了 ${dur(waitedMs)}）` : "";
  return `[warp-pool] :${port} ${MARK.step} 清理残留：${parts.join("；")}${wait}`;
}

/** 写出的 WireGuard 配置（体积能看出是不是缺字段：缺私钥那次就是 338B vs 373B）。 */
export function fmtConf({ port, conf, bytes }) {
  return `[warp-pool] :${port} ${MARK.step} 写配置 ${conf}（${bytes}B，0600）`;
}

/** 起隧道：pid + 完整命令行，事后可 `ps -p <pid>` 对账。 */
export function fmtSpawn({ port, pid, binPath, conf }) {
  return `[warp-pool] :${port} ${MARK.step} 起隧道 pid=${pid ?? "?"}：${binPath} -c ${conf}`;
}

/** 探活单次：URL、状态、耗时、错误原文——第 3 轮返工缺的就是「到底哪一步不通」。 */
export function fmtProbe({ port, attempt, attempts, url, ok, status, error, ms }) {
  const head = `[warp-pool] :${port} ${ok ? MARK.ok : MARK.fail} 探活 ${attempt}/${attempts}：GET ${url} 经 127.0.0.1:${port}`;
  const tail = ok
    ? `HTTP ${status}（${dur(ms)}）→ 进池`
    : `HTTP ${status || 0}（${dur(ms)}）${error ? ` 错误=${String(error).slice(0, 160)}` : ""} → 稍后重试`;
  return `${head} → ${tail}`;
}

/** 探活彻底失败：说清「不进池」的后果与自检命令，而不是只丢一句「没探通」。 */
export function fmtProbeGiveUp({ port, attempts, url }) {
  return `[warp-pool] :${port} ${MARK.fail} 探活 ${attempts} 次都不通 ⇒ 不进池（进程可能在跑但隧道转不动流量，进池会把请求挂到超时，比直连更糟）。自检：curl --proxy http://127.0.0.1:${port} ${url}`;
}

/** 隧道退出：退出码/信号/存活时长/pid/是否外部终止/stderr 末行（含「谁杀的」这一层推断）。 */
export function fmtExit({ port, code, signal, pid, aliveMs, tail }) {
  const how = signal ? `信号 ${signal}` : `退出码 ${code}`;
  const killed = signal ? "本进程未调用 stop ⇒ 外部终止（别人杀了它 / 系统回收）" : "进程自行退出（多为配置被拒或端口被占）";
  return `[warp-pool] :${port} ${MARK.fail} 隧道退出：${how}｜存活 ${aliveMs == null ? "?" : dur(aliveMs)}｜pid ${pid ?? "?"}｜${killed}｜末行="${tail || "没有输出"}"`;
}

/** 端口最终被占着、拒绝硬起时，把「另一个 daemon 的活隧道 / 本池残留 / 僵尸 / 别人的进程 / 套接字还没释放」分开说。 */
export function fmtPortBlocked({ port, ours = [], zombies = [], foreign = [], others = [] }) {
  const foreignTxt = foreign.length ? `${fmtForeign(foreign)}（清了就是互杀，故本进程不碰）——先停掉那个 daemon：kill ${[...new Set(foreign.map((f) => f.ppid))].join(" ")}` : "";
  const oursTxt = ours.length ? `本池残留 pid ${ours.join(",")}（SIGTERM/SIGKILL 都没清掉）` : "";
  const zombieTxt = zombies.length ? `本池僵尸 pid ${zombies.join(",")}（已死等收尸，不占端口）` : "";
  const othTxt = others.length ? others.map((o) => `pid ${o.pid} ${o.name}`).join("、") : "";
  const who = [foreignTxt, oursTxt, zombieTxt, othTxt].filter(Boolean).join("；") || "未知进程（已等套接字释放仍连得上）";
  return `[warp-pool] :${port} ${MARK.fail} 端口被 ${who} 占着，拒绝再起（硬起只会 bind 失败、无限重启刷屏）。查明：ss -ltnp | grep :${port}`;
}

/** 池子结论：入池几个、各端口出口是什么、几种不同地址——一句话判断「WARP 到底有没有在用」。 */
export function fmtPool({ pooled, total, exits }) {
  const head = `[warp-pool] ${MARK.step} 出口池就绪：${pooled}/${total} 条入池`;
  const ipOf = new Map();
  for (const g of exits || []) for (const p of g.nodes || []) if (g.ip) ipOf.set(p, g.ip);
  if (!ipOf.size) return `${head}｜出口地址未知（CF trace 取证失败，不影响使用）`;
  const table = [...ipOf.entries()].map(([p, ip]) => `:${p}=${ip}`).join(" ");
  return `${head}｜出口：${table}｜不同地址 ${new Set(ipOf.values()).size} 个`;
}

/**
 * 身份指纹：每个端口的短设备 id / WARP 内网 IPv6 尾段 / 对端端点 / 注册时间。
 * 为什么必须有：4 条隧道只拿到 2 个出口地址时（真机 2026-10-17），只有这组读数能区分
 * 「设备本身被写重复了」和「CF 把不同设备折叠成一个出口」——没有它就只能猜。
 *
 * ⚠ 判据**不看 IPv4**：`172.16.0.2` 是 WARP 的**固定接口地址**（6 次实测全是它：组长 4 台 +
 * 本机 2 台；公开的 wgcf 生成配置里同样是 `Address = 172.16.0.2/32`），按它判「重复」是误报
 * （2026-10-17 十一次修订前确实这么误报过）。每台设备真正唯一的是 **IPv6**（`2606:4700:110:…`）
 * 与密钥对，所以指纹打 v6 尾段。
 */
/** v6 尾段做指纹（`2606:4700:110:81b5:56ec:72b3:9542:e3de` → `…:9542:e3de`）；缺了给「无」。 */
export function v6Tail(v6) {
  const s = String(v6 || "");
  if (!s) return "无";
  const parts = s.split(":");
  return parts.length > 2 ? `…:${parts.slice(-2).join(":")}` : s;
}
export function fmtIdentityDetail(nodes = []) {
  const out = [];
  const byId = new Map();
  const byEp = new Map();
  for (const n of nodes || []) {
    if (n?.id) byId.set(n.id, [...(byId.get(n.id) || []), n.port]);
    if (n?.endpoint) byEp.set(n.endpoint, [...(byEp.get(n.endpoint) || []), n.port]);
    out.push(`[warp-pool]     :${n?.port} 设备=${n?.id ? String(n.id).slice(0, 8) : "无id"} 内网v6=${v6Tail(n?.v6)} 端点=${n?.endpoint || "?"} 注册=${String(n?.registeredAt || "?").slice(0, 19)}`);
  }
  const dupId = [...byId.entries()].filter(([, p]) => p.length > 1).map(([k, p]) => `${String(k).slice(0, 8)} ← :${p.join(",:")}`).join("；");
  if (dupId) out.push(`[warp-pool] ${MARK.warn} 设备 id 重复：${dupId} —— 同一个 WARP 设备被写到多个端口，出口必然相同；删掉重复端口的 node-<port>.json 再重启，它会重新注册`);
  // 端点全同 = 大家都从同一个 CF 入口出去（CF 对每次注册都回同一个 hostname）：出口撞车由此而来
  const total = (nodes || []).length;
  const sameEp = [...byEp.entries()].find(([, p]) => total > 1 && p.length === total);
  if (sameEp) out.push(`[warp-pool] ${MARK.step} ${total} 条隧道都用同一个端点（${sameEp[0]}）—— CF 对每次注册都回同一个 hostname，故大家都从同一个 CF 入口出去，出口地址撞车由此而来（想分散：把 node-<port>.json 的 endpoint 改成别的 WARP 入口 IP 后重启）`);
  return out;
}

/**
 * 出口分散结论：几个出口地址 / 几条隧道在线、撞车的是谁、以及「想多要一份该怎么办」。
 * 措辞必须自洽：免费 WARP 的 IPv4 是共享 NAT，**隧道数 ≠ 上游名额数**——旧措辞
 * 「同时在线就有 N 份名额」与紧邻的「出口不分散」分支自相矛盾（真机 4 条隧道只拿到 2 个出口）。
 */
export function fmtExits({ groups = [], dir = "" } = {}) {
  if (!groups.length) return "";
  const online = groups.reduce((a, g) => a + g.nodes.length, 0);
  if (groups.length === 1) {
    return `[warp-pool] ${MARK.warn} 出口不分散：${online} 条隧道同时在线只有 1 个出口地址（${groups[0].ip}）：免费版 WARP 的 IPv4 是共享 NAT，多开隧道换不到多份名额；多份名额靠撞 429 时的身份轮换`;
  }
  const collide = groups.filter((g) => g.nodes.length > 1);
  const drop = collide.flatMap((g) => g.nodes.slice(1));
  const base = dir || "$HOME/.config/mslxdff/warp-pool";
  const next = drop.length
    ? `｜${MARK.warn} 撞车：${collide.map((g) => `${g.ip} ← :${g.nodes.join(",:")}`).join("；")}（它们共用同一份上游名额）⇒ 想多要一份：rm -f ${drop.map((p) => `${base}/node-${p}.json`).join(" ")} && mslxdff -restart（重新注册换出口；共享 NAT 下常换不动，要试几次）`
    : "";
  return `[warp-pool] ${MARK.step} 出口分散：${groups.length} 个出口地址 / ${online} 条隧道在线（上游按出口 IP 计名额 ⇒ 最多 ${groups.length} 份；隧道数 ≠ 名额数：免费版 WARP 的 IPv4 是共享 NAT）${next}`;
}

/** 池空告警：最容易被误读成「功能在跑」，必须把结论与逐条自检命令一起说。 */
export function fmtPoolEmpty({ total, ports }) {
  return `[warp-pool] ${MARK.warn} 没有一条隧道探通 ⇒ 池为空，全部请求照旧直连（不影响可用性，但 WARP 出口等于没启用）。逐条自检：for p in ${ports.join(" ")}; do echo -n ":$p "; curl -s --max-time 8 --proxy http://127.0.0.1:$p https://cloudflare.com/cdn-cgi/trace | grep '^ip='; done`;
}

/** 健康检查一轮：只在状态变化/心跳时打（每分钟一行会把日志淹掉）。 */
export function fmtHealth({ healthy, total, slowestMs, problems = [] }) {
  if (!problems.length) return `[warp-pool] ${MARK.ok} 健康检查：${healthy}/${total} 通（最慢 ${dur(slowestMs)}）`;
  const detail = problems
    .map((p) => `:${p.port} 第 ${p.fails} 次不通（HTTP ${p.status || 0}${p.error ? ` ${String(p.error).slice(0, 80)}` : ""}，${dur(p.ms)}）冷却 ${Math.round(p.cooldownMs / 1000)}s`)
    .join("；");
  return `[warp-pool] ${MARK.warn} 健康检查：${healthy}/${total} 通｜不通：${detail}`;
}

/** 心跳：一行给全部关键状态，省得「日志翻半天不知道现在啥情况」。 */
export function fmtHeartbeat({ alive, total, pooled, exits, cooling, lastAllDown }) {
  const ips = [...new Set((exits || []).map((e) => e.ip).filter(Boolean))];
  return `[warp-pool] ${MARK.step} 心跳：隧道 ${alive}/${total} 活｜入池 ${pooled}｜出口 ${ips.length ? `${ips.length} 种（${ips.join(",")}）` : "未知"}｜冷却中 ${cooling}｜全池不通 ${lastAllDown || "未发生"}`;
}

/** 同机其它 daemon：两个 daemon 抢同一批端口会互杀（真机事故根因），必须一次说清并给出精确 kill 命令。 */
export function fmtSiblings({ list = [] } = {}) {
  if (!list.length) return "";
  const who = list.map((d) => `pid ${d.pid}（父 ${d.ppid}${d.aliveSec != null ? `，已运行 ${fmtAlive(d.aliveSec)}` : ""}）`).join("；");
  return `[warp-pool] ${MARK.warn} 同机还有 ${list.length} 个别的 mslxdff daemon 在跑：${who} —— 它也在管同一个出口池目录，两边会把对方的隧道当「残留」杀掉（本池每个 conf 只允许一个拥有者）。先停掉它：kill ${list.map((d) => d.pid).join(" ")}`;
}

/**
 * 启动自检块：一次性把「这次按什么参数跑、二进制在哪多大、磁盘上有几个身份、端口分别被谁占着」打全。
 * 第 1 轮返工只看到「退出 code=1 / 已复活」循环，就是缺这一块——真因（孤儿占端口）当时只能靠猜。
 * @param {{ cfg: object, nodes: Array<object>, binPath?: string, binSize?: number,
 *           ownerOf: (port:number)=>Promise<{busy:boolean, ours:number[], zombies:number[], foreign:Array<object>, others:Array<{pid:number,name:string}>}>,
 *           log?: Function }} opts
 */
export async function startupReport({ cfg, nodes, binPath = "", binSize = 0, ownerOf, log = () => {} }) {
  log(fmtConfig(cfg));
  log(fmtEnv({ dir: cfg.dir, binPath, binSize }));
  log(fmtIdentities(nodes, cfg.ports));
  const states = [];
  for (const port of cfg.ports) {
    try {
      states.push({ port, ...(await ownerOf(port)) });
    } catch (e) {
      states.push({ port, busy: false, ours: [], zombies: [], foreign: [], others: [], error: String(e?.message || e) });
    }
  }
  const busy = states.filter((s) => s.busy);
  log(`[warp-pool] ${MARK.step} 端口体检：${busy.length} 个被占 / ${states.length} 个端口`);
  for (const s of states) log(fmtPortState(s));
  // 另一个 daemon 占着端口 = 两个 daemon 互杀（真机事故根因）：必须单独大声报，并给出精确 kill 命令
  const foreign = busy.flatMap((s) => s.foreign || []);
  if (foreign.length) {
    const pids = [...new Set(foreign.map((f) => f.ppid))];
    log(`[warp-pool] ${MARK.warn} ${foreign.length} 个端口被 ${fmtForeign(foreign)} 占着 —— 那不是残留，本进程不碰它（清了就是互杀）。若那是上一代的 daemon：kill ${pids.join(" ")}`);
  }
  const orphans = busy.filter((s) => (s.ours || []).length).length;
  if (orphans) log(`[warp-pool] ${MARK.warn} 有 ${orphans} 个端口被本池残留占着（上一代 daemon 被强杀留下的孤儿）——起隧道前逐个清理，日志会写清 pid`);
  const zombies = busy.filter((s) => (s.zombies || []).length).length;
  if (zombies) log(`[warp-pool] ${MARK.step} 有 ${zombies} 个端口上还有本池僵尸进程（已死等收尸：kill 无效，也不再占端口，无需处理）`);
  return states;
}
