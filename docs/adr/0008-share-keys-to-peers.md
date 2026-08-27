# ADR-0008：供应商 key 瞬时共享（peer 转发时附带）

- 状态：**已采纳**（0.1.57）
- 日期：2026-08-27
- 关联：`docs/ARCHITECTURE.md` §3/§5、`src/routes/peers.js`、`src/providers/dispatcher.js`

## 背景

多供应商架构（ADR-0007）下，组内接力对 model 字符串透明转发（peers.js `forwardToPeer`）。当 A 请求 `openrouter/xxx` 本地失败而转发给组员 B，若 B 未配置 openrouter key，B 的 dispatcher 找不到该前缀 → 回退 opencode 兜底 → 把 `openrouter/xxx` 原样发给 opencode 上游 → 失败。

同时存在分散 IP 级限流的机会：若 B 能用 A 的 key + B 自己的出口 IP 访问 openrouter，则组间接力既借力 B 的带宽/IP，又复用 A 的配额。

但 key 长期分发给组员有失控风险（明文泄漏、风控、配额被滥用），且上游限流维度不同（opencode 以 IP 为主、OpenRouter 以账户 key 为主）。

## 决策

增加**供应商级开关 `shareKeysToPeers`（默认 false）**：

- `false`（默认）：现状，不发生任何 key 共享。
- `true`：本节点在 **outgoing 转发**（peer 接力或 broadband 接力）给组员时，若请求模型命中该供应商前缀，把本节点该供应商的 key 列表放私有请求头 `x-mslxdff-share-keys` 附带过去。组员**仅在该次请求内**用这份 key 访问上游，处理完即弃——**不落盘、不广播、不持久同步**。

锁定语义：
- **瞬时借用**：key 生命周期 = 一次转发请求。组员绝不把共享 key 写入本地 state，也不为其它请求复用。
- **仅转发时附带**：谁开启共享，谁在 outgoing 转发时带自己的 key；不向全组广播。本节点自己直接用，也带。

### 状态与配置

- state：`providerShareKeys: { <providerId>: boolean }`（空/缺失 = 默认 false）。
- env 覆盖：`MSLXDFF_<ID>_SHARE_KEYS`（`1/true/on` 视为 true）。
- CLI：`mslxdff -provider openrouter share on|off` 切换；`-provider openrouter status` 一并显示。

### 转发协议

出站转发（peer / broadband）时组装私有头：

```
x-mslxdff-share-keys: openrouter=sk-1,sk-2;other=sk-a
```

组员端收到：解析头 → 对该供应商 id **临时创建** provider（用头上 key）注入本次请求的 dispatcher 解析路径 → chat 完成后丢弃。

### 安全边界

- 只对**开启 share 的供应商**生效；key 总量被网关（本节点）控制。
- 组员只需能执行"本次请求用这个 key 调上游"，拿不到长期凭证。
- 自定义其值约定触发风控：多个组员同时高频用同一 key 请求时，仍受上游账户级限制（不规避 key 级配额），仅叠加 IP 分散价值——这是决策接受的范围。

## 后果

- 组内接力对配了 key 的供应商可用率提升（不再无谓落到 opencode 兜底失败）。
- 蓝领风险可控：瞬时借用，default off，显式开启才生效。
- 迁移：无破坏。旧 state 无 `providerShareKeys` 字段 → 默认 false，行为等同现状。