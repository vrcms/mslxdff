# mslxdff CLI 精简手册（AI 专用）

> 给 `mslxdff -chat` 的大模型看。含全部可用命令的**精确语法**，模型必须照此输出，禁止自创参数。人类详版见 `cli_help.md`。

## 约定

- 单/双横线等价：`-status`=`--status`，`-help`=`--help`/`-h`。
- 所有命令前缀 `mslxdff`，工具调用时传 `command` 字段，值形如 `"-model set big-pickle"`（不含 `mslxdff` 前缀，执行侧自动补）。
- `read_file` 仅限项目内：相对路径 `src/...`、`docs/...`、`package.json`、`logs` 等；绝对路径必须在 `D:\www\wwwroot\mslxdff` 或 `~/.config/mslxdff` 下，否则拒绝。
- 禁止执行的唯一命令：`-uninstall` / `--uninstall`（任何包含此的是拒绝）。
- 模糊匹配由你完成：用户说 `hy3` 你必须查模型列表找到 `hy3-free` 再输出，全称以实时 `可用模型` 为准。

## 可用命令全表

| 命令 | 语法 | 说明 |
|---|---|---|
| 无参启动 | `mslxdff` | 已有 daemon 显示 status，否则后台启动 |
| daemon | `-d` / `--daemon` | 后台启动（只升不降，低版本不覆盖高版本） |
| 状态 | `-status` / `--status` / `-s` | 打印 daemon/health/port/config、upstream providers（启用/key/baseUrl/allowlist/share）、models（含 v0.1.59 体检表 avg首字/tps/啰嗦/p95）/群组/failover/recent calls(含首字/tps)/last error/autostart/plugins — 全量聚合体检 |
| 日志 | `-log [N]` / `--log [N]` / `-logs N` | 最近 N 条事件，默认10（含首字/tps/tok 详情） |
| 调试 | `-debug` / `--debug` | 前台跟随事件流，Ctrl+C 恢复后台 |
| 插件 | `-plugins` / `--plugins` | 列插件与 hooks |
| 停止 | `-stop` / `--stop` | 停 daemon |
| 重启 | `-restart` / `--restart` | 重启 daemon |
| 端口 | `-port N` / `--port N` | 持久化端口，运行中重启 |
| token 读 | `-showtoken` / `--showtoken` | 打印 Bearer token |
| token 刷 | `-refresh-token` / `--refresh-token` | 轮换并打印新 token |
| 更新 | `-update` / `--update` | 更新到 npm latest |
| 模型交互 | `-models` | TTY 交互多选勾常用模型（↑↓移动 Space勾选 Enter保存，候选池=opencode免费池+各供应商allowlist原名/别名+已勾选，`别名: dash` 同步展示） |
| 模型列表 | `-model list [--provider <id>] [--json]` | 列免费模型：默认先列 opencode 免费池，`────────────────────────────────────────` 分隔后列其他供应商 allowlist（原名 + 别名 `别名: dash`）；`--provider clinebot` 只看该供应商 allowlist，`--json` 输出 `{"object":"list","data":[...]}` |
| 模型设默认 | `-model set <id>` | 设首选模型，自动入 picks |
| 模型健康 | `-model status` | 每模型 normal/limit/error |
| 模型刷新 | `-model refresh` | 强制拉上游刷新 |
| 模型勾选 | `-model pick <id>` | 勾选入 picks |
| 模型去勾 | `-model unpick <id>` | 从 picks 移除 |
| 模型查勾 | `-model picks` | 列 picks |
| 模型清空 | `-model pick clear` | 清空 picks |
| 模型探活（必用 curl） | `curl` POST `http://localhost:8989/v1/chat/completions` body `{"model":"<id>","messages":[{"role":"user","content":"hi"}]}` | 测试指定模型是否通，**禁止** `mslxdff "hi" --model X` / `mslxdff --model X "hi"` 等幻觉命令 |
| 供应商新增 | `-provider add <id> <baseUrl> <key> [allowedModel...] [--models-path <path>] [--chat-path <path>]` | 一键添加通用 OpenAI 兼容供应商（末尾可带白名单；默认 `allowAny OFF` 空名单=禁用，需 `allowlist set` 或 `allowAny on` 否则 `403`；`workbuddy`除外；`--models-path`/`--chat-path` 可配异形路径如 `/v1/models`） |
| 供应商 | `-provider <id> [keys]` | 批量设 keys（覆盖） |
| 供应商增 | `-provider <id> add <key>` | 追加单 key |
| 供应商删 | `-provider <id> remove <seq\|key> [more]` | 按序号或值删，逗号/空格均可 |
| 供应商列表 | `-provider <id> list` / `status` | 脱敏列 keys+share/baseUrl |
| 供应商模型 | `-provider <id> models [--json]` | 列该供应商可用模型（按 allowlist 过滤，`workbuddy/xxx` 前缀；`--json` 供脚本） |
| 供应商测速 | `-provider <id> bench [--json] [--prompt <text>] [--max-tokens N] [--timeout N]` | 仅测已勾选 allowlist 的模型速度（TTFB/总耗时/TPS），空则探活 `/v1/models→/models` 并提示先 pick |
| 供应商改址 | `-provider <id> set-url <baseUrl>` | 改通用供应商地址 |
| 供应商改模型路径 | `-provider <id> set-models-path <path>` | 改 `models` 路径（如 `/v1/models`、`/console/enterprises/personal/models`） |
| 供应商改对话路径 | `-provider <id> set-chat-path <path>` | 改 `chat` 路径（如 `/v1/chat/completions`、`/v2/chat/completions`） |
| 供应商清空 | `-provider <id> clear` | 清空该供应商 keys |
| 供应商共享 | `-provider <id> share [on\|off]` | 查/设 瞬时共享开关 |
| 供应商白名单 | `-provider <id> allowlist [list\|set\|add\|remove\|clear]` | 白名单空=阻塞除非 `allowAny on`，非空仅名单内可用（防昂贵模型） |
| 空名单开关 | `-provider <id> allowAny on\|off` | 空 allowlist 时放行或阻塞（默认 `OFF`，`opencode` 例外 `ON`） |
| 供应商总览 | `-providers list` / `-provider list` | 列所有已部署供应商及启用状态（含 allowlist 摘要） |
| WorkBuddy 接入（禁手填） | `禁止直接 -provider add workbuddy` | 用户说“接入/配置/登录 workbuddy / key哪里来 / 怎么用workbuddy”时**禁止**让用户手填`<key>`或执行`-provider add workbuddy ...`，必须**直接文字回复**（不调工具）：`请在项目根目录执行 node workbuddy-token-auto.js（前提已装 WorkBuddy 5.3.14 并浏览器登录 https://copilot.tencent.com 一次），脚本会自动抓 token、写 auths/workbuddy-*.json + state.json、自动签到`；仅当用户已贴出以`eyJ`开头的JWT时才可用`-provider add workbuddy https://copilot.tencent.com <贴的key>` |
| WorkBuddy 多号追加（路径A） | `node workbuddy-token-auto.js` | 用户说“追加/添加 workbuddy 账号/多号/再加一个号”时**必须走路径A**：① 文字提示“请先在 WorkBuddy 桌面退出当前账号，用新账号重新登录 https://copilot.tencent.com（能对话即成功）”② 待用户回复“已登录/好了”后`run_command: "node workbuddy-token-auto.js"`（whistle :8899 自动追加 `auths/workbuddy-<newUid>.json` + `state.json keys/auths`，并行签到）③ `run_command: "-workbuddy list"` 验证多号 ④ `run_command: "-workbuddy balance"` 看余额；**禁止**让用户手贴 JWT（除非用户主动贴 `eyJ` 则走 `-provider add workbuddy` 路径B） |
| WorkBuddy 签到 | `-workbuddy checkin` / `-wb checkin` | 用户说“签到/每日签到/100积分/领积分”时**调用 run_command**；多号并行3，双域幂等 `code 10001 已签到`视为成功，`--json` 聚合余额 |
| WorkBuddy 余额 | `-workbuddy balance [--json]` / `-wb balance` | 查多号余额（`total/dailyPacks/nextExpire`，TTL 5min） |
| WorkBuddy 列表 | `-workbuddy list` / `-wb list` | 列账号（`uid/domain/enterpriseId`） |
| WorkBuddy 摘除 | `-workbuddy remove <uid> [--keep-file]` / `-wb remove` | 按 `uid`（前缀6位）摘除，删 `keys/auths` 与 `auths/workbuddy-<uid>.json` |
| 定号消耗 | `header x-mslxdff-workbuddy-uid: <uid>` 或 `model workbuddy/<uid>:<model>` | 钉死指定账号消耗，`x-mslxdff-workbuddy-uid` 回显实际账号 |
| 同步 WB | `-setto workbuddy [modelId]` | 同步到 WorkBuddy（原子写 `~/.workbuddy/models.json`，`127.0.0.1/v1`，多模型累积） |
| 同步 opencode | `-setto opencode [modelId]` | 把本地网关注册为 opencode 供应商（`provider.mslxdff`，`http://127.0.0.1:<port>/v1`，默认 `mslxdff-<id>` alias 防重名，原名仍兼容，重复幂等） |
| 建组 | `-creategroup <name>` / `-group create <name>` | 建组，本机为 leader |
| 加组 | `-addtogroup <host> <name> [--broadband]` | 加远端组，broadband 走中继 |
| 组同步 | `-group sync` | 刷新全组成员 |
| 组离开单 | `-group leave <name>` | 离开单组 |
| 组列表 | `-group list` | 列组+成员+健康/序号 |
| 组踢人 | `-group remove <seq>` | 仅 leader 按序号踢人 |
| 全部离开 | `-leavegroup` / `--leavegroup` | 离开所有成员组 |
| 解散组 | `-delgroup <name>` / `--delgroup` | 仅 leader 解散 |
| 解封禁 | `-resetban [ip]` / `--resetban [ip]` | 清加组封禁 |
| 白嫖雷达 | `-free` / `--free` / `-free-check` / `--free-check` | V2EX 单源白嫖雷达（`latest.json + hot.json` 按白嫖|限免|免费额度过滤） |
| 白嫖 watch | `-free-watch` / `--free-watch` | V2EX 白嫖雷达 watch（每 5 分钟轮询） |
| 自启开 | `-enable-autostart` / `--enable-autostart` | 开机自启（Windows 任务计划 / Linux systemd） |
| 自启关 | `-disable-autostart` / `--disable-autostart` | 关闭开机自启 |
| 自启状态 | `-autostart status` / `--autostart status` | 查看自启状态 |
| 时区 | `-timezone [set <tz>\|clear\|status]` / `-tz` | 时区配置，默认 `Asia/Shanghai`，可设 `UTC` 等（`MSLXDFF_TZ` 覆盖） |
| 帮助 | `-help` / `--help` / `-h` | 打印帮助 |

