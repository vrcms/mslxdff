import { createServer as httpCreateServer } from "node:http";
import { DEFAULT_PORT, getPort } from "./state.js";
import { flushAgentLoop } from "./talk-full.js"; // 关停收尾：talk/full 捕获是异步队列落盘，退出前排空（空队列时近似 O(1)，且自身不抛）

export function startServer({ router, signals = true, host, onBeforeClose }, port = resolvePort()) {
  const listenHost = host ?? resolveHost();
  const server = httpCreateServer((req, res) => {
    router(req, res).catch((err) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    });
  });
  // 空闲 keep-alive 连接必须活得比**客户端池**（打我们的组员/peer 用 undici keepAliveTimeout=30s，
  // routes/peers.js:64）更久，否则出现两端超时打架：服务端 Node 默认 5s 就单方面掐掉闲置连接，
  // 而组长池里的 socket 账面上还活着（<30s），下一次真请求复用死 socket ⇒ `fetch failed`
  //（现网 2026-10-18 16:16：三个组员同时 fetch failed，peer-race 全灭、收场 502——间歇性、下一发又好的形态）。
  // 65s = 30s 客户端余量 + 一倍缓冲；headersTimeout 必须 > keepAliveTimeout（Node 断言要求），取 70s。
  server.keepAliveTimeout = Number(process.env.MSLXDFF_KEEPALIVE_TIMEOUT_MS) || 65_000;
  server.headersTimeout = Number(process.env.MSLXDFF_HEADERS_TIMEOUT_MS) || 70_000;

  const ready = () =>
    new Promise((resolve, reject) => {
      server.on("error", reject);
      if (listenHost) server.listen(port, listenHost, resolve);
      else server.listen(port, resolve);
    });

  const close = async () => {
    // 关停序列里唯一的新增步：先排空 agent 回路捕获（talk/full）的异步写队列，再走既有顺序
    // （server:stop hook → server.close/closeAllConnections）。既有关停顺序语义一字未动；
    // 队列空时 flush 即刻返回，且 flushAgentLoop 自身不抛（外层 try 只为兜住 import 侧意外）。
    try { await flushAgentLoop(); } catch {}
    // 插件 hook：server:stop — 关闭前触发（fire-and-forget，不阻塞关停）
    try { await onBeforeClose?.(); } catch {}
    await new Promise((resolve) => {
      server.close(resolve);
      // SSE debug streams keep connections open — force-close so shutdown
      // never waits on them.
      server.closeAllConnections?.();
    });
  };

  if (signals) {
    // 关停留痕（Linux 有效：可捕获 SIGTERM/SIGINT 并记录）。Windows 注意：process.kill 的
    // SIGTERM 实为 TerminateProcess 强杀，被杀的 JS 进程收不到该事件，此处不会触发——
    // Windows 的"谁杀了我"靠 src/daemon.js stopDaemon() 的杀者留痕 + 最后一条 heartbeat。
    let stopping = false;
    const onSignal = (sig) => {
      if (stopping) return;
      stopping = true;
      try { console.log(`[lifecycle] ${sig} received — shutting down (pid ${process.pid}, uptime ${Math.round(process.uptime())}s)`); } catch {}
      // 关停必须**真的退出**：warp-pool 的 wireproxy 子进程 stdio 是 pipe，活着的子进程会把事件循环钉住；
      // 只 close() server（放开 8989）会留下「不监听端口却还活着」的幽灵 daemon
      //（真机 2026-10-17：Oct16 起的幽灵与新版互杀 warp-pool 端口一整天，且它不在 daemon.pid 里，-restart 永远碰不到）。
      // process.exit 会跑 exit 钩子（warp-pool 杀隧道、lifecycle 写遗书），故清理不会被跳过。
      const hard = setTimeout(() => { try { console.log(`[lifecycle] ${sig} 优雅关停 8s 未完成 — 强制退出`); } catch {} process.exit(0); }, 8000);
      hard.unref?.();
      close().then(() => process.exit(0), (e) => { try { console.log(`[lifecycle] 关停抛错：${String(e?.message || e)}`); } catch {} process.exit(1); });
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
  }

  return { server, ready, close };
}

export function resolveHost() {
  const envHost = process.env.MSLXDFF_HOST || process.env.MSLXDFF_BIND_HOST;
  if (typeof envHost === "string" && envHost.trim()) return envHost.trim();
  return "0.0.0.0";
}

export function resolvePort() {
  // 8989 is the hard default. Port only changes via an explicit, mslxdff-owned
  // override: the persisted `-port N` setting, or the MSLXDFF_PORT env var.
  // Bare `PORT` is deliberately NOT read — an ssh session / wrapper script
  // commonly injects it and would silently override the default.
  const persisted = getPort();
  if (persisted) return persisted;
  const env = Number(process.env.MSLXDFF_PORT);
  // 0 = OS-assigned ephemeral port (valid; used by tests/containers)
  if (Number.isInteger(env) && env >= 0) return env;
  return DEFAULT_PORT;
}
