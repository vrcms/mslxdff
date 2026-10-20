import { loadGroupsJoined } from "../state.js";
import { errMsg } from "../cli/util.js";
import { describeErrorText } from "../net-diag.js";
import { withOutputFloor } from "../chat-pipeline/empty-turn.js";
import { startBroadbandStream } from "./broadband-stream.js";
import { compatFetch, timeoutSignal } from "../compat.js";

/**
 * 造一个「成员侧执行 + 回传结果」的执行器（可注入依赖，便于单测）。
 *
 * 为什么要单独抽出来并**带日志**：成员 B 用 upstream.chat 打自己的上游失败时，原实现只造了个
 * `{status:502, body:{"error":"fetch failed"}}` 回传组长，**本机一行日志都没留** —— 于是组长侧
 * 看到 `502 fetch failed`、成员侧看到空日志，全链路都没人能说出 B 为什么打不到上游。
 * 现在：执行抛错记 errors.log（带 cause 链诊断），上游返回 4xx/5xx 也记，回传失败同样记。
 *
 * @param {{ token: string, upstream: {chat: Function}, logs?: {appendError?: Function, appendEvent?: Function}, log?: Function, fetchImpl?: Function }} opts
 * @returns {(g: {name: string, leaderUrl: string}, reqId: string, body: object) => Promise<void>}
 */
