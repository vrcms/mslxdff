import { errMsg } from "../cli/util.js";

/**
 * 宽带 SSE 长连 — 单组成员订阅 + 指数退避重连 + ensure 定时器。
 * execAndPost / broadbandGroups 由 broadband.js 注入。
 */
export function startBroadbandStream({ token, upstream, execAndPost, broadbandGroups }) {
  const streamManagers = new Map();
  const startStreamForGroup = (g) => {
    if (streamManagers.has(g.name)) return;
    let attempts = 0;
    let abort = null;
    let stopped = false;
    const connect = async () => {
      if (stopped) return;
      const url = `${g.leaderUrl}/v1/groups/relay/stream?name=${encodeURIComponent(g.name)}`;
      const controller = new AbortController();
      abort = controller;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`stream ${res.status}`);
        if (!res.body) throw new Error("no body");
        attempts = 0;
        let buf = "";
        const decodeChunk = (c) => {
          if (typeof c === "string") return c;
          if (Buffer.isBuffer(c)) return c.toString("utf8");
          if (c instanceof Uint8Array) return Buffer.from(c).toString("utf8");
          return String(c);
        };
        for await (const chunk of res.body) {
          buf += decodeChunk(chunk);
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (!raw || raw.startsWith(":")) continue;
            let event = "message";
            let data = "";
            for (const line of raw.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (event === "relay" && data) {
              try {
                const parsed = JSON.parse(data);
                const { reqId, body } = parsed;
                if (reqId && body) execAndPost(g, reqId, body).catch(() => {});
              } catch {}
            }
          }
        }
        throw new Error("stream ended");
      } catch (err) {
        if (stopped) return;
        const msg = errMsg(err);
        if (!String(msg).includes("abort") && !String(msg).includes("Abort")) console.log(`broadband stream ${g.name}: ${msg} — reconnecting`);
        attempts++;
        const delay = Math.min(30_000, 1000 * Math.pow(2, attempts - 1) + Math.random() * 500);
        await new Promise((r) => setTimeout(r, delay));
        connect();
      }
    };
    streamManagers.set(g.name, { stop: () => { stopped = true; abort?.abort(); } });
    connect();
  };
  for (const g of broadbandGroups()) startStreamForGroup(g);
  const ensureTimer = setInterval(() => {
    for (const g of broadbandGroups()) if (!streamManagers.has(g.name)) startStreamForGroup(g);
  }, 10_000);
  ensureTimer.unref();
  console.log(`broadband relay: stream (SSE) + ping 25s for ${broadbandGroups().length} group(s)`);
}
