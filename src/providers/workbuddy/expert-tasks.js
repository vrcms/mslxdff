import { compatFetch, timeoutSignal } from "../../compat.js";
import { reportDesktopEvents } from "./desktop-report.js";
// WorkBuddy 专家类任务（expert_5 / Expert_team_use_3 / Expert_lighthouse）。
//
// 判据（workbuddy2api-panel internal/upstream/desktop.go 三账号实测）：
// 1) 专家 id 必须是专家市场里**真实存在**的（编造 id 不计数），先拉市场列表；
// 2) expert_actual_use 的 requestId 必须是**服务端返回的**幂等 id（自造 UUID 不计数），
//    所以要先发一次真实对话并从 SSE 里抓 data.id；
// 3) 事件链：web_element_click + expert_summon_click + expert_summoned + expert_actual_use。
// Expert_lighthouse 额外要求 expert_actual_use 的 mode=LOCAL。
//
// 代价：每个任务一次真实短对话（fast-model，一条 "1+1"），与夜猫子同口径。

const CHAT_BASE = "https://copilot.tencent.com";
const DESKTOP_UA = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";
const ID_RE = /^(cmb-)?[0-9a-f]{32}$/;

async function fetchExpertList({ uid, at, expertType, fetchImpl = compatFetch, timeoutMs = 20000 }) {
  const body = { page: 1, page_size: 20, sort_by: "reco_rank", sort_order: "desc" };
  if (expertType) body.expert_type = expertType;
  try {
    const res = await fetchImpl(`${CHAT_BASE}/portal/operation-platform/market/expert/list`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${at}`,
        "Content-Type": "application/json",
        "User-Agent": DESKTOP_UA,
        "X-Domain": CHAT_BASE,
        "X-Product": "SaaS",
        "X-User-Id": uid,
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });
    const j = await res.json().catch(() => null);
    if (res.status !== 200) return { ok: false, msg: `专家市场 HTTP ${res.status}` };
    const list = j?.data?.experts || j?.experts || [];
    if (!list.length) return { ok: false, msg: "专家市场返回空列表" };
    return { ok: true, experts: list };
  } catch (e) {
    return { ok: false, msg: `专家市场请求失败: ${String(e?.message || e).slice(0, 160)}` };
  }
}

// 发一条真实短对话，从 SSE 抓服务端 requestId（自造的不计数）。
async function chatForRequestId({ uid, at, expertId, fetchImpl = compatFetch, timeoutMs = 60000 }) {
  const conversationId = `mslxdff-conv-${Date.now()}`;
  const headers = {
    Authorization: `Bearer ${at}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": DESKTOP_UA,
    "X-Domain": CHAT_BASE,
    "X-Product": "SaaS",
    "X-User-Id": uid,
    "X-Conversation-ID": conversationId,
    "X-Request-ID": String(Date.now()),
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": "5.5.6",
    "x-codebuddy-request": "1",
  };
  if (expertId) headers["X-Expert-Id"] = expertId;
  let res;
  try {
    res = await fetchImpl(`${CHAT_BASE}/v2/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "fast-model",
        messages: [
          { role: "system", content: "You are a helpful assistant. 当前处于中文环境，使用简体中文回答。" },
          { role: "user", content: "1+1等于几？直接回答。" },
        ],
        agent: "cli",
        temperature: 1,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    return { ok: false, msg: `对话请求失败: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (res.status !== 200) return { ok: false, msg: `对话 HTTP ${res.status}` };
  // 只需要开头一段就能拿到 data.id；读完主动 disconnect，不消费整条流。
  let buf = "";
  const reader = res.body?.getReader?.();
  if (!reader) return { ok: false, msg: "响应无 body 流" };
  try {
    while (buf.length < 256 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value, { stream: true });
      const m = buf.match(/"id"\s*:\s*"([^"]+)"/);
      if (m && ID_RE.test(m[1])) return { ok: true, conversationId, requestId: m[1] };
    }
  } catch {
  } finally {
    try { await reader.cancel?.(); } catch {}
  }
  const m = buf.match(/"id"\s*:\s*"([^"]+)"\s*[,}]/);
  if (m && ID_RE.test(m[1])) return { ok: true, conversationId, requestId: m[1] };
  return { ok: false, msg: "SSE 中未找到服务端 requestId" };
}

