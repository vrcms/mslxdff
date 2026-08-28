# AGENTS.md

Strip-down of 9Router's **OpenCode Free** provider into a standalone OpenAI-compatible proxy.
The full implementation blueprint lives in `./CLAUDE.md` — **read it first**; it is authoritative and current.

## 命令执行规则（用户强制约定，必须遵守）

- **每次执行命令（Bash 工具）前，先输出当前时间**（如 `echo "[$(date +%H:%M:%S)] start"`），命令结束后输出结束时间（`status: $?`）。这样用户能直接看到你的命令耗时。
- **命令必须短、快、一次返回**：禁止把 `sleep`、后台进程（`&`）、长轮询、完整测试混进同一条命令制造"看似卡死"的假象。
- 启动长驻进程务必用 `Start-Process cmd.exe /c "... >> log 2>> err"`（见全局 CLAUDE.md），并在返回前必须验证：端口监听 + 最小请求日志落盘。
- 如果某条命令预计会跑很久（如全量测试），先单独执行，且设置合理超时；不要跟其他命令堆叠。

## 文档变更契约（强制，改功能必读）

- **`docs/ARCHITECTURE.md` 是长效架构总览 + 变更记账门**：任何新增/改动功能，都必须在其中更新对应章节（CLI 表 / Env 表 / 功能地图 / 目录导览 / 请求链路）。表格见该文件 §1。
- **结构性决策**（新模块、改请求链路、改存储 schema）额外追加 `docs/adr/` 新条目（当前最大 0007，下一个 0008），并在 ARCHITECTURE.md §8 索引登记。
- **检查**：改动涉及代码或文档后，跑 `npm run docs:check`（验证模块引用、ADR 索引、AGENTS.md 契约三件事）。CI/发布前必须通过。
- 写了新源文件记得补进 ARCHITECTURE.md §7 目录导览。

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
- 用户偏好显式语义：`-leavegroup` 只用于组员离开，组长走 `-delgroup <name>`；`-chat` 仅拦 `-uninstall`，`-stop`/`-port` 可直接执行。
- 8989 是硬性默认端口；仅认 `-port N` 持久化或 `MSLXDFF_PORT` env，SSH/包装脚本注入的裸 `PORT` 被忽略。
- 慢模型不掐当前流：首块 25s 内到即视为可用，后续无限等；stall 15s 仅作质量分，耗时>20s 降权；1秒未回即并发组员对冲，现场谁快用谁；指定模型 429 时按延迟 EMA 择优切最快模型。
- `-chat` 必须严格只用 `mimo-v2.5-free` 优先/`big-pickle` 兜底，不自增其他模型；模糊匹配（`hy3`→`hy3-free`）与命令精确性由大模型自行查 `cli_help_mini`+实时模型列表完成，不用代码归一。
- `cli_help.md`（人类详版）与 `cli_help_mini.md`（AI 精简版）为活文档，改任何 CLI 必须同步两者及 `ARCHITECTURE.md §6`；`read_file` 仅限项目内（`pkgRoot`/`logDir`/`stateDir`）。
- 上下文超长时由大模型摘要压缩（保留 `system`+最近 8 条，其余发 mimo 摘要成 `【历史摘要】`）；A 转发给 B 时上游以 B 出口 IP 访 opencode.ai 分散限流，扩展优先做可配置常量/单一 hook 契约。

## 代码文件大小约束（强制）

- 大多数 `src/**/*.js` 源码文件请保持 **≤10KB**（约 300 行内）
- 单文件 **>20KB 必须着手拆分**：按职责拆成多个 js 模块，通过 entry-point 聚合（例：`src/routes/` 拆 `chat.js`/`groups.js`/`relay.js`，`src/upstream/` 拆 `client.js`/`headers.js`）
- 检查方式：`ls -lh src/**/*.js` 或 `wc -c src/**/*.js`；CI 可加 `find src -name "*.js" -size +20k` 告警
- 现状：`src/routes.js` 约 63KB 已超标，下一版本需优先拆分

## Learned Workspace Facts

