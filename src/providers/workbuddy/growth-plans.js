// WorkBuddy 成长任务策略表：哪些任务可自动完成 / 用什么事件 / 何时只能人工。
// 来源：workbuddy2api-panel internal/upstream/{desktop,tasks}.go 的三账号实测点亮记录；
// 本机 2026-10-20 复核任务列表与领奖入口。
// 未登记任务默认 MANUAL——宁可漏做，不盲发请求污染上游日志。

export const PLAN_LEVELS = { AUTO: "auto", MULTI: "multi", DESKTOP: "desktop", EXPERT: "expert", MANUAL: "manual", SKIP: "skip" };
export const MAX_TIMES = 10;

// DESKTOP（桌面指纹事件链）与 EXPERT（真实专家 id + 对话回执）各有独立实现，
// 不走 growthEvent 通道，所以 eventCodes 为空也算可执行。
const ACTIONABLE = new Set([PLAN_LEVELS.AUTO, PLAN_LEVELS.MULTI, PLAN_LEVELS.DESKTOP, PLAN_LEVELS.EXPERT]);

function plan(code, level, eventCodes = [], reason = "", model = "") {
  return {
    code, level, eventCodes, model, reason,
    actionable: ACTIONABLE.has(level),
  };
}

export const TASK_PLANS = {
  // —— growthEvent 通道（带 growthEvent 的真实对话）——
  chat_5: plan("chat_5", PLAN_LEVELS.MULTI, ["chat_request_send"], "对话类：带 growthEvent 的对话请求，按 target 次数重复"),
  automation_1: plan("automation_1", PLAN_LEVELS.AUTO, ["automated_task_create_suc"], "自动化任务：创建成功事件"),
  skill_1: plan("skill_1", PLAN_LEVELS.AUTO, ["skill_info"], "尝鲜技能：skill_info 事件"),
  "Model_chat_GLM5.2": plan("Model_chat_GLM5.2", PLAN_LEVELS.AUTO, ["chat_request_send"], "模型体验：必须真实调用 glm-5.2（发事件包无效）", "glm-5.2"),

  // —— 桌面指纹事件链（/v2/report，UA=WorkBuddy/5.5.6，X-Domain=copilot.tencent.com）——
  RichMeow_Chat: plan("RichMeow_Chat", PLAN_LEVELS.DESKTOP, [], "桌面端对话：agent_task_created + 成功回复回执六事件链"),
  Buddy_App: plan("Buddy_App", PLAN_LEVELS.DESKTOP, [], "发现应用：discover→show→enter_click→auth_confirm→bindaccount_skip 五连"),
  Buddy_App_QQ: plan("Buddy_App_QQ", PLAN_LEVELS.DESKTOP, [], "企鹅教师助手：与 Buddy_App 共用事件链（固定 buddyID）"),
  create_canvas: plan("create_canvas", PLAN_LEVELS.DESKTOP, [], "设计创意画布：chat 链 + wbx_design_canvas_{task_create,open}"),
  template_5: plan("template_5", PLAN_LEVELS.DESKTOP, [], "使用模板：chat 链 + agent_task_created_with_template + template_used，按 target 重复"),
  playbook_prompt: plan("playbook_prompt", PLAN_LEVELS.DESKTOP, [], "灵感案例：web_element_click + playbook_cta_click + playbook_prompt_send"),
  Library_read: plan("Library_read", PLAN_LEVELS.MANUAL, [], "资料库：web 域页面行为（2026-10-20 实测多个事件名均不计数，需客户端真读回执）"),

  // —— 专家类：拉市场真实专家 id + 一次真实对话回执 ——
  expert_5: plan("expert_5", PLAN_LEVELS.EXPERT, [], "召唤专家：expert_summon 链 + 真实对话 requestId + expert_actual_use，按 target 重复"),
  Expert_team_use_3: plan("Expert_team_use_3", PLAN_LEVELS.EXPERT, [], "召唤专家团：同专家链，expert_type=team"),
  Expert_lighthouse: plan("Expert_lighthouse", PLAN_LEVELS.MANUAL, [], "轻量云专家：需在对话框上方授权连接器后对话（连接器授权无 API 判据，2026-10-20 实测不计数）"),

  // —— 判据未通过 ——
  Expert_Philanthropy: plan("Expert_Philanthropy", PLAN_LEVELS.MANUAL, [], "公益专家：领奖校验真实捐赠回执，无法自动"),
  expert_5_paid: plan("expert_5_paid", PLAN_LEVELS.MANUAL, [], "召唤专家（付费版）：需真实付费"),
  Hp_Appearance: plan("Hp_Appearance", PLAN_LEVELS.MANUAL, [], "和平精英主题：需客户端真实切主题（2026-10-20 实测召唤吉事通专家不计数）"),
  WorkBuddy_Valorant: plan("WorkBuddy_Valorant", PLAN_LEVELS.MANUAL, [], "无畏契约拼豆：市场当前查无此专家，暂不可自动"),
  wb_wechat_oa_subscribe_task: plan("wb_wechat_oa_subscribe_task", PLAN_LEVELS.MANUAL, [], "关注公众号满 24 小时：需真实关注，无 API 判据"),
  black_cat: plan("black_cat", PLAN_LEVELS.SKIP, [], "夜猫子活动：任务列表不下发，无积分收益"),
};

const DEFAULT_PLAN = plan("", PLAN_LEVELS.MANUAL, [], "未登记的任务类型，需人工确认");

export function planFor(code) {
  return TASK_PLANS[code] || DEFAULT_PLAN;
}

export function classifyTask(task = {}) {
  const code = task.task_code || "";
  const p = planFor(code);
  let level = p.level;
  const reward = Number(task.reward_credit || 0);
  if (reward <= 0 && level !== PLAN_LEVELS.SKIP) level = PLAN_LEVELS.SKIP;
  const prog = task.progress || {};
  const target = Number(prog.target);
  const current = Number(prog.current || 0);
  const rawNeed = Number.isInteger(target) && target > current ? target - current : 1;
  return {
    ...task,
    level,
    actionable: ACTIONABLE.has(level),
    strategy: p.reason,
    model: p.model,
    need_times: Math.max(1, Math.min(rawNeed, MAX_TIMES)),
  };
}
