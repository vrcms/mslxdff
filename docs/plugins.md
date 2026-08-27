# mslxdff 插件开发指南

mslxdff 内置一个零依赖的插件系统：把符合约定的 `.mjs` 模块放进插件目录，daemon 启动时自动加载，在**请求链路的所有关键节点**（hook 点）调用你的代码——包括替换上游 provider 本身。**插件出错只记日志，绝不影响主链路。**

> **内置多供应商**：0.1.56 起默认走 `src/providers/` 的多 Provider 架构（opencode 恒启用 + openrouter 可选，见 AGENTS.md）。插件 `createUpstream` 仍是"整体替换式"制造商供应，与内置多 Provider 二选一（有 provider 插件时走插件单通道）。

## 快速开始

### 1. 插件目录（双目录，都会被加载）

```
官方插件:  <mslxdff安装目录>/plugins/     ← 随包分发，auto-update 一起更新
用户插件:  ~/.config/mslxdff/plugins/    ← 你自己的正式插件，升级永不丢
完全接管:  环境变量 MSLXDFF_PLUGINS_DIR=/path/to/dir（只扫这一个）
```

优先级：同名文件时**用户目录覆盖官方目录**；加载顺序官方在前、用户在后。

> 为什么不直接放安装目录？npm 升级会重置包内文件——所以自己的正式插件务必放用户目录。

### 2. 写一个最小插件

创建 `~/.config/mslxdff/plugins/hello.mjs`：

```js
export default {
  name: "hello",
  version: "1.0.0",
  description: "我的第一个 mslxdff 插件",
  hooks: {
    "server:start": (ctx) => {
      console.log(`[hello] mslxdff 已启动 port=${ctx.port}`);
    },
  },
};
```

### 3. 查看是否被识别

```bash
mslxdff -plugins
# plugins dir: C:\Users\you\.config\mslxdff\plugins
#   hello@1.0.0  [server:start]
#     我的第一个 mslxdff 插件
```

重启 daemon（`mslxdff -stop && mslxdff`）后生效。日志里会出现 `plugins loaded (1): hello@1.0.0`。

## Hook 全表

### 请求链路（按触发顺序）

| Hook | 触发时机 | ctx 内容 | 返回值语义 |
|---|---|---|---|
| `request:received` | 读到请求 body 后 | `{ ip, hops, headers, body }` | 返回 `{ respond: { status, body } }` **可短路请求**，直接响应客户端 |
| `model:select` | 候选顺序确定后 | `{ reqId, requested, useAuto, order, hops, stream }` | 返回数组**替换候选顺序** |
| `model:beforeTry` | 每个模型尝试前（循环内） | `{ reqId, requested, model, idx, hops }` | 返回 `false` 或 `{ skip: true }` **跳过该候选** |
| `upstream:request` | 发往上游前 | `{ reqId, requested, model, payload, stream }` | 返回 `{ payload }` **替换本次上游负载**（含 model 字段） |
| `upstream:response` | 上游响应/错误后 | `{ reqId, requested, model, status, ok, error, timing }` | 只观察 |
| `relay:first-chunk` | 流式首块到达 | `{ reqId, requested, model, via, ttfMs }` | 只观察 |
| `request:completed` | 请求结束（所有出口） | `{ reqId, requested, via, status, actual, durationMs, fallback?, interrupted?, error? }` | 只观察 |

> `x-mslxdff-model-lock` 锁定模型时 `model:select` 不触发——锁是硬约束。

### 上游层（upstream 内部，作用于内置 client 的每次 fetch）

| Hook | 触发时机 | ctx 内容 | 返回值语义 |
|---|---|---|---|
| `upstream:headers` | 构建请求头后 | `{ url, body, headers }` | 返回 `{ headers }` **替换请求头** |
| `upstream:before-request` | fetch 调用前 | `{ url, method, body, headers }` | 返回 `{ url?, headers? }` **改目标地址/头** —— 上游不限于 opencode，可指向任意兼容端点 |

### 模型列表 / 组内转发 / 生命周期

