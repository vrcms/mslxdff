# ADR-0006: 宽带动态IP成员（broadband）经 Leader 中继共享配额

> **状态**：规划完成，待实现（基于 v0.1.33）。用户确认：`--broadband` 为唯一语义，不设 `--relay` 别名；默认 `127.0.0.1` 监听。

## 1. 背景与问题

现有组模型（ADR-0005）假设组员均为公网 VPS，`A->D` 直连 `http://D公网IP:8989/v1/chat/completions` 用 `D` 的出口 IP 打 `opencode.ai`，实现 `IP级免费池` 分散。家庭宽带 `D` 有公网 IP 但：

1. **入站不可达**：无端口映射/CGNAT，`probeHealth GET http://D:8989/health` 恒 `fail`，`peer-race` 直接跳过，`D` 的配额永不被用。
2. **IP 动态**：`refreshGroupMembers` 透传旧 `myUrl`，IP 变更后 60s 同步期内全组仍用旧 IP。
3. **语义缺失**：组内无法区分 `static(VPS直连)` 与 `broadband(家庭中继)`，`-group list` 无标识。

需求：家庭 `D` 以 `broadband` 类型加入，无需公网入站，经 `Leader` 中继仍用 `D` 的家庭出口打上游，且全程可观测。

## 2. 决策

新增成员类型 `kind: "broadband"`（默认 `kind: "static"` 兼容老数据），`broadband` 隐含 `relay` 中继：

* **加入**：`mslxdff -addtogroup <leader-host> <group> --broadband`（唯一旗标，不设 `--relay`）。
* **监听**：`--broadband` 下默认 `listen 127.0.0.1:8989`，仅本机 `WorkBuddy` 可用；不加该旗标的为 `static` 走 `0.0.0.0`。
* **共享**：`D --WS--> Leader` 常驻出站，`A(429) -> Leader -> D -> opencode.ai -> D -> Leader -> A`，上游仍见 `D` 家庭 IP。
* **展示**：`-help` 新增用法行，`-group list / -status / -log` 标注 `[broadband] via leader Xs ago ip=...`。

## 3. 设计

### 3.1 成员模型

`state.json groups[name].members[id]` 扩展：

```json
"home-D": {
  "url": "relay://home-D",
  "token": "...",
  "kind": "broadband",
  "publicIp": "183.14.22.78",
  "lastSeen": 1724212345678,
  "status": {"upstreamOk": true, "latencyMs": 4200}
}
```

* `static`：`url: http://IP:8989`，参与 `probeHealth`。
* `broadband`：`url: relay://id`，不探活，只看 `lastSeen`（`>90s` 标 `cooling`）+ `status`，`rankModels` 同 `slow` 5m 冷却共用。

### 3.2 连接与心跳

**D 端（家庭）**
* 解析 `--broadband`，建 `WS wss://Leader/v1/groups/relay/connect?group=my@mslxd`，`Authorization: Bearer <token>`。
* `hello {group, token, kind:"broadband", version}` → Leader 回 `welcome {memberId}`。
* `heartbeat 30s {status:{upstreamOk, models, load}}`，`publicIp` 由 Leader 的 `clientIp(req)` 填，不靠 `ifconfig.me`。
* 断线指数退避 `1s/2s/4s...` 重连，IP 变更导致 `TCP RST` 自动重建即完成 IP 更新。

**Leader 端（VPS）**
* `GET /v1/groups/relay/connect` 升级 WS，鉴权 `membersForToken`，存 `relayConns[group][id]=ws`，`ws.remoteIp=clientIp`。
* 每条 `heartbeat` 对比 `remoteIp` vs `members[id].publicIp`，变则 `saveGroups` + `evt relay-ip-change` 入 `events.log`。
* `lastSeen >90s` 或 `WS断开` 立即标 `cooling`，`A` 下次 `candidatesFor` 自动避开。

### 3.3 转发路径

```
用户 -> A: POST /v1/chat/completions {model: deepseek, stream:true}
A -> opencode.ai (用A IP) 429
A选 candidatesFor -> [B(static), home-D(broadband via Leader), ...] 按 latency EMA
A -> Leader: POST /v1/groups/relay/forward {target: home-D, body, hops:1, reqId}
Leader -> D (WS): {reqId, body:{model,messages}}
D -> opencode.ai (用D家庭IP) 200 SSE chunk*
D --WS {reqId, data:chunk}--> Leader --HTTP chunk--> A --SSE--> 用户
A断开 -> Leader --WS {abort reqId}--> D controller.abort()
```

* `hops` 每跳 +1，`MAX_HOPS=3` 防环；`broadband` 节点自身 `429` 时可直接 `fetch` 到 VPS `static` 节点（出站直连，无需中继）。
* 多请求复用一条 WS，`reqId` 复用现有 `relay` 日志的 `reqId/detail` 串联。

### 3.4 可观测

* `-help`：` -addtogroup <host> <name> [--broadband]  宽带动态IP成员（经Leader中继，无需公网入站，默认127.0.0.1）`
* `-group list`：`3. relay://home-D [broadband] ok via leader 12s ago ip=183.14.22.78`
* `-log [N]`：`relay-ip-change / relay-forward / relay-heartbeat / client-abort` 均带 `reqId/detail`。

## 4. 实现清单

| 文件 | 改动 |
|---|---|
| `bin/mslxdff.js` | `-addtogroup` 解析 `--broadband`，`WS` 客户端+心跳+重连，`listen` 在 `broadband` 下绑 `127.0.0.1`，`printHelp` 新增行，`groupSyncTimer` 对 `broadband` 组 30s |
| `src/groups.js` | 成员结构 `kind/publicIp/lastSeen/status`，`addGroupMember/upsertMember/syncPeersFromMembers` 支持 `broadband`，`refreshGroupMembers` 透传 `kind` |
| `src/peers.js` | 新增 `relayVia` 字段，`add({relayVia, kind}) / isRelay`，`broadband` 不进 `ordered()` 直连池 |
| `src/routes.js` | 新增 `WS /v1/groups/relay/connect` + `POST /v1/groups/relay/forward`，`forwardToPeer` 中继分支，`hops` 处理 |
| `src/state.js` | 持久化 `kind/publicIp/lastSeen`，新增 `load/save` 兼容 |
| `src/logs.js` | `relay-*` 事件类型 |

依赖：`ws`（或 Node 22 原生 `WebSocket`，服务端需 `upgrade` 处理）。

## 5. 验证

1. **IP变更**：`D` 拨号重拨，`WS` 重连，`events.log` 出现 `relay-ip-change old->new`，`-group list` IP 更新，`A` 经 `Leader` 仍命中 `D`。
2. **配额共享**：`A` 指定 `deepseek 429`，`-log` 显示 `peer-race via=relay-leader target=home-D`，`D` 的 `upstream-done 200` 且 `detail.exitReason:normal`，回包完整。
3. **本地可用**：`D` 本机 `curl http://127.0.0.1:8989/v1/chat/completions` 200，外网 `curl http://家庭公网IP:8989` 超时（符合预期）。
4. **`-help` / `-group list`** 均含 `broadband` 标识。

## 6. 风险与取舍

* `Leader` 单点中继增加 `10-30ms` 延迟，可接受；`Leader` 宕则 `broadband` 配额暂不可用（`static` 组员仍直连可用）。
* 多并发复用单 `WS` 需 `reqId` 复用与背压控制，首版可限并发 3（复用 `PEER_RACE_LIMIT`）。
* 不设 `--relay` 别名，术语统一为 `broadband`，内部变量 `relay` 仅作实现名。