function expertPayload(e, conversationId, requestId, mode) {
  const cat = Array.isArray(e.categories) && e.categories.length ? String(e.categories[0]) : "expert-all";
  const ver = e.version || "1.0.0";
  return {
    id: e.expert_id,
    name: e.display_name_zh || e.expert_id,
    expertTitle: e.profession_zh || "",
    type: cat,
    expertType: e.expert_type || "agent",
    source: "builtin",
    version: ver,
    mode,
  };
}

function expertEvents(e, conversationId, requestId, mode) {
  const base = expertPayload(e, conversationId, requestId, mode);
  const cat = base.type;
  const ver = base.version;
  return [
    {
      eventCode: "web_element_click", source: e.expert_id, type: cat, version: ver,
      elementId: "expert_summon_click", elementName: "立即召唤",
      pageURL: "/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html",
    },
    {
      eventCode: "expert_summon_click", id: e.expert_id, name: base.name,
      expertTitle: base.expertTitle, type: "expert-all", position: 0,
      expertType: base.expertType, version: ver, mode: "LOCAL",
    },
    { eventCode: "expert_summoned", id: e.expert_id, name: base.name, expertTitle: base.expertTitle, type: "expert-all" },
    {
      eventCode: "expert_actual_use",
      id: e.expert_id, name: base.name, expertTitle: base.expertTitle,
      type: cat, expertType: base.expertType, source: "builtin", version: ver,
      cost: mode === "LOCAL" ? 0 : 9000, characterCount: 14,
      conversationId, requestId, messageId: `msg-${requestId.slice(-8)}`,
      requestModelId: "fast-model", requestModelName: "fast-model",
      mode,
    },
  ];
}

const EXPERT_TYPE = {
  expert_5: "agent",
  Expert_team_use_3: "team",
  Expert_lighthouse: "agent",
  WorkBuddy_Valorant: "agent",
  Hp_Appearance: "agent",
};

// 指定专家名（任务描述点名要某个专家时用）；不匹配就退回推荐序前几个。
const EXPERT_NAME_HINT = {
  Hp_Appearance: "吉事通", // 《和平精英》主题任务，市场里对应「吉事通」
  WorkBuddy_Valorant: "无畏契约拼豆",
};

export async function runExpertTask(api = {}, { code, needTimes = 1, round = 0, sleepFn, onStep } = {}) {
  const { uid, at, fetchImpl = compatFetch } = api;
  const step = (e) => { try { onStep?.(e); } catch {} };
  const mode = code === "Expert_lighthouse" ? "LOCAL" : "craft";
  const wanted = EXPERT_TYPE[code] || "agent";

  const listed = await fetchExpertList({ uid, at, expertType: wanted, fetchImpl });
  if (!listed.ok) return { ok: false, done: 0, msg: listed.msg };
  // 每次换一个专家（上游按 id 去重，同一个打多少次只算一次）。
  // 专家团任务优先挑 team 类型；市场没给类型时退回全量。
  const pool = listed.experts.filter((e) => !e.expert_type || e.expert_type === wanted);
  let experts = pool.length ? pool : listed.experts;
  // 任务点名了某个专家：把它排到最前（找不到就照常走推荐序）。
  const hint = EXPERT_NAME_HINT[code];
  if (hint) {
    const hit = experts.filter((e) => String(e.display_name_zh || "").includes(hint));
    if (hit.length) experts = [...hit, ...experts.filter((e) => !hit.includes(e))];
    else return { ok: false, done: 0, msg: `专家市场里找不到「${hint}」（任务点名要它）` };
  }
  if (needTimes > experts.length) needTimes = experts.length;

  let done = 0;
  for (let i = 0; i < needTimes; i++) {
    const e = experts[(round + i) % experts.length];
    const chat = await chatForRequestId({ uid, at, expertId: e.expert_id, fetchImpl });
    if (!chat.ok) {
      step({ phase: "fire", task_code: code, i: i + 1, ok: false, msg: chat.msg, stage: "chat" });
      return { ok: false, done, msg: chat.msg };
    }
    const r = await reportDesktopEvents({
      uid, at, fetchImpl,
      events: expertEvents(e, chat.conversationId, chat.requestId, mode),
    });
    step({ phase: "fire", task_code: code, i: i + 1, times: needTimes, ok: r.ok, msg: r.msg, expert: e.display_name_zh });
    if (!r.ok) return { ok: false, done, msg: r.msg || `HTTP ${r.status}` };
    done += 1;
    if (i + 1 < needTimes) await sleepFn?.(1500);
  }
  return { ok: true, done };
}
