// qoder 上游技术常量（转译 qoder2api account/region.go，禁止改值）
export const OAUTH_CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";

// Region → 端点（global=国际站 *.qoder.sh / cn=国内站 *.qoder.com.cn）
export const ENDPOINTS = {
  global: {
    deviceLoginBase: "https://qoder.com/device/selectAccounts",
    pollEndpoint: "https://openapi.qoder.sh/api/v1/deviceToken/poll",
    userinfoBase: "https://openapi.qoder.sh/api/v1/userinfo",
    chatStreamURL: "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
    modelListURL: "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1",
    jobTokenURL: "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1",
    openapiBase: "https://openapi.qoder.sh",
  },
  cn: {
    deviceLoginBase: "https://qoder.com.cn/device/selectAccounts",
    pollEndpoint: "https://openapi.qoder.com.cn/api/v1/deviceToken/poll",
    userinfoBase: "https://openapi.qoder.com.cn/api/v1/userinfo",
    chatStreamURL: "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
    modelListURL: "https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1",
    jobTokenURL: "https://gateway.qoder.com.cn/algo/api/v3/user/jobToken?Encode=1",
    openapiBase: "https://openapi.qoder.com.cn",
  },
};

export function normalizeRegion(s) {
  const v = String(s || "").trim().toLowerCase();
  return v === "cn" ? "cn" : "global";
}

export function getEndpoints(region) {
  return ENDPOINTS[normalizeRegion(region)];
}

// 签到/额度路径（同 base 换域名）：global=openapi.qoder.sh（有 campaigns，daily-check-in 404）；
// cn=openapi.qoder.com.cn（两者皆有；Go 版签到硬编码该域，故只服务国内号）。
export const EP_CAMPAIGNS = "/sash/api/v1/me/campaigns";
export const EP_CHECKIN_STATUS = "/sash/api/v1/me/daily-check-in/status";
export const EP_CHECKIN_CLAIM = "/sash/api/v1/me/daily-check-in/claim";
export const EP_PLAN = "/api/v2/user/plan";
export const EP_QUOTA = "/api/v2/quota/usage";

export function openapiBase(region) {
  return getEndpoints(region).openapiBase;
}