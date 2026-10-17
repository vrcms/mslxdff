// warp-pool · 日志与自检报告（2026-10-16 四轮返工后新增）。
//
// 为什么单独一个模块（四轮返工的教训）：日志若只说「失败了」、不说「谁干的、为什么」，就只能靠猜——
// 第 1 轮猜孤儿占端口、第 2 轮分不清旧 daemon 子进程与刚被杀还没释放的套接字、第 3 轮分不清握手未完成与上游拒绝。
// 故把可判定信息一次摆全：配置快照、端口占用者（pid+命令行+是否本池残留）、身份文件、每条隧道完整生命周期
// （清理→写配置→spawn pid→探活耗时/状态/错误→退出码/信号/存活时长/末行）、池子结论与「下一步敲什么命令」。
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

/** 单端口占用者：区分「本池残留」「别人的进程」「空闲」——第 1 轮返工缺的就是这一行。 */
export function fmtPortState({ port, busy, ours = [], others = [] }) {
  if (!busy) return `[warp-pool]     :${port} 空闲`;
  if (ours.length) return `[warp-pool]     :${port} 被 pid ${ours.join(",")} 占：本池 wireproxy 残留（上一代 daemon 被强杀留下的孤儿）→ 起隧道前清理`;
  const who = others.length ? others.map((o) => `pid ${o.pid} ${o.name}`).join("、") : "未知进程";
  return `[warp-pool]     :${port} 被 ${who} 占：非本池进程 → 不碰它，这个端口本轮跳过（查明：ss -ltnp | grep :${port}）`;
}

/** 清理残留的结果：扫了多少进程、命中谁、等了多久、清掉没——第 2 轮返工缺的就是「谁在占」。 */
export function fmtReclaim({ port, scanned, ours = [], others = [], waitedMs, killed }) {
  if (!ours.length) {
    const extra = others.length ? "（端口另有别的进程占着，不是本池的，不动它）" : "";
    return `[warp-pool] :${port} ${MARK.step} 清理残留：扫 ${scanned} 个进程，无本池残留${extra}`;
  }
  return `[warp-pool] :${port} ${MARK.step} 清理残留：扫 ${scanned} 个进程，命中本池残留 pid ${ours.join(",")} → ${killed ? "已清掉" : "清不掉"}（等了 ${dur(waitedMs)}）`;
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

/** 端口最终被非本池进程占着、拒绝硬起时，把占用者与「套接字还没释放」两种情形分开说。 */
export function fmtPortBlocked({ port, ours = [], others = [] }) {
  const oursTxt = ours.length ? `本池残留 pid ${ours.join(",")}（SIGTERM/SIGKILL 都没清掉：可能僵尸或权限不足）` : "";
  const othTxt = others.length ? others.map((o) => `pid ${o.pid} ${o.name}`).join("、") : "";
  const who = [oursTxt, othTxt].filter(Boolean).join("；") || "未知进程（已等套接字释放仍连得上）";
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

/**
 * 启动自检块：一次性把「这次按什么参数跑、二进制在哪多大、磁盘上有几个身份、端口分别被谁占着」打全。
 * 第 1 轮返工只看到「退出 code=1 / 已复活」循环，就是缺这一块——真因（孤儿占端口）当时只能靠猜。
 * @param {{ cfg: object, nodes: Array<object>, binPath?: string, binSize?: number,
 *           ownerOf: (port:number)=>Promise<{busy:boolean, ours:number[], others:Array<{pid:number,name:string}>}>,
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
      states.push({ port, busy: false, ours: [], others: [], error: String(e?.message || e) });
    }
  }
  const busy = states.filter((s) => s.busy);
  log(`[warp-pool] ${MARK.step} 端口体检：${busy.length} 个被占 / ${states.length} 个端口`);
  for (const s of states) log(fmtPortState(s));
  const orphans = busy.filter((s) => (s.ours || []).length).length;
  if (orphans) log(`[warp-pool] ${MARK.warn} 有 ${orphans} 个端口被本池残留占着（上一代 daemon 被强杀留下的孤儿）——起隧道前逐个清理，日志会写清 pid`);
  return states;
}
