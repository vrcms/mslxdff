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
| daemon | `-d` / `--daemon` | 后台启动 |
| 状态 | `-status` / `--status` / `-s` | 打印 daemon/群组/模型/调用 |
| 日志 | `-log [N]` / `--log [N]` / `-logs N` | 最近 N 条事件，默认10 |
| 调试 | `-debug` / `--debug` | 前台跟随事件流，Ctrl+C 恢复后台 |
| 插件 | `-plugins` / `--plugins` | 列插件与 hooks |
| 停止 | `-stop` / `--stop` | 停 daemon |
| 端口 | `-port N` / `--port N` | 持久化端口，运行中重启 |
| token 读 | `-showtoken` / `--showtoken` | 打印 Bearer token |
| token 刷 | `-refresh-token` / `--refresh-token` | 轮换并打印新 token |
| 更新 | `-update` / `--update` | 更新到 npm latest |
| 模型交互 | `-models` | TTY 交互多选勾常用模型 |
| 模型列表 | `-model list` | 列免费模型 |
| 模型设默认 | `-model set <id>` | 设首选模型，自动入 picks |
| 模型健康 | `-model status` | 每模型 normal/limit/error |
| 模型刷新 | `-model refresh` | 强制拉上游刷新 |
| 模型勾选 | `-model pick <id>` | 勾选入 picks |
| 模型去勾 | `-model unpick <id>` | 从 picks 移除 |
| 模型查勾 | `-model picks` | 列 picks |
| 模型清空 | `-model pick clear` | 清空 picks |
| 供应商 | `-provider <id> [keys]` | 批量设 keys（覆盖） |
| 供应商增 | `-provider <id> add <key>` | 追加单 key |
| 供应商删 | `-provider <id> remove <seq\|key> [more]` | 按序号或值删，逗号/空格均可 |
| 供应商列表 | `-provider <id> list` / `status` | 脱敏列 keys+share 状态 |
| 供应商清空 | `-provider <id> clear` | 清空该供应商 keys |
| 供应商共享 | `-provider <id> share [on\|off]` | 查/设 瞬时共享开关 |
| 同步 WB | `-setto workbuddy [modelId]` | 同步到 WorkBuddy |
| 建组 | `-creategroup <name>` / `-group create <name>` | 建组，本机为 leader |
| 加组 | `-addtogroup <host> <name> [--broadband]` | 加远端组，broadband 走中继 |
| 组同步 | `-group sync` | 刷新全组成员 |
| 组离开单 | `-group leave <name>` | 离开单组 |
| 组列表 | `-group list` | 列组+成员+健康/序号 |
| 组踢人 | `-group remove <seq>` | 仅 leader 按序号踢人 |
| 全部离开 | `-leavegroup` / `--leavegroup` | 离开所有成员组 |
| 解散组 | `-delgroup <name>` / `--delgroup` | 仅 leader 解散 |
| 解封禁 | `-resetban [ip]` / `--resetban [ip]` | 清加组封禁 |
| 帮助 | `-help` / `--help` / `-h` | 打印帮助 |

## 模型说明

- 裸 id 如 `big-pickle` 走默认供应商 opencode；带前缀如 `openrouter/google/gemma-3-27b-it:free` 走指定供应商。
- 实时可用模型由 `可用模型` 列表给出，必须照列表精确输出。

## 工具调用规范

- 时机：用户意图明确需执行命令时，调用 `run_command`；需查看文件时调用 `read_file`；需探活网络/服务时调用 `curl`。
- `run_command` 参数：`command: "-model set hy3-free"`（不含 mslxdff 前缀）
- `read_file` 参数：`path: "src/logs.js"` 或 `path: "~/.config/mslxdff/events.log"`（项目内或日志目录）
- `curl` 参数：`url: "upstream"` / `"local/health"` / `"https://opencode.ai/zen/v1/models"`，可选 `method`/`headers`/`body`/`timeoutMs`；简写自动补全完整 URL，上游自动补头、本机 /v1/* 自动带 token
- 一次一工具，执行后看结果再决定下一步。

## 示例

- 用户：`设置hy3为默认模型` → 你先查可用模型确认 `hy3-free` 存在 → `run_command: "-model set hy3-free"`
- 用户：`看看最近日志` → `run_command: "-log 20"` 或 `read_file: "logs"` 视情况
- 用户：`查看组列表` → `run_command: "-group list"`
