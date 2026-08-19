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

## Learned Workspace Facts

- 端口优先级（`src/server.js resolvePort()`）：state.json 持久化 `port` > `MSLXDFF_PORT` env > 默认 8989；不再读裸 `PORT`。`-port N` 写 state 并触发 daemon 重启。
- `-group list` 的序号按 state 成员顺序（过滤 `leader`，leader 不占号）固定渲染，`-group remove <seq>` 用同一顺序踢人（仅组长）。
- 组长节点 `-leavegroup` 会提示改用 `-delgroup`；`-delgroup` 在组员节点报错并提示该组由谁领导。
- 上游 opencode.ai 免费额度会 429 限流导致 failover：同一请求的模型可能被静默换成健康模型响应；用 `x-mslxdff-model-lock` 头可锁定模型拿到真实状态。
- 免费模型当前约 7 个：`deepseek-v4-flash-free`/`big-pickle`/`mimo-v2.5-free`/`hy3-free`/`nemotron-3-ultra-free`/`nemotron-3.5-lightning-free`/`laguna-s-2.1-free`。
- 服务器节点：i-69b368cf221da7821163239e（leader，port 8989）、172.93.221.187:8989、149.13.91.10:8989，组名 `my@mslxd`。
- 耗时优化（0.1.27）：① 上游 429/5xx 重试从 `2次×2s` 收到 `1次×500ms`（`src/upstream.js`），每个失败模型 failover 从 ~6.7s → ~2.3s；② 慢模型按**整体墙钟耗时**降权（`SLOW_TOTAL_MS` 默认 15s，env `MSLXDFF_SLOW_TOTAL_MS`；`out.totalMs`/`Date.now()-startedAt` 判断，超阈值 `recordError(slow)` → 下次 auto 排到最后），nemotron-3-ultra 36s 被降权后接请求改用快模型 2.7s；③ 流式首块超时断路器 `STREAM_TIMEOUT_MS` 默认 25s（env `MSLXDFF_STREAM_TIMEOUT_MS`），首块未到且未写任何下游字节则干净切下一模型。
- 慢模型评分机制（0.1.28）：`SLOW_TOTAL_MS` 提到默认 **20s**；超阈值请求被标 `slow:true`（`recordError({slow:true})`，`src/auto.js` 持久化 `slow` 字段）并进入**更长冷却 `SLOW_COOLDOWN_MS` 默认 5 分钟**（env `MSLXDFF_SLOW_COOLDOWN_MS`，对比普通 60s `MSLXDFF_MODEL_COOLDOWN_MS`），冷却期内 `rankModels` 把 slow 模型排到最后（近似禁用），冷却期过自动解冻（自愈，不会永久锁死；若再慢则刷新冷却）。workbuddy 连续追问时，慢模型（hy3/nemotron-ultra 24-27s）被压后、快模型（nemotron-3.5 3.7s）顶上，避免第二次提问因 20s+ 等待而"停止"。
- 请求打点：`src/routes.js` handler 按 stage 记录 `parsed/ordered/up-<model>/ttf-<model>`（相对请求起点 ms），随 `evt`/`logs.appendCall` 落入 events.log/calls.log；`src/upstream.js` 记录每次 attempt 的 `{attempt,type,ms}` 与总 `waitMs/totalMs` 挂到 `res._t`/`err._t`。排查耗时直接看这两类日志。
- 首块断路器 bug 教训：relay 返回值从 number 改成 `{status,ttfMs,totalMs,aborted}`，新增常量须在文件顶部定义（`ReferenceError: STREAM_TIMEOUT is not defined`/`ttf is not defined` 是作用域/未定义踩坑）；`upstream.body.cancel()` 用于超时释放流但不写 res（否则 `ERR_HTTP_HEADERS_SENT`）。
- workbuddy 自定义模型条目 id 会被当作 model 名原样发给 mslxdff → 会 failover 到上游不认识的假名（Nvidia 502）。若按真实模型命名（如 `deepseek-v4-flash-free`）则正常。