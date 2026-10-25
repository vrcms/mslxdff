// multi-ip-pool · 节点表与出口的**网络侧**：取表（多源回退 + 本地表文件）/ 出口 IP 取证 / fetch 失败归因。
//
// 为什么单独一份：出口池的成败在受限网络里完全取决于「表取不取得到」，这一层的诊断信息
// （DNS 污染 / 连接被掐 / 超时）必须与解析层分开演进。纯解析与落盘在 ./nodes.js，本文件只碰网络。
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { compatFetch, getUndici, timeoutSignal } from "../compat.js";
import { EXIT_PROBE_URL, parseExitIp } from "../warp-pool/revive.js";
import { parseVpnGateCsv, saveNodeCache } from "./nodes.js";

/**
 * fetch 失败的人话原因：undici 一律只回 `fetch failed`，真凶在 `e.cause`。
 * 这个区分是**功能性的**：受限网络下 ENOTFOUND（DNS 污染）与 ECONNRESET（连接被掐）
 * 与超时（IP 被墙）意味着完全不同的对策，糊成一句「fetch failed」等于没诊断。
 */
export function describeFetchError(e) {
  const c = e?.cause || {};
  const code = String(c.code || c.errno || "");
  const msg = String(c.message || e?.message || "");
  if (code === "ENOTFOUND") return "DNS 解析失败 ENOTFOUND（域名可能被污染或不存在）";
  if (code === "EAI_AGAIN") return "DNS 暂时解析不了 EAI_AGAIN（当前网络解析不了这个域）";
  if (code === "ECONNREFUSED") return "连接被拒 ECONNREFUSED（端口没开或服务已下线）";
  if (code === "ECONNRESET" || code === "EPIPE") return "连接被重置 ECONNRESET（中途被掐断，常见于墙/防火墙）";
  if (code === "ETIMEDOUT" || /timeout|timed out|deadline|abort/i.test(msg)) return "连接超时（IP 不可达或被静默丢包）";
  if (/cert|self-signed|SSL|TLS|handshake/i.test(msg + code)) return `TLS 握手失败 ${code || msg}`.trim();
  if (code) return `网络失败 ${code}`;
  return (msg || String(e || "未知原因")).slice(0, 70);
}

/** 把任何异常归成人话（有 cause 走 fetch 归因，否则取 message）。 */
export function errorWhy(e) {
  return e && e.cause ? describeFetchError(e) : String(e?.message || e);
}

/** 节点源 scheme 判定：`http(s)://` 走 fetch；`file://` 与裸路径都当**本地表文件**（受限网络「抓一份带过去」）。 */
export function sourceToLocalPath(url) {
  const s = String(url || "").trim();
  if (!s || /^https?:\/\//i.test(s)) return null;
  if (/^file:\/\/\//i.test(s) || /^file:\/\//i.test(s)) {
    try {
      return fileURLToPath(s);
    } catch {
      return s.replace(/^file:\/\/\/?/i, "");
    }
  }
  return s;
}

/**
 * 逐源尝试取表；任一源返回可解析的 CSV 即成功（并顺手写缓存）。
 * 全失败时**逐源原因都进异常**（受限网络下「为什么取不到」就是用户唯一的线索）。
 * @returns {Promise<{ source: string, rows: object[], text: string }>} text 是原始 CSV，供 `fetchNodesToFile` 落盘
 */
export async function fetchNodes({ sources = [], dir = "", fetchImpl, timeoutMs = 20_000, now = () => Date.now(), log = () => {} } = {}) {
  const f = fetchImpl || getUndici().fetch || compatFetch;
  const fails = [];
  for (const url of sources) {
    try {
      const local = sourceToLocalPath(url);
      let text = "";
      if (local !== null) {
        text = readFileSync(local, "utf8");
      } else {
        const res = await f(url, { signal: timeoutSignal(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      }
      const rows = parseVpnGateCsv(text);
      if (!rows.length) throw new Error("返回体不是可解析的 VPNGate CSV");
      log(`[multi-ip-pool] 节点表取自 ${url}（${rows.length} 个节点）`);
      if (dir) saveNodeCache({ dir, source: url, rows, now });
      return { source: url, rows, text };
    } catch (e) {
      const why = errorWhy(e);
      fails.push(`${url}：${why}`);
      log(`[multi-ip-pool] 节点源失败 ${url}：${why}`);
    }
  }
  throw new Error(fails.length ? `全部 ${fails.length} 个节点源都失败 → ${fails.join(" ｜ ")}` : "没配任何节点源（MSLXDFF_MULTI_IP_SOURCES 为空）");
}

/**
 * 取表并原样落一份 CSV（`-multi-ip-pool fetch` 的实现）：在能连的机器上抓，scp 进受限网络的组长机，
 * 那边 `MSLXDFF_MULTI_IP_NODES_FILE=<路径>` 即可零网络取表。0600：表里是节点凭据，不该给同机用户读。
 */
export async function fetchNodesToFile({ sources = [], out, fetchImpl, timeoutMs = 20_000, log } = {}) {
  const got = await fetchNodes({ sources, fetchImpl, timeoutMs, log });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, got.text, { mode: 0o600 });
  return { ...got, out, file: out };
}

/**
 * 出口取证：从某槽的 tun 地址出网，读回真实出口 IP（照 warp-pool/revive.js 的同源判据）。
 * 这是「换 IP 到底换没换动」的直接证据——没有它，日志只能说"起了隧道"，说不了"出口变了"。
 * @returns {Promise<{ ok: boolean, ip: string, ms: number, error?: string }>}
 */
export async function probeExitIp({ agent, fetchImpl, timeoutMs = 12_000 } = {}) {
  const t0 = Date.now();
  try {
    const f = fetchImpl || getUndici().fetch || compatFetch;
    const res = await f(EXIT_PROBE_URL, { ...(agent ? { dispatcher: agent } : {}), signal: timeoutSignal(timeoutMs) });
    const text = await res.text();
    const ip = parseExitIp(text);
    return { ok: Boolean(ip), ip, ms: Date.now() - t0, ...(ip ? {} : { error: `取证响应认不出出口 IP：${text.slice(0, 80)}` }) };
  } catch (e) {
    return { ok: false, ip: "", ms: Date.now() - t0, error: errorWhy(e) };
  }
}
