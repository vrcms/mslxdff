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
- 现网升级验证用 `npx -y mslxdff@<ver>`（锁版本、绕过 npx 缓存）；注意 mslxdff 不认 `--version`（会当普通启动跑 daemon），registry 验证用 `npm view mslxdff@<ver> version` + 拉 tarball 解包读 package.json 确认。
- 小改动直接落地不逐轮确认，涉及数据删除/架构大改/配置变更先确认；新功能增量落地，先提交当前版本再实现下一步，速度优化先在现有链路验证再扩展到备用上游。npm 发布不在本地直连（无手机提供 OTP），一律走 GitHub workflow 的 NPM_TOKEN 通道。
- 命令结果要紧凑，不贴大段 diff；重要结果先验证（端口监听+日志落盘）再让用户测；每次改动需经单元+集成+全量测试跑通才算完成。
- 讲解要用大白话，少堆术语，多讲“快了多少、怎么变的”直观结果而非实现细节。
- 用户偏好"显式语义清晰"的命令设计：`-leavegroup` 只用于组员离开，组长只能走 `-delgroup <name>` 解散组。
- 8989 是硬性默认端口；仅认 `-port N` 持久化或 `MSLXDFF_PORT` env，SSH/包装脚本注入的裸 `PORT` 被忽略。
- 深度思考被截断时不要自发压测，补细粒度日志（reqId/detail）后等用户复现。
- 慢模型不掐当前流：首块 25s 内到来即视为可用，后续无限等；stall 15s 仅作质量分（stallHits 累计数进 5 分钟降权），总耗时>20s 也降权；速度优先采用首块对冲，1秒未回即并发组员赛跑，现场谁快用谁。
- 指定模型 429 不可用时按延迟 EMA 择优切最快模型（nemotron-3.5 快、hy3/laguna 慢）。
- A 转发给 B 时上游应以 B 的出口 IP 访问 opencode.ai（分散免费池 IP 级限流）；扩展功能优先做成可配置常量/单一变量，避免硬编码，跨系统扩展先在 mslxdff 侧留稳定 hook 契约。

## 代码文件大小约束（强制）

- 大多数 `src/**/*.js` 源码文件请保持 **≤10KB**（约 300 行内）
- 单文件 **>20KB 必须着手拆分**：按职责拆成多个 js 模块，通过 entry-point 聚合（例：`src/routes/` 拆 `chat.js`/`groups.js`/`relay.js`，`src/upstream/` 拆 `client.js`/`headers.js`）
- 检查方式：`ls -lh src/**/*.js` 或 `wc -c src/**/*.js`；CI 可加 `find src -name "*.js" -size +20k` 告警
- 现状：`src/routes.js` 约 63KB 已超标，下一版本需优先拆分

## Learned Workspace Facts