| Hook | 触发时机 | ctx 内容 | 返回值语义 |
|---|---|---|---|
| `models:list` | `/v1/models` 返回前 | `{ data }` | 返回 id 数组或完整 data 数组**替换对外模型列表** |
| `peer:beforeForward` | 转发给组员前 | `{ reqId, peer, model, hops }` | 只观察 |
| `peer:result` | 组员响应后 | `{ reqId, peer, model, ok, status, latencyMs }` | 只观察 |
| `server:start` | 服务就绪 | `{ port, host, version }` | 只观察 |
| `server:stop` | 关闭前 | `{ version }` | 只观察 |

### 特殊接口（非 hooks 字段）

```js
export default {
  name: "my-plugin",
  // ① 订阅全部事件流（request/ordered/upstream/fallback/result...每条 evt 都会推给你）
  onEvent(evt) { /* fire-and-forget，抛错被吞 */ },
  // ② 整体替换上游 provider（接任意 OpenAI 兼容服务；多个插件声明时取第一个）
  async createUpstream(ctx) {
    // ctx = { baseUrl, authToken, env }
    return {
      chat(body) { /* 返回 fetch Response，status>=400 会走 fallback */ },
      preheat() { /* 可选：返回 { ok, status, ms } */ },
      close() { /* 可选 */ },
    };
  },
  hooks: { /* ...上表全部 hook */ },
};
```

## 实战示例

### 改变模型列表设定（首选模型）

```js
// prefer-model.mjs — 把指定模型排到最前
const PREFER = "big-pickle"; // 改这里，或读你自己的配置文件

export default {
  name: "prefer-model",
  hooks: {
    "model:select": (ctx) => {
      if (!ctx.order.includes(PREFER)) return; // 不在列表就不动
      return [PREFER, ...ctx.order.filter((m) => m !== PREFER)];
    },
    "models:list": (ctx) => {
      // 对外只暴露白名单模型
      return ctx.data.filter((m) => /big-pickle|deepseek/i.test(m.id ?? m));
    },
  },
};
```

### 把上游换成任意 OpenAI 兼容服务（不改 URL 配置）

```js
// redirect-upstream.mjs
export default {
  name: "redirect-upstream",
  hooks: {
    "upstream:before-request": (ctx) => ({
      url: ctx.url.replace("https://opencode.ai", "https://my-proxy.example.com"),
    }),
  },
};
```

### 自定义鉴权 / 限流

```js
export default {
  name: "guard",
  hooks: {
    "request:received": (ctx) => {
      if (String(ctx.body?.messages?.[0]?.content || "").includes("BLOCK")) {
        return { respond: { status: 403, body: { error: "blocked by plugin" } } };
      }
    },
  },
};
```

### 监控统计（事件流）

```js
let total = 0;
export default {
  name: "stats",
  onEvent(evt) {
    if (evt.type === "request") total++;
    if (evt.type === "result" && evt.status >= 500) console.log(`[stats] 5xx! ${evt.model}`);
  },
};
```

## 规则与保证

- **文件格式**：仅 `.mjs` / `.js`，ESM，必须有 `export default { ... }`；`name` 缺省取文件名
- **串行执行**：多个插件的同一 hook 按文件名排序依次执行；返回值链式传递（前一个的输出是后一个的输入）
- **错误隔离**：
  - 加载失败 → 不注册，错误进 events.log（`plugin-load-error`）和 `-plugins` 输出
  - hook 抛错 → 跳过该插件继续执行后续插件，主链路无感
- **可观测**：hook 生效时 events.log 记 `plugin-hook`；报错记 `plugin-hook-error`；替换上游记 `plugin-upstream-active`
- **性能**：`request:received / model:select / model:beforeTry / upstream:request` 是 await 串行的，别做慢操作（>100ms 请改 fire-and-forget）；`onEvent / request:completed / relay:first-chunk / upstream:response / peer:*` 本身就是异步不阻塞

## 调试

```bash
mslxdff -plugins          # 列出已识别插件与其 hooks
mslxdff -debug            # 前台跑，实时看 plugin-hook / plugin-hook-error 事件
mslxdff -log 50           # 回看事件日志
```

## 与 WorkBuddy 集成

WorkBuddy 插件的 SKILL.md 可以教 AI 在用户说"切换首选模型到 xxx"时，自动改写上面的 `prefer-model.mjs` 并重启 daemon —— mslxdff 侧无需任何改动，hook 就是稳定契约。
