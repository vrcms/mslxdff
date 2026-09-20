// 模型目录（按账号隔离）+ 三路发现（agent-center / builtin / 福利网关）+ 福利 claim。
// 福利是按账号授予的：目录按 userId 存，isBenefit 只信「发起请求的账号」的目录；
// 目录里没有的模型回退冷启动种子（少带 maas_type 头 = InferHub.002002009.404）。
// 算法对齐 HITZY2002/codearts2api internal/upstream/models.go。
import {
  SNAP_BASE, BENEFIT_HOST, EP_MODEL_BUILTIN, EP_AGENT_LIST, EP_AGENT_DETAIL,
  EP_BENEFIT_CONFIG, EP_BENEFIT_CLAIM,
  SEED_BENEFIT_MODELS, SEED_KNOWN_MODELS, CATALOG_TTL_MS,
} from "./const.js";
import { signRequest } from "./sign.js";
import { compatFetch } from "../../compat.js";

const lower = (s) => String(s || "").trim().toLowerCase();

export function createCatalog() {
  const known = new Map(); // lower → 精确 ID（种子 + 已发现，大小写归一单点）
  for (const id of [...SEED_KNOWN_MODELS, ...SEED_BENEFIT_MODELS]) {
    if (!known.has(lower(id))) known.set(lower(id), id);
  }
  const accounts = new Map(); // userId → {models, benefit:Set, knows:Set, lastBenefit:Map, fetched}

  function setAccount(userId, models, { keepBenefit = false, now = Date.now() } = {}) {
    if (!userId) return;
    const prev = accounts.get(userId);
    const ac = { models: [], benefit: new Set(), knows: new Set(), lastBenefit: prev ? new Map(prev.lastBenefit) : new Map(), fetched: now };
    for (const m of models || []) {
      if (!m?.id) continue;
      const key = lower(m.id);
      ac.knows.add(key);
      if (m.benefit) { ac.benefit.add(key); ac.lastBenefit.set(key, m); }
      if (!known.has(key) || m.id !== key) known.set(key, m.id);
      ac.models.push(m);
    }
    if (keepBenefit) {
      // 福利来源失败但内置成功：上轮福利条目只要内置没明确登记（转正）就保留标记
      for (const [key, mi] of ac.lastBenefit) {
        if (ac.knows.has(key)) continue;
        ac.benefit.add(key);
        ac.knows.add(key);
        ac.models.push(mi);
        if (!known.has(key) || mi.id !== key) known.set(key, mi.id);
      }
      ac.models.sort((a, b) => (lower(a.id) < lower(b.id) ? -1 : lower(a.id) > lower(b.id) ? 1 : (a.id < b.id ? -1 : 1)));
    }
    accounts.set(userId, ac);
  }

  // 判定顺序：账号目录标了福利 → true；目录里有但没标 → false（已转正）；目录没有 → 种子兜底。
  function isBenefit(userId, model) {
    const key = lower(model);
    if (!key) return false;
    const ac = accounts.get(userId);
    if (ac) {
      if (ac.benefit.has(key)) return true;
      if (ac.knows.has(key)) return false;
    }
    return SEED_BENEFIT_MODELS.some((m) => lower(m) === key);
  }

  function canonical(model) {
    const exact = known.get(lower(model));
    return exact || null;
  }
  function accountModels(userId) {
    const ac = accounts.get(userId);
    return ac ? [...ac.models] : [];
  }
  function isStale(userId, now = Date.now(), ttlMs = CATALOG_TTL_MS) {
    const ac = accounts.get(userId);
    return !ac || now - ac.fetched >= ttlMs;
  }
  return { setAccount, isBenefit, canonical, accountModels, isStale };
}

/** 多路合并：按小写 ID 去重，福利标记取或，参数更全/精确大小写优先，按小写 ID 排序。 */
export function mergeModels(sets) {
  const merged = new Map();
  for (const set of sets || []) {
    for (const m of set || []) {
      if (!m?.id) continue;
      const key = lower(m.id);
      const cur = merged.get(key);
      if (!cur) { merged.set(key, { ...m }); continue; }
      const keep = (m.contextWindow > 0 && !cur.contextWindow) || (m.id !== lower(m.id) && cur.id === lower(cur.id)) ? m : cur;
      const drop = keep === m ? cur : m;
      merged.set(key, {
        ...keep,
        benefit: !!(keep.benefit || drop.benefit),
        name: keep.name || drop.name || "",
        contextWindow: keep.contextWindow || drop.contextWindow || 0,
        maxTokens: keep.maxTokens || drop.maxTokens || 0,
        desc: keep.desc || drop.desc || "",
      });
    }
  }
  return [...merged.values()].sort((a, b) => (lower(a.id) < lower(b.id) ? -1 : lower(a.id) > lower(b.id) ? 1 : (a.id < b.id ? -1 : 1)));
}

