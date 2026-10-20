import { createHash } from "node:crypto";
import { compatFetch, timeoutSignal } from "../../compat.js";
// WorkBuddy 桌面客户端行为指纹上报（/v2/report）。
//
// 为什么需要：桌面端类任务（RichMeow_Chat / Buddy_App / create_canvas / template_5 /
// playbook_prompt / Library_read）上游按**客户端指纹**判据，CLI 域的 growthEvent
// 发了也不计数。判据是同一 POST /v2/report 通道上不同的事件链 + 桌面 UA。
// 来源：workbuddy2api-panel internal/upstream/desktop.go 三账号实测点亮记录。
//
// 幂等：行为事件按天去重，重复推进不会重复扣资源；已达标任务由调用方跳过。

const DESKTOP_BASE = "https://copilot.tencent.com";
const DESKTOP_UA = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";
const WEB_BASE = "https://www.workbuddy.cn";
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// 稳定派生设备标识：同一账号每次同值，模拟固定设备。
function deriveId(uid, salt) {
  return createHash("sha256").update(`${salt}:${uid}`).digest("hex").slice(0, 36);
}

function desktopFingerprint(uid, nickname = "") {
  const now = Date.now();
  return {
    timezone: "Asia/Shanghai",
    reportDelay: 2000,
    userId: uid,
    username: nickname,
    userNickname: nickname,
    product: "SaaS",
    releaseDate: 1789036585355,
    commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    ideVersion: "5.5.6",
    machineId: deriveId(uid, "machine"),
    sessionId: deriveId(uid, "session"),
    extName: "workbuddy-desktop",
    extVersion: "5.5.6",
    os: "win32",
    arch: "x64",
    osVersion: "10.0.26220",
    cpuCores: 20,
    memorySize: 24,
    timestamp: now,
    presentAt: now,
  };
}

