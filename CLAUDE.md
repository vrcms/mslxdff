# CLAUDE.md — OpenCode Free 剥离项目

> 🔖 **源码回查**：原始实现位于 `/root/9router`（9Router v0.5.45，git 标签 `v0.5.45`）。
> 所有「原实现」的代码、函数签名、请求链路都以该仓库为准，需要时直接去那里查。

本文档是把 9Router 的 **OpenCode Free** 功能剥离为独立项目的调研汇总 + 实现蓝图。
来源仓库：`/root/9router`（v0.5.45）。目标：做一个独立、极简、闭源/私有可用的 OpenAI 兼容代理，
只做一件事 —— 把任意 OpenAI 格式请求转发到 opencode.ai 的免费 Zen 网关，并处理好模型列表与思考模式。

---

## Agent skills

### Issue tracker

Issues and specs live as markdown under `.scratch/<feature>/` (local markdown tracker — no git remote). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles map 1:1 to label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) stored as `Status:` lines in issue files. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

Key domain terms (glossary): `CONTEXT.md` — Zen upstream, oc/ 前缀, reasoning 注入, free model, passthrough, zero-state.
Key decisions (ADRs): `docs/adr/0001` (reasoning placeholder injection), `0002` (models free filter + big-pickle whitelist), `0003` (zero-state no-DB), `0004` (single bearer token).

---

## 1. 功能本质（一句话）

OpenCode Free 是 9Router 里的一个 **零配置免费 provider**：无需任何凭据，把请求带上
`x-opencode-client: desktop` 头 + `Authorization: Bearer public` 打到
`https://opencode.ai/zen/v1/chat/completions`（OpenAI chat 兼容格式），模型 id 原样透传；
免费模型列表由 `https://opencode.ai/zen/v1/models` 动态拉取。

它**不是** opencode.ai 的付费 Go 订阅（`opencode-go`，`x-api-key` 认证），不要混淆。

## 2. 上游 API 契约（实测 2026-08-03）

### 2.1 聊天

```
POST https://opencode.ai/zen/v1/chat/completions
Content-Type: application/json
x-opencode-client: desktop        # 必需，伪装 desktop 客户端
Authorization: Bearer public      # 必需，值任意（"public" 即可）；服务端不校验密钥
Accept: text/event-stream          # stream:true 时要带
```

请求体 = 标准 OpenAI Chat Completions（`model/messages/max_tokens/stream/…`）。

实测样例响应（非流式）：
```json
{
  "id": "router-...",
  "object": "chat.completion",
  "model": "deepseek-v4-flash-free",
  "choices": [{
    "index": 0, "finish_reason": "length", "logprobs": null,
    "message": { "role": "assistant", "content": "", "reasoning_content": "1.  The user", "tool_calls": null }
  }],
  "usage": { "prompt_tokens": 6, "completion_tokens": 5, "total_tokens": 11, "prompt_tokens_details": {} },
  "cost": "0"
}
```

关键点：
- **思考模式模型返回 `reasoning_content`** 字段（DeepSeek/Kimi 系）。
- 上游 DeepSeek 思考模式**要求多轮请求里 assistant 消息回传 `reasoning_content`**，
  否则返回 `400 "The reasoning_content in the thinking mode must be passed back"`。
- 响应含 `usage` 与 `cost`，proxy 可直接透传，前端可展示 token 消耗。

### 2.2 模型列表

```
GET https://opencode.ai/zen/v1/models     # 同样带 x-opencode-client: desktop
```
响应：`{"object":"list","data":[{"id":"...","object":"model","created":...,"owned_by":"opencode"}, ...]}`

实测：**60 个模型**，免费模型判定 = `id` 以 `-free` 结尾 或 在已知白名单：
- `deepseek-v4-flash-free`
- `mimo-v2.5-free`
- `ling-3.0-flash-free`
- `nemotron-3-ultra-free`
- `north-mini-code-free`
- `laguna-s-2.1-free`
- `big-pickle`（**无 `-free` 后缀**，白名单 `KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"]`）

其余 53 个（claude-*/gemini-*/gpt-*/…）是正常付费模型，不应在免费列表暴露。

## 3. 原实现逐文件 / 逐函数拆解

> 路径均相对 9router 仓库根。以下是"要复刻什么"。剥离时把无关的 40+ provider / 翻译引擎 / RTK / 云同步全部砍掉。

### 3.1 Provider 注册（数据定义）

