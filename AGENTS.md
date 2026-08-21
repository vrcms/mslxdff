# AGENTS.md

Strip-down of 9Router's **OpenCode Free** provider into a standalone OpenAI-compatible proxy.
The full implementation blueprint lives in `./CLAUDE.md` — **read it first**; it is authoritative and current.

## 命令执行规则（用户强制约定，必须遵守）

- **每次执行命令（Bash 工具）前，先输出当前时间**（如 `echo "[$(date +%H:%M:%S)] start"`），命令结束后输出结束时间（`status: $?`）。这样用户能直接看到你的命令耗时。
- **命令必须短、快、一次返回**：禁止把 `sleep`、后台进程（`&`）、长轮询、完整测试混进同一条命令制造"看似卡死"的假象。
- 启动长驻进程务必用 `Start-Process cmd.exe /c "... >> log 2>> err"`（见全局 CLAUDE.md），并在返回前必须验证：端口监听 + 最小请求日志落盘。
- 如果某条命令预计会跑很久（如全量测试），先单独执行，且设置合理超时；不要跟其他命令堆叠。

## Source of truth

- **Reference repo**: `/root/9router` (git tag `v0.5.45`). Original implementation and request chains
  are defined there. Never guess behavior from memory — look it up in `/root/9router` when in doubt.
- `/root/mslxdff` currently has **no code yet** — only `CLAUDE.md` + this file. A skeleton
  layout (server, `/v1/*` routes, models cache, SSE forwarder) is proposed in `CLAUDE.md` §5.

## Verified upstream contract (opencode.ai zen gateway)

- `POST https://opencode.ai/zen/v1/chat/completions` + `GET https://opencode.ai/zen/v1/models`.
- **Always** send: `x-opencode-client: desktop` + `Authorization: Bearer public`
  (value unvalidated, "public" works) + `Accept: text/event-stream` when streaming.
