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

// 入站请求体读取：**必须先收齐字节再一次性 decode**。
//
// 不要写成 `let data = ""; req.on("data", c => data += c)`：`c` 是 Buffer，`+=` 会按**每个 TCP 块**
// 各自隐式 `toString("utf8")` —— 多字节字符（绝大多数汉字/emoji）被切在块中间时，两半各自解成
// `U+FFFD`「�」。切块位置随网络随机 ⇒ **同一份请求体不同轮次坏的位置不同**，而这份 body 会原样
// 转发给上游：从坏点起的字节前缀每轮都变，上游的前缀缓存从那里起永远命中不了。
// 实测（2026-10-18，raccoon 会话 talk/full 语料）：同一会话相邻两轮的同一条历史消息里
// 「个」↔「�」来回跳（成 U+FFFD），首差异落在历史 21%–43% 处；命中一次的对照实验里
// 同前缀两连发 cache_read=384/429，说明上游缓存本来是好的、是被我们这份坏字节废掉的。
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8")));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
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