**`open-sse/providers/registry/opencode.js`**：
```js
export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",             // 客户端用 oc/<model>
  display: { name: "OpenCode Free", icon: "terminal", color: "#E87040", textIcon: "OC" },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: { "x-opencode-client": "desktop" },
    noAuth: true,
  },
  models: [],                                  // 无静态模型表
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,                     // 客户端模型 id 原样转发
};
```
- `buildTransport`（`open-sse/providers/index.js:12`）会把 `format` 缺省补成 `"openai"`。
- `PROVIDERS.opencode` 由此得到；`BaseExecutor` 构造时读 `config.noAuth` → `this.noAuth=true`。

### 3.2 模型路由别名

`open-sse/services/model.js`：
- `ALIAS_TO_PROVIDER_ID`（第 13-18 行）：遍历注册表，登记 `id→id`、`alias→id`、`aliases[]→id`。即 `"opencode"→"opencode"`、`"oc"→"opencode"`。
- `parseModel(modelStr)`（第 34 行）：按第一个 `/` 拆分 → `{ provider, model, isAlias, providerAlias }`；`oc/xxx` → `{provider:"opencode", model:"xxx"}`。

### 2.3 免费虚拟凭证（不复刻 DB，直接内建一个）

`src/sse/services/auth.js` `getProviderCredentials()`（第 36-60 行）：
```js
if (FREE_PROVIDERS[id]?.noAuth) {
  return {
    id: "noauth", connectionName: "Public", isActive: true,
    accessToken: "public",                       // → Authorization: Bearer public
    providerSpecificData: { connectionProxy: ..., vercelRelayUrl: "" },
  };
}
```
- 无 DB 连接、无 token、无刷新、无配额。
- 限流/冷却/账户 fallback 全部跳过（`markAccountUnavailable`/`clearAccountError` 对 `"noauth"` 直接 return）。

### 2.4 Executor

`open-sse/executors/opencode.js`（继承 `BaseExecutor`）：
```js
const MESSAGES_MODELS = new Set();   // 预留：将来某模型若走 /zen/v1/messages(Claude 格式) 加进来

class OpenCodeExecutor extends BaseExecutor {
  constructor() { super("opencode", PROVIDERS.opencode); }

  transformRequest(model, body) {
    return injectReasoningContent({ provider: "opencode", model, body });
  }
  buildUrl(model) {
    return MESSAGES_MODELS.has(model)
      ? `${this.config.baseUrl}/zen/v1/messages`
      : `${this.config.baseUrl}/zen/v1/chat/completions`;
  }
  buildHeaders() {
    return { "Content-Type":"application/json",
             "Authorization":"Bearer public",
             "x-opencode-client":"desktop",
             "Accept":"text/event-stream" };
  }
}
```
`BaseExecutor.execute`（`open-sse/executors/base.js:99`）职责：URL/header/body 组装 → `fetch(POST)` →
连接超时（`FETCH_CONNECT_TIMEOUT_MS`）→ 按状态码退避重试（429/网络错误进 502 重试）→ 返回 `{response,url,headers,transformedBody}`。

### 2.5 reasoning_content 注入（**must-have**）

`open-sse/utils/reasoningContentInjector.js` 完整逻辑：
```js
const PLACEHOLDER = " ";
// 模型级规则
const MODEL_RULES = [
  { match: m => /^kimi-/i.test(m || ""), scope: "toolCalls" }, // 带 tool_calls 的 assistant 消息
  { match: m => /deepseek/i.test(m || ""), scope: "all" },      // 所有 assistant 消息
];
function shouldInject(message, scope) {
  if (message?.role !== "assistant") return false;
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) return false;
  if (scope === "toolCalls") return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return true;
}
function applyRule(body, rule) {
  if (!rule || !body?.messages) return body;
  body.messages = body.messages.map(m =>
    shouldInject(m, rule.scope) ? { ...m, reasoning_content: PLACEHOLDER } : m);
  return body;
}
// 入口：providerRule = PROVIDERS[provider]?.reasoningInject || MODEL_RULES.find(...)
```
（deepseek-v4-flash-free 会被 `all` 规则命中，因此每个 assistant 消息都会被写 `reasoning_content`。）

### 2.6 Chat 处理主链路（Chat 编辑器入口 → 上游）

9routes 完整链路（剥离时只保留 3、4、6、7、8、9、10、11 的等效实现）：