export function createBroadbandExec({ token, upstream, logs, log = console.log, fetchImpl = compatFetch } = {}) {
  const appendError = (entry) => { try { logs?.appendError?.(entry); } catch { /* 日志失败不拖垮执行 */ } };
  const appendEvent = (entry) => { try { logs?.appendEvent?.(entry); } catch {} };
  return async function execAndPost(g, reqId, body) {
    let result;
    const t0 = Date.now();
    const model = String(body?.model || "");
    const fl = withOutputFloor(body); // 首发输出额度托底：leader 转来的 body 不经 pipeline，成员侧自托（评审 P1）
    // 成员「收到任务」：谁转来的、是什么规模、转给谁 —— 中继全流程在**成员这一跳**的入口日志。
    // 没有它，组长侧只知道"入队了"，无从确认成员是否真收到、收到的是什么（用户实证要求「日志要全面」）。
    const nMsgs = Array.isArray(body?.messages) ? body.messages.length : 0;
    const nTools = Array.isArray(body?.tools) ? body.tools.length : 0;
    log(`broadband task recv: group=${g.name} req=${reqId} from leader=${g.leaderUrl} model=${model} messages=${nMsgs} tools=${nTools}`);
    if (fl !== body) log(`output-floor(broadband): req=${reqId} ${(body?.max_tokens ?? body?.max_completion_tokens)}→${(fl.max_tokens ?? fl.max_completion_tokens)}`);
    try {
      const upRes = await upstream.chat(fl);
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
      appendEvent({ ts: Date.now(), type: "broadband-task", reqId, group: g.name, model, status: result.status, ms: Date.now() - t0, chars: String(result.body || "").length });
      if (result.status >= 400) {
        // 成员成功连上上游、但上游回错 —— 也要留痕，否则组长只见状态码不知原因
        const snippet = String(result.body || "").slice(0, 300);
        log(`broadband task: ${g.name} req=${reqId} 成员上游返回 HTTP ${result.status} — ${snippet}`);
        appendError({ api: "broadband", reqId, group: g.name, model, status: result.status, message: `组员执行上游返回 HTTP ${result.status}：${snippet}` });
      }
    } catch (err) {
      // 成员打自己上游**抛错**（连不上/DNS/超时/TLS）—— 这是 `502 fetch failed` 的真正来源，展开 cause 链
      const diag = describeErrorText(err);
      result = { status: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: diag }) };
      log(`broadband task: ${g.name} req=${reqId} 成员打上游失败 — ${diag}`);
      appendError({ api: "broadband", reqId, group: g.name, model, status: 502, message: `组员打上游请求抛错（成员侧失败，非组长）：${diag}` });
    }
    try {
      const r = await fetchImpl(`${g.leaderUrl}/v1/groups/relay/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: g.name, group: g.name, reqId, result }),
        signal: timeoutSignal(5000),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        log(`broadband result post: ${g.name} req=${reqId} HTTP ${r.status} ${txt.slice(0, 120)}`);
        appendError({ api: "broadband", reqId, group: g.name, status: r.status, message: `结果回传组长失败 HTTP ${r.status}：${txt.slice(0, 200)}` });
      }
    } catch (err) {
      const diag = describeErrorText(err);
      log(`broadband result post: ${g.name} req=${reqId} failed — ${diag}`);
      appendError({ api: "broadband", reqId, group: g.name, status: 0, message: `结果回传组长请求抛错：${diag}` });
    }
  };
}

/**
 * 宽带中继 — poll 模式（heartbeat + poll）与 stream 模式分发。
 * stream 长连下沉 broadband-stream.js，本文件保留任务执行与降级分支。
 * 空组不再早退：加组后由 ensure（stream 10s / poll 每次读组）自动接上，无需重启 daemon。
 * // Note: 空组不早退与向导默认 broadband 的取舍 — 见 .agents/notes/implemented/feature/2026-09-16-mobile-broadband-join-wizard.md
 */
export function startBroadband({ token, upstream, logs, log = console.log }) {
  const broadbandGroups = () => loadGroupsJoined().filter((g) => g.kind === "broadband" && g.leaderUrl);
  const streamEnabled = (() => {
    const v = process.env.MSLXDFF_BROADBAND_STREAM;
    if (v === "0" || v === "false" || v === "off") return false;
    return true;
  })();
  const execAndPost = createBroadbandExec({ token, upstream, logs, log });
  // 心跳往返延迟：成员侧自己量「上一轮 heartbeat 的 RTT」，随下一次心跳上报给组长。
  // 组长侧据此排序「谁的延迟更低」（选路=延迟最小优先，见 routes/peers.js 的 ordered）。
  // 用上一轮而不是本轮的原因：本轮 RTT 要等响应回来才知道，来不及带在这次请求里。
  const hbRtt = new Map(); // group name -> ms
  // 本机 IPv6 出口池是否可用：心跳里带 hasV6，组长据此知道「谁的 v6 额度还能用」。
  // 只有本机真的建起了带地址的 v6 池才算 true（空池/未检测到前缀 = false）。
  const v6Available = () => {
    try {
      const d = upstream?.dispatcher;
      const slots = d?.stats?.().slots;
      return Array.isArray(slots) && slots.some((s) => s.addr && !s.cooling);
    } catch { return false; }
  };
  const doHeartbeat = async () => {
    for (const g of broadbandGroups()) {
      try {
        const t0 = Date.now();
        const res = await compatFetch(`${g.leaderUrl}/v1/groups/relay/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: g.name, group: g.name, rttMs: hbRtt.get(g.name) ?? null, hasV6: v6Available() }),
          signal: timeoutSignal(5000),
        });
        const rtt = Date.now() - t0;
        hbRtt.set(g.name, rtt);
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          log(`broadband heartbeat ${g.name}: ${res.status} ${txt.slice(0, 100)}`);
        } else {
          log(`broadband heartbeat ${g.name}: ok rtt=${rtt}ms`);
        }
      } catch (err) {
        hbRtt.delete(g.name);
        log(`broadband heartbeat ${g.name}: failed — ${errMsg(err)}`);
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
      } catch (err) {
        log(`broadband poll ${g.name}: failed — ${describeErrorText(err)}`);
      }
    }
  };
  if (!streamEnabled) {
    doHeartbeat().catch(() => {});
    const hbTimer = setInterval(doHeartbeat, 30_000);
    hbTimer.unref();
    const pollTimer = setInterval(doPoll, 1000);
    pollTimer.unref();
    const n = broadbandGroups().length;
    log(n ? `broadband relay: heartbeat 30s + poll 1s for ${n} group(s) [poll mode]` : "broadband relay: idle (0 group) — waiting for a group join [poll mode]");
    return;
  }
  startBroadbandStream({ token, upstream, execAndPost, broadbandGroups, log });
}
