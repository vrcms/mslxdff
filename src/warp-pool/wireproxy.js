// warp-pool · wireproxy 进程管理：取二进制 → 生成配置 → 启动 → 守护/销毁。
// wireproxy（octeep/wireproxy，Go，用户态 WireGuard，无需 root/TUN）把 WARP 隧道暴露为本地 HTTP 代理。
// 为什么是 [http] 而非 [Socks5]：项目 undici 为 v5（实测 5.29.0），其 ProxyAgent 只接受 http/https，
// 「SOCKS5 支持」是 undici 后续版本才加的（实测 socks5:// 直接抛 Invalid URL protocol）。
import { spawn } from "node:child_process";
import { chmodSync, existsSync, createWriteStream, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { compatFetch, getUndici } from "../compat.js";
import { ensureDir, nodePaths, renderWireproxyConf, writeSecret } from "./nodes.js";

export const WIREPROXY_VERSION = "v1.1.3";
const RELEASE_BASE = "https://github.com/octeep/wireproxy/releases/download";

const ASSETS = {
  "linux-x64": "wireproxy_linux_amd64.tar.gz",
  "linux-arm64": "wireproxy_linux_arm64.tar.gz",
  "darwin-x64": "wireproxy_darwin_amd64.tar.gz",
  "darwin-arm64": "wireproxy_darwin_arm64.tar.gz",
};

/** 依平台选发布包；不支持的平台返回 null（改用 MSLXDFF_WARP_BIN 自备二进制）。 */
export function resolveAsset(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  return ASSETS[key] || null;
}

/** 本地二进制路径（bin/ 下按平台固定名）。 */
export function binaryPath(dir) {
  return join(dir, "bin", process.platform === "win32" ? "wireproxy.exe" : "wireproxy");
}

/**
 * 确保 wireproxy 可用：优先 env 指定 → 本地已下载 → 自动下载解包。
 * @returns {Promise<string>} 可执行文件绝对路径
 */
export async function ensureBinary({ dir, bin = "", autodownload = true, fetchImpl = compatFetch, log = () => {}, platform = process.platform, arch = process.arch } = {}) {
  if (bin) {
    if (!existsSync(bin)) throw new Error(`MSLXDFF_WARP_BIN 指向的文件不存在：${bin}`);
    return bin;
  }
  const local = binaryPath(dir);
  if (existsSync(local)) return local;

  if (!autodownload) throw new Error(`未找到 wireproxy（${local}），且已关闭自动下载：请设 MSLXDFF_WARP_BIN 或开启 MSLXDFF_WARP_AUTODOWNLOAD`);
  const asset = resolveAsset(platform, arch);
  if (!asset) throw new Error(`暂不支持自动下载 wireproxy（平台 ${platform}-${arch}）：请自备二进制并设 MSLXDFF_WARP_BIN`);

  ensureDir(join(dir, "bin"));
  const url = `${RELEASE_BASE}/${WIREPROXY_VERSION}/${asset}`;
  const tarball = join(dir, "bin", asset);
  log(`[warp-pool] 下载 wireproxy ${WIREPROXY_VERSION}（${asset}）`);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`下载 wireproxy 失败：HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(tarball));

  // 解包用系统 tar（Linux/macOS 必带；不引入 npm 依赖去解析 tar 格式）。
  await runCommand("tar", ["-xzf", tarball, "-C", join(dir, "bin")], { log });
  try { rmSync(tarball, { force: true }); } catch {}

  const extracted = findWireproxy(join(dir, "bin"));
  if (!extracted) throw new Error(`解包后未找到 wireproxy 可执行文件（目录：${join(dir, "bin")}）`);
  if (extracted !== local) {
    try { chmodSync(extracted, 0o755); } catch {}
  }
  try { chmodSync(local, 0o755); } catch {}
  return existsSync(local) ? local : extracted;
}

function findWireproxy(binDir) {
  try {
    const hit = readdirSync(binDir).find((f) => f === "wireproxy" || f === "wireproxy.exe");
    return hit ? join(binDir, hit) : null;
  } catch {
    return null;
  }
}

function runCommand(cmd, args, { log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let err = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => { err += String(d); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}${err ? `：${err.slice(0, 200)}` : ""}`));
    });
  });
}

/** 写出某节点的 wireproxy 配置（含私钥 ⇒ 0600）。 */
export function writeTunnelConf(dir, node) {
  const { conf } = nodePaths(dir, node.port);
  return writeSecret(conf, renderWireproxyConf({ ...node, port: node.port }));
}

/**
 * 启动一条隧道。返回 { port, conf, stop() }。
 * 进程退出即视为隧道失效（不自动重启：由 health 层决策重拨换 IP）。
 */
export function startTunnel({ binPath: exe, dir, port, log = () => {}, onExit = () => {} } = {}) {
  const { conf } = nodePaths(dir, port);
  const child = spawn(exe, ["-c", conf], { stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const keepTail = (d) => {
    tail = (tail + String(d)).slice(-800);
  };
  child.stdout.on("data", keepTail);
  child.stderr.on("data", keepTail);

  let stopped = false;
  child.on("exit", (code, signal) => {
    if (!stopped) onExit({ port, code, signal, tail });
  });

  return {
    port,
    conf,
    get pid() {
      return child.pid;
    },
    get alive() {
      return !stopped && child.exitCode === null;
    },
    get tail() {
      return tail;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { child.kill("SIGTERM"); } catch {}
    },
  };
}

/** 探活一个已起的隧道：经该端口访问上游 models 路径（不烧 token）。 */
export async function probeTunnel({ port, baseUrl = "https://opencode.ai", path = "/zen/v1/models", fetchImpl = compatFetch, timeoutMs = 8000, headers = {} } = {}) {
  const { ProxyAgent } = getUndici();
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${port}`, connections: 2, keepAliveTimeout: 10_000 });
  try {
    const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}${path}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: agent,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    try { await agent.close(); } catch {}
  }
}
