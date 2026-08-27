# mslxdff 架构与功能说明

> 本文档是 mslxdff 的**长效架构视图**，描述"当前系统长什么样、为什么长这样、改哪里必须同步这里"。
>
> **变更契约（强制）**：每新增或改动一个功能，都必须同步更新本文档的对应章节（`## 5 功能地图`、`## 6 契约与配置`、`## 7 目录导览` 中受影响的部分）。
> 结构性决策（引入新模块、改变请求链路、改存储 schema）**还额外要求**在 `docs/adr/` 追加以 ADR-NNN 编号的决策记录，并在 `## 8 决策索引` 登记。
> 详见 `## 1 变更契约`。检查工具：`npm run docs:check`。

## 1. 变更契约（本文件是唯一权威的"变更-记账"门）

新增或改动任何功能时，必须满足下面的矩阵——**不满足则视为未完成**：

| 变更类型 | 必须更新 | 附加要求 |
|---|---|---|
| 新增/修改 CLI 命令或 `-参数` | `## 6 契约与配置` 的 CLI 表 | — |
| 新增/修改环境变量 | 同上 的 Env 表 | 命名遵循 `MSLXDFF_*`/`UPSTREAM_*` 前缀 |
| 新增/修改 HTTP 路由 | `## 4 请求链路` 路由图 + `## 6` 契约 | 鉴权规则按 ADR-0004 |
| 新增/修改 State 持久化字段 | `## 6` `## 7` | 兼容旧值或写明迁移，记 ADR |
| 新增/修改供应商 Provider | `## 3 多供应商` + `## 5` 功能地图 | 默认 opencode，其余加 `<id>/` 前缀（见 ADR-0007） |
| 新增/修改插件 Hook 点 | `docs/plugins.md` + `## 5` | 保持"插件失败只记日志"原则 |
| 新增/修改上游行为（限流、重试、时延） | `## 5` 质量机制 | 常量须在文件顶部定义（见 AGENTS.md 教训） |
| 引入新模块 / 改变模块边界 | `## 7 目录导览`（含文件树） | 单文件保持 ≤10KB，>20KB 拆分（见 AGENTS.md） |
| 影响请求成败语义（超时/降级/冷却） | `## 5` 质量机制 + `## 4` | 记 ADR 说明取舍 |
| 纯重构（行为不变） | `## 7` 文件树即可，`## 5/6` 若提及接口则同步 | 跑全量测试证明行为等价 |

> 写文档时：优先改**语义**而非字面——架构文档描述"设计意图"，若实现与文档冲突，以代码为准并反查是否该更新本文档或引入 ADR 修正。

## 2. 一句话说明

mslxdff 是把 opencode.ai 的免费模型池（以及可选的 OpenRouter 免费模型）包装成**本地 OpenAI 兼容代理**的零依赖 Node 服务：客户端（OpenCode / Claude Code / WorkBuddy 等）把请求打到 `http://127.0.0.1:8989/v1/*`，mslxdff 负责模型排序、自动选择、慢模型降权、多账户轮转、群组接力，最后转发到上游。

## 3. 多供应商架构（0.1.56）

```
┌─ 客户端 ─────────────────────────────┐
│  model = "big-pickle"                 │  ← 裸 id：默认供应商（opencode）
│  model = "openrouter/google/gemma:free"│  ← 带前缀：路由到指定供应商
└──────────────┬───────────────────────┘
               ▼
  POST /v1/chat/completions
               ▼
   ┌─ src/providers/dispatcher.js ──────────┐
   │  splitModelId(): 按 '<provider>/<raw>' │
   │  拆前缀；转发前剥掉前缀只发原始 id      │
   └────────┬──────────────┬───────────────┘
            ▼              ▼
   ┌─ opencode.js ──┐  ┌─ openrouter.js ──┐
   │ createUpstream │  │ createOpenRouter  │
   │ (upstream.js)  │  │  Provider        │
   └────────────────┘  └──────────────────┘
                        │  apiKeys: [...]  多 key 轮转
                        │  keyring.js:     冷却隔离(30s)
                        └──────────────────
                            ▼
                 openrouter.ai/api/v1
```

