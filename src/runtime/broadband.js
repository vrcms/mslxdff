import { loadGroupsJoined } from "../state.js";
import { errMsg } from "../cli/util.js";
import { startBroadbandStream } from "./broadband-stream.js";
import { compatFetch, timeoutSignal } from "../compat.js";

/**
 * 宽带中继 — poll 模式（heartbeat + poll）与 stream 模式分发。
 * stream 长连下沉 broadband-stream.js，本文件保留任务执行与降级分支。
 */
export function startBroadband({ token, upstream }) {
  const broadbandGroups = () => loadGroupsJoined().filter((g) => g.kind === "broadband" && g.leaderUrl);
  if (!broadbandGroups().length) return;
  const streamEnabled = (() => {
    const v = process.env.MSLXDFF_BROADBAND_STREAM;
    if (v === "0" || v === "false" || v === "off") return false;
    return true;
  })();
  const execAndPost = async (g, reqId, body) => {
    let result;
    try {
      const upRes = await upstream.chat(body);
      const ct = upRes.headers.get("content-type") || "";
      const isStream = Boolean(body?.stream) || ct.includes("text/event-stream");
      if (isStream && upRes.body) {
        let collected = "";
        for await (const chunk of upRes.body) {
          if (typeof chunk === "string") collected += chunk;
          else if (Buffer.isBuffer(chunk)) collected += chunk.toString("utf8");
          else if (chunk instanceof Uint8Array) collected += Buffer.from(chunk).toString("utf8");
          else collected += String(chunk);
        }
        result = { status: upRes.status, headers: { "Content-Type": "text/event-stream" }, body: collected };
      } else {
        const txt = await upRes.text();
        let parsed;
        try { parsed = JSON.parse(txt); } catch { parsed = txt; }
        result = { status: upRes.status, headers: { "Content-Type": upRes.headers.get("content-type") || "application/json" }, body: typeof parsed === "string" ? parsed : JSON.stringify(parsed) };
      }
    } catch (err) {
      result = { status: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: errMsg(err) }) };
    }
    try {
      await compatFetch(`${g.leaderUrl}/v1/groups/relay/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ name: g.name, group: g.name, reqId, result }),
        signal: timeoutSignal(5000),
      });
    } catch {}
  };
  const doHeartbeat = async () => {
    for (const g of broadbandGroups()) {
      try {
        const res = await compatFetch(`${g.leaderUrl}/v1/groups/relay/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ name: g.name, group: g.name }),
          signal: timeoutSignal(5000),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          console.log(`broadband heartbeat ${g.name}: ${res.status} ${txt.slice(0, 100)}`);
        }
      } catch (err) {
        console.log(`broadband heartbeat ${g.name}: failed — ${errMsg(err)}`);
      }
    }
  };
  const doPoll = async () => {
    for (const g of broadbandGroups()) {
      try {
        const pollRes = await compatFetch(`${g.leaderUrl}/v1/groups/relay/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ name: g.name, group: g.name }),
          signal: timeoutSignal(8000),
        });
        if (!pollRes.ok) continue;
        const data = await pollRes.json().catch(() => ({}));
        const items = data.data || [];
        for (const item of items) {
          const { reqId, body } = item;
          await execAndPost(g, reqId, body);
        }
      } catch {}
    }
  };
  if (!streamEnabled) {
    doHeartbeat().catch(() => {});
    const hbTimer = setInterval(doHeartbeat, 30_000);
    hbTimer.unref();
    const pollTimer = setInterval(doPoll, 1000);
    pollTimer.unref();
    console.log(`broadband relay: heartbeat 30s + poll 1s for ${broadbandGroups().length} group(s) [poll mode]`);
    return;
  }
  startBroadbandStream({ token, upstream, execAndPost, broadbandGroups });
}