// 以桌面指纹上报一批事件（业务字段覆盖公共指纹）。
export async function reportDesktopEvents({ uid, at, nickname, events = [], fetchImpl = compatFetch, timeoutMs = 20000 } = {}) {
  if (!events.length) return { ok: false, msg: "无事件" };
  const fp = desktopFingerprint(uid, nickname);
  const body = JSON.stringify(events.map((ev) => ({ ...fp, ...ev })));
  try {
    const res = await fetchImpl(`${DESKTOP_BASE}/v2/report`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${at}`,
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": DESKTOP_UA,
        "X-Domain": DESKTOP_BASE,
        "X-Product": "SaaS",
        "X-Request-ID": `${deriveId(uid, "req")}${Date.now() % 1e6}`,
        "X-User-Id": uid,
      },
      body,
      signal: timeoutSignal(timeoutMs),
    });
    let j = null;
    try { j = await res.json(); } catch {}
    return { ok: res.status === 200 && (j?.code === undefined || j?.code === 0), status: res.status, code: j?.code, msg: j?.msg || "" };
  } catch (e) {
    return { ok: false, status: 0, msg: `网络失败: ${String(e?.message || e).slice(0, 160)}` };
  }
}

// web 域单事件上报（Library_read 这类页面行为任务）。
export async function reportWebEvent({ uid, at, enterpriseId, eventCode, pageURL, elementId = "", elementName = "", fetchImpl = compatFetch, timeoutMs = 20000 } = {}) {
  const ev = {
    eventCode,
    timestamp: Date.now(),
    reportDelay: 0,
    pageURL,
    elementId,
    elementName,
    os: "Win32",
    arch: "",
    osVersion: "10.0",
    userAgent: WEB_UA,
    machineId: deriveId(uid, "webmachine"),
    userId: uid,
    enterpriseId: enterpriseId || "",
  };
  try {
    const res = await fetchImpl(`${WEB_BASE}/v2/report`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${at}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-client-platform": "web",
        Origin: WEB_BASE,
        Referer: pageURL,
        "User-Agent": WEB_UA,
        "X-User-Id": uid,
      },
      body: JSON.stringify([ev]),
      signal: timeoutSignal(timeoutMs),
    });
    let j = null;
    try { j = await res.json(); } catch {}
    return { ok: res.status === 200 && (j?.code === undefined || j?.code === 0), status: res.status, msg: j?.msg || "" };
  } catch (e) {
    return { ok: false, status: 0, msg: `网络失败: ${String(e?.message || e).slice(0, 160)}` };
  }
}

// 一次「桌面端成功对话」六事件链（点亮 RichMeow_Chat；也是模板/画布/灵感链的前缀）。
export function chatSequence({ conversationId, requestId, messageId }) {
  const mk = (code, extra) => ({ eventCode: code, ...extra });
  return [
    mk("agent_task_created", {
      source: "LOCAL", name: "working", task_target: "local", mode: "craft",
      requestModelId: "fast-model", requestModelName: "fast-model",
      has_repo: false, repo_type: "none", workspace_type: "empty",
      has_connector: false, connector_types: [], has_mention: false, mention_types: [],
      has_template: false, action: "", template_name: "",
      has_expert: false, expert_id: "", expert_name: "", expert_industry_id: "",
      has_skill: false, skill_names: [],
      conversationId, messageId, buddyId: "", buddyName: "",
    }),
    mk("chat_message_send", {
      messageId: `${messageId}-assistant`, historyCount: 0, isContextTruncated: false,
      currentStepCount: 1, traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId, agentName: "cli", agentType: "main",
    }),
    mk("chat_request_send", {
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
      codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [], codebaseId: "",
      mentionContextCount: 0, command: "", recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
      traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationId, "codebuddy.conversation_request_id": requestId,
    }),
    mk("chat_message_response", {
      messageId: `${messageId}-assistant`, responseModelId: "fast-model",
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      firstTokenAt: Date.now(), traceId: requestId, conversationId,
      rootRequestId: requestId, parentConversationId: conversationId, agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationId, "codebuddy.conversation_request_id": requestId,
    }),
    mk("chat_message_status", {
      messageId: `${messageId}-assistant`, messageErrorCode: "0", traceId: requestId,
      rootRequestId: requestId, parentConversationId: conversationId, agentName: "cli", agentType: "main",
    }),
    mk("chat_request_response", {
      mode: "craft", toolCallCount: 0, inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      rootRequestId: requestId, parentConversationId: conversationId,
    }),
  ];
}

// 企鹅教师助手（Buddy_App_QQ 判据应用；同时满足 Buddy_App「进入任一应用」）。
const BUDDY_APP = { id: "cb_y5Dy46tPQGGWtueMxXbe", name: "企鹅教师助手" };

function buddyAppSequence() {
  const mk = (code, extra = {}) => ({ eventCode: code, mode: "LOCAL", buddyId: BUDDY_APP.id, buddyName: BUDDY_APP.name, ...extra });
  return [
    mk("buddyapp_discover_click"),
    mk("buddyapp_show", { elementId: BUDDY_APP.id, elementName: BUDDY_APP.name, position: 2 }),
    mk("buddyapp_enter_click", { elementId: BUDDY_APP.id, elementName: BUDDY_APP.name, position: 2, isFirstPage: "1" }),
    mk("buddyapp_auth_confirm_click", { elementId: BUDDY_APP.id, elementName: BUDDY_APP.name }),
    mk("buddyapp_bindaccount_skip_click", { elementId: BUDDY_APP.id, elementName: BUDDY_APP.name }),
  ];
}

const TEMPLATES = [
  "代码审查", "单元测试生成", "重构建议", "技术文档撰写", "接口设计",
  "SQL 优化", "缺陷分诊", "性能分析", "安全审计", "日志排查",
];

// 模板 id 只用于去重计数：上游不校验 id 是否真实存在（实测任意不同 id 都计数），
// 但**必须每次都不同**——固定 id 打到第 5 次就再也不涨。
function freshTemplateId(used) {
  for (let i = 0; i < 50; i++) {
    const id = `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!used.includes(id)) return id;
  }
  return `tpl-${Date.now()}`;
}