- **前缀规则**：`<provider>/<raw-id>`。裸 id 恒指默认供应商（opencode），向后兼容。模型对外 id 由各 provider 用 `joinModelId` 前缀化，客户端看到的就是带前缀的完整 id；转发时 dispatcher 剥前缀。（ADR-0007）
- **默认供应商 opencode 恒启用**；`openrouter` 在配了任一 key 时自动启用（env `MSLXDFF_OPENROUTER_KEY` 或 state `providerKeys.openrouter`）。
- **未识别前缀**回退：整体当裸 id 交给默认供应商处理（例如用户传 `claude/sonnet` 想走 opencode，兼容）。

## 4. 请求链路

```
客户端
  │  Authorization: Bearer <token>   (ADR-0004，恒定时间比较，/health 除外)
  ▼
POST /v1/chat/completions          (/v1/* 需认证)
  │  plugins: request:received → model:select → model:beforeTry
  ▼
src/routes/chat.js (门面) ──▶ src/routes/chat/{index,hedge,local,peer,broadband,exhausted}-handler.js
  │
  ├─ 本地处理：model 解析 (auto/normalize) ──▶ upstream ──▶ 拆供应商转发
  ├─ 组员接力 (peer)：本机超时可让组员处理，结果带 x-mslxdff-via
  ├─ 对冲 (hedge)：流式 / 非流式 首块延迟对冲，谁快用谁 (MSLXDFF_HEDGE_DELAY_MS)
  └─ 模型无服务 → 自动选健康模型 (src/auto.js)
  ▼
上游 (Dispatcher → Provider)
  ▼
SSE 流式转发逐 chunk / 非流式透传 JSON
```

- 认证：`POST /v1/chat/completions`、`GET /v1/models` 需 `Authorization: Bearer <token>`；`GET /health` 公开。
- 中间件注入：DeepSeek 思考模式在 assistant 消息注入 `reasoning_content` 占位（ADR-0001）。
- 模型列表：`/v1/models` 只暴露免费模型（whitelist + `-free` 后缀，`big-pickle` 特例，ADR-0002），10 分钟缓存。

## 5. 功能地图（现状 + 归属模块）

| 功能 | 说明 | 主要模块 | 关键常量/配置 |
|---|---|---|---|
| 认证 | Bearer token，state 生成/轮换，恒时比较 | `src/state.js`, `src/server.js` | `-showtoken` / `-refresh-token` |
| 模型自动选择 | auto: 冷却>首选>延迟EMA>错误时间排序 | `src/auto.js` | `MSLXDFF_PREFERRED_MODEL`（默认 big-pickle） |
| 模型勾选集 | state `modelPicks` 限制候选池；显式指定真实上游模型自动勾选 | `src/auto.js` | `-model pick/unpick/…` |
| 多账户 key 轮转 | 每供应商多 key round-robin + 30s 冷却隔离（401/403/429/5xx），全冷却即报失效 | `src/providers/keyring.js` | `MSLXDFF_OPENROUTER_COOLDOWN_MS`、`-provider` |
| 冷却/慢模型 | 模型出错 60s 冷却(慢 5min)，`slow:true` 排最后 | `src/upstream.js`, `src/auto.js` | `SLOW_TOTAL_MS`(20s)、`MSLXDFF_MODEL_COOLDOWN_MS`、`STREAM_TIMEOUT_MS`(25s)、`MAX_STREAM_MS`(120s) |
| 首块对冲 (hedge) | 流式 1s 未回发并发组员/备用竞速 | `src/routes/chat/*` + `hedge.js` | `MSLXDFF_HEDGE_DELAY_MS`(1000) |
| 群组接力 | 组员/组长网格，赶 IP 级限流，宽带成员经 Leader 中继 | `src/routes/chat/peer*` | `-creategroup/-addtogroup/-group…` |
| 免费额度匿名兜底 | `public` 429 且 free 模型 → 空 `Authorization` 重试（hermes 通道） | `src/upstream.js` | `MSLXDFF_FREE_ANON_DELAY_MS`(1000)/`_RETRIES`(3)/`MSLXDFF_FREE_ANON=0` 关 |
| Keep-Alive + 预热 | undici keepAlive 30/60s，`srv.ready` 预拉模型 | `src/upstream.js` | `MSLXDFF_UPSTREAM_KEEPALIVE_*`、`MSLXDFF_PREHEAT=0` |
| 插件系统 | 可替换上游/.mjs hook，失败仅记日志 | `src/plugins.js` + `docs/plugins.md` | `MSLXDFF_PLUGINS_DIR` |
| WorkBuddy 同步 | `-setto workbuddy` 原子写 `~/.workbuddy/models.json` | `src/sync-workbuddy.js` | 仅认 127.0.0.1/v1 |
| Daemon | 后台守护，pid/日志/事件流，auto-update | `src/daemon.js`, `bin/mslxdff.js` | `-d/-status/-debug/-log/-update` |

