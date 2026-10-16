// warp-pool · 节点元数据持久化。
// 含 WireGuard 私钥文件与设备 token ⇒ 一律 0600，且只落在日志根（MSLXDFF_WARP_DIR），不进工作树。
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_MODE = 0o600;

/** 节点两件套：WireGuard 配置（含私钥）与元数据（含设备 token）。 */
export function nodePaths(dir, port) {
  return {
    conf: join(dir, `node-${port}.conf`),
    meta: join(dir, `node-${port}.json`),
  };
}

/** 写敏感文件：新建用 0600，存量补 chmod（mode 只在新建时生效）。 */
export function writeSecret(file, content) {
  const existed = existsSync(file);
  writeFileSync(file, content, existed ? undefined : { mode: SECRET_MODE });
  try { chmodSync(file, SECRET_MODE); } catch {}
  return file;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 读单个节点元数据；文件缺失/损坏返回 null，绝不抛。 */
export function loadNode(dir, port) {
  const { meta } = nodePaths(dir, port);
  try {
    const j = JSON.parse(readFileSync(meta, "utf8"));
    if (!j || typeof j !== "object") return null;
    return {
      port,
      id: String(j.id || ""),
      token: String(j.token || ""),
      v4: String(j.v4 || ""),
      v6: String(j.v6 || ""),
      endpoint: String(j.endpoint || ""),
      peerKey: String(j.peerKey || ""),
      privateKey: String(j.privateKey || ""), // 必须读回：bringUp 靠它渲染 conf，漏了就是 PrivateKey = undefined（2026-10-16 真机事故：复用节点的隧道全起不来）
      registeredAt: String(j.registeredAt || ""),
      ...(j.cooldownUntil ? { cooldownUntil: Number(j.cooldownUntil) } : {}),
    };
  } catch {
    return null;
  }
}

export function saveNode(dir, node) {
  const { meta } = nodePaths(dir, node.port);
  return writeSecret(meta, `${JSON.stringify(node, null, 2)}\n`);
}

export function removeNode(dir, port) {
  const { conf, meta } = nodePaths(dir, port);
  for (const f of [conf, meta]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

/** 读回配置目录里已注册的节点（按端口升序）。 */
export function loadNodes(dir, ports) {
  const out = [];
  for (const p of ports) {
    const n = loadNode(dir, p);
    if (n && n.id && n.token && n.privateKey) out.push(n);
  }
  return out;
}

/** WireGuard + wireproxy INI（[http] 段把隧道暴露成本地 HTTP 代理出口；undici v5 的 ProxyAgent 只吃 http/https）。 */
export function renderWireproxyConf({ privateKey, v4, v6, endpoint, peerKey, port }) {
  const addresses = [
    v4 ? `Address = ${v4}/32` : "",
    v6 ? `Address = ${v6}/128` : "",
  ].filter(Boolean).join("\n");
  return `[Interface]
PrivateKey = ${privateKey}
${addresses}
DNS = 1.1.1.1
MTU = 1280

[Peer]
PublicKey = ${peerKey}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = ${endpoint}
PersistentKeepalive = 25

[http]
BindAddress = 127.0.0.1:${port}
`;
}
