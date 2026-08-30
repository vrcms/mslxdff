# mslxdff CLI 完整参数手册

> **活文档**：本文件与 `bin/mslxdff.js`、`docs/ARCHITECTURE.md §6` 同为单一事实源。
> **新增或改动任何 CLI 参数，必须同步更新本文件**（否则视为未完成）。检查：`npm run docs:check` 会校验 `ARCHITECTURE.md` 的 CLI 表与实现一致，本文件需人工保持与之同步。
> 适用版本：`>=0.1.60`（含 WorkBuddy 供应商 + 每日 100 credits 签到）。最后更新：2026-08-28。

## 目录

- [0. 约定与通用规则](#0-约定与通用规则)
- [1. 速览表](#1-速览表)
- [2. 启动与生命周期](#2-启动与生命周期)
- [3. 状态与诊断](#3-状态与诊断)
- [4. 认证与端口](#4-认证与端口)
- [5. 模型管理](#5-模型管理)
- [6. 供应商 Provider](#6-供应商-provider)
- [7. 外部同步（WorkBuddy / opencode）](#7-外部同步workbuddy--opencode)
- [8. 群组网络](#8-群组网络)
- [9. 帮助](#9-帮助)
- [附录 A 环境变量](#附录-a-环境变量)
- [附录 B 状态文件](#附录-b-状态文件)
- [附录 C 退出码与提示](#附录-c-退出码与提示)
- [附录 D 交互式终端说明](#附录-d-交互式终端说明)

---

## 0. 约定与通用规则

- **单/双横线等价**：`-status` 与 `--status` 完全等价（源码用 `args.includes("-status") || args.includes("--status")` 判断）。下表只写一遍，别名在“别名”列注明。
- **大小写敏感**：模型 id、group 名、`-provider` 的 id 均大小写敏感。
- **参数顺序**：多数命令不强制顺序，但子命令紧跟主参数（如 `-provider openrouter list` 的 `list` 必须在 id 之后）。
- **TTY 判定**：部分命令在 `process.stdin.isTTY && process.stdout.isTTY` 时进入交互式（` -models`/ `-provider <id>` 空参），非 TTY（管道/脚本/CI）则走非交互分支或报错提示用法。
- **状态持久化**：`token`/`port`/`preferredModel`/`modelPicks`/`providerKeys`/`providerShareKeys`/`groupsJoined` 等写入 `MSLXDFF_STATE_FILE`（默认 `~/.config/mslxdff/state.json`，`0600` 权限）。热数据（`modelErrors`/`modelLatencies`/`peerErrors`）500ms 批量刷盘，冷数据立即落盘。
- **裸 `PORT` 被忽略**：只认 `MSLXDFF_PORT` 环境变量或 `-port N` 持久化，不读裸 `PORT`（见 `AGENTS.md`）。
- **帮助优先级最高**：只要参数中出现 `-help/--help/-h`，立即打印帮助并 `exit 0`，不执行其他命令。

---

## 1. 速览表

| 命令 | 别名 | 作用一句话 | 是否写 state | 是否需 daemon 运行 |
|---|---|---|---|---|
| `mslxdff` | — | 无参：daemon 已在且版本一致→显示 status+help；否则以后台 daemon 启动并退出（npx 友好） | 否 | 否 |
| `mslxdff -d` | `--daemon` | 以 detached 后台进程启动 daemon，等待 `/health` | 否 | 否 |
| `mslxdff -status` | `--status`, `-s` | 打印 daemon/health/port/config、upstream providers（启用/key/baseUrl/allowlist/share）、models（free 缓存/preferred/picks + 体检表 avg首字/tps/啰嗦/p95）、autostart/plugins、群组/failover、recent calls(含 ttfb/tps/tok)、last error | 否 | 否（未运行时也打印，health 显示 fail） |
| `mslxdff -log [N]` | `--log`, `-logs`, `--logs` | 显示最近 N 条事件（默认 10），并提示其他日志路径 | 否 | 否 |
| `mslxdff -debug` | `--debug` | 停掉后台 daemon，前台运行并实时打印事件流；Ctrl+C 恢复后台 | 清空旧日志 | 会停旧 daemon |
| `mslxdff -plugins` | `--plugins` | 列出插件目录与已识别插件及其 hooks，不启动 daemon | 否 | 否 |
| `mslxdff -stop` | `--stop` | 停止 daemon | 否 | 需运行 |
| `mslxdff -uninstall` | `--uninstall` | 停 daemon 并删除 state/pid/log/calls/errors/events 文件，提示 `npm uninstall -g` | 删文件 | — |
| `mslxdff -port N` | `--port N` | 持久化监听端口到 state，运行中则重启 daemon | 是（`port`） | 重启 |
| `mslxdff -showtoken` | `--showtoken` | 打印当前 Bearer token | 首次会生成 | 否 |
| `mslxdff -refresh-token` | `--refresh-token` | 轮换 token 并打印新值 | 是（`token`） | 否 |
| `mslxdff -update` | `--update` | 查询 npm `latest`，若有新版则 `npm install -g` 并重启 daemon | 否 | 重启若有更新 |
| `mslxdff -models` | — | 交互式多选：空格勾选常用模型，Enter 保存到 `modelPicks`；非 TTY 则纯列表 | 是（`modelPicks`） | 否 |
| `mslxdff -model list` | `-models` 同 | 列出免费模型（每次 4s 超时尝试刷新，失败回退缓存） | 否 | 否 |
| `mslxdff -model set <id>` | — | 设默认模型 `preferredModel`，并自动加入 `modelPicks` | 是 | 热重载 |
| `mslxdff -model status` | — | 显示每模型健康状态 normal/limit/error + 时间 + HTTP 码 | 否 | 否 |
| `mslxdff -model refresh` | — | 强制从上游拉取模型列表并更新缓存 | 是（cacheFile） | 否 |
| `mslxdff -model pick <id>` | — | 勾选一个模型到 `modelPicks` | 是 | — |
| `mslxdff -model unpick <id>` | — | 从 `modelPicks` 移除 | 是 | — |
| `mslxdff -model picks` | — | 列出当前勾选集 | 否 | — |
| `mslxdff -model pick clear` | — | 清空勾选集（auto 回退全量） | 是 | — |
| `mslxdff -provider add <id> <baseUrl> <key>` | `--provider` | 一键添加通用 OpenAI 兼容供应商（`providerConfigs`，前缀路由 `<id>/model`） | 是 | 重启生效 |
| `mslxdff -provider add workbuddy https://copilot.tencent.com <key> [allow...]` | `--provider` | 添加 WorkBuddy 专用供应商（`providerConfigs.workbuddy={baseUrl,keys,auths}`，`workbuddy/hy3` 前缀路由，走 `workbuddy-token-auto.js` 自动落盘 `auths`） | 是 | 重启生效 |
| `mslxdff -provider <id> ...` | `--provider` | 配置需鉴权供应商的 API keys/地址（多 key 轮转、set-url 改地址）及共享开关 | 是 | 重启生效 |
| `mslxdff -provider <id> allowlist ...` | `--provider` | 管理供应商模型白名单（空=阻塞除非 `allowAny on`，非空仅名单内可用，防昂贵模型） | 是 | 热更新立即生效 |
| `mslxdff -provider <id> allowAny on\|off` | `--provider` | 空 allowlist 时放行或阻塞（默认 `OFF`，`opencode` 例外 `ON`） | 是 | 热更新立即生效 |
| `mslxdff -providers list` | `--providers`, `-provider list` | 列出所有已部署上游供应商（opencode/openrouter/通用/workbuddy）及启用状态（含 allowlist 摘要） | 否 | 否 |
| `mslxdff -workbuddy checkin` | `-wb checkin`, `--workbuddy checkin` | WorkBuddy 每日签到 100 credits（多号并行 3，双域 `POST /v2/billing/meter/daily-checkin` 幂等，`code 10001 已签到` 视为成功；`--json` 聚合 `total/dailyPacks/nextExpire`，`workbuddy-checkin.js` 代理，`node workbuddy-token-auto.js` 已自动触发） | 否 | 否 |
| `mslxdff -workbuddy balance [--json]` | `-wb balance` | WorkBuddy 多号余额总览（`total/dailyPacks/nextExpire/fetchedAt`，`workbuddy-balance.js` TTL 5min） | 否 | 否 |
| `mslxdff -workbuddy list` | `-wb list` | 列出已接入 WorkBuddy 账号（`uid/domain/enterpriseId`） | 否 | 否 |
| `mslxdff -workbuddy remove <uid> [--keep-file]` | `-wb remove` | 按 `uid`（全等或前缀 6 位）摘除账号（删 `keys/auths` 与 `auths/workbuddy-<uid>.json`，清 `balanceCache`） | 是 | 重启生效 |
| `mslxdff -setto workbuddy [modelId]` | `--setto` | 设默认模型并原子写入 `~/.workbuddy/models.json`（仅 127.0.0.1/v1） | 是 | 热重载 |
| `mslxdff -free` | `--free`, `-free-check`, `--free-check` | V2EX 白嫖雷达（仅 V2EX 单源）：拉 `latest.json + hot.json` 按 `白嫖|限免|免费额度|注册送|羊毛` 过滤 | 否 | 否 |
| `mslxdff -enable-autostart` | `--enable-autostart` | 开机自启：注册 Windows 任务计划 / Linux systemd user（重启后自动拉起） | 否 | 否 |
| `mslxdff -disable-autostart` | `--disable-autostart` | 关闭开机自启 | 否 | 否 |
| `mslxdff -autostart status` | `--autostart status` | 查看自启状态（已启用/未启用 + 任务/注册表路径） | 否 | 否 |
| `mslxdff -free-watch` | `--free-watch` | V2EX 白嫖雷达 watch 模式（每 5 分钟轮询，前台常驻） | 否 | 否 |
| `mslxdff -setto opencode [modelId]` | `--setto` | 把本地网关注册为 opencode 供应商（`provider.mslxdff`，`http://127.0.0.1:<port>/v1`，默认 `mslxdff-<id>` alias 防重名，原名仍兼容，重复幂等） | 是（`opencode.json`） | 热重载 |
| `mslxdff -creategroup <name>` | `--creategroup`, `-group create <name>` | 在本节点创建群组（组名即密码，本节点为 leader） | 是（`groups`+`groupsJoined`） | 否 |
| `mslxdff -addtogroup <host> <name> [--broadband]` | `--addtogroup` | 以成员身份加入远端 leader 的群组；`--broadband` 为宽带中继模式 | 是（`groupsJoined`） | 否 |
| `mslxdff -group sync` | `--group sync` | 刷新所有已加入群组的成员列表到本地 failover peers | 否 | 否 |
| `mslxdff -group leave <name>` | — | 成员侧离开单群组（本地移除） | 是 | — |
| `mslxdff -group list` | — | 列出本节点群组与成员（带健康探测与序号，宽带显示 via leader） | 否 | — |
| `mslxdff -group remove <seq>` | — | 仅 leader：按 `list` 序号踢出成员（1-based，排除 leader） | 是（`groups`） | 需 leader |
| `mslxdff -leavegroup` | `--leavegroup`, `-leave-groups` | 成员侧离开所有已加入群组（跳过 leader 组并提示用 `-delgroup`） | 是 | — |
| `mslxdff -delgroup <name>` | `--delgroup` | 仅 leader：解散本节点领导的群组 | 是 | 需 leader |
| `mslxdff -resetban [ip]` | `--resetban` | 清除加群失败封禁（全清或按 ip） | 是（`bans`） | 否 |
| `mslxdff -chat ["prompt"]` | `--chat` | 对话终端：mimo 优先/big-pickle 兜底，模糊匹配由模型完成，历史持久化超长压缩，仅拦 -uninstall，daemon 重启不影响 | 是（`chat-history.json`） | 否（独立进程） |
| `mslxdff -help` | `--help`, `-h` | 打印帮助 | 否 | 否 |

---

## 2. 启动与生命周期

### `mslxdff`（无参）

- **语法**：`mslxdff`
- **作用**：最常用的“裸跑”入口。行为分两支：
  1. 若 daemon 已在运行且版本一致（`pidFile` 存在、`isPidAlive(pid)` 且 `readPidVersion() === VERSION`）：打印 `printStatus()` + `printHelp()` 后退出，不另起进程。
  2. 否则：以后台 detached 进程启动 daemon（`startDaemon([])`），等待 `/health` 就绪（4s），打印 `vX.Y.Z started as a background daemon`、`endpoint`、`log`、`pid` 后退出。**绝不驻留终端**，npx 友好。
- **示例**：
  ```bash
  mslxdff
  # → mslxdff v0.1.57 listening ... / 已运行时显示 status
  ```

### `-d` / `--daemon`

- **语法**：`mslxdff -d` 或 `mslxdff --daemon`
- **作用**：显式以后台 daemon 启动。会先执行 `stopDaemonIfOutdated()`（版本不一致则停旧 daemon），`spawn detached` 后等待健康检查。
- **环境**：子进程带 `MSLXDFF_DAEMON=1` 标记；父进程等待后打印 `daemon started (pid XXX)`、`log`、`pid`。
- **与其他参数混用**：`startDaemon` 会过滤掉 `-d/--daemon` 再透传其余参数（如 `-port 8989`）。
- **示例**：
  ```bash
  mslxdff -d
  mslxdff --daemon -port 9090
  ```

### `-port N` / `--port N`

- **语法**：`mslxdff -port <N>` / `mslxdff --port <N>`
- **作用**：持久化监听端口到 `state.json` 的 `port` 字段。
- **行为**：
  - 校验：必须为整数 `1..65535`，否则 `invalid port` 并 `exit 1`。
  - 若 daemon 正在运行：`setPort(port)` → `stopDaemon()` → `startDaemon(["-port", String(port)])` → 等健康 → 打印 `restarted on port N (pid XXX)` 与 `endpoint`。
  - 若未运行：仅 `setPort(port)`，打印 `port saved: N (daemon not running; takes effect on next start)`。
- **优先级**：`state.json port` > `MSLXDFF_PORT` env > 默认 `8989`（`src/server.js resolvePort()`）。裸 `PORT` 忽略。
- **示例**：
  ```bash
  mslxdff -port 8989
  mslxdff -port 9090
  ```

### `-stop` / `--stop`

- **语法**：`mslxdff -stop`
- **作用**：停止后台 daemon（`stopDaemon()` 读 `daemon.pid` 并 `kill`）。
- **输出**：
  - 成功：`mslxdff daemon stopped (pid XXX)`
  - 未运行：`mslxdff daemon not running`（若有原因则带 `reason`）。
- **示例**：`mslxdff -stop`

### `-uninstall` / `--uninstall`

- **语法**：`mslxdff -uninstall`
- **作用**：先尝试 `stopDaemon()`，再删除以下文件（`rmSync {force:true}`）：
  - `stateFile`（`MSLXDFF_STATE_FILE`）
  - `pidFile()`、`logFile()`（daemon pid 与日志）
  - `<daemonDir>/calls.log`、`errors.log`、`events.log`
- **输出**：`removed N file(s): ...` 或 `no state/log files to remove`，最后提示：
  ```
  package still installed — finish with:
    npm uninstall -g mslxdff
  ```
- **注意**：不会自动执行 `npm uninstall -g`，需手动完成。

### `-update` / `--update`

- **语法**：`mslxdff -update`
- **作用**：自更新到 npm 已发布的最新版。
- **流程**：
  1. `npm view mslxdff dist-tags.latest --json` 查询 `latest`（Windows 走 `npm.cmd` + `shell:true`）。
  2. 解析版本号，`compareSemver(latest, VERSION) <= 0` 则 `already up to date` 退出。
  3. 否则 `npm install -g mslxdff@latest`（`stdio: inherit`），若 daemon 在运行则 `stopDaemon()` → `startDaemon([])` → 等健康 → `restarted (pid XXX)`。
- **示例**：`mslxdff -update`

---

## 3. 状态与诊断

### `-status` / `--status` / `-s`

- **语法**：`mslxdff -status` / `mslxdff --status` / `mslxdff -s`
- **作用**：只读聚合展示当前节点全貌（不启 daemon）。依次打印（v0.1.60 起大幅增强，原仅 daemon/模型/调用）：
  - `mslxdff vX.Y.Z`、`daemon` 是否运行（pid + uptime + version ok）、`endpoint` + `health` 探活（ok/fail + ms）、`config`（port 来源 persisted/env/default + state/log 路径 + bind host）
  - `upstream providers`：所有已配置供应商（`opencode` 恒 enabled 无需 key + `openrouter`/`workbuddy`/通用 `providerConfigs.<id>`），每行 `●/○ enabled/disabled  keys/acc  allow  baseUrl  share` + 备注（测试桩/缺 key 等），0 enabled 时提示加 `mslxdff -provider add` 或 `node workbuddy-token-auto.js`（`providerRows` 聚合 `loadProviderConfigs+Keys+BaseUrl+Allow+Share`，workbuddy `k-new` stub 特殊识别）
  - `models`：`models.json` free 数 + 缓存时间/age、`preferred`（含 avg首字/tps/次数）、`picks`（勾选集，空=全量）、`free list`（每模型 `fmtStatus` + avg首字/tps/次数，<10ms 视为测试数据隐藏）、`模型体检 TopN`（`modelStats` 按次数排序的 `avg首字/总耗时/速度/啰嗦/样本/p95`，<10ms 隐藏，仅样本>0）
  - `autostart`：`getAutostartStatus()` 的 `detail` + `task/unit`，含 `mslxdff -autostart status` 提示
  - `plugins`：`resolvePluginDirs+loadPlugins` 的 `plugins.length` 与每插件 `name@version [hooks]` 或 `none` 提示
  - `joined groups`：每个已加入群组的 `name`、`leaderUrl`、成员列表（同前）
  - `failover targets`：`peers.all()` 列表（同前），空时提示 `failover: (none — 加组后自动出现)`
  - `groups on this node`：本节点作为 leader 创建的组名
  - `recent calls:`：`(gateway 持久化，最近5条，含首字/tok/s)` 头 + avg + 每行 `ts/model/status/dur+ttfb+tps/tok`（来自 `recentCalls(5)` 的 `ttfbMs/tps/usage`，v0.1.59 起记录）
  - `last error`：`lastError()` 的 `ts/model/status/message`（无则 `none — 暂无错误`）
  - 额外：`auth token: use mslxdff -showtoken` + `health: http://127.0.0.1:<port>/health` 或 `not running — start with: mslxdff -d` + `hints: mslxdff -providers list · mslxdff -model status ...`
  - 体验：空状态有明确提示（如 `models: not cached yet`、`recent calls: (none yet — 发一次请求后出现)`、`plugins: (none) — 放 *.mjs ...`），`health` 探测失败有 `health fail (…)`，测试桩 `workbuddy k-new` 标 `disabled (测试桩…)`
- **实现**：`createGroupsService` + `loadGroupsJoined`，成员通过 `refreshGroupMembers`（1.5s 超时）拉取。
- **示例**：`mslxdff -status`

### `-log [N]` / `--log [N]` / `-logs [N]` / `--logs [N]`

- **语法**：`mslxdff -log [N]`（`N` 可选正整数，默认 `10`）
- **作用**：显示最近 `N` 条事件（读 `eventsFile()`，`recentEvents(count)`），并打印：
  - `log dir: ...`、`events: ...`
  - `--- last X event(s) ---` + 每行 `fmtEvent(e)`（见 `fmtEvent` 的 `type` 分支）
  - 当 `count <= 10` 时额外提示：`hint: mslxdff -log 100 | calls: ... errors: ... daemon: ...`
- **参数解析**：`args[ idx+1 ]` 转 `Number`，仅当整数且 `>0` 时取用，否则默认 10。
- **示例**：
  ```bash
  mslxdff -log        # 最近 10 条
  mslxdff -log 100    # 最近 100 条
  mslxdff --logs 50
  ```

### `-debug` / `--debug`

- **语法**：`mslxdff -debug`
- **作用**：进入前台调试模式，实时跟随事件流。
- **流程**：
  1. `stopDaemon()` 停旧 daemon（若有则打印 `[debug] stopped background daemon (pid XXX)`）
  2. 清空旧日志：`eventsFile()`、`callsFile()`、`errorsFile()`、`logFile()` 写空（计数并打印 `已清理旧日志 X 个文件 (dir)，本次会话干净输出`）
  3. 打印 `--- live (Ctrl+C: stop debugging and restore background daemon) ---`
  4. 置 `MSLXDFF_DEBUG=1`、`MSLXDFF_DAEMON=1`，**不退出**，落入 daemon 主体（`bus.subscribe(e => console.log(fmtEvent(e)))`）
  5. 监听 `SIGINT/SIGTERM`：`restore()` → `startDaemon([])` 恢复后台 → `setTimeout(exit,300)`
- **注意**：`-debug` 会清日志，适合排障时“干净输出”。退出调试务必 `Ctrl+C`，不要直接 `kill -9`。
- **示例**：`mslxdff -debug`

### `-plugins` / `--plugins`

- **语法**：`mslxdff -plugins`
- **作用**：不启动 daemon，仅列出插件目录与已识别插件。
- **输出**：
  ```
  plugin dirs:
    [official (bundled)] /path/to/pkg/plugins
    [user] ~/.config/mslxdff/plugins
    hello@1.0.0  [server:start]  (user)
      我的第一个 mslxdff 插件
    load error: bad.mjs — ...
  ```
  无插件时提示：`(no plugins — drop *.mjs files into a dir above, see docs/plugins.md)`。
- **目录解析**：`resolvePluginDirs({ pkgRoot })` 返回 `[pkg/plugins, userPlugins]`；若 `MSLXDFF_PLUGINS_DIR` 设了则只扫该目录。
- **示例**：`mslxdff -plugins`

---

## 4. 认证与端口

### `-showtoken` / `--showtoken`

- **语法**：`mslxdff -showtoken`
- **作用**：打印当前 `Authorization: Bearer <token>` 的 token 明文（`loadToken()`）。
- **副作用**：若 `state.json` 尚无 token，会生成一个（`randomBytes(32).hex`）并落盘。
- **示例**：`mslxdff -showtoken`

### `-refresh-token` / `--refresh-token`

- **语法**：`mslxdff -refresh-token`
- **作用**：轮换 token（`refreshToken()` 生成新 64 hex 并 `createdAt` 落盘），打印新 token。
- **影响**：所有客户端需更新 `Authorization` 头；daemon 热重载下次请求即生效。
- **示例**：`mslxdff -refresh-token`

### `-port N` 参见 [2. 启动与生命周期](#2-启动与生命周期)

---

## 5. 模型管理

> 模型 id 说明：裸 id（如 `big-pickle`）恒指默认供应商 `opencode`；带前缀的 id（如 `openrouter/google/gemma-3-27b-it:free`）路由到对应供应商。`auto` 为特殊 id，表示“让 mslxdff 自动选最快可用模型”。

### `-models`（交互式多选，TTY 专属）

- **语法**：`mslxdff -models`（无子命令）
- **作用**：交互式勾选常用模型集合 `modelPicks`。`modelPicks` 为空表示“不筛选，全量 auto”。
- **交互**（仅 TTY）：
  - `↑/↓` 移动光标，`Space` 勾选/取消，`Enter` 保存，`q/Esc` 取消（`picks 不变`）。
  - 初始光标在当前首选模型 `getPreferredModel()` 所在行；已勾选项带 `picked` 标记。
  - 保存：`saveModelPicks([...result])`，打印 `saved N picked model(s): ...` 或 `(none — auto uses full list)`。
  - 取消：`cancelled — picks unchanged`。
- **非 TTY 行为**：等价于 ` -model list` 的纯列表分支（带 `*` 标注已勾选），不进入交互。
- **前置**：每次执行都会 4s 超时尝试刷新模型列表（`tryRefreshModels()`），成功则用新列表，失败回退 stale 缓存。
- **示例**：
  ```bash
  mslxdff -models
  # → ↑/↓ 移动  Space 勾选  Enter 保存
  ```

### `-model list` / `-models`（非交互列表）

- **语法**：`mslxdff -model list` 或 `mslxdff -models`（非 TTY）
- **作用**：列出当前代理对外暴露的免费模型（已过滤，仅 free）。每次都尝试刷新，4s 超时失败则回退缓存；无缓存且刷新失败则 `no cached models and refresh failed`。
- **输出**：
  ```
  8 free model(s) (cached 2026-08-27 14:00) (2 picked, * = picked):
    * big-pickle
      deepseek-v4-flash-free
  picked only constrains auto; manage with: ...
  ```
- **示例**：`mslxdff -model list | cat`（非 TTY 强制列表）

### `-model set <id>`

- **语法**：`mslxdff -model set <id>`
- **作用**：设默认（首选）模型 `preferredModel`，并**自动加入**勾选集（`modelPicks` 去重）。
- **校验**：`<id>` 不能为空；`normalizeModel(raw)` 为空则报错。
- **输出**：
  ```
  default model set to: <id> (daemon hot-reloads on next request)
  picked: <id1>, <id2> (auto will pick within these)
  ```
- **示例**：
  ```bash
  mslxdff -model set big-pickle
  mslxdff -model set openrouter/google/gemma-3-27b-it:free
  ```

### `-model status`

- **语法**：`mslxdff -model status`
- **作用**：显示每模型的健康状态（读 `loadModelErrors()` + `models.json` 缓存的并集）。
- **状态值**：`normal` / `error` / `limit` 等（`e.status`），兼容旧版纯 `number`（时间戳）存储。
- **输出**：`id  status  (MM-DD HH:MM:SS)  HTTP code`
- **示例**：`mslxdff -model status`

### `-model refresh`

- **语法**：`mslxdff -model refresh`
- **作用**：强制从上游拉取最新免费模型列表并更新缓存（`cacheFile: <logDir>/models.json`，`refreshMs: 0`）。
- **成功**：`refreshed: N free model(s)` + 每行 id。
- **失败**：`could not refresh models: ...` 并 `exit 1`。
- **示例**：`mslxdff -model refresh`

### `-model pick <id>` / `-model unpick <id>` / `-model picks` / `-model pick clear`

- **语法**：
  ```bash
  mslxdff -model pick <id>        # 勾选一个模型（去重）
  mslxdff -model unpick <id>      # 取消勾选一个模型
  mslxdff -model picks            # 列出当前勾选集
  mslxdff -model pick clear       # 清空勾选集，auto 回退全量
  ```
- **作用**：非 TTY 场景下管理 `modelPicks`。`saveModelPicks([...new Set([...loadModelPicks(), id])])`。
- **输出**：
  ```
  picked: a, b (auto will pick within these)
  # 或
  picked: (none) (auto uses full list)
  # 或
  picks cleared — auto uses the full model list again
  ```
- **候选约束**：`src/auto.js candidates()` 先按勾选集过滤候选池；勾选全失效（全被冷却/下线）则自动回退全量。
- **示例**：
  ```bash
  mslxdff -model pick big-pickle
  mslxdff -model pick openrouter/google/gemma-3-27b-it:free
  mslxdff -model picks
  mslxdff -model unpick big-pickle
  mslxdff -model pick clear
  ```

### 模型连通性探活（给 `mslxdff -chat` 的 Agent 看，禁止幻觉命令）

> **唯一正确方式**：`curl` 直连本机网关 `POST /v1/chat/completions`，自动带 `Authorization: Bearer $(mslxdff -showtoken)`。**严禁** `mslxdff "hi" --model X` / `mslxdff --model X "hi"` / `mslxdff -chat --model X` 等不存在的命令（CLI 无此参数，执行只会输出 `mslxdff vX.Y.Z` 状态页）。

- **语法（curl 工具）**：
  ```json
  {
    "url": "http://localhost:8989/v1/chat/completions",
    "method": "POST",
    "headers": {"Content-Type":"application/json"},
    "body": "{\"model\":\"<provider/模型>\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}"
  }
  ```
  等价 shell：
  ```bash
  curl -H "Authorization: Bearer $(mslxdff -showtoken)" \
       -H "Content-Type: application/json" \
       http://127.0.0.1:8989/v1/chat/completions \
       -d '{"model":"clinebot/z-ai/glm-5.3-flash","messages":[{"role":"user","content":"hi"}],"stream":false}'
  ```
- **模型 id 精确匹配**：`clinebot/z-ai/glm-5.3-flash`、`clinebot/deepseek/deepseek-v4-flash`、`workbuddy/hy3` 等必须与 `mslxdff -providers list` / `GET /v1/models` 的 `id` 完全一致（含前缀）。
- **结果判读**：
  - `200 + x-mslxdff-via: local` → 通，`body` 含 `choices[0].message.content` 与 `usage.cost`
  - `401 {"error":"Unauthorized"}` + `www-authenticate: Bearer` → 本机 token 陈旧（`state.json` 改动后未重启），提示用户 `mslxdff -stop && mslxdff` 重启 daemon
  - `403 {"error":"model not allowed…"} + x-mslxdff-allowlist:1` → `allowlist` 未放行，需 `mslxdff -provider <id> allowlist add <model>` 或 `allowAny on`
  - `429/5xx` → 上游限流/故障，走冷却与转发兜底
- **与 `-chat` 的区别**：`-chat` 的 `mimo-v2.5-free → big-pickle` 是**直连上游** `https://opencode.ai/zen/v1/chat/completions`（`createUpstreamClient`），不经本地网关；探活 `clinebot/*` / `workbuddy/*` 必须经本地网关 `curl`，不能用 `run_command` 拼 CLI。
- **反例（禁止）**：
  ```bash
  mslxdff "hi" --model clinebot/z-ai/glm-5.3-flash   # ❌ 输出 status 页
  mslxdff --model clinebot/z-ai/glm-5.3-flash "hi"  # ❌ 同上
  mslxdff -chat --model clinebot/z-ai/glm-5.3-flash # ❌ -chat 无 --model 参数
  ```

---

## 6. 供应商 Provider

> 多供应商架构（ADR-0007 + 通用 0.1.59）：`opencode` 为默认供应商（裸 id，向后兼容，恒启用，无 key）；其他供应商带 `<provider>/` 前缀（如 `openrouter/google/gemma:free` / `myapi/gpt-4`），按前缀路由并在转发前剥回原始 id。已实现 `openrouter`（匿名可拉 `GET /api/v1/models`，chat 必须有 key）与通用 OpenAI 兼容供应商（`providerConfigs.<id>={baseUrl,keys}`，`mslxdff -provider add <id> <baseUrl> <key>` 一键添加）。

### `-provider add <id> <baseUrl> <key>` / `-provider <id> [key...|add|remove|list|clear|share|set-url]`

#### 通用语法

```bash
mslxdff -provider add <id> <baseUrl> <key>          # 一键添加通用 OpenAI 兼容供应商
mslxdff -provider <id> [key...|add|remove|list|clear|share|set-url]
# 别名：--provider
# id 归一化：toLowerCase + 非字母数字转 _
# 特殊：opencode / oc 恒提示“无需 key、永不共享”并直接退出
```

#### 无子命令（交互式隐藏输入）

- **触发**：`mslxdff -provider <id>` 且 `isTTY`。
- **行为**：提示 `Enter <id> API keys, one per line (input hidden). Blank line to finish:`，逐行 `rl.question`（隐藏），空行结束。逐一 `addProviderKey(id, k)` 追加到现有 keys，不覆盖。
- **成功**：`added N <id> API key(s) (now M total) — restart daemon to activate`
- **空输入**：`empty input — nothing changed`
- **非 TTY 且无 key 参数**：报错 `provide keys inline (non-TTY): mslxdff -provider openrouter <key1> [key2 ...]` 并 `exit 1`。

#### `mslxdff -provider <id> <key1> [key2 ...]`（批量设置，覆盖）

- **作用**：批量设置该供应商的全部 keys（**覆盖**旧值）。`saveProviderKeys(id, keys)`，去重、trim、去空。
- **输出**：`set <id> API keys (N: abcd…wxyz, ...) — restart daemon to activate`（仅首尾 4 字符脱敏）。
- **示例**：
  ```bash
  mslxdff -provider openrouter sk-or-v1-aaa sk-or-v1-bbb sk-or-v1-ccc
  ```

#### `mslxdff -provider <id> add <key>`（追加单 key）

- **语法**：`mslxdff -provider openrouter add <key>`
- **作用**：追加一个 key（去重），不覆盖已有。`addProviderKey(id, key)`。
- **输出**：`added <id> API key (now N total) — restart daemon to activate`
- **示例**：`mslxdff -provider openrouter add sk-or-v1-ddd`

#### `mslxdff -provider <id> remove <seq|key> [seq|key ...]`（按序号或值删除，支持逗号）

- **语法**：`mslxdff -provider openrouter remove <seq|key> [seq|key ...]`，多个目标可用空格或逗号分隔（如 `remove 1 3` / `remove 1,3` / `remove sk-aaa sk-bbb` 混写）。
- **序号语义**：`seq` 为 `list` 显示的 `1-based` 编号（`[1]` 对应第一行）。内部基于删除前快照 `current` 解析序号为值，再批量 `removeProviderKeys`，`new Set` 去重。
- **越界**：`! no key at sequence N (provider has M) — skipped`，不报错，跳过该序号。
- **输出**：`removed X <id> API key(s) (now Y total) — restart daemon to activate` 或 `nothing to remove`。
- **示例**：
  ```bash
  mslxdff -provider openrouter list
  # → [1] sk-a…  [2] sk-b…  [3] sk-c…
  mslxdff -provider openrouter remove 2
  mslxdff -provider openrouter remove 1,3
  mslxdff -provider openrouter remove sk-or-v1-bbb
  ```

#### `mslxdff -provider <id> list` / `status`（列表，脱敏）

- **语法**：`mslxdff -provider <id> list` 或 `mslxdff -provider <id> status`
- **作用**：列出该供应商已配置的 keys（脱敏）与共享开关。
- **输出**：
  ```
  provider: openrouter (3 keys)
    [1]  sk-o…aaaa (51 chars)
    [2]  sk-o…bbbb (51 chars)
    [3]  sk-o…cccc (51 chars)
    remove by: mslxdff -provider openrouter remove <seq> [seq...] | <key-value>
    share keys to peers:   off   (mslxdff -provider openrouter share on|off)
    NOTE: opencode is the default provider and can never be shared
  ```
  无 key 时：`provider: openrouter (no keys configured)`。
- **示例**：`mslxdff -provider openrouter list`

#### `mslxdff -provider <id> clear`（清空）

- **语法**：`mslxdff -provider openrouter clear`
- **作用**：清空该供应商全部 keys（`saveProviderKeys(id, [])`），provider 在下次 daemon 启动时自动禁用。
- **输出**：`cleared openrouter API keys (provider disabled on next daemon start)`
- **示例**：`mslxdff -provider openrouter clear`

#### `mslxdff -provider <id> share on|off`（瞬时共享开关，ADR-0008）

- **语法**：`mslxdff -provider <id> share [on|off|1|0|true|false]`
- **作用**：控制该供应商 key 是否在**对外转发（给组员/peers）时瞬时共享**。默认 `off`。
- **行为**：
  - 无 `on/off` 参数：仅显示状态 `share keys to peers: ON/off`。
  - 有参数：`saveProviderShareKeys(id, state)`，`state` 为 `on/1/true` 视为开，其余 `off/0/false` 视为关。
  - 输出：`share keys to peers: ON/off — restart daemon to activate`（需重启生效）。
  - 可被环境变量覆盖：`MSLXDFF_<ID>_SHARE_KEYS`（见附录 A）。
- **安全与排除**：
  - `opencode`/`oc` 恒被排除：`mslxdff -provider opencode ...` 直接提示 `needs no API key and can never be shared`；`share-keys` 三层过滤（白名单/组装/解析）均跳过 `DEFAULT_PROVIDER`。
  - 瞬时借用：转发侧在 `POST /v1/chat/completions` 命中可共享供应商时，把 key 列表放私有头 `x-mslxdff-share-keys: provider=k1,k2` 附带；组员侧 `parseShareKeysHeader` 解析后 `dispatcher.chat(body, {shareKeys})` → `provider.chatWithKeys` 用临时 `keyring` 调上游，**用完即弃，不落盘**。
- **示例**：
  ```bash
  mslxdff -provider openrouter share          # 查看
  mslxdff -provider openrouter share on      # 开启
  mslxdff -provider openrouter share off     # 关闭
  mslxdff -provider openrouter list          # 一并显示 share 状态
  ```

#### `mslxdff -provider add <id> <baseUrl> <key>`（通用 OpenAI 兼容供应商一键添加）

- **语法**：`mslxdff -provider add <id> <baseUrl> <key>`
- **作用**：一键注册任意 OpenAI 兼容网关为新供应商。`baseUrl` 为 OpenAI 根（如 `https://api.example.com/v1`，去尾 `/`），`key` 为 Bearer token；模型对外形如 `myapi/gpt-4`，转发时剥前缀 `gpt-4` 调 `POST <baseUrl>/chat/completions`，`GET <baseUrl>/models` 拉模型列表（不过滤，全量前缀化）。
- **安全默认（0.1.61 起）**：`allowAnyModels=false`，**空 `allowlist` 时上游直接禁用**，`chat` 返回 `403 {"error":"model not allowed… — allowed: (none) (use: mslxdff -provider <id> allowlist add <model>)"}` + 头 `x-mslxdff-allowlist:1`，不打上游、不计费。**必须二选一**：`mslxdff -provider <id> allowlist set <m1> <m2> ...`（推荐，精确 free 模型）或 `mslxdff -provider <id> allowAny on`（放行全部，`opencode` 例外默认 `ON`）。
- **行为**：`saveProviderConfig(id, {baseUrl, keys:[key]})`，若 `id` 已存在则更新 `baseUrl` 并追加 key（去重）；`opencode/openrouter` 保留走原分支，误用 `add openrouter ...` 会提示改用 `add <key>` / `set-url`。
- **校验**：`id` 经 `normalizeProviderId`，`baseUrl` 必须 `http(s)://` 前缀。
- **输出**：`added generic provider: myapi / baseUrl: ... / keys: 1 (...) / allow=none(BLOCKED) — set allowlist or allowAny on to enable / use as: myapi/<model-id> — restart daemon to activate`
- **示例**：
  ```bash
  mslxdff -provider add myapi https://api.example.com/v1 sk-xxx
  mslxdff -provider myapi list        # 看 baseUrl + keys
  # 调用
  curl -H "Authorization: Bearer $(mslxdff -showtoken)" http://127.0.0.1:8989/v1/chat/completions -d '{"model":"myapi/gpt-4","messages":[{"role":"user","content":"hi"}]}'
  ```

#### `mslxdff -provider <id> set-url <baseUrl>`（改通用供应商地址）

- **语法**：`mslxdff -provider <id> set-url <baseUrl>`（别名 `setUrl`/`url`）
- **作用**：仅改已注册通用供应商的 `baseUrl`，保留 `keys`；`openrouter` 的地址仍由 `MSLXDFF_OPENROUTER_BASE_URL` 控制，不建议用此改。
- **输出**：`set <id> baseUrl: https://... — restart daemon to activate`
- **示例**：
  ```bash
  mslxdff -provider myapi set-url https://api.new.com/v1
  ```

#### `mslxdff -providers list` / `mslxdff -provider list`（列出所有已部署供应商）

- **语法**：`mslxdff -providers list` / `mslxdff -providers status` / `mslxdff --providers list` / `mslxdff -provider list`（单数 `list` 为同义别名，无参 `mslxdff -providers` 亦视为 `list`）
- **作用**：聚合展示当前已部署的所有上游供应商及其启用状态，不启动 daemon。
- **判定**：
  - `opencode` 恒 `enabled`（`https://opencode.ai`，无 key，`cannot share`）
  - `openrouter` 当 `keys.length>0` 为 `enabled`（`https://openrouter.ai/api/v1`）
  - 通用：`providerConfigs.<id>={baseUrl,keys}` 中 `baseUrl && keys.length>0` 为 `enabled`，否则 `disabled` 并标注 `missing baseUrl / no keys`
- **输出**：
  ```
  providers (3):
    opencode     enabled   0 keys                        allow=all               baseUrl=https://opencode.ai  cannot share  (built-in, no key, cannot share)
    openrouter   disabled  0 keys                        allow=none(BLOCKED)     baseUrl=https://openrouter.ai/api/v1  share=off  (no keys)
    bai          enabled   1 key sk-t…93hc               allow=2(glm-5.3-flash,minimax-m3)  baseUrl=https://api.b.ai/v1  share=off
  ```
  每行含 `keys` 脱敏（首尾 4 字符）、`baseUrl`、`share=ON/off`、`allow` 摘要（`allow=none(BLOCKED)` 表示空名单+`allowAny OFF`）与 `note`。
- **示例**：
  ```bash
  mslxdff -providers list
  mslxdff -provider list   # 同义
  mslxdff -provider bai list  # 单供应商详情（非聚合，含 allowlist）
  ```

#### `mslxdff -provider <id> allowlist [list|set|add|remove|clear]`（供应商模型白名单，防昂贵/奇怪模型）

- **语法**：
  ```bash
  mslxdff -provider <id> allowlist list                        # 查看
  mslxdff -provider <id> allowlist set <m1> <m2> ...           # 覆盖
  mslxdff -provider <id> allowlist add <m> [m2 ...]            # 追加（去重）
  mslxdff -provider <id> allowlist remove <m> [m2 ...]         # 移除
  mslxdff -provider <id> allowlist clear                       # 清空（= 阻塞，见 allowAny）
  # 别名：allow / allowed / whitelist 均等价于 allowlist
  # 接入时直接带白名单：
  mslxdff -provider add <id> <baseUrl> <key> [m1 m2 ...]
  ```
- **语义（0.1.61 起安全默认）**：
  - `allowlist` 为空 + `allowAnyModels=false`（默认，`opencode` 例外为 `true`）→ **阻塞**，`chat` 直接 `403`（`{"error":"model not allowed for provider \"...\" — allowed: (none) (use: mslxdff -provider ... allowlist add <model>)"}` + 头 `x-mslxdff-allowlist:1`），`GET /v1/models` 不暴露任何模型。
  - `allowlist` 为空 + `allowAnyModels=true` → **不限**，全部模型可用（需显式 `mslxdff -provider <id> allowAny on`）。
  - 非空 → **仅名单内可用**，`chat` 时 `rawModel` 不在名单则立即 `403`，不计入冷却、不触发 fallback；`GET /v1/models` 亦仅返回白名单内的模型（按 `raw` 精确匹配，支持 `bai/glm-...` 或 `glm-...` 两种写法，存储时自动归一为 raw）。
- **存储**：`state.json providerConfigs.<id>.{allowedModels: string[], allowAnyModels: boolean}`（`saveProviderAllowedModels` 去重、trim、支持逗号分隔的一串如 `m1,m2`）。`providerConfigs.<id>.baseUrl/keys` 为空但 `allowedModels` 非空时仍保留条目（便于先定白名单后补 key）。
- **生效**：热更新立即生效（`chat` 与 `listModels` 均无需重启；`provider add` 的白名单亦同）；`opencode` 亦支持（`mslxdff -provider opencode allowlist set big-pickle mimo-v2.5-free`）。
- **示例**：
  ```bash
  mslxdff -provider add myapi https://api.example.com/v1 sk-xxx gpt-4 gpt-3.5  # 接入即定白名单
  mslxdff -provider myapi allowlist list
  # → provider: myapi  baseUrl: https://api.example.com/v1
  #     allowedModels: 2 models (only these can be used)
  #     [1]  gpt-4
  #     [2]  gpt-3.5
  mslxdff -provider myapi allowlist add gpt-4o
  mslxdff -provider myapi allowlist remove gpt-3.5
  mslxdff -provider myapi allowlist clear   # 回到阻塞（allowAny OFF）或不限（allowAny ON）
  mslxdff -providers list   # 聚合视图亦显示 allow=2(...) 或 allow=none(BLOCKED) 摘要
  ```

#### `mslxdff -provider <id> allowAny on|off`（空 allowlist 时放行或阻塞，安全开关）

- **语法**：`mslxdff -provider <id> allowAny on|off`（别名 `allow-any`/`allow_any`/`allowany`，`list` 为空参时仅查看）
- **作用**：控制 `allowlist` 为空时的行为。默认 `OFF`（`opencode` 例外 `ON`，兼容历史免费池），`OFF` 时空名单=`403 BLOCKED`，`ON` 时空名单=放行全部。
- **存储**：`state.json providerConfigs.<id>.allowAnyModels: boolean`（显式存 `true/false`，`saveProviderAllowAnyModels`）。
- **示例**：
  ```bash
  mslxdff -provider cline allowlist list  # → (none — BLOCK ALL, provider disabled until allowlist set or allowAny ON)
  mslxdff -provider cline allowAny on    # 空名单时放行全部（不推荐，cline 易欠费）
  mslxdff -provider workbuddy allowAny on # 恢复旧不限行为
  ```

#### WorkBuddy 专用供应商（`workbuddy/hy3` 等 16 CLI 模型）

- **语法**：
  ```bash
  # 单号接入（禁手填，必须自动化）
  mslxdff -provider add workbuddy https://copilot.tencent.com <key> [allow1 allow2 ...]  # 仅当用户贴 eyJ 时可用，否则禁手填

  # 多号追加（路径A，推荐，自动化）
  # 1) WorkBuddy 桌面退出当前账号 → 用新账号重新登录 https://copilot.tencent.com（能对话即成功）
  # 2) 项目根执行（whistle :8899 自动追加新号，不覆旧号）
  node workbuddy-token-auto.js
  mslxdff -workbuddy list                                 # 验证 2 行 uid
  mslxdff -workbuddy balance --json                       # 看 total/dailyPacks/nextExpire

  # 运维
  mslxdff -provider workbuddy list                        # 看 baseUrl/keys/share/allowlist
  mslxdff -provider workbuddy allowlist set hy3 hy4-preview glm-5.3-flash  # 仅低耗
  mslxdff -workbuddy checkin                              # 每日签到 100 credits（多号并行 3，幂等，--json 聚合）
  mslxdff -workbuddy balance [--json]                     # 多号余额总览（total/dailyPacks/nextExpire，TTL 5min）
  mslxdff -workbuddy list                                 # 列出账号（uid/domain/enterpriseId）
  mslxdff -workbuddy remove <uid> [--keep-file]           # 按 uid 摘除（删 keys/auths 与 auths/workbuddy-<uid>.json）
  ```
- **存储**：`state.json providerConfigs.workbuddy={ baseUrl:"https://copilot.tencent.com", keys:["k1",...], auths:[{uid,domain,enterpriseId,refreshToken}], allowedModels:["hy3",...] }`，`auths` 与 `keys` 一一对应（多号同索引），由 `node workbuddy-token-auto.js` 自动落盘（`auths/workbuddy-<uid>.json` + `state.json`，`0600`）或 `-provider add workbuddy` 解析 JWT `uid` 自动追加。`baseUrl` 默认 `https://copilot.tencent.com`（`MSLXDFF_WORKBUDDY_BASE_URL` 可覆盖）。
- **上游**：`POST https://copilot.tencent.com/v2/chat/completions`（强制 `stream:true`，头含 `X-User-Id/X-Domain/X-Product:SaaS + Origin/Referer/User-Agent`，多号环形：`402/insufficient` 自动切号 + `balanceCache` TTL 5min，`header x-mslxdff-workbuddy-uid` 或 `model workbuddy/<uid>:<id>` 定号，`x-mslxdff-workbuddy-uid` 回显），`GET https://copilot.tencent.com/console/enterprises/personal/models`（`credits xN.NN` 升序，前缀 `workbuddy/`）+ `POST /v2/billing/meter/get-user-resource` 查余额（`workbuddy-balance.js`），401/403 自动 `POST /v2/plugin/auth/token/refresh` 回写并重放一次。
- **白名单**：同通用供应商（空=不限，非空仅名单内可用，`403 + x-mslxdff-allowlist:1` 直通，`/v1/models` 过滤）。
- **共享**：`workbuddy` 默认 `share=off`（`opencode` 同理恒排除），需 `mslxdff -provider workbuddy share on` 或 `MSLXDFF_WORKBUDDY_SHARE_KEYS=1` 显式开启才随 `x-mslxdff-share-keys` 外借。
- **签到**：`POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin` + `https://copilot.tencent.com/v2/billing/meter/daily-checkin` 双域，`code 0` 新增 100 credits/30d 裂变包，`code 10001 已签到` 视为成功；并行 3，`--json` 聚合 `results[].balance`；`workbuddy-token-auto.js` 已在 `refresh` 后自动 `spawn workbuddy-checkin.js`，可另加 `schtasks /create /tn WorkBuddyCheckin /tr "node .../workbuddy-checkin.js" /sc daily /st 09:00`。
- **调用**：
  ```bash
  curl -H "Authorization: Bearer $(mslxdff -showtoken)" http://127.0.0.1:8989/v1/chat/completions -d '{"model":"workbuddy/hy3","messages":[{"role":"user","content":"hi"}]}'
  curl -H "Authorization: Bearer $(mslxdff -showtoken)" -H "x-mslxdff-workbuddy-uid: a06ef5f8" http://127.0.0.1:8989/v1/chat/completions -d '{"model":"workbuddy/hy3","messages":[]}'  # 钉死 C
  curl -H "Authorization: Bearer $(mslxdff -showtoken)" http://127.0.0.1:8989/v1/chat/completions -d '{"model":"workbuddy/a06ef:hy3","messages":[]}'  # 前缀亦可
  ```

#### 存储与生效

- **优先级**：`MSLXDFF_<ID>_KEY` env（单值）> `state.json providerConfigs.<id>.keys` / `providerKeys.<id>`（数组）；`MSLXDFF_<ID>_BASE_URL` env 覆盖 `providerConfigs.<id>.baseUrl`。`opencode` 无视 key，恒为 `public`；`workbuddy` 额外支持 `MSLXDFF_WORKBUDDY_*`（见附录 A）。
- **文件**：`~/.config/mslxdff/state.json` 的 `providerConfigs: { myapi: { baseUrl: "https://api.example.com/v1", keys: ["sk-..."] }, workbuddy: { baseUrl:"https://copilot.tencent.com", keys:["k1"], auths:[{uid,refreshToken}], allowedModels:["hy3"] } }`（新）与 `providerKeys: { openrouter: ["sk-..."] }`（兼容旧版单字符串）与 `providerShareKeys: { openrouter: true }`。
- **生效时机**：修改后需重启 daemon（`stop` + `start` 或 ` -port` 触发的重启）；`allowlist` 热更新立即生效。
- **多 key 调度**：`src/providers/keyring.js` round-robin，`401/403/429/5xx` 冷却 30s（`MSLXDFF_GENERIC_COOLDOWN_MS` / `MSLXDFF_OPENROUTER_COOLDOWN_MS` / `MSLXDFF_WORKBUDDY_COOLDOWN_MS`），全冷却则抛 `provider temporarily unavailable`。

---

## 7. 外部同步（WorkBuddy / opencode）

### `-setto opencode [modelId]` / `--setto opencode [modelId]`

- **语法**：`mslxdff -setto opencode [modelId]`（`--setto` 等价）
- **作用**：把本地网关 `http://127.0.0.1:<port>/v1` 以 `provider.mslxdff` 写入 `~/.config/opencode/opencode.json`，使 opencode 把 mslxdff 当供应商（`mslxdff/mslxdff-<id>`）。默认写 **alias** `mslxdff-<id>` 防重名（如 `deepseek`→`mslxdff-deepseek`，避免与 `workbuddy/deepseek` 混乱），**原名仍兼容**（旧裸 `deepseek` 键视为同一逻辑模型，不强制迁移；网关对 `mslxdff-deepseek` 与 `deepseek` 双兼容，重复添加幂等）。
- **参数**：
  - 无 `modelId`：取 `loadPreferredModel() || getPreferredModel()`（`big-pickle` 兜底），归一后转 alias。
  - 有 `modelId`：`normalizeModel(raw)` 归一后 `toInternalId`→`toExternalAlias`（`mslxdff-deepseek` 不会双前缀），`savePreferredModel`，`modelId` 不能为 `auto` 或空。
- **流程**：
  1. 4s 超时尝试刷新模型列表，若 `internal` 与 `alias` 均不在 free 列表则 `warn` 但仍继续。
  2. `loadToken()` 取 token，`getPort() || MSLXDFF_PORT || 8989` 取端口，`opencodeConfigPath()` 取文件（`OPENCODE_CONFIG` 可覆盖）。
  3. `syncToOpencode({ id: alias, token, port, file })`：不存在则 `inserted`，已存在（`alias` 或原名 `internal` 任一存在即视为已存在）则 `updated`（不新增双键，保留原键，仅覆盖 `options.baseURL/apiKey`），原子写 `tmp→rename`，损坏备份 `.bak`。
- **输出**：
  ```
  default model set to: deepseek (daemon hot-reloads on next request)
  synced to opencode: inserted "mslxdff-deepseek" (alias for "deepseek", 原名仍兼容) @ C:\Users\you\.config\opencode\opencode.json
    url: http://127.0.0.1:8989/v1
    alias: mslxdff-deepseek -> deepseek (opencode 选 mslxdff/mslxdff-deepseek 直达本地 deepseek)
  ```
- **入站兼容**：网关对 `POST /v1/chat/completions` 的 `model` 做 alias 还原：`mslxdff-deepseek`→`deepseek`、`mslxdff/mslxdff-deepseek`→`deepseek`、`deepseek` 原样，`x-mslxdff-alias` 头回显。
- **示例**：
  ```bash
  mslxdff -setto opencode deepseek
  mslxdff -setto opencode mslxdff-deepseek   # 已带前缀不双写，去重
  mslxdff -setto opencode big-pickle
  mslxdff -setto opencode   # 用当前首选
  ```

### `-setto workbuddy [modelId]` / `--setto workbuddy [modelId]`

- **语法**：`mslxdff -setto workbuddy [modelId]`
- **作用**：设默认模型并原子写入 WorkBuddy 的 `~/.workbuddy/models.json`，供 WorkBuddy 以 `http://127.0.0.1:<port>/v1` 为 OpenAI 兼容端点调用 mslxdff。
- **参数**：
  - 无 `modelId`：取 `loadPreferredModel() || getPreferredModel()`（当前首选/出厂默认 `big-pickle`）。
  - 有 `modelId`：`normalizeModel(raw)` 归一化后 `savePreferredModel(norm)`，`modelId` 不能为 `auto` 或空，否则 `modelId 不能为 auto 或空`。
- **流程**：
  1. （可选）4s 超时尝试刷新模型列表，若 `id` 不在 free 列表则 `warn: "id" not in current free list (...)` 但仍继续同步。
  2. `loadToken()` 取 token，`getPort() || MSLXDFF_PORT || 8989` 取端口，`workbuddyModelsPath()` 取文件路径。
  3. `syncToWorkbuddy({ id, token, port, file })`：若 `models.json` 不存在则插入 `127.0.0.1/v1` 条目，存在则更新其 `token/port/model`。
- **输出**：
  ```
  default model set to: <id> (daemon hot-reloads on next request)
  synced to WorkBuddy: updated "big-pickle" @ C:\Users\you\.workbuddy\models.json
    url: http://127.0.0.1:8989/v1/chat/completions
  ```
- **约束**：WorkBuddy 仅认 `127.0.0.1/v1`，不认 `localhost`。
- **示例**：
  ```bash
  mslxdff -setto workbuddy big-pickle
  mslxdff -setto workbuddy openrouter/google/gemma-3-27b-it:free
  mslxdff -setto workbuddy   # 用当前首选同步
  ```

---

## 8. 群组网络

> 群组用于分散 `opencode.ai` 的 IP 级限流：A 转发给 B 时，上游看到的是 B 的出口 IP。组内还支持 failover、hedge 对冲、宽带中继等。Leader 持有 `groups.<name>.members`，成员通过 `-addtogroup` 注册到 leader。

### `-creategroup <name>` / `--creategroup <name>` / `-group create <name>`

- **语法**：三者等价，`<name>` 即组密码。
- **作用**：在本节点创建群组，本节点成为 leader。`groups.create(name)`，`markJoined({ name, leaderUrl:"", myUrl:"", memberName:"leader" })`，`syncAllJoinedGroups` 同步 peers。
- **输出**：
  ```
  group created: my@mslxd  # 或 already exists
  members on this node: 0 (failover: 0)
  others join with: mslxdff -addtogroup <this-node-host> my@mslxd
  ```
- **示例**：`mslxdff -creategroup my@mslxd`

### `-addtogroup <leader-host> <name> [--broadband]` / `--addtogroup`

- **语法**：`mslxdff -addtogroup <leader-host> <name> [--broadband]`
  - `<leader-host>` 可为 `host`、`host:port` 或完整 `http(s)://host:port`（尾斜杠自动去除，缺端口默认 `:8989`）。
  - `[--broadband]` 可选，位于任意位置（会被过滤），表示宽带动态 IP 成员。
- **作用**：以成员身份加入远端 leader 的群组。
- **流程**：
  1. 归一化 `leaderUrl`，取 `myToken`、`myPort`（`effectivePort()`）。
  2. 组装 `joinBody`：
     - 普通：`{ name, key:name, leaderUrl, myPort, token, kind:"static" }`，`myUrl` 由 leader 返回的 `data.you.url` 确定。
     - 宽带：`{ name, key:name, leaderUrl, url:"relay://<token8>", token, kind:"broadband" }`，`myUrl`/`memberName` 均为 `relay://...`。
  3. `POST <leaderUrl>/v1/groups/join`，失败抛 `join failed (HTTP status): text`。
  4. `markJoined({ name, leaderUrl, myUrl, memberName, kind })`，`syncAllJoinedGroups`。
- **输出**：
  ```
  joined group "my@mslxd" at http://1.2.3.4:8989
    1 failover target(s) configured
  # 宽带：
  joined group "my@mslxd" at http://1.2.3.4:8989 [broadband]
    1 failover target(s) configured (broadband via leader, local 127.0.0.1)
  ```
- **失败**：`join failed: ...` 并 `exit 1`。
- **示例**：
  ```bash
  mslxdff -addtogroup 1.2.3.4 my@mslxd
  mslxdff -addtogroup http://1.2.3.4:8989 my@mslxd --broadband
  ```

### `-group sync`

- **语法**：`mslxdff -group sync`
- **作用**：刷新所有已加入群组的成员列表到本地 failover peers。
- **行为**：
  - Leader 组：直接读 `groups.list()[name].members` → `syncPeersFromMembers(..., skipIds:["leader"])`。
  - 成员组：`refreshGroupMembers({ leaderUrl, memberName, url:myUrl, token, kind })` 幂等重注册以拿最新成员 → `syncPeersFromMembers`。
- **输出**：每组一行 `name: N member(s), M failover target(s) configured` 或 `sync failed — error`；未加入任何组则 `not joined to any group (use -addtogroup or -creategroup)`。
- **示例**：`mslxdff -group sync`

### `-group leave <name>`

- **语法**：`mslxdff -group leave <name>`
- **作用**：成员侧本地离开单群组（不通知 leader，仅本地 `groupsJoined` 过滤 + `peers.removeByGroup(name)`）。
- **输出**：`left group "name" (N member(s) removed)` 或 `not a member of group "name"`。
- **与 `-leavegroup` 区别**：`leave` 是单组本地移除；`-leavegroup` 是全量离开并尝试通知 leader 注销。
- **示例**：`mslxdff -group leave my@mslxd`

### `-group list`

- **语法**：`mslxdff -group list`
- **作用**：列出本节点所有群组及成员，带健康探测与稳定序号（用于 `remove`）。
- **输出结构**：
  ```
  my@mslxd  (2 members)
    1. http://1.2.3.4:8989  ok    23ms
    2. http://5.6.7.8:8989  [broadband] via leader 12s ago ip=5.6.7.8
    leader  http://leader:8989  ok    15ms
  joined groups (1):
    my@mslxd  leader http://leader:8989
  ```
  - 成员按 state 顺序渲染，序号 `1..N` 稳定（leader 排除在外，单独 `leader` 行）。
  - 每个成员并发 `probeHealth`（`fetch /health`，1.5s 超时）；宽带成员不探测，显示 `via leader Xs ago` / `stale` + `ip`。
  - Leader 本机与成员组分别取成员：leader 读本地 `groups.list()`，成员走 `refreshGroupMembers`（失败则 `members unavailable — leader unreachable`）。
- **示例**：`mslxdff -group list`

### `-group remove <seq>`

- **语法**：`mslxdff -group remove <seq>`（`seq` 为 `list` 显示的 `1-based` 序号，leader 不计）
- **作用**：仅 leader 侧：按序号踢出成员 `groups.removeMember(name, {url})`。
- **校验**：
  - `seq` 非整数或 `<1` → `usage: mslxdff -group remove <seq>` 并 `exit 1`。
  - 本节点非 leader（`!joined.find(g=>!g.leaderUrl)`）→ `group remove requires being the leader — this node leads no group`。
  - 序号越界 → `member #N not found — group "name" has M member(s)`。
- **输出**：`removed http://... from "name"` 或 `already gone`。
- **示例**：`mslxdff -group remove 2`

### `-leavegroup` / `--leavegroup` / `-leave-groups`

- **语法**：`mslxdff -leavegroup`
- **作用**：成员侧离开**所有**已加入群组。
- **行为**：
  - 遍历 `loadGroupsJoined()`：
    - 成员组（`g.leaderUrl` 存在）：`peers.removeByGroup(g.name)` + `POST <leaderUrl>/v1/groups/leave`（`Authorization Bearer myToken`，`{name}`），成功 `left (deregistered from ...)`，失败 `left locally (leader said: ...)` 或 `leader unreachable: ...`。
    - Leader 组：跳过，记入 `leaders`。
  - 持久化：`saveGroupsJoined( filtered: 仅保留 leader 组 )`，打印 `left N group(s)`。
  - 若有 leader 组被跳过，额外提示：
    ```
    skipped N group(s) where this node is the leader:
      my@mslxd  — leaders can't leave; disband it with: mslxdff -delgroup my@mslxd
    ```
- **与 `-group leave` 区别**：`-leavegroup` 批量且尝试通知 leader；`-group leave` 单组本地移除。
- **示例**：`mslxdff -leavegroup`

### `-delgroup <name>` / `--delgroup <name>`

- **语法**：`mslxdff -delgroup <name>`
- **作用**：仅 leader：解散本节点领导的群组（删 `groups` 定义 + `peers.removeByGroup` + `groupsJoined` 过滤）。
- **校验**：
  - `groups.list()[name]` 不存在：查 `groupsJoined` 是否为成员组 → 提示 `is led by ... — you are a member, use -leavegroup to leave it`；或 `not found on this node` 并 `exit 1`。
- **成功**：`group "name" disbanded (N members removed)`。
- **示例**：`mslxdff -delgroup my@mslxd`

### `-resetban [ip]` / `--resetban [ip]`

- **语法**：`mslxdff -resetban` 或 `mslxdff -resetban <ip>`
- **作用**：清除加群失败封禁。`createBansService({ windowMs, threshold })`，`bans.clear(ip)`（无 ip 则全清）。
- **输出**：`ban cleared for 1.2.3.4` 或 `all bans cleared`。
- **示例**：
  ```bash
  mslxdff -resetban
  mslxdff -resetban 1.2.3.4
  ```

---

## 9. 对话终端

### `-chat ["prompt"]` / `--chat ["prompt"]`

- **语法**：`mslxdff -chat`（进入常驻 REPL）或 `mslxdff -chat "把 hy3 设为默认模型"`（单次执行后退出）
- **作用**：自然语言转精确 CLI 命令并执行。背后是 `src/chat/*` 独立模块，**优先调 `mimo-v2.5-free`**，失败自动降级 `big-pickle`（与 auto 同套冷却），把用户说的简称（如 `hy3`）自行查可用模型列表补全为全称（如 `hy3-free`）再调用工具。
- **交互**：
  - `mimo> ` 提示符，支持上下历史、`/help`（看可用说法）、`/clear`（清历史）、`/history`（看条数）、`/exit`/`quit`/`退出`/`Ctrl+D` 退出。
  - 单次模式：`mslxdff -chat "查看组列表"` 直接执行一次后退出，适合管道/脚本。
- **工具**（3 类 + 纯回答）：
  - `run_command`：执行 `cli_help.md` 所列任意命令（不含 `mslxdff` 前缀），**仅拦截 `-uninstall`**，`-stop`/`-port` 等可执行；模糊匹配与精确性由大模型负责，进程侧不做二次归一。
  - `read_file`：读取**项目内**文件（`src/` `docs/` `package.json`）或日志目录（`~/.config/mslxdff/*`），用于“看看日志/配置”，超出项目根或超 20KB 截断，目录则列文件名。
  - `curl`：网络/HTTP 探活，检测上游或本机可用性。支持 `url` 简写（`upstream`=`https://opencode.ai/zen/v1/models`、`local/health`=`http://127.0.0.1:<port>/health`、`local/models`），也支持完整 `http(s)` URL；可选 `method`/`headers`/`body`/`timeoutMs`，上游自动补 `x-opencode-client/desktop` 与 `Authorization: Bearer public`，本机 `/v1/*` 自动带 state token。返回状态码、耗时、响应头与前 6KB body，便于自检“上游是否活着/本地是否监听”。
  - 纯回答：闲聊或解释时不调工具，直接中文回复。
- **历史与压缩**：
  - 持久化：`~/.config/mslxdff/chat-history.json`（`MSLXDFF_CHAT_HISTORY` 可覆盖），存最近 120 条，`daemon` 重启不影响（chat 是前台独立进程，与 daemon 无父子关系）。
  - 压缩原理：当总字符 > `400000`（`CHAT_HISTORY_MAX_CHARS`≈128k*95%≈400k 字符）时触发——**保留 system + 最近 40 条**，将其余旧消息打包让**大模型自己做摘要**（`summarizeHistory` 发一次 `mimo`/`big-pickle` 调用，提示“压缩成 800 字内中文摘要，保留关键操作与偏好及时间线”），成功则用 `【历史摘要】…` 替代旧段，失败则直接截断。这样大模型 128k 上下文下接近 95% 才压缩，避免频繁压缩。
- **独立进程保证**：`mslxdff -chat` 就是用户终端的前台进程，`bin` 中直接 `await startChat()`，不经 `startDaemon`，`daemon` 的 `stopDaemonIfOutdated`/`-port` 重启完全走另一条链路。
- **示例**：
  ```bash
  mslxdff -chat
  # mimo> 设置hy3为默认模型
  # → 执行: mslxdff -model set hy3-free
  # → OK: default model set to: hy3-free

  mslxdff -chat "查看最近20条日志"
  # → 执行: mslxdff -log 20

  mslxdff -chat "读一下 src/logs.js"
  # → 读取: src/logs.js OK
  ```

---

## 10. 帮助

### `-help` / `--help` / `-h`

- **语法**：`mslxdff -help`（任一别名出现即触发）
- **作用**：打印 `printHelp()` 的完整 Usage + Environment 段并 `exit 0`，不执行其他逻辑。
- **内容**：与本文件一致的精简版（含 `mslxdff vX.Y.Z — OpenCode Free OpenAI-compatible proxy` 头）。
- **示例**：`mslxdff -help` / `mslxdff --help` / `mslxdff -h`

---

## 附录 A 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MSLXDFF_PORT` | `8989` | 监听端口（`state.json port` 优先于它；裸 `PORT` 忽略） |
| `MSLXDFF_HOST` / `MSLXDFF_BIND_HOST` | `0.0.0.0`（宽带成员自动 `127.0.0.1`） | 绑定 host（`src/server.js effectiveHost()`） |
| `MSLXDFF_STATE_FILE` | `~/.config/mslxdff/state.json` | state 持久化路径 |
| `MSLXDFF_DAEMON_DIR` | 随 state 派生（`dirname(stateFile)`） | daemon pid/log/models 目录 |
| `MSLXDFF_STATE_FLUSH_MS` | `500` | 热数据批量刷盘间隔，`0` 则同步刷（测试用） |
| `UPSTREAM_BASE_URL` | `https://opencode.ai` | 默认供应商上游 |
| `UPSTREAM_AUTH_TOKEN` | `public` | 上游鉴权值（opencode 侧恒 `public`） |
| `MSLXDFF_OPENROUTER_KEY` | — | OpenRouter 单 key（env 优先于 state；多 key 用 `-provider` 持久化） |
| `MSLXDFF_OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter 上游地址（可覆盖为代理/测试地址） |
| `MSLXDFF_OPENROUTER_TIMEOUT_MS` | `30000` | OpenRouter 单次 fetch 超时 |
| `MSLXDFF_OPENROUTER_COOLDOWN_MS` | `30000` | 多 key 冷却（401/403/429/5xx 后） |
| `MSLXDFF_OA_KEEPALIVE_TIMEOUT` | `30000` | OpenRouter keepAlive 超时 |
| `MSLXDFF_OA_KEEPALIVE_MAX_TIMEOUT` | `60000` | keepAlive 最大超时 |
| `MSLXDFF_OA_KEEPALIVE_CONNECTIONS` | `20` | keepAlive 连接数 |
| `MSLXDFF_OPENROUTER_REFERER` | `https://github.com/mslxdff` | OpenRouter 必需 `HTTP-Referer` |
| `MSLXDFF_OPENROUTER_TITLE` | `mslxdff` | OpenRouter 必需 `X-Title` |
| `MSLXDFF_WORKBUDDY_KEY` | — | WorkBuddy 单 key（env 优先；多 key 用 `-provider workbuddy ...`） |
| `MSLXDFF_WORKBUDDY_BASE_URL` | `https://copilot.tencent.com` | WorkBuddy 上游（`POST /v2/chat/completions` + `GET /console/.../models`） |
| `MSLXDFF_WORKBUDDY_TIMEOUT_MS` | `30000` | WorkBuddy 单次 fetch 超时 |
| `MSLXDFF_WORKBUDDY_COOLDOWN_MS` | `30000` | WorkBuddy 多 key 冷却（401/403/429/5xx） |
| `MSLXDFF_WORKBUDDY_SHARE_KEYS` | `off` | WorkBuddy 共享开关（`1/on/true` 显式开，默认关） |
| `WORKBUDDY_AUTH_DIR` | `./auths` | WorkBuddy 落盘目录（`workbuddy-*.json`，`0600`） |
| `MSLXDFF_<ID>_KEY` | — | 任意供应商的 env key（`<ID>` 大写、非字母数字转 `_`） |
| `MSLXDFF_<ID>_BASE_URL` | — | 通用供应商 env baseUrl（覆盖 `providerConfigs.<id>.baseUrl`） |
| `MSLXDFF_<ID>_SHARE_KEYS` | — | 任意供应商的共享开关覆盖（`1/true/on/yes` 视为开） |
| `MSLXDFF_GENERIC_TIMEOUT_MS` | `30000` | 通用供应商单次 fetch 超时 |
| `MSLXDFF_GENERIC_COOLDOWN_MS` | `30000` | 通用供应商多 key 冷却 |
| `MSLXDFF_GENERIC_KEEPALIVE_TIMEOUT` | `30000` | 通用 keepAlive 超时 |
| `MSLXDFF_GENERIC_KEEPALIVE_MAX_TIMEOUT` | `60000` | 通用 keepAlive 最大超时 |
| `MSLXDFF_GENERIC_KEEPALIVE_CONNECTIONS` | `20` | 通用 keepAlive 连接数 |
| `MSLXDFF_SHARE_PROVIDERS` | — | 高级：显式共享白名单，逗号分隔（如 `openrouter`）；出现则覆盖自动判定，且 `opencode` 恒被过滤 |
| `MODELS_REFRESH_MS` | `7200000` (2h) | 模型列表后台刷新间隔 |
| `MSLXDFF_PREFERRED_MODEL` | `big-pickle` | 覆盖出厂首选模型（`src/auto.js`） |
| `MSLXDFF_MODEL_COOLDOWN_MS` | `60000` | 模型错误冷却 |
| `MSLXDFF_SLOW_COOLDOWN_MS` | `300000` (5m) | 慢模型冷却 |
| `MSLXDFF_PEER_COOLDOWN_MS` | `30000` | 组员 failover 冷却 |
| `MSLXDFF_PEER_HEAT_MS` | `300000` (5m) | 组员成功后 hot 时长 |
| `MSLXDFF_MAX_HOPS` | `3` | 组员转发最大跳数 |
| `MSLXDFF_GROUP_SYNC_MS` | `60000` (1m) | 群组成员同步间隔 |
| `MSLXDFF_BROADBAND_STALE_MS` | `90000` (90s) | 宽带成员心跳过期阈值 |
| `MSLXDFF_PEER_HEALTH_TTL_MS` | — | 组员健康缓存 TTL（`src/routes/peers.js`） |
| `MSLXDFF_PEER_RACE_LIMIT` | — | 组员并发竞速限制 |
| `MSLXDFF_BAN_WINDOW_MS` | `172800000` (48h) | 加群失败封禁窗口 |
| `MSLXDFF_BAN_THRESHOLD` | `5` | 封禁阈值（窗口内失败次数） |
| `MSLXDFF_HEDGE_DELAY_MS` | `1000` | 首块对冲等待（`0/off` 关闭） |
| `MSLXDFF_SLOW_TOTAL_MS` | `20000` | 慢模型判定：总耗时阈值 |
| `MSLXDFF_STREAM_TIMEOUT_MS` | `25000` | 流式首块超时（未写字节才 failover） |
| `MSLXDFF_STALL_TIMEOUT_MS` | `0`（关闭） | 相邻 chunk 间隔 stall 阈值（仅作质量分） |
| `MSLXDFF_MAX_STREAM_MS` | `120000` (2m) | 流式总时长上限 |
| `MSLXDFF_FREE_ANON` | — | 空或非 `0/off/false` 则启用 free 模型 public 429 后的匿名重试 |
| `MSLXDFF_FREE_ANON_RETRIES` | `3` | 匿名重试次数 |
| `MSLXDFF_FREE_ANON_DELAY_MS` | `1000` | 匿名重试间隔 |
| `MSLXDFF_FREE_ANON_LOG` | `<cwd>/free-anon-extra.txt` | 匿名命中日志路径 |
| `MSLXDFF_PREHEAT` | `1` | 上游预热开关（`0` 关闭） |
| `MSLXDFF_UPSTREAM_KEEPALIVE_TIMEOUT` | `30000` | opencode 上游 keepAlive 超时 |
| `MSLXDFF_UPSTREAM_KEEPALIVE_MAX_TIMEOUT` | `60000` | keepAlive 最大超时 |
| `MSLXDFF_UPSTREAM_KEEPALIVE_CONNECTIONS` | `20` | keepAlive 连接数 |
| `MSLXDFF_PLUGINS_DIR` | `<pkg>/plugins` + `~/.config/mslxdff/plugins` | 插件目录覆盖（设了则只扫该目录） |
| `MSLXDFF_DAEMON` | — | 内部标记：子进程为 daemon 时置 `1` |
| `MSLXDFF_DEBUG` | — | `1` 时前台打印详细事件与 free-anon 日志 |
| `MSLXDFF_LOGS_SYNC` | — | `1` 时日志同步写 |
| `MSLXDFF_AUTO_UPDATE` / `MSLXDFF_AUTO_UPDATE_MS` | 默认每小时 | 自动更新：`0/off/false` 关闭，`1/true/on` 每小时，数值则为毫秒间隔 |

> 注：`-port`/`-provider` 等 CLI 写入的 state 优先级高于同名 env（如 `MSLXDFF_PORT`），但 `MSLXDFF_<ID>_KEY` 单值 env 优先于 state 的多 key（便于容器/CI 临时覆盖）。

---

## 附录 B 状态文件

- **路径**：`MSLXDFF_STATE_FILE` 或 `~/.config/mslxdff/state.json`（`0600`）
- **daemon 派生**：`pidFile()`、`logFile()`、`calls.log`、`errors.log`、`events.log`、`models.json` 均在 `dirname(stateFile)` 下。
- **主要字段**：
  ```jsonc
  {
    "token": "64 hex",
    "createdAt": "2026-08-27T00:00:00.000Z",
    "port": 8989,
    "preferredModel": "big-pickle",
    "modelPicks": ["big-pickle", "openrouter/..."],
    "providerKeys": { "openrouter": ["sk-...","sk-..."] },
    "providerConfigs": { "myapi": { "baseUrl": "https://api.example.com/v1", "keys": ["sk-..."], "allowedModels": ["gpt-4", "gpt-3.5"] } },
    "providerShareKeys": { "openrouter": true },
    "peers": [],
    "groups": { "my@mslxd": { "members": { "leader": {...}, "http://...": {...} } } },
    "groupsJoined": [{ "name": "my@mslxd", "leaderUrl": "http://...", "myUrl": "...", "memberName": "...", "kind": "static|broadband" }],
    "bans": { "1.2.3.4": 1234567890 },
    "modelErrors": { "deepseek-...": { "status": "error", "at": 123, "code": 429 } },
    "modelLatencies": { "big-pickle": 123 }
  }
  ```
  `allowedModels` 空数组或缺失 = 不限；非空仅名单内可用（`403` 拦截，`/v1/models` 过滤）。
- **.gitignore**：`**/*state*.json`、`**/*key*.json` 等已加固，key 类 state 绝不进 repo。

---

## 附录 C 退出码与提示

- `0`：成功（`--help`/`--status`/`--log`/`--plugins`/`-model list` 等正常结束也为 0）。
- `1`：参数错误或业务失败（`invalid port`、`usage: ...`、`could not refresh models`、`join failed`、`remove failed`、`group remove requires being the leader` 等）。
- 常见 `console.error` 提示：
  - `usage: mslxdff -provider <id> [key...|add|remove|list|clear|share|set-url]` — `-provider` 缺 id。
  - `usage: mslxdff -provider add <id> <baseUrl> <key>` — 通用供应商缺参。
  - `opencode is the default (bare) provider — it needs no API key and can never be shared` — 对 `opencode` 执行 provider 操作。
  - `group remove requires being the leader — this node leads no group` — 非 leader 尝试踢人。
  - `member #N not found — group "name" has M member(s)` — 序号越界。
  - `"name" is led by http://... — you are a member, use -leavegroup to leave it` — 成员误用 `-delgroup`。
  - `not joined to any group` / `not a member of group` — 未加入或不在该组。

---

## 附录 D 交互式终端说明

- **触发条件**：`process.stdin.isTTY && process.stdout.isTTY` 同时为真。
- **涉及命令**：
  - `mslxdff -models`：多选勾选（`renderChooser`，ANSI 原地重绘，`↑/↓/Space/Enter/q`）。
  - `mslxdff -provider <id>`（无子命令）：隐藏输入多行追加（`readline/promises`，空行结束）。
- **非 TTY 行为**：一律走非交互分支（列表或报错提示用法），不会挂起等待输入，适合脚本/CI。
- **按键**：`parseKey` 识别 `up/down/enter/space/cancel`（`cancel` 为 `q/Esc/Ctrl+C`）。

---

> 维护者注意：改 `bin/mslxdff.js` 的参数解析后，务必同步更新本文件与 `docs/ARCHITECTURE.md §6` 的 CLI 表，并跑 `npm run docs:check`。