// 每个任务构造一批事件。round 用于需要重复的任务（模板 ×5）区分不同对象。
function buildEvents(code, round, ids, used = []) {
  const { conversationId, requestId, messageId } = ids;
  const chat = () => chatSequence({ conversationId, requestId, messageId });
  switch (code) {
    case "RichMeow_Chat":
      return { events: chat(), via: "desktop" };
    case "Buddy_App":
    case "Buddy_App_QQ":
      return { events: buddyAppSequence(), via: "desktop" };
    case "create_canvas":
      return {
        events: [
          ...chat(),
          { eventCode: "wbx_design_canvas_task_create", conversationId, requestId, source: "summon_keyword", cost: 12000, isSuccessful: true },
          { eventCode: "wbx_design_canvas_open", conversationId, requestId, id: `ardot-file-${requestId.slice(-8)}`, source: "summon_keyword", type: "page", cost: 13000, isSuccessful: true },
        ],
        via: "desktop",
      };
    case "template_5": {
      const id = freshTemplateId(used);
      const name = TEMPLATES[used.length % TEMPLATES.length];
      return {
        events: [
          ...chat(),
          { eventCode: "agent_task_created_with_template", mode: "working", isCustomModel: false, id, name, requestId },
          { eventCode: "template_used", template_id: id, task_mode: "working" },
        ],
        via: "desktop",
        obj: id,
      };
    }
    case "playbook_prompt": {
      // 同理：案例 id 只需每次不同，用真实案例名做展示字段。
      const id = `pb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const name = TEMPLATES[used.length % TEMPLATES.length];
      const payload = { id, name, type: "document", categoryId: "", categoryName: "" };
      return {
        events: [
          ...chat(),
          { eventCode: "web_element_click", pageName: "playbook_detail", elementId: "playbook_ctaClick", elementName: name, source: "discover" },
          { eventCode: "playbook_cta_click", source: "discover", position: 0, ...payload },
          { eventCode: "playbook_prompt_send", conversationId, requestId, ...payload },
        ],
        via: "desktop",
        obj: id,
      };
    }
    case "Library_read":
      return {
        via: "web",
        event: {
          eventCode: "library_doc_intro_click",
          pageURL: "https://www.workbuddy.cn/library",
          elementId: "library_doc",
          elementName: "资料库",
        },
      };
    default:
      return null;
  }
}

// 桌面/网页类任务执行器：按 needTimes 重复上报，任一失败即中断并回传原因。
export async function runDesktopTask(api = {}, { code, needTimes = 1, round = 0, sleepFn, onStep } = {}) {
  const { uid, at, enterpriseId, fetchImpl = compatFetch } = api;
  const step = (e) => { try { onStep?.(e); } catch {} };
  let done = 0;
  const used = [];
  for (let i = 0; i < needTimes; i++) {
    const stamp = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const built = buildEvents(code, round + i, {
      conversationId: `mslxdff-conv-${stamp}`,
      requestId: `mslxdff-req-${stamp}`,
      messageId: `mslxdff-msg-${stamp}`,
    }, used);
    if (!built) return { ok: false, done, msg: `任务 ${code} 没有对应的事件构造器` };
    const r = built.via === "web"
      ? await reportWebEvent({ uid, at, enterpriseId, fetchImpl, ...built.event })
      : await reportDesktopEvents({ uid, at, fetchImpl, events: built.events });
    step({ phase: "fire", task_code: code, i: i + 1, times: needTimes, ok: r.ok, msg: r.msg });
    if (!r.ok) return { ok: false, done, msg: r.msg || `HTTP ${r.status}` };
    done += 1;
    if (built.obj) used.push(built.obj);
    if (i + 1 < needTimes) await sleepFn?.(1200);
  }
  return { ok: true, done };
}