## 6. 契约与配置

### CLI（bin/mslxdff.js）

| 命令 | 作用 |
|---|---|
| `mslxdff` / `-d` | 启动为后台 daemon |
| `-status` / `-log [N]` / `-debug` | 状态 / 最近事件 / 实时事件流 |
| `-stop` / `-uninstall` | 停止 / 停止并删状态日志 |
| `-port N` | 持久化端口（写 state，重启 daemon） |
| `-model list/set/status/refresh/pick/unpick/…` | 模型查看/默认/健康/勾选集管理 |
| `-models` | 交互式模型多选 |
| `-provider <id> [key...|add|remove|list|clear]` | 配置供应商 key（多 key 轮转，remove 支持序号；list 1 起编） |
| `-setto workbuddy [modelId]` | 同步默认模型到 WorkBuddy |
| `-creategroup` / `-addtogroup` / `-group …` / `-leavegroup` / `-delgroup` | 群组生命周期（组员用 `-group leave`，组长用 `-delgroup`，ADR-0005/0006） |
| `-showtoken` / `-refresh-token` | 读 / 轮换 auth token |
| `-update` | 更新到最新已发布版本 |

### Env

| 变量 | 默认 | 说明 |
|---|---|---|
| `MSLXDFF_PORT` | 8989 | 监听端口（裸 `PORT` 忽略，见 AGENTS.md） |
| `MSLXDFF_STATE_FILE` | `~/.config/mslxdff/state.json` | token/port/modelPicks/providerKeys 等持久化 |
| `MSLXDFF_DAEMON_DIR` | 随 state 派生 | daemon pid/log/models 目录 |
| `MSLXDFF_OPENROUTER_KEY` / `_COOLDOWN_MS` / `_BASE_URL` / `_TIMEOUT_MS` | — / 30000 / 官方 / 30000 | openrouter 供应商 key 与行为 |
| `UPSTREAM_BASE_URL` | `https://opencode.ai` | 默认供应商上游 |
| `UPSTREAM_AUTH_TOKEN` | `public` | 上游鉴权值 |
| `MODELS_REFRESH_MS` | 7200000 | 模型后台刷新间隔 |
| `MSLXDFF_MODEL_COOLDOWN_MS` / `MSLXDFF_PEER_COOLDOWN_MS` | 60000 / 30000 | 模型 / 组员冷却 |
| `MSLXDFF_FREE_ANON*` | 见上 | 免费匿名兜底开关/参数 |
| `MSLXDFF_HEDGE_DELAY_MS` | 1000 | 对冲等待（0/off 关） |
| `MSLXDFF_PREHEAT` | 1 | 上游预热（0 关） |
| `MSLXDFF_PLUGINS_DIR` | 见 plugins.md | 插件目录覆盖 |