/** 签名 GET 并解析 JSON（Agent-Type 可选；空 body 签名 = sha256("")）。 */
export async function signedGetJson({ url, cred, agentType, fetchImpl }) {
  const doFetch = fetchImpl || compatFetch;
  const headers = { "content-type": "application/json", "x-language": "zh-cn" };
  if (agentType) headers["agent-type"] = agentType;
  if (cred?.securityToken) headers["x-security-token"] = cred.securityToken;
  const { headers: signed } = signRequest({ method: "GET", url, headers, body: "", cred });
  const res = await doFetch(url, { method: "GET", headers: signed });
  const raw = await res.text().catch(() => "");
  if (res.status >= 400) throw new Error(`http ${res.status}: ${String(raw).slice(0, 200)}`);
  try { return JSON.parse(raw); } catch { throw new Error(`non-JSON body: ${String(raw).slice(0, 120)}`); }
}

/** 幂等领取限时福利（官方客户端打开模型菜单即调用；error_code "0000" 视为成功）。 */
export async function claimBenefit({ cred, benefitHost = BENEFIT_HOST, fetchImpl }) {
  const doFetch = fetchImpl || compatFetch;
  const url = benefitHost + EP_BENEFIT_CLAIM;
  const body = "{}";
  const headers = { "content-type": "application/json", "x-language": "zh-cn" };
  if (cred?.securityToken) headers["x-security-token"] = cred.securityToken;
  const { headers: signed } = signRequest({ method: "POST", url, headers, body, cred });
  const res = await doFetch(url, { method: "POST", headers: signed, body });
  const raw = await res.text().catch(() => "");
  if (res.status >= 400) throw new Error(`claim http ${res.status}: ${String(raw).slice(0, 200)}`);
  const json = JSON.parse(raw);
  if (String(json?.error_code || "") !== "0000") throw new Error(`claim failed: error_code=${json?.error_code} msg=${json?.error_msg}`);
  return json;
}

const toModelInfo = (m, { benefit = false } = {}) => {
  const id = m?.model_id || m?.model_name || m?.modelAlias || "";
  if (!id) return null;
  return {
    id: String(id),
    name: String(m?.model_name || id),
    contextWindow: Number(m?.context_window) || 0,
    maxTokens: Number(m?.max_tokens) || 0,
    benefit,
    desc: String(m?.model_desc || ""),
  };
};

/** 三路发现（任一路失败不阻断）→ {models, builtinOk, benefitOk, agentOk}。 */
export async function discoverAccountModels({ account, snapBase = SNAP_BASE, benefitHost = BENEFIT_HOST, autoClaim = true, fetchImpl } = {}) {
  const cred = { accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey, securityToken: account.securityToken };
  const sets = [];
  let agentOk = false, builtinOk = false, benefitOk = false;

  // 1) agent-center：useragents 找 CodeAgent → detail.gpts.models
  try {
    const list = await signedGetJson({ url: `${snapBase}${EP_AGENT_LIST}?offset=0&limit=100&is_primary_agent=true`, cred, agentType: "AgentCenter", fetchImpl });
    const agents = Array.isArray(list?.agents) ? list.agents : [];
    const pick = agents.find((a) => a?.agent_name === "CodeAgent" && a?.alias?.alias_zh_cn === "智能体" && a?.show_in_ide)
      || agents.find((a) => a?.is_primary_agent) || agents[0];
    if (pick?.agent_id) {
      const detail = await signedGetJson({ url: `${snapBase}${EP_AGENT_DETAIL}?agent_id=${encodeURIComponent(pick.agent_id)}`, cred, agentType: "AgentCenter", fetchImpl });
      const models = (Array.isArray(detail?.gpts?.models) ? detail.gpts.models : [])
        .map((m) => toModelInfo({ model_id: m?.model_id, model_name: m?.model_name || m?.model_alias, context_window: m?.model_parameters?.context_window, max_tokens: m?.model_parameters?.max_tokens, model_desc: m?.model_parameters?.model_desc }))
        .filter(Boolean);
      if (models.length) { sets.push(models); agentOk = true; }
    }
  } catch { /* agent 路失败不阻断 */ }

  // 2) 内置模型（Agent-Type: PromptCenter）
  try {
    const json = await signedGetJson({ url: `${snapBase}${EP_MODEL_BUILTIN}`, cred, agentType: "PromptCenter", fetchImpl });
    const models = (Array.isArray(json?.builtinModels) ? json.builtinModels : []).map((m) => toModelInfo(m)).filter(Boolean);
    if (models.length) { sets.push(models); builtinOk = true; }
  } catch { /* builtin 失败不阻断 */ }

  // 3) 福利网关（先幂等 claim 再拉目录；error_code!=0000 视为该来源失败）
  try {
    if (autoClaim) { try { await claimBenefit({ cred, benefitHost, fetchImpl }); } catch { /* 未开通福利套餐时 claim 可能报错，继续拉目录 */ } }
    const json = await signedGetJson({ url: benefitHost + EP_BENEFIT_CONFIG, cred, fetchImpl });
    if (String(json?.error_code || "") === "0000") {
      const models = (Array.isArray(json?.result?.models) ? json.result.models : []).map((m) => toModelInfo(m, { benefit: true })).filter(Boolean);
      if (models.length) { sets.push(models); benefitOk = true; }
    }
  } catch { /* benefit 失败不阻断 */ }

  const models = mergeModels(sets);
  if (!models.length) throw new Error("codearts models api returned empty list");
  return { models, agentOk, builtinOk, benefitOk };
}