- 端口优先级（`src/server.js resolvePort()`）：state.json 持久化 `port` > `MSLXDFF_PORT` env > 默认 8989；不再读裸 `PORT`。`-port N` 写 state 并触发 daemon 重启。
- 组命令语义：`-group list` 序号按 state 成员顺序（过滤 leader）固定渲染，`-group remove <seq>` 用同一顺序踢人（仅组长）；组长 `-leavegroup` 提示改用 `-delgroup`，`-delgroup` 在组员节点报错并提示该组由谁领导。
- 上游 opencode.ai 免费额度会 429 限流导致 failover：同一请求的模型可能被静默换成健康模型响应；用 `x-mslxdff-model-lock` 头可锁定模型拿到真实状态。
- 免费模型与匿名额外额度通道（hermes 调研，0.1.54 落地）：opencode-free 与 mslxdff 同走 `https://opencode.ai/zen/v1`，可匿名 `Authorization: ""` + hermes 头（`HTTP-Referer: https://hermes-agent.nousresearch.com` + `X-Title: Hermes Agent`）；UA 门禁——`big-pickle`/`mimo-v2.5-free` 需 `opencode` UA（hermes 用自身 UA 会 429），mslxdff UA=opencode 可过；`deepseek-v4-flash-free` 对 hermes 显示 unavailable。`src/upstream.js` public 429 + 是 free 模型 → 空头重试 `MSLXDFF_FREE_ANON_DELAY_MS`(1000ms)/`MSLXDFF_FREE_ANON_RETRIES`(3)，命中记当前目录 `free-anon-extra.txt`（gitignore，勿改路径），`MSLXDFF_FREE_ANON=0` 关闭。
- 服务器节点：i-69b368cf221da7821163239e（leader，port 8989）、172.93.221.187:8989、149.13.91.10:8989，组名 `my@mslxd`。
- 超时与慢模型机制（0.1.27~0.1.30 演进）：上游重试 `1次×100ms`（0.1.45 起 429/502/503/504 delayMs 500→100、network 1000→300）；`SLOW_TOTAL_MS` 默认 20s 超时标 `slow:true` 进 5 分钟长冷却（普通冷却 60s），`rankModels` 把 slow 排最后、过期自愈；`STREAM_TIMEOUT_MS` 25s 首块未到且未写字节才 failover，已写字节只能中断不换模型；`STALL_TIMEOUT_MS` 监测相邻 chunk 间隔（现默认 0 关闭，仅作 stallHits 质量分）；`MAX_STREAM_MS` 120s 防无限流；速度优先对冲（hedge） `MSLXDFF_HEDGE_DELAY_MS` 默认 1000ms（0/off 关闭），流式首块 1 秒未回即并发组员赛跑，`src/routes/hedge.js` + `chat.js` 首块对冲（`getReader`/`AsyncIterator` 双兼容 + `bufferedBody` + `flushHeaders`），赢家 `x-mslxdff-via` 标记。教训：新增常量须在文件顶部定义（曾踩 ReferenceError）；`upstream.body.cancel()` 释放流但不写 res（否则 ERR_HTTP_HEADERS_SENT）。chat.js 已拆分（0.1.46）：`src/routes/chat.js` 变门面，逻辑拆 `src/routes/chat/` 六文件（index/hedge-handler/local-handler/peer-handler/broadband-handler/exhausted-handler）全 <10KB，`find src -size +20k` 为空。
- Keep-Alive + 预热（0.1.42）：`src/upstream.js` 显式 `undici.Agent(keepAlive 30s/60s, connections 20)` + `dispatcher` 透传 chat/preheat；`srv.ready` 后 100ms 异步 `GET /zen/v1/models` 预热（`upstream-preheat` 事件）；`MSLXDFF_PREHEAT=0` 可关、`MSLXDFF_UPSTREAM_KEEPALIVE_*` 可调。npm undici 与 Node 内置 fetch 不兼容（`invalid onRequestStart`），必须配对 `UndiciFetch || fetch`；测试中 `createUpstreamClient` 的 Agent 需 `await client.close()` 否则多测试并发致 `fetch failed`。
- auto 首选模型（0.1.43）：`PREFERRED_MODEL = env MSLXDFF_PREFERRED_MODEL || "big-pickle"` 单点定义于 `src/auto.js`；排序优先级 `cooling > preferred > latency EMA > errAt`（preferred 强制第一，慢/429 冷却自动让位自愈）；`DEFAULT_AUTO_MODELS` 首位引用它并去重；测试需用 `tmpStateFile()` + `MSLXDFF_STATE_FILE` 隔离，否则污染 `modelLatencies` 致排序错乱。
- 插件系统（0.1.44 未发版）：插件目录 `~/.config/mslxdff/plugins/`（env `MSLXDFF_PLUGINS_DIR`），`.mjs` default export `{name,version,hooks,onEvent,createUpstream}`；hook 全表见 `docs/plugins.md`——请求链路 `request:received`(可短路)/`model:select`(可改序)/`model:beforeTry`(可跳过)/`upstream:request`(可改payload)，上游层 `upstream:headers`/`upstream:before-request`(可改URL+头)，旁路 `models:list`/`peer:*`/`server:start|stop`/`onEvent`；插件 `createUpstream(ctx)` 可整体替换上游 provider；`runHook` 语义=任何非 undefined 返回值生效且链式传递；错误全隔离只记日志；`x-mslxdff-model-lock` 时 model:select 不触发。
- 本机 daemon 启动方式：`Start-Process node bin/mslxdff.js --daemon`（直启 node，勿用 cmd /c 包装——会撞 daemon.log EBUSY 句柄占用）；pid/version 落 `~/.config/mslxdff/daemon.pid`。
- WorkBuddy（腾讯 CodeBuddy 系）支持插件：`.codebuddy-plugin/plugin.json` + `skills/<name>/SKILL.md`（兼容 `.workbuddy-plugin/`），本机已装 agent-browser/pdf 等 7 个官方插件于 `C:\Users\mslxd\.workbuddy\plugins\`；其自定义模型条目 id 会原样发给 mslxdff（假名会 failover 到上游 502，按真实模型命名则正常）；`mslxdff -setto workbuddy [modelId]` 原子写入 `~/.workbuddy/models.json`（仅认 127.0.0.1/v1，不含 localhost，存在更新 token/port，不存在插入），`src/sync-workbuddy.js` 4.6KB；SKILL.md 可教 AI 执行命令，是 mslxdff hook 契约的消费端。
- npm 发布链路（0.1.54 打通）：本地 token 直发被 EOTP 卡（账号 `tfa:false` 但后台仍要求 2FA，用户无手机无 OTP）；OIDC trusted publisher 即使仓库改 PUBLIC 仍 `E404 PUT /mslxdff Not found`；落地双通道 `.github/workflows/publish.yml`（OIDC `--provenance` continue-on-error + `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` fallback），最终 NPM_TOKEN fallback 成功，registry latest=0.1.54。发版=改 version→commit→push→`git tag v0.1.x && git push origin v0.1.x`（触发 `tags v*`）；Windows Git Bash 下 npm 输出乱码须 `cmd //c "npm ... 2>&1"` 才能读日志。
- 常用模型勾选集（modelPicks，0.1.55 落地）：state 存 `modelPicks` 数组（空=不启用，全量 auto）；`src/auto.js` `candidates()` 先按勾选集过滤候选池（勾选全失效自动回退全量），`candidatesFor()` 对显式指定的**真实上游模型**自动加入勾选（垃圾 id 不污染）；CLI：`-models` 交互式多选（空格勾选/Enter 保存）+ `-model pick <id>`/`-model unpick <id>`/`-model pick clear`/`-model picks`，`-model set <id>` 自动勾选，`-model list` 以 `*` 标注；`createAutoSelector` 的 `loadPicks`/`persistPicks` 默认在无 `file` 时为空/no-op（测试不污染真实 state）。