- Request body is standard OpenAI chat completions; pass `model` through verbatim.
- May be rate-limited / unstable (it's a shared free quota) → keep configurable timeout + 429/network backoff.
- This is **not** the paid opencode-go subscription (`x-api-key` auth) — don't mix them up.

## Non-obvious gotchas

- **Thinking-mode injection is required.** DeepSeek-family models in thinking mode require the client to
  echo back `reasoning_content` on assistant messages, or the upstream returns
  `400 "The reasoning_content in the thinking mode must be passed back"`. Inject a `" "` placeholder on
  assistant messages before forwarding: DeepSeek = scope `all`, `kimi-*` = scope `tool_calls`.
  Reference: `/root/9router/open-sse/utils/reasoningContentInjector.js`.
- **Free-model filter is whitelist-plus-suffix, not suffix-only**: `id.endsWith("-free")` OR
  `KNOWN_FREE_OPENTECH_MODELS = ["big-pickle"]`. `big-pickle` has no `-free` suffix and would be dropped
  otherwise. Reference: `/root/9router/src/app/api/providers/suggested-models/filters.js`.
- Models endpoint returns `{"object":"list","data":[...]}` (OpenAI shape), not a bare array.
- No-account virtual credential: `public` against a `Bearer header`, `noAuth` provider skips
 401/403 refresh and account fallback.
- Only expose the **free** models (~7) on `/models`, not all 60 from the upstream list.

## Contract to uphold

1. `POST /v1/chat/completions` forwards body upstream unmodified (except middleware injections); model id passes through.
2. Always add both headers named above.
3. reasoning_content injection before send (all-deepseek / tool-tiered-kimi).
4. Stream SSE per-chunk; non-stream non-JSON passthrough.
5. `/models` returns the filtered free model list (10-min cache).
6. `/v1/*` requires `Authorization: Bearer <token>` (constant-time compare, `401` otherwise); `/health` is public.
7. Token lives in the state file (default `~/.config/mslxdff/state.json`, env `MSLXDFF_STATE_FILE`), generated on first run, rotated via `mslxdff -refresh-token`. See `docs/adr/0004.md`.

## Learned User Preferences

- 所有回复、思考过程及任务清单均须使用简体中文；文案用中文优先，命令/代码保持原文。
- 每轮命令前后都要打印时间戳（`echo "[$(date +%H:%M:%S)] start"` / `status: $?`），命令短快一次返回。
- 现网升级验证必须用 `npx -y mslxdff@<ver>`（锁版本、绕过 npx 缓存）。
- 小改动（文案、样式、小重构）直接落地不逐轮确认；涉及数据删除/架构大改/配置变更先确认。
- 行情式命令结果要紧凑，不贴大段 diff；重要结果先验证（端口监听+日志落盘）再让用户测。
- 用户偏好"显式语义清晰"的命令设计：`-leavegroup` 只用于组员离开，组长只能走 `-delgroup <name>` 解散组。
- 8989 是硬性默认端口；仅认 `-port N` 持久化或 `MSLXDFF_PORT` env，SSH/包装脚本注入的裸 `PORT` 被忽略。
- 深度思考被截断时不要自发压测，补细粒度日志（reqId/detail）后等用户复现。
- 慢模型不掐当前流：首块 25s 内到来即视为可用，后续无限等；stall 15s 仅作质量分（stallHits 累计数进 5 分钟降权），总耗时>20s 也降权。
- 指定模型 429 不可用时按延迟 EMA 择优切最快模型（nemotron-3.5 快、hy3/laguna 慢）。
- A 转发给 B 时上游应以 B 的出口 IP 访问 opencode.ai（分散免费池 IP 级限流）。
- 扩展功能优先做成可配置常量/单一变量（如 `PREFERRED_MODEL` + env 覆盖），避免到处硬编码；跨系统扩展（如 WorkBuddy）先在 mslxdff 侧留稳定 hook 契约。

## 代码文件大小约束（强制）

- 大多数 `src/**/*.js` 源码文件请保持 **≤10KB**（约 300 行内）
- 单文件 **>20KB 必须着手拆分**：按职责拆成多个 js 模块，通过 entry-point 聚合（例：`src/routes/` 拆 `chat.js`/`groups.js`/`relay.js`，`src/upstream/` 拆 `client.js`/`headers.js`）
- 检查方式：`ls -lh src/**/*.js` 或 `wc -c src/**/*.js`；CI 可加 `find src -name "*.js" -size +20k` 告警
- 现状：`src/routes.js` 约 63KB 已超标，下一版本需优先拆分

## Learned Workspace Facts

- 端口优先级（`src/server.js resolvePort()`）：state.json 持久化 `port` > `MSLXDFF_PORT` env > 默认 8989；不再读裸 `PORT`。`-port N` 写 state 并触发 daemon 重启。
- `-group list` 的序号按 state 成员顺序（过滤 `leader`，leader 不占号）固定渲染，`-group remove <seq>` 用同一顺序踢人（仅组长）。
- 组长节点 `-leavegroup` 会提示改用 `-delgroup`；`-delgroup` 在组员节点报错并提示该组由谁领导。
- 上游 opencode.ai 免费额度会 429 限流导致 failover：同一请求的模型可能被静默换成健康模型响应；用 `x-mslxdff-model-lock` 头可锁定模型拿到真实状态。
- 免费模型当前约 9 个（0.1.43 实测）：`deepseek-v4-flash-free`/`big-pickle`/`x-preview-f-free`/`muse-spark-1.2-contributor-free`/`mimo-v2.5-free`/`hy3-free`/`nemotron-3-ultra-free`/`nemotron-3.5-lightning-free`/`laguna-s-2.1-free`。
- 服务器节点：i-69b368cf221da7821163239e（leader，port 8989）、172.93.221.187:8989、149.13.91.10:8989，组名 `my@mslxd`。
- 超时与慢模型机制（0.1.27~0.1.30 演进）：上游重试 `1次×500ms`；`SLOW_TOTAL_MS` 默认 20s 超时标 `slow:true` 进 5 分钟长冷却（普通冷却 60s），`rankModels` 把 slow 排最后、过期自愈；`STREAM_TIMEOUT_MS` 25s 首块未到且未写字节才 failover，已写字节只能中断不换模型；`STALL_TIMEOUT_MS` 监测相邻 chunk 间隔（现默认 0 关闭，仅作 stallHits 质量分）；`MAX_STREAM_MS` 120s 防无限流。教训：新增常量须在文件顶部定义（曾踩 ReferenceError）；`upstream.body.cancel()` 释放流但不写 res（否则 ERR_HTTP_HEADERS_SENT）。
- Keep-Alive + 预热（0.1.42）：`src/upstream.js` 显式 `undici.Agent(keepAlive 30s/60s, connections 20)` + `dispatcher` 透传 chat/preheat；`srv.ready` 后 100ms 异步 `GET /zen/v1/models` 预热（`upstream-preheat` 事件）；`MSLXDFF_PREHEAT=0` 可关、`MSLXDFF_UPSTREAM_KEEPALIVE_*` 可调。npm undici 与 Node 内置 fetch 不兼容（`invalid onRequestStart`），必须配对 `UndiciFetch || fetch`。
- auto 首选模型（0.1.43）：`PREFERRED_MODEL = env MSLXDFF_PREFERRED_MODEL || "big-pickle"` 单点定义于 `src/auto.js`；排序优先级 `cooling > preferred > latency EMA > errAt`（preferred 强制第一，慢/429 冷却自动让位自愈）；`DEFAULT_AUTO_MODELS` 首位引用它并去重。
- 插件系统（0.1.44 未发版）：插件目录 `~/.config/mslxdff/plugins/`（env `MSLXDFF_PLUGINS_DIR`），`.mjs` default export `{name,version,hooks,onEvent,createUpstream}`；hook 全表见 `docs/plugins.md`——请求链路 `request:received`(可短路)/`model:select`(可改序)/`model:beforeTry`(可跳过)/`upstream:request`(可改payload)，上游层 `upstream:headers`/`upstream:before-request`(可改URL+头)，旁路 `models:list`/`peer:*`/`server:start|stop`/`onEvent`；插件 `createUpstream(ctx)` 可整体替换上游 provider；`runHook` 语义=任何非 undefined 返回值生效且链式传递；错误全隔离只记日志；`x-mslxdff-model-lock` 时 model:select 不触发。
- 本机 daemon 启动方式：`Start-Process node bin/mslxdff.js --daemon`（直启 node，勿用 cmd /c 包装——会撞 daemon.log EBUSY 句柄占用）；pid/version 落 `~/.config/mslxdff/daemon.pid`。
- WorkBuddy（腾讯 CodeBuddy 系）支持插件：`.codebuddy-plugin/plugin.json` + `skills/<name>/SKILL.md`（兼容 `.workbuddy-plugin/`），本机已装 agent-browser/pdf 等 7 个官方插件于 `C:\Users\mslxd\.workbuddy\plugins\`；其自定义模型条目 id 会原样发给 mslxdff（假名会 failover 到上游 502，按真实模型命名则正常）；SKILL.md 可教 AI 执行命令，是 mslxdff hook 契约的消费端。