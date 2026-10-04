import { timingSafeEqual, createHash } from "node:crypto";

export const errMsg = (err) => String(err?.message || err);

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  const head = typeof fwd === "string" ? fwd.split(",")[0].trim() : "";
  const raw = String(head || req.socket.remoteAddress || "");
  return raw.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1") || null;
}

export function authorized(req, token) {
  const header = req.headers["authorization"] || "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const digests = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digests(match[1]), digests(token));
}

export function json(res, status, body) {
  // 幂等守卫：已收场的响应必须 no-op（空轮 hold 后多处共用收场出口，二次 end 会抛）
  if (!res || res.writableEnded) return;
  if (!res.headersSent) {
    res.statusCode = status;
    try { res.setHeader("Content-Type", "application/json"); } catch { /* ignore */ }
    try { res.end(JSON.stringify(body)); } catch { /* ignore */ }
    return;
  }
  // headers 已 flush（failover 前候选写过 SSE 注释帧、或空轮 hold 期间发过 keepalive）：
  // 设 statusCode 会抛 ERR_HTTP_HEADERS_SENT，写 JSON 体更会把 application/json 混进 text/event-stream
  // （客户端只会当噪声丢掉，等于悄悄吞掉错误）。SSE 一律改用 in-band 错误帧 + [DONE] 收场。
  const ct = typeof res.getHeader === "function" ? String(res.getHeader("content-type") || "") : "";
  if (ct.includes("text/event-stream")) {
    try {
      const msg = body && typeof body === "object" ? String(body.error ?? body.message ?? JSON.stringify(body)) : String(body ?? "error");
      res.write(`data: ${JSON.stringify({ error: { message: msg, type: "mslxdff_error" } })}\n\n`);
      res.write("data: [DONE]\n\n");
    } catch { /* 下游已断 */ }
  }
  try { res.end(); } catch { /* ignore */ }
}

export function notFound(res) {
  return json(res, 404, { error: "Not Found" });
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function parseHops(header) {
  const n = Number(header);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export const PROMPT_MAX_LEN = 160;

export function summarizePrompt(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || !msgs.length) return "";
  const msg = msgs[msgs.length - 1];
  const c = msg?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c
      .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : ""))
      .join(" ");
  }
  text = String(text || "").replace(/\s+/g, " ").trim();
  return text.length > PROMPT_MAX_LEN ? text.slice(0, PROMPT_MAX_LEN) + "…" : text;
}