### 运行契约（对外不可破坏）

1. `POST /v1/chat/completions` 转发 body 上游不改（仅中间件注入），模型 id 透传。
2. 恒带 `x-opencode-client: desktop` + `Authorization: Bearer`(上游值，默认 public) + 流式 `Accept: text/event-stream`。
3. DeepSeek 思考模型：assistant 消息必须带 `reasoning_content` 占位再转发（ADR-0001）。
4. 流式按 SSE chunk 转发；非流式非 JSON 上游响应透传。
5. `/models` 只返回免费模型 filter（whitelist + `-free`，`big-pickle` 特例，ADR-0002），10-min 缓存。
6. `/v1/*` 需 `Authorization: Bearer <token>`（恒时比较，401 否则）；`/health` 公开。
7. key 类 state（providerKeys）只存用户主目录 `~/.config/mslxdff/state.json`，绝不进 repo（见 AGENTS.md + .gitignore 加固）。

## 7. 目录导览（当前结构）

```
mslxdff/
├── bin/mslxdff.js            CLI 分派、参数解析、daemon 装配（1760+ 行，>20KB 候选拆分为子命令模块）
├── src/
│   ├── server.js              HTTP server、路由装配、认证、resolvePort
│   ├── routes.js              路由门面（63KB 超标，待拆——计划见 AGENTS.md）
│   ├── routes/chat/           chat 门面 + 6 handler（index/hedge/local/peer/broadband/exhausted，均 <10KB）
│   ├── upstream.js            上游客户端：keepalive、重试、超时、匿名兜底
│   ├── models.js              模型服务：刷新、到期、cacheFile、providers 聚合
│   ├── auto.js                自动模型：排序、冷却自愈、勾选集
│   ├── reasoning.js           思考模式 reasoning_content 注入
│   ├── state.js               state 持久化（缓存层 + token/port/modelPicks/providerKeys）
│   ├── daemon.js              后台守护
│   ├── plugins.js             插件加载/执行，失败隔离
│   ├── sync-workbuddy.js      WorkBuddy models.json 同步
│   └── providers/
│       ├── dispatcher.js      前缀路由、聚合 listModels、剥前缀
│       ├── model-id.js        splitModelId/joinModelId/normalizeProviderId
│       ├── opencode.js        opencode 上游 provider
│       ├── openrouter.js      OpenRouter provider（keyring + 品牌头 + 免费 filter）
│       ├── keyring.js         多 key 轮转 + 冷却隔离
│       └── index.js           导出
├── docs/
│   ├── ARCHITECTURE.md        ← 本文件（总览 + 变更契约）
│   ├── plugins.md             插件开发指南
│   ├── adr/                   架构决策记录（0001..0007，见 §8 索引）
│   └── agents/                agent 工作流用领域文档
├── test/                      单元+集成测试（node --test，全量 250+）
└── scripts/docs-check.js      npm run docs:check 文档就绪检查
```

## 8. 决策索引（ADR 目录）

| # | 主题 | 一句话 |
|---|---|---|
| 0001 | reasoning_content 注入 | DeepSeek 思考模式回传占位，防 400 |
| 0002 | 免费模型 filter | whitelist + `-free`，`big-pickle` 特例 |
| 0003 | 零状态无鉴权 | 早期无账号阶段的设计 |
| 0004 | Bearer token 鉴权 | `/v1/*` 恒时比较，`/health` 公开，token 轮换 |
| 0005 | 组网 mesh | 组员/组长接力，IP 级限流分散 |
| 0006 | 宽带成员 | 动态 IP 成员经 Leader 中继 |
| 0007 | 多供应商前缀 | `<provider>/<id>` 前缀路由，默认 opencode 裸 id（0.1.56 新增） |

