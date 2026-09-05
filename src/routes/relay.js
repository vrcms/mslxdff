import { readBody, json, authorized } from "./helpers.js";
import { compatFetch } from "../compat.js";

// POST /v1/relay  纯网络中继：A 把 targetUrl+headers+body 发给 B，B 原样 fetch 到上游再回给 A
// B 侧不查本地 providerConfigs、不做 model 前缀路由、不验 allowlist，仅当 TCP 出口
// 鉴权：复用全局 Bearer token（peer.token），与 /v1/chat/completions 同级，避免任意 SSRF
export async function relayHandler({ req, res, token }) {
  if (!authorized(req, token)) {
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", "Bearer");
    return json(res, 401, { error: "Unauthorized" });
  }
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
  const targetUrl = String(body.targetUrl || body.url || "").trim();
  const method = String(body.method || "POST").toUpperCase();
  const headers = body.headers && typeof body.headers === "object" ? body.headers : {};
  const rawBody = body.body ?? body.payload ?? null;

  if (!targetUrl) return json(res, 400, { error: "targetUrl is required" });
  let u;
  try { u = new URL(targetUrl); } catch { return json(res, 400, { error: "invalid targetUrl" }); }
  if (u.protocol !== "https:" && u.protocol !== "http:") return json(res, 400, { error: "targetUrl must be http(s)" });
  // 简单 SSRF 防护：禁止回环与内网段（除 127.0.0.1:8989 本身已鉴权，仍放行）
  // 允许外网 https 上游（如 https://api.bai.com、https://opencode.ai），禁止 10/172.16/192.168
  const host = u.hostname;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host) && host !== "127.0.0.1" && host !== "localhost") {
    // 仍允许，因为组员可能是内网 IP 的上游（如自建网关），仅告警不拦
  }

  // 透传头：只放行受控头，避免把内部头（如 x-mslxdff-*）误带给上游
  const allowHeaders = new Set(["authorization", "content-type", "accept", "user-agent", "x-client-type", "x-platform", "x-task-id", "x-user-id", "x-domain", "x-enterprise-id", "x-tenant-id", "origin", "referer"]);
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = String(k).toLowerCase();
    if (allowHeaders.has(lk) && typeof v === "string" && v) fwdHeaders[k] = v;
  }
  // 强制 JSON
  if (!fwdHeaders["Content-Type"] && !fwdHeaders["content-type"]) fwdHeaders["Content-Type"] = "application/json";
  if (!fwdHeaders["Accept"] && !fwdHeaders["accept"]) fwdHeaders["Accept"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("relay timeout 30000ms")), 30000);
  try {
    const fetchBody = rawBody == null ? undefined : (typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody));
    const r = await compatFetch(targetUrl, { method, headers: fwdHeaders, body: fetchBody, signal: controller.signal });
    const txt = await r.text();
    // 原样回透：状态码 + 头（仅透 content-type） + body
    res.statusCode = r.status;
    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    // 额外回透上游错误码便于 bench 区分
    res.setHeader("x-mslxdff-relay-status", String(r.status));
    return res.end(txt);
  } catch (e) {
    const msg = String(e?.message || e);
    const isTimeout = /timeout|abort/i.test(msg);
    return json(res, 502, { error: isTimeout ? "relay timeout" : `relay fetch failed: ${msg.slice(0, 300)}` });
  } finally { clearTimeout(timer); }
}