- 端口优先级（`src/server.js resolvePort()`）：state.json 持久化 `port` > `MSLXDFF_PORT` env > 默认 8989；不再读裸 `PORT`。`-port N` 写 state 并触发 daemon 重启。
- 组命令语义：`-group list` 序号按 state 成员顺序（过滤 leader）固定渲染，`-group remove <seq>` 用同一顺序踢人（仅组长）；组长 `-leavegroup` 提示改用 `-delgroup`，`-delgroup` 在组员节点报错并提示该组由谁领导。
- 上游免费池限流与锁定：opencode.ai 免费额度 429 会静默 failover 换模型，`x-mslxdff-model-lock` 可锁定；`src/upstream.js` 遇 free 模型 public 429 会匿名 hermes 重试（`MSLXDFF_FREE_ANON_RETRIES=3`/`DELAY=1000`，UA=opencode 才过，`big-pickle`/`mimo` 需此 UA），命中记 `free-anon-extra.txt`；`muse-spark*` 走 `POST /zen/v1/responses`（`zen /chat 500`，`responses 200`），`public→anon` 重试同步支持该路径，当前 JP 代理仍 500 需 US 出口
- 超时与对冲（hedge）机制：上游重试 `1次×100ms`，`SLOW_TOTAL_MS=20s` 标 slow 进 5 分钟冷却（普通 60s），`STREAM_TIMEOUT_MS=25s` 仅首块未到且未写字节才 failover，`STALL_TIMEOUT_MS=0` 仅质量分，`MAX_STREAM_MS=120s`；`MSLXDFF_HEDGE_DELAY_MS=1000` 时 1s 未回即并发组员赛跑（`hedge.js`+`routes/chat/` 6 文件均 <10KB，`getReader`/`AsyncIterator` 双兼容），赢家 `x-mslxdff-via`。
- Keep-Alive + 预热：网关 `undici.Agent(keepAlive 30s/60s, connections 20)` 显式复用，`srv.ready` 100ms 后预热 `GET /zen/v1/models`；`-chat` 前台改 `keepAlive:false + fetchImpl:globalThis.fetch` 绕开 TUN 代理下 `undici` 复用连接被静默关闭致 `mimo` 中文 30s 超时，直走系统代理；`MSLXDFF_PREHEAT=0` 可关
- 模型排序与勾选集：`PREFERRED_MODEL = env MSLXDFF_PREFERRED_MODEL || "big-pickle"` 单点于 `src/auto.js`，排序 `cooling > preferred > latency EMA > errAt`；`modelPicks` 空=不筛选，`candidates()` 按勾选过滤、勾选全失效回退全量，`candidatesFor()` 对真实上游模型自动入 picks；`-models` 交互多选 + `-model pick/unpick/clear/picks`，`-model set` 自动勾选，`*` 标注。
- 插件系统：`~/.config/mslxdff/plugins/`（`MSLXDFF_PLUGINS_DIR` 覆盖），`.mjs` 导出 `{name,version,hooks,onEvent,createUpstream}`，hook 含 `request:received`/`model:select`/`model:beforeTry`/`upstream:*`/`models:list`/`peer:*`/`server:*`，`runHook` 链式传递、错误隔离，`x-mslxdff-model-lock` 时 `model:select` 不触发。
- 多供应商 Provider（0.1.56）与瞬时共享（0.1.57）：`src/providers/` 每供应商一文件（`opencode.js`/`openrouter.js`/`dispatcher.js`/`model-id.js`/`share-keys.js`/`keyring.js`），前缀路由 `<provider>/raw`（裸 id 归 opencode），`dispatcher` 剥前缀转发；`providerKeys: {id:[k1,k2]}` round-robin 30s 冷却（`MSLXDFF_OPENROUTER_COOLDOWN_MS`），`shareKeys` via `x-mslxdff-share-keys` 瞬时借用且 opencode 恒排除；当前 `openrouter` 无 key（`state.json` 与 `MSLXDFF_OPENROUTER_KEY` 均空）
- CLI 活文档：`cli_help.md`（人类详版 41KB）与 `cli_help_mini.md`（AI 精简版 4.3KB）双镜像于根/`docs/`，改 CLI 必同步两者及 `ARCHITECTURE.md §6`；`npm run docs:check` 校验模块/ADR 双向一致，ADR 已至 0009。
- 对话终端 `-chat`（0.1.58.2）：`src/chat/` 7 文件均 <10KB（`repl 9.2KB`+`stats 6.4KB`），`stats` 网关 `-d` 视角（标题“数据来自 -d 网关进程”、`collectStats` 读 `modelLatencies/calls.log/errors.log`），严格仅 `mimo-v2.5-free` 优先/`big-pickle` 兜底；工具 `run_command` 仅拦 `-uninstall`、`read_file` 限 `pkgRoot/logDir/stateDir`（已移除 `cwd`）、`curl` 探活；历史 `~/.config/mslxdff/chat-history.json` 超 18000 字符保留 `system`+最近 8 条、其余 mimo 摘要；`maybeCompress` 返拷贝已修 400
- 本机 daemon 与外部联动：`Start-Process node bin/mslxdff.js --daemon` 直启 node（勿 `cmd /c` 包装防 EBUSY），pid/version 落 `~/.config/mslxdff/daemon.pid`；`mslxdff -setto workbuddy [modelId]` 原子写 `~/.workbuddy/models.json`（仅 127.0.0.1/v1）；npm 发布走 GitHub workflow 双通道（OIDC + `NPM_TOKEN` fallback），发版 `改 version→commit→push→tag v* → push tag`，Windows 下 `cmd //c "npm ... 2>&1"` 读日志。
- 常用测试隔离：`tmpStateFile()` + `MSLXDFF_STATE_FILE` 隔离 `modelLatencies`/`modelPicks`，`createModelsService` 的 `loadPicks`/`persistPicks` 无 `file` 时为 no-op；`find src -size +20k` 为空，单文件超 20KB 必须拆分。