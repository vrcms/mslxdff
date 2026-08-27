# ADR-0007：多供应商前缀路由

- 状态：**已采纳**（0.1.56）
- 日期：2026-08-27
- 关联：`docs/ARCHITECTURE.md` §3、`src/providers/`

## 背景

opencode.ai 的免费池会 429 限流，且模型种类有限。需要引入 OpenRouter 的免费模型池（`pricing.prompt/completion` 全 0，实测 20 个）作为第二通道。上游供应商各有自己的模型 id 空间、鉴权方式、品牌头要求，如果全部裸 id 混在一个 namespace 会冲突（同名 id 歧义）。

## 决策

采用**前缀路由**：

- 模型 id 对外形态：`<provider>/<raw-id>`；裸 id（无前缀）恒指默认供应商 **opencode**，向后兼容所有存量配置。
- 新增 `src/providers/`：每供应商一个文件，统一接口 `{ id, chat(body), listModels(), preheat, close }`。
- `dispatcher.js` 用 `splitModelId` 拆前缀路由到对应 provider，**转发前把 `body.model` 剥回原始 id**，上游看到的是未污染的 id。
- 未识别前缀回退：整个 model 当裸 id 交给默认供应商。
- 供应商发布模型清单时用 `joinModelId` 前缀化，客户端看到的完整 id 即为最终路由键。

## 后果

- 模型选择器（auto、modelPicks）工作在**完整带前缀 id** 上，天然区分供应商。
- 多 key 轮转（keyring）在 provider 内部，对路由透明。
- 默认供应商无 key 不需要；非主供应商（如 openrouter）无 key 时**不加载**，不报错。