1. `src/sse/handlers/chat.js handleChat()`：解 body → `requireApiKey` 校验（本地可不开）→ 组合/别名校验 → `handleSingleModelChat()`。
2. `handleSingleModelChat()`：`getModelInfo(modelStr)` 解析 `oc/<model>`；账户循环（对 noAuth 只有虚拟账号一轮）。
3. `handleChatCore()`（`open-sse/handlers/chatCore.js`）—— 这是"核心引擎"：
   - `detectFormat(body)`（`open-sse/services/provider.js:28`）：识别 openai / claude / gemini / openai-responses。
   - 目标格式 = `getModelTargetFormat??` 空 → `resolveTransport`null → `getTargetFormat(provider)` = `"openai"`。
   - `translateRequest(source, target="openai", upstreamModel, body,…)`：opencode 全链路 **openai→openai 恒等**（`open-sse/translator/`）。
   - 上游模型透传：`getModelUpstreamId()` 因模型表空返回原 id；`body.model = stripThinkingSuffix(upstreamModel)`。
   - token saver（rtk/headroom/caveman/pxpipe）→ **剥离项目可全部去掉**。
   - `executor.execute({model, body, stream, credentials, signal, log})`。
   - `executor.noAuth` → **跳过 401/403 刷新**；响应非 ok → `parseUpstreamError` 解析。
   - 流式 → `chatCore/chandler.js` 的 SSE 透传（`stream/true`）；非流式 → `nonStreamingHandler`。

### 2.7 UI（9dashboard）
- "Free Tier Providers" 区（`page.js:466`），noAuth provider 卡显示绿色 `Ready` 徽章（`page.js:650-703`）。
- `freeEntries` 排序把 noAuth 排最前（`page.js:294-296`）。
- 模型下拉框：`ModelSelectModal.js:218` 当 `providerInfo.passthroughModels` 时允许输入任意模型。
- 建议模型：`providerModelsFetcher.js→GET /api/providers/suggested-models?url=&type=opencode-free→route.js(fetch)→filters.js(opencode-free filter)`，前端缓存 10min。
- "Test All(free)" 不落在 noAuth provider 上（它们没有 DB 连接）。

## 4. 参考：相同模式的其它 provider（剥离时可对照）
- `providers/registry/mimo-free.js`（noAuth + passthrough + modelsFetcher type mimo）
- `providers/registry/openrouter.js`（passthrough + modelsFetcher type openrouter-free）
- `providers/registry/venice.js`、"passthroughModels + fetcher" 同款提法

## 5. 剥离项目建议架构（紧凑版）

```
mslxdfree/
├─ server.js          # Node 原生 http / express / bun，监听一个 /v1/* 端点
├─ src/
│  ├─ opencode.js     # 上游调用（buildUrl/buildHeaders/injectReasoningContent）
│  ├─ routes.js       # /v1/chat/completions (POST, stream+非流式)  + /v1/models
│  ├─ models.js       # /v1/models 拉取 + `-free`/big-pickle 过滤 + 10min 缓存
│  ├─ sse.js          # SSE → 客户端转发
│  └─ env.js          # BASE_URL、PORT、上游 URL、速率限制……
├─ README.md          # 部署/客户端配置（Endpoint=http://localhost:PORT/v1, model=oc/deepseek-v4-flash-free）
└─ package.json
```

必需满足的契约（最小闭环）：
1. 单端点 `POST /v1/chat/completions`，body 透传上游，**仅改 `model` 无需改（上游接受任意 id）**；
2. 恒带 `x-opencode-client: desktop`，`Authorization: Bearer <随意或 public>`；
3. 请求前对 messages 做 reasoning_content 注入（deepseek `all` / kimi `tool_calls`）；
4. 响应透传（非流式 JSON；流式逐块 SSE，服务端先转 `finish` 即可）；
5. `/models` 返回过滤后的 7 个免费模型（可选，供工具端配置）。

## 6. 代码文件大小约束（强制）

- 大多数 `src/**/*.js` 保持 **≤10KB**（约 300 行）；>20KB 必须拆分到多个 js 模块，通过入口聚合
- 检查：`ls -lh src/**/*.js` / `find src -name "*.js" -size +20k`
- 现状 `src/routes.js` 63KB，已超标需拆分

## 7. 已知陷阱 / 注意
- OpenCode Free 是**公共免费额度**，可能限流/不稳定 → 预留可配超时与失败重试（429 退避）。
- 不要实现账户体系/DB/云同步/工单 DB —— 那不是本功能职责。唯一凭据是自建的 Bearer token（见 `docs/adr/0004.md`，首建 + `-refresh-token` 轮换）。
- `Accept: text/event-stream` 对非流式也带上无影响（上游忽略）。
- 上游 models 结构 `{ object:"list", data:[…] }`（OpenAI 风格），不是裸数组；route 里的取值顺序 `data ?? models ?? json` 保留这个鲁棒性。
- `big-pickle` 无 `-free` 后缀，必须白名单，否则丢模型。