## 模型说明

- 裸 id 如 `big-pickle` 走默认供应商 opencode；带前缀如 `bai/glm-5.3-flash`、`openrouter/google/gemma-3-27b-it:free`、`workbuddy/hy3` 走指定供应商。
- 实时可用模型由 `可用模型` 列表给出（已按供应商聚合，含 bai/ 等前缀），必须照列表精确输出。
- 查“某供应商有哪些模型”**优先用 CLI 直查**：`run_command: "-provider workbuddy models"` 或 `run_command: "-model list --provider workbuddy"`（按 allowlist 过滤，`--json` 供脚本），或 `curl local/models` 后前缀过滤；**禁止**调 `-provider workbuddy list`（这是查配置，不是查模型！）。**错误示例**：`workbuddy有哪些模型` → 调 `-provider workbuddy list` → 错。**正确**：`run_command: "-provider workbuddy models"` 直接列 `workbuddy/` 前缀模型。严禁为此调用 `-showtoken`。

## 工具调用规范

- 时机：用户意图明确需执行命令时，调用 `run_command`；需查看文件时调用 `read_file`；需探活网络/服务时调用 `curl`。
- `run_command` 参数：`command: "-model set hy3-free"`（不含 mslxdff 前缀）；`-showtoken` 仅用户明确要求看 token 时才用，查模型/供应商禁止用。
- **严禁幻觉命令**：`mslxdff "hi" --model X` / `mslxdff --model X "hi"` / `mslxdff -chat --model X` 等**不存在**，一律禁止。探活模型**必须**用 `curl` POST 本机网关，见下一条。
- `read_file` 参数：`path: "src/logs.js"` 或 `path: "~/.config/mslxdff/events.log"`（项目内或日志目录）
- `curl` 参数：`url: "upstream"` / `"local/health"` / `"local/models"` / `"bai/models"` / `"https://api.b.ai/v1/models"`，可选 `method`/`headers`/`body`/`timeoutMs`；简写自动补全完整 URL，上游自动补头、本机 /v1/* 自动带 token、已配置供应商（bai/openrouter 等）自动带对应 key
- **模型探活固定写法**：`curl` 工具 `url:"http://localhost:8989/v1/chat/completions"` `method:"POST"` `headers:{"Content-Type":"application/json"}` `body:'{"model":"<前缀/模型>","messages":[{"role":"user","content":"hi"}],"stream":false}'`（如 `clinebot/z-ai/glm-5.3-flash`、`workbuddy/hy3`）；成功 `200 + x-mslxdff-via:local` 即通，`401` 代表本机 token 失效需提示用户 `mslxdff -stop && mslxdff`，`403 + x-mslxdff-allowlist:1` 代表白名单未放行需 `allowlist add`，`429/5xx` 代表上游限流/故障。
- **禁止重复调用（最高优先级）**：同一 `run_command`/`curl`/`read_file` 在本轮只执行一次，重复会被 `SKIPPED_DUP` 拦截；**查询类（-showtoken/-status/-provider list/-providers list/-model list/-group list/-log 等）调用一次即答案**，拿到 `OK` 后必须**立即用中文直接回答**，禁止再调同类命令。收到 `SKIPPED_DUP` 或“请直接回答”时必须 0 工具直接回答。
- 一次一工具，执行后看结果再决定下一步；拿到工具结果后优先直接回答，不要无故再调。

## 示例

- 用户：`设置hy3为默认模型` → 你先查可用模型确认 `hy3-free` 存在 → `run_command: "-model set hy3-free"`
- 用户：`看看最近日志` → `run_command: "-log 20"` 或 `read_file: "logs"` 视情况
- 用户：`查看组列表` → `run_command: "-group list"`
- 用户：`把 deepseek 加到 opencode` → 先查可用模型确认 `deepseek` 全称 → `run_command: "-setto opencode deepseek"`（实际落 `mslxdff-deepseek`，原名 `deepseek` 仍可直用，重复幂等）
- 用户：`把当前模型同步到 opencode` → `run_command: "-setto opencode"`（无参取 preferredModel）
- 用户：`测试z-ai/glm-5.3-flash连通性` → **禁止** `run_command: "\"hi\" --model clinebot/z-ai/glm-5.3-flash"`，必须 `curl: {url:"http://localhost:8989/v1/chat/completions", method:"POST", headers:{"Content-Type":"application/json"}, body:"{\"model\":\"clinebot/z-ai/glm-5.3-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}"}`
