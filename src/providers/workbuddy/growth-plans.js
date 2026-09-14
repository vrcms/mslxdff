// WorkBuddy 成长任务策略表：哪些任务可自动完成 / 用什么事件 / 何时只能人工。
// 来源：workbuddy2api admin/growth_plans.py 的逐条实测结论（1131 事件枚举 + 客户端机制证据）。
// 未登记任务默认 MANUAL——宁可漏做，不盲发请求污染上游日志。

export const PLAN_LEVELS = { AUTO: "auto", MULTI: "multi", MANUAL: "manual", SKIP: "skip" };
export const MAX_TIMES = 10;

function plan(code, level, eventCodes = [], reason = "", model = "") {
  return {
    code, level, eventCodes, model, reason,
    actionable: (level === PLAN_LEVELS.AUTO || level === PLAN_LEVELS.MULTI) && eventCodes.length > 0,
  };
}

export const TASK_PLANS = {
  // —— 上游实测可自动 ——
  chat_5: plan("chat_5", PLAN_LEVELS.MULTI, ["chat_request_send"], "对话类：带 growthEvent 的对话请求，按 target 次数重复"),
  automation_1: plan("automation_1", PLAN_LEVELS.AUTO, ["automated_task_create_suc"], "自动化任务：创建成功事件"),
  skill_1: plan("skill_1", PLAN_LEVELS.AUTO, ["skill_info"], "尝鲜技能：skill_info 事件"),
  "Model_chat_GLM5.2": plan("Model_chat_GLM5.2", PLAN_LEVELS.AUTO, ["chat_request_send"], "模型体验：必须真实调用 glm-5.2（发事件包无效）", "glm-5.2"),
  // —— 机制上必须客户端（上游枚举 1131 事件未命中）——
  RichMeow_Chat: plan("RichMeow_Chat", PLAN_LEVELS.MANUAL, [], "桌面端对话：上游按客户端类型判定，需真实桌面端"),
  expert_5: plan("expert_5", PLAN_LEVELS.MANUAL, [], "召唤专家：客户端本地专家包下载+激活，非服务端事件"),
  expert_5_paid: plan("expert_5_paid", PLAN_LEVELS.MANUAL, [], "召唤专家（付费版）：同上"),
  Expert_team_use_3: plan("Expert_team_use_3", PLAN_LEVELS.MANUAL, [], "召唤专家团：同上"),
  Hp_Appearance: plan("Hp_Appearance", PLAN_LEVELS.MANUAL, [], "和平精英主题：桌面端本地设置状态"),
  create_canvas: plan("create_canvas", PLAN_LEVELS.MANUAL, [], "设计创意模式：需真实创建画布"),
  template_5: plan("template_5", PLAN_LEVELS.MANUAL, ["agent_task_created_with_template"], "使用模板：尝试模板事件未验证，暂按人工"),
  playbook_prompt: plan("playbook_prompt", PLAN_LEVELS.MANUAL, [], "灵感案例：未找到有效事件"),
  Library_read: plan("Library_read", PLAN_LEVELS.MANUAL, [], "资料库：未找到有效事件"),
  Expert_Philanthropy: plan("Expert_Philanthropy", PLAN_LEVELS.MANUAL, [], "公益专家：未找到有效事件"),
  Buddy_App: plan("Buddy_App", PLAN_LEVELS.MANUAL, [], "发现应用：未找到有效事件"),
  Buddy_App_QQ: plan("Buddy_App_QQ", PLAN_LEVELS.MANUAL, [], "企鹅教师助手：未找到有效事件"),
  Expert_lighthouse: plan("Expert_lighthouse", PLAN_LEVELS.MANUAL, [], "腾讯轻量云专家：未找到有效事件"),
  // —— 无收益 ——
  black_cat: plan("black_cat", PLAN_LEVELS.SKIP, [], "夜猫子折扣活动，奖励为 0"),
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
    actionable: (level === PLAN_LEVELS.AUTO || level === PLAN_LEVELS.MULTI) && p.eventCodes.length > 0,
    strategy: p.reason,
    model: p.model,
    need_times: Math.max(1, Math.min(rawNeed, MAX_TIMES)),
  };
}
