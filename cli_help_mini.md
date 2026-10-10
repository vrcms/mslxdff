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
| 状态 | `-status` / `--status` / `-s` | 打印 daemon/health/port/config、upstream providers（启用/key/baseUrl/allowlist/共享）、models（含 v0.1.59 体检表 avg首字/tps/啰嗦/p95）/群组/failover/recent calls(ts/model/status/dur)/last error/autostart/plugins — 全量聚合体检 |
| 用量报表 | `-stats` / `--stats` `[--hours N] [--json] [--model <id>]` | 默认统计**今日 0 点至现在**，`--hours N` 切近 N 小时滚动（上限 168）；输出 `Token 用量`（请求/输入/输出/思考/合计）与 `响应性能`（首字/总耗时/加权速度/**首字样本 n/N**）两张自适应边框表并含合计，长 id 不截断；k/M 缩写，`--json` 精确值。**首字 = 本次上游尝试开始 → 网关转发首个真实数据帧**（含排队/建连/判决预读，ADR-0039），`0ms` 有效、非流式不进分子与分母，N=0 显示 `—`；**思考四态**：上报值 / `~` 估算（思考字符÷4）/ `0` 真无 / `—` 未知（不再拿 0 冒充「不思考」）；与 `-status`/`-model stats` 的 EMA 首字**不同源**；速度仍为窗口加权 `Σ输出÷Σ生成耗时`；不含失败请求与 `-chat` 直连 |
| 日志 | `-log [N]` / `--log [N]` / `-logs N` | 最近 N 条事件 + `timeline.log` 人读时间线；按模型链路日志为 `logDir/<provider>-<model>.log`，逐阶段记录 request/route/upstream/peer/relay/result（安全摘要，不落 prompt/正文/凭据）。**事件面用黑名单**：默认全部可见，只排除 `peer-health`/`heartbeat`/`client-session`/`upstream-probe*`；决定类事件只渲染登记字段，含上游回显 `upstream=`/`account=`/`pick=`/`cooled=` |
| 回路语料捕获（第四条观测通道，**缺省开**） | `MSLXDFF_TALK_FULL`（**未设置即捕获**；只有显式关闭词 `0`/`off`/`false`/`no`/`disable`（trim+lowercase）才停写、且不建目录；`1`/`true`/`on`/`yes` 与任意其它取值=开，旧 `=1` 姿势继续有效；改 env 后必须 `cmd /c .\restart-daemon.bat` 重启才生效）+ `MSLXDFF_TALK_CAP_CHARS`（响应正文桶上限：缺省开 2000000／显式关 400000，正数 env 覆盖优先）+ `MSLXDFF_TALK_FULL_MAX_MB`(50)/`MSLXDFF_TALK_FULL_KEEP`(3，`0`=不留旧份)/`MSLXDFF_TALK_FULL_MAX_LINE_MB`(16) | 机读全量语料落 `<日志根>/talk/full/<供应商>-<模型>-talkfull.jsonl`（`0600`、按字节轮转，不是 1h 环形）：一行 = 一次上游尝试的 `system prompt` 全文 + 工具定义 + 完整历史（含往轮 tool 结果）+ 思考/正文/工具调用。**只捕 `hops=0` 的本机自发流量**——组员 `forwardToPeer` 转进来的对话（`hops>0`）**不落盘**，别把它当「全部流量」；`mslxdff -chat` 属 `hops=0` 会被捕。磁盘/内存账：缺省开 ⇒ 单模型最坏 `(KEEP+1)×MAX_MB`=200MB、在途请求正文桶上界 200 万字符。凭据落盘前双层脱敏；截断必显式（`meta.truncated`/`meta.cap`，`talk.log` 头行 `truncated=1`）。**读数（ADR-0046）**：`talk/*.log` 头行新增 `finish=<值>`（缺值 `finish=-`）与条件性 `relayMs=`（仅当 ≠`elapsed` 时出现），`elapsed=` 取**本次上游尝试墙钟**（缓冲重放不再报 2ms），零正文轮显式落 `[回答 · 0 字 · 本轮无正文（finish=…）]`，语料恒写 `meta.relayMs`；`events.log`（写前剥正文）、`<provider>-<model>.log`（不落正文）两条口径逐字不变，`talk/*.log` 除头行新字段与 `elapsed` 口径外不变（仍 1h+5MB、只留末条 user 提问）。止血 = 设 `MSLXDFF_TALK_FULL=0` 重启 + 删 `<日志根>/talk/full`。ADR-0045/0046 |
| 回路语料视图（**不是** mslxdff 子命令，禁止当 CLI 命令幻觉） | `node scripts/talkfull-view.js [--file <path>] [--model <供应商/模型id>] [--session <key>] [--tail N] [--all]` | 只读脚本（不建目录/不写文件/不改权限）：首行打印 `talk/full/` 目录总占用并提示**缺省已开**（`MSLXDFF_TALK_FULL=0` 可关）→ 按会话拼回路（`sessionKey` 形态 `sha1尾12-原值前8`）渲染 system 全文/工具清单/逐轮（与上一条前缀 diff 只打新增尾巴；逐轮 `elapsed` = 本次上游尝试墙钟，旧记录回落 `meta.relayMs` 并标注），并给「回路体检」五项读数（① 上下文膨胀曲线 ② 重复工具调用 同 name+同参数 ≥3 次 ③ 连续零输出轮 ≥2 ④ 思考循环措辞 ≥3 轮 ⑤ `finishReason=length` 且思考占比 ≥0.9），阈值随输出打印、缺判据不下结论；坏行跳过不致命；`--tail` 缺省 50，`--all` 出全文 |
| 网关代跑 WebSearch（Claude Code 内置搜索的唯一活路） | `MSLXDFF_WEB_SEARCH`（缺省 `tavily,exa,parallel`；`off`/`none`/`0`=关）+ `_TIMEOUT_MS`(15000，**整条后端链共享**)+ `_MAX_RESULTS`(8)/`_MAX_CHARS`(700)+ `_TAVILY_URL`/`_PARALLEL_URL`/`_EXA_URL`（换自建/内网）+ `_TAVILY_KEY`/`_PARALLEL_KEY`/`_EXA_KEY` | Claude Code 的 `WebSearch` 是 Anthropic **server tool**（搜索由推理服务端执行），接第三方模型后没人跑搜索 → 网关认出那发**搜索旁路请求**（`tools` 里有 `web_search_*` server tool + 消息以 `Perform a web search for the query: ` 开头）后自己搜，合成 `server_tool_use`+`web_search_tool_result` 直接回，**不打模型**；搜不到/关了/空查询一律 **400** 带原因（不把没工具的旁路丢给模型＝不编 URL）。其余不实现的 server tool 发上游前剥除，`tool_choice` 点名未声明工具降 `auto`（修订 ADR-0047）。**隐私账**：查询词与本机公网 IP 会离开本机到第三方免 key 端点；不缓存（Zero-state）、不进 token 账与 `talk/full`，只落 `events.log` 的 `web-search`/`web-search-unavailable` 行（含 `chain` 逐后端耗时）+ 回显头 `x-mslxdff-web-search`。ADR-0049 |
| 调试 | `-debug` / `--debug` | 前台跟随事件流，Ctrl+C 恢复后台 |
| 插件 | `-plugins` / `--plugins` | 列插件与 hooks |
| 停止 | `-stop` / `--stop` | 停 daemon |
| 重启 | `-restart` / `--restart` | 重启 daemon |
| 端口 | `-port N` / `--port N` | 持久化端口，运行中重启 |
| token 读 | `-showtoken` / `--showtoken` | 打印 Bearer token |
| token 刷 | `-refresh-token` / `--refresh-token` | 轮换并打印新 token |
| 更新 | `-update` / `--update` | 更新到 npm latest |
| 模型交互 | `-models` | TTY 交互多选勾常用模型（↑↓移动 ←→翻页 Space勾选 Enter保存，勾选框在名字前 `❯ [✓] <id>`；候选池=opencode免费池+已启用供应商allowlist原名/别名+已勾选+allowAny空白名单者的网关live模型，不存在/未启用provider不列出，启用后回来）；**勾选集即 `GET /v1/models` 对外目录**（非空只暴露勾选项，空=全量，`?all=1` 绕过取全量） |
| 模型列表 | `-model list [--provider <id>] [--json]` | 列免费模型：默认先列 opencode 免费池，`────────────────────────────────────────` 分隔后列其他供应商 allowlist（原名 + 别名 `别名: dash`）；`--provider cline` 只看该供应商 allowlist，`--json` 输出 `{"object":"list","data":[...]}` |
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
 | 供应商列表 | `-provider <id> list` / `status` | 脱敏列 keys/baseUrl/共享（`codearts`/`cline` 等硬排除显示"不借出"；codearts 每条 key 带 user/uid/domain 摘要） |
| 供应商模型 | `-provider <id> models [--json]` | 列该供应商可用模型（按 allowlist 过滤，`workbuddy/xxx` 前缀；`cline` 与聚合目录同源走 `recommended-models` 的 `free`+`clinePass`，**每次成功取数即把上游 id 自动并入 allowlist（只增不减，`MSLXDFF_CLINE_AUTOSYNC=0` 关）**，daemon 启动自检 free 增删写 `daemon.log`；`--json` 供脚本） |
| 供应商测速 | `-provider <id> bench [--json] [--prompt <text>] [--max-tokens N] [--timeout N]` | 仅测（allowlist ∩ 全局 picks）交集的速度（TTFB/总耗时/TPS），空则探活 `/v1/models→/models` 并提示先 pick；**deepseek 网页通道不支持 bench**（防禁言，改用 `-provider deepseek health` 体检） |
| 供应商选路 | `-provider <id> bench --via [--include-opencode] [--json] [--samples N] [--timeout N] [--apply]` / `-provider bench --via` | **家宽选路**：对比 `direct` vs 经每个在线 `peer` 的 `TTFB`（仅测 picks∩allowlist 交集，串行轻探针 `max_tokens=5`，`--json` 时进度走 `stderr`；默认跳过 `opencode`需 `--include-opencode`+TTY `y/N`；**deepseek 一律跳过**（防禁言）；结果不写 state；空组直接引导；`--apply` 落盘 `via-routes.json` 供显式锁模型单路径择路） |
  | Cline 登录 | `-provider cline login` | Cline WorkOS 设备授权拿 refreshToken 落盘；`cline` 走 `refresh→workos:token`+指纹头，deepseek 家族免 403（含 `cline-free/deepseek-*`；非流式内部强制 stream 聚合成 JSON，对外仍按请求方 stream）；多账号重复 login 追加（同邮箱替换不追加，`list` 显示邮箱）；直连 workos 被墙则 `set HTTPS_PROXY=http://127.0.0.1:7890` 后重试 |
| Cline 免费目录 | `-provider cline free [--json]` | 上游免费目录只读（`recommended-models` 的 `free`，5 个）：列目录 + 与当前 allowlist 的差异，不写 state |
| Cline 免费同步 | `-provider cline free sync [--yes] [--json] [--keep-extra]` | 把免费目录同步为 `cline` 的 allowlist（写裸 id）：**默认 dry-run，`--yes` 才落盘**；`--keep-extra` 只增不删；**全量替换**（会挤掉 daemon auto-sync 并入的 `cline-pass/*`）；**上游不可达时拒绝写盘**（不把内置兜底落成白名单） |
| Cline 用量 | `-provider cline quota [--json] [--account <hash>] [--model <substr>]` | 账号×模型双口径只读统计（`cline-usage.jsonl`）：free 显示本周期/已完成周期/累计，pass 显示近 24h/累计；`--json` 供脚本；空账本给引导 |
| Cline 迁移 | `-provider cline migrate [--dry-run]` | 旧 `providerConfigs.clinebot` 合并进 `cline`（keys 去重 + 剔 `sk_`、allowlist 求并）后删旧键，幂等、改前备份；**cline 恒 local-only**（不走组员、不借 key、只走本地直连，历史别名同样硬排除） |
| CodeArts 登录 | `-provider codearts login` | 华为云 CodeArts Agent（盘古助手）PKCE 浏览器授权：凭证 blob（refreshToken/codeVerifier/dpopJwk）落盘 `providerConfigs.codearts.keys`（一账号一 blob，多账号 keyring 轮转，默认 `allowAnyModels=true`）；此后 `codearts/<modelId>` 前缀（恒 `stream:true`，STS 临期自动刷新 + refresh_token 轮换原位写回，死号提示重登）；**恒 local-only** 不借 key（ADR-0027） |
| CodeArts 模型 | `-provider codearts models [--json]` | 三路发现（builtin 归一 + 代理型 + 福利网关），benefit 模型自动 claim（幂等 `0000`），对外带 `tags:["free:benefit"]` |
| TraeWork 登录 | `-provider traework login` | TRAE SOLO 通道浏览器授权（复刻 traework2api login.sh）：打印 trae.cn 授权链接 → 登录后粘贴 `127.0.0.1` 回调链接 → ExchangeToken → 落盘 `auths/trae-<uid>.json`（0600）+state 双写，自动签到+查积分；此后 `traework/<modelId>` 前缀（恒 `stream:true` SOLO SSE 透传/聚合，模型空/auto→`glm-5.2`，动态表+静态 32 回退；1005 plan 长冷却 12h、401 换号、429 短冷，过期前 24h 预刷新）；**恒 local-only** 不借出 key |
| DeepSeek 登录 | `-provider deepseek login --token <userToken>` 或 `login <email\|mobile> <password>` | DeepSeek 官网免费对话接入（ADR-0014）：userToken 在 chat.deepseek.com F12→Local Storage；无参数打印图文引导；落盘后 `allowAny on` + `-restart`；模型 `deepseek/{chat,reasoner,chat-search,reasoner-search}`；单账号 1 路并发，多号轮换 |
| DeepSeek 探活 | `-provider deepseek health [--json]` | 逐账号体检（防禁言）：检测禁言（自动冷却 5min）/限频前兆/凭据坏；网络失败不误伤；禁言解封后再探自动恢复 |
| 供应商改址 | `-provider <id> set-url <baseUrl>` | 改通用供应商地址 |
| 供应商改模型路径 | `-provider <id> set-models-path <path>` | 改 `models` 路径（如 `/v1/models`、`/v3/config`） |
| 供应商改对话路径 | `-provider <id> set-chat-path <path>` | 改 `chat` 路径（如 `/v1/chat/completions`、`/v2/chat/completions`） |
| 供应商清空 | `-provider <id> clear` | 清空该供应商 keys |
| 供应商共享 | key 随转发自动借出（ADR-0019，无开关无白名单） | 借道时自动附带；opencode/workbuddy/cline/codearts/traework 硬排除 |
| 供应商白名单 | `-provider <id> allowlist [list\|set\|add\|remove\|clear]` | 白名单空=阻塞除非 `allowAny on`，非空仅名单内可用（防昂贵模型） |
| 空名单开关 | `-provider <id> allowAny on\|off` | 空 allowlist 时放行或阻塞（默认 `OFF`，`opencode` 例外 `ON`） |
| 供应商总览 | `-providers list` / `-provider list` | 列所有已部署供应商及启用状态（含 allowlist 摘要） |
| WorkBuddy 接入（禁手填） | `禁止直接 -provider add workbuddy` | 用户说“接入/配置/登录 workbuddy / key哪里来 / 怎么用workbuddy”时**禁止**让用户手填`<key>`或执行`-provider add workbuddy ...`，必须**直接文字回复**（不调工具）：`请在项目根目录执行 node workbuddy-token-auto.js（前提已装 WorkBuddy 5.3.14 并浏览器登录 https://copilot.tencent.com 一次），脚本会自动抓 token、写 auths/workbuddy-*.json + state.json、自动签到`；仅当用户已贴出以`eyJ`开头的JWT时才可用`-provider add workbuddy https://copilot.tencent.com <贴的key>` |
| WorkBuddy 桌面导入 | `mslxdff -provider workbuddy import [--file=路径]` | 桌面已登录新号时最快：跨平台自动发现登录态（找不到时 `--file`/env `MSLXDFF_WORKBUDDY_DESKTOP_INFO` 显式指定），无需浏览器/抓包 |
| WorkBuddy 多号追加（路径A） | `mslxdff -provider workbuddy login` | 用户说“追加/添加 workbuddy 账号/多号/再加一个号”时**必须走路径A**：`run_command: "mslxdff -provider workbuddy login"`（设备授权：打印浏览器链接→用户用新账号登录→自动轮询落盘 `auths/workbuddy-<newUid>.json` + `state.json keys/auths`，不走抓包，桌面端不用退旧号）③ `run_command: "-workbuddy list"` 验证多号 ④ `run_command: "-workbuddy balance"` 看余额；新号次日自动纳入 daemon 每日签到；抓包兜底路径B：`node workbuddy-token-auto.js --force`（需桌面先切新号登录）；**禁止**让用户手贴 JWT（除非用户主动贴 `eyJ` 则走 `-provider add workbuddy` 路径C） |
| WorkBuddy 签到 | `-workbuddy checkin` / `-wb checkin` | 用户说“签到/每日签到/100积分/领积分”时**调用 run_command**；多号并行3，双域幂等 `code 10001 已签到`视为成功，`--json` 聚合余额；daemon 每日 09:00 自动全号签到（`MSLXDFF_WORKBUDDY_CHECKIN=0` 关，`_HOUR` 改时间） |
| Qoder 签到 | `-provider qoder checkin [--json] [--region cn\|global] [--any] [--dry]` | 用户说“qoder 签到/领积分”时**调用 run_command**；**按每号 region 选域名**（cn=`openapi.qoder.com.cn` 走 `daily-check-in`，409=今日已领；global=`openapi.qoder.sh` 无该端点→回落 campaigns），默认只领 `CLAIM_BENEFIT`（`--any` 才含 VIEW_DETAILS 促销），`--dry` 只查不领；daemon 每日 09:00 自动（`MSLXDFF_QODER_CHECKIN=0` 关，`_CHECKIN_HOUR` 改时间） |
| Qoder 接入 | `-provider qoder login [--region cn\|global]` | Qoder 设备授权（PKCE+poll）：打印兑换链接→浏览器登录→落盘 `auths/qoder-<uid>.json`+state；`--region cn` 走国内站 `qoder.com.cn`（默认国际站）；多号重复 login 追加，`qoder/<modelId>` 前缀路由，恒 local-only 不借出 |
| 千问办公接入 | `-provider qwenwork login` | 千问办公设备授权（PKCE+poll，`gateway.qwenwork.cn`）：打印兑换链接→浏览器确认→落盘 `auths/qwenwork-<uid>.json`+state；**默认 `allowAnyModels=false` + 只种 `flash/pro/qwen3.8-max-preview`**（额度是账号积分池，防 auto 烧分）；登录尾部显示套餐名+积分剩余；`qwenwork/<modelId>` 前缀路由，恒 local-only 不借出 |
| zcode 接入 | `-provider zcode login [--bigmodel]` | ZCode（智谱官方编程工作台）免费额度授权：打印 chat.z.ai 授权链接→浏览器登录→CLI 轮询（`oauth/cli/init`→`poll`）拿 JWT，落盘 `auths/zcode-<uid>.json`+state 并把内置目录（`GLM-5.3`/`GLM-5.3-Flash`/`GLM-5.2`/`GLM-5-Turbo`）并入 allowlist；`zcode/<modelId>` 前缀路由（Anthropic 网关，恒上游 stream，**免验证码**）；`--bigmodel` 切 bigmodel.cn；恒 local-only 不借出 |
| zcode 额度 | `-provider zcode quota [--json]` | 查 ZCode 套餐名/状态/有效期 + 各模型余量（`billing/balance` 分组表格）；空套餐给领取指引、401 给重登指引 |
| raccoon 接入 | `-provider raccoon login` | Raccoon（商汤小浣熊）扫码登录：生成 `qrcode_code`→终端二维码 + `login/mp?code=` 链接→**用微信「扫一扫」扫**并确认（浏览器直接打开链接会 404，站点 SPA 无该路由）→轮询拿 token，落盘 `auths/raccoon-<uid>.json`+state（`keys` 一律以文档为准，续期后自愈）并把兜底 6 模型并入 allowlist；`raccoon/<modelId>` 前缀路由（**OpenAI 兼容网关**，**免验证码**）；多号自动轮换：请求内撞积分不足/限流就当场换下一个号，**暂不支持手动指定用哪个号**；积分不足长冷 1h、限流短冷 30s；恒 local-only 不借出 |
| raccoon 积分 | `-provider raccoon quota [--json]` / `checkin` | 逐号查积分五分项 / 领「桌面端登录奖励」——**这家没有每日签到**：每日 300 与注册礼包 3000 由服务端自动发（无端点，每日 300 当天 23:59:59 清零），唯一要领的登录奖励 3000 是**每号一次性**且 `login` 时已自动领掉，`checkin` 只是补领兜底；判据只认账单、不认上游 `code:0`（重复领会虚回成功）；未登录给 login 指引；daemon 每日 09:00 兜底扫描未领过的号（`MSLXDFF_RACCOON_CHECKIN=0` 关，`_CHECKIN_HOUR` 改点） |
| WorkBuddy 成长任务 | `-workbuddy growth [--json]` / `-wb growth` | 成长任务全自动（拉列表→参与→触发→领奖，串行 1.2s/1s，已领幂等跳过）；可自动 `chat_5`/`automation_1`/`skill_1`/`Model_chat_GLM5.2`，需客户端任务标 MANUAL 不发包；daemon 每日 09:30 自动（`MSLXDFF_WORKBUDDY_GROWTH=0` 关，`_GROWTH_HOUR`/`_GROWTH_MODEL` 可配） |
| WorkBuddy 猫猫旅行 | `-workbuddy travel [--json]` / `-wb travel` | 无猫自动同意协议+领养（+300，门槛未达自动补一次对话解锁）；到站领奖 / 空闲派出（location 4）/ 旅行中跳过 |
| WorkBuddy 余额 | `-workbuddy balance [--json]` / `-wb balance` | 查多号余额（`total/dailyPacks/nextExpire`，TTL 5min） |
| WorkBuddy 列表 | `-workbuddy list` / `-wb list` | 列账号（`uid/domain/enterpriseId`） |
| WorkBuddy SDK 通道（缺省启用） | `MSLXDFF_WORKBUDDY_SDK`（未设置则继承 `MSLXDFF_UPSTREAM_ENGINE`） | 底层缺省走 `@ai-sdk/openai-compatible`（optionalDependencies，需 Node>=18，不可用自动回退原生）；设 `legacy`/关闭词回退原生 transport，上层轮换/刷新/reshape 不变 |
| 上游引擎（默认，ADR-0017） | `MSLXDFF_UPSTREAM_ENGINE`（缺省 `sdk`） | opencode 流式 chat 走 `@ai-sdk/openai-compatible`、`muse-spark*` 走 `@ai-sdk/openai` 的 responses 适配器（响应标记头 `x-mslxdff-upstream-engine: sdk`，复用 legacy 连接池）；通用 OpenAI 兼容族与 cline 同源（供应商级 `MSLXDFF_<ID>_SDK` 未设置即继承本变量）；非流式自动委派 legacy，SDK 不可用回退并告警；显式 `legacy`/关闭词回退原实现 |
| responses 类模型路由（ADR-0032） | `MSLXDFF_<ID>_RESPONSES_PATH`（缺省 `/responses`） | 通用带 key 供应商遇 responses 类模型（`muse-spark*` 等，判定与 `/v1/models` 的 `capabilities.upstreamApi` 同源）自动改打 `<baseUrl>/responses`（此前固定打 `chatPath` → 上游 503 `Endpoint is unavailable`）；流式走 `@ai-sdk/openai` responses 适配器（含加密思考往返），非流式/SDK 不可用走原生 `chatToResponsesBody` 转换，出参恒 chat 形状；异形上游用该 env 覆盖路径 |
| SDK 通道 headers 超时 | `MSLXDFF_SDK_HEADERS_TIMEOUT_MS`（缺省 `120000`） | 防 SDK 通道挂死：`doStream` 到点仍未返回响应头即判挂死抛错（由调用方回退/换路），`0`=关闭；错误文案**不含 "timed out"**（避免 cline runChat 按文案重试放大挂死） |
| 空转重试阶梯 | `MSLXDFF_EMPTY_TURN_RETRY_STEPS`（缺省 `[2000,8000,30000]`）/`MSLXDFF_EMPTY_TURN_RETRIES`/`MSLXDFF_EMPTY_TURN_MAX_WAIT_MS`（缺省 60000） | 上游 200 但零正文（客户端表现为 "The model ended its turn without producing any output"）时同模型重拉：按阶梯逐档 2s→8s→30s 等待，次数缺省跟随档数（`0`=关，空串=未设）；上游报 `retryAfterSeconds` 时本次等待被抬到不低于该窗口（封顶 `MAX_WAIT_MS`，防上游文本把请求挂 1 小时）；`STEPS=[]`=逃生阀回旧式固定 2s×2；非法值告警一次并落回默认阶梯（手滑不清零恢复能力）；事件 `empty-turn-retry` 带 `step/delayMs/waitedMs(累计)` |
| 空轮留口与终局收场（ADR-0043） | `MSLXDFF_EMPTY_TURN_HOLD_END`（默认开）/`MSLXDFF_EMPTY_TURN_BUDGET_MS`（45000）/`MSLXDFF_EMPTY_TURN_MIN_RAISE_TO`（16384） | 「200 但零正文」的空轮曾先 `res.end()` 再判定，重拉/换候选写的是已终结响应（客户端只看到空白）。现把「可撤销」定义为**尚未提交模型产出**：空 delta 帧与 `[DONE]` 暂扣不写、流结束不封口，交回重拉续写同一条连接；思考已刷出的一类撤不回 → 不留口，改在流尾补 `EMPTY_MODEL_RESPONSE` SSE 错误帧 + `[DONE]`（客户端看到具体原因而非莫名空白）。终局按 `res.headersSent` 分叉（未 flush→502 JSON / 已 flush→SSE 错误帧），单一出口 + `writableEnded` 守卫保证恰好一次；预算=请求级跨候选累计封顶；`MIN_RAISE_TO` 给"客户端没设额度"的主流空轮兜底抬一次（`0`=回旧口径不发明）；`HOLD_END=0` 逐字节回退旧行为 |
| 首发输出额度托底 | `MSLXDFF_EMPTY_TURN_MIN_TOKENS`（缺省 8192，`0`/负数=关）/`MSLXDFF_EMPTY_TURN_TINY_MAX`（缺省 64） | 客户端额度 < 门槛（算爆，实测 `max_completion_tokens=1` 被上游截成 1 token 碎渣、agent 循环停摆）→ 首发上游前托到托底值；只加不减、没设额度不发明、0/负数（上游默认语义）不托；serial-trial、auto-race 与宽带成员三处 `upstream.chat` 出口都托；事件 `output-floor`（`key/raiseFrom/raiseTo`） |
| 免费层形状门禁（ADR-0020） | `MSLXDFF_FREE_LANE`（缺省 1）/`MSLXDFF_FREE_LANE_DEBUG=1` | zen 免费模型必须 `stream:true` + tools 含 bash/edit/glob/grep/read 五名且 UA≥`opencode/1.18.0`（否则 403/426）；`src/free-lane.js` 自动补形状、非流式聚合回 JSON；`0`=关（逃生阀），DEBUG 打 `[free-lane]` 日志 |
| WorkBuddy 摘除 | `-workbuddy remove <uid> [--keep-file]` / `-wb remove` | 按 `uid`（前缀6位）摘除，删 `keys/auths` 与 `auths/workbuddy-<uid>.json` |
| 定号消耗 | `header x-mslxdff-workbuddy-uid: <uid>` 或 `model workbuddy/<uid>:<model>` | 钉死指定账号消耗，`x-mslxdff-workbuddy-uid` 回显实际账号 |
| 同步 WB | `-setto workbuddy [modelId]` | 同步到 WorkBuddy（原子写 `~/.workbuddy/models.json`，`127.0.0.1/v1`，多模型累积；picks 非空时摘除失效本地条目） |
| 同步 opencode | `-setto opencode [modelId\|--all]` | 把本地网关注册为 opencode 供应商（`provider.mslxdff`，`http://127.0.0.1:<port>/v1`，直写裸名如 `deepseek-v4-flash-free`，`/`→`-` 如 `bai/deepseek`→`bai-deepseek` 到 8989 自动还原，`--all` 批量同步全部 picks；picks 非空时摘除失效模型；自动附模型能力：models.dev 目录 + workbuddy 走上游原生字段，opencode 原生识别；写 variants 档位供 ctrl+t 切换（effort 型按档位写，toggle 型不写，TUI 改配置后需重启）） |
| 同步 chatgpt | `-setto chatgpt [modelId]` | 写 Codex 三端共用 `~/.codex/config.toml`（`model_providers.mslxdff` → `127.0.0.1/v1/responses`，鉴权走 `mslxdff -showtoken` 不落盘），换模型重跑 setto 或 `codex exec -m <id>` 单次覆盖，`codex exec "hi"` 验证；排障 `MSLXDFF_RESPONSES_DEBUG=1` 看 daemon.log `[responses]` |
| 同步 Claude Code | `-setto claude [modelId] [--behaves-as <id>]` | 写 Claude Code 用户设置 `~/.claude/settings.json`（`CLAUDE_CONFIG_DIR` 可改址）：`env.ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`（**不带 /v1**）+ 明文 `ANTHROPIC_AUTH_TOKEN` + `CLAUDE_CODE_ATTRIBUTION_HEADER=0`/`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` + `model` + `modelPicker.options`；**不带 modelId = 写入 `modelPicks` 勾选集全集**（顶层 `model` 也只在勾选集内取，picks 空则报错退出，不兜底到可能已失效的 `preferredModel`；`--all` 与之同义）；`behavesAs` 只给客户端不认识的 id（缺省 `claude-sonnet-5`，`claude-*` 行不写；实测无映射的未知 id 会被本机 Claude Code 直接拒跑）（ADR-0047 `/v1/messages` 外壳）；只动这些键、其余键与键序保留，首写前一次性备份 `settings.pre-mslxdff.json`（不覆盖），JSON 解析失败拒写、写不进即报错不谎报；排障 `MSLXDFF_ANTHROPIC_DEBUG=1` 看 daemon.log `[messages]` |
| 接 Claude Desktop（3P） | `-setto claude-desktop [modelId ...] [--max N] [--max-effort <lvl>] [--no-alias] [--check] [--official]`、`-claude-desktop status\\|slots\\|check` | 桌面端**不读** `ANTHROPIC_BASE_URL`/`settings.json`，只读自家 3P profile 且只认「三档角色 ID」→ 一次写两处：① `%LOCALAPPDATA%\Claude-3p\configLibrary\<uuid>.json` + `_meta.json`（uuid 由端口派生、只 upsert 自家条目、他人 entry 不动、损坏拒写、幂等按**原文 vs 原文**、明文 token `0600`、baseUrl **不带 /v1**、`authScheme=bearer`（本仓 `authorized()` 只认 Bearer）、`inferenceModels[{name:角色槽,labelOverride:真模型名}]`）② `model-aliases.json` 写「角色槽 → 真模型」（入站 `src/chat-pipeline/policy.js` 生效、`getModelAlias` 未命中即重读 → **不重启 daemon**）；槽位上限 12（取 App 签名 `model-catalog`，前三档 sonnet/opus/haiku，Haiku 供子 agent），缺 alias 时 App 探活 30–90 s 后 502；`--official` 摘登记不删配置；不写 `preferredModel`、不碰 `claude_desktop_config.json` 与注册表策略；⚠ **App 不热重载**，写完须完全退出重开并选 3P 入口（免 claude.ai 登录）（ADR-0048） |
| 建组 | `-creategroup <name>` / `-group create <name>` | 建组，本机为 leader |
| 加组 | `-addtogroup <host> <name> [--broadband]` | 加远端组，broadband 走中继（不占端口纯出站）；**零参数/单参数进手机宽带向导**：问组长地址+组名，自动起服务，回报出口 IP |
| 组同步 | `-group sync` | 刷新全组成员 |
| 组离开单 | `-group leave <name>` | 离开单组 |
| 组列表 | `-group list` | 列组+成员+健康/序号 |
| 组踢人 | `-group remove <seq>` | 仅 leader 按序号踢人 |
| 全部离开 | `-leavegroup` / `--leavegroup` | 离开所有成员组 |
| 解散组 | `-delgroup <name>` / `--delgroup` | 仅 leader 解散 |
| 解封禁 | `-resetban [ip]` / `--resetban [ip]` | 清加组封禁 |
| 组员开关 | `-use-group [on\|off]` / `--use-group [on\|off]` | opencode 失败时是否走组员（默认 on，off 则所有供应商仅本机；key 供应商默认恒直连，`MSLXDFF_USE_GROUP_KEYS=1` 可开回；cline/workbuddy 恒禁） |
| 白嫖雷达 | `-free` / `--free` / `-free-check` / `--free-check` | V2EX 单源白嫖雷达（`latest.json + hot.json` 按白嫖|限免|免费额度过滤） |
| 白嫖 watch | `-free-watch` / `--free-watch` | V2EX 白嫖雷达 watch（每 5 分钟轮询） |
| 自启开 | `-enable-autostart` / `--enable-autostart` | 开机自启（Windows 任务计划 / Linux systemd） |
| 自启关 | `-disable-autostart` / `--disable-autostart` | 关闭开机自启 |
| 自启状态 | `-autostart status` / `--autostart status` | 查看自启状态 |
| 时区 | `-timezone [set <tz>\|clear\|status]` / `-tz` | 时区配置，默认 `Asia/Shanghai`，可设 `UTC` 等（`MSLXDFF_TZ` 覆盖） |
| 帮助 | `-help` / `--help` / `-h` | 打印帮助 |

## 模型说明

- 裸 id 如 `big-pickle` 走默认供应商 opencode；带前缀如 `bai/glm-5.3-flash`、`openrouter/google/gemma-3-27b-it:free`、`workbuddy/hy3`、`cline/z-ai/glm-5.3-flash` 走指定供应商。
- 实时可用模型由 `可用模型` 列表给出（已按供应商聚合，含 bai/ 等前缀），必须照列表精确输出。
- 查“某供应商有哪些模型”**优先用 CLI 直查**：`run_command: "-provider workbuddy models"` 或 `run_command: "-model list --provider workbuddy"`（表格含能力列：上下文/📷读图/🧠推理/🔧工具调用，`--json` 供脚本），或 `curl local/models` 后前缀过滤；查模型能力（推理档位/读图/上下文/价格）用 `curl local/models/capabilities?id=<模型id>`（opencode 默认源 models.dev；workbuddy 用 `?provider=workbuddy&id=<裸id>` 走上游原生字段、全量含 blocked，ADR-0016）；**禁止**调 `-provider workbuddy list`（这是查配置，不是查模型！）。**错误示例**：`workbuddy有哪些模型` → 调 `-provider workbuddy list` → 错。**正确**：`run_command: "-provider workbuddy models"` 直接列 `workbuddy/` 前缀模型。严禁为此调用 `-showtoken`。

## 工具调用规范

- 时机：用户意图明确需执行命令时，调用 `run_command`；需查看文件时调用 `read_file`；需探活网络/服务时调用 `curl`。
- `run_command` 参数：`command: "-model set hy3-free"`（不含 mslxdff 前缀）；`-showtoken` 仅用户明确要求看 token 时才用，查模型/供应商禁止用。
- **严禁幻觉命令**：`mslxdff "hi" --model X` / `mslxdff --model X "hi"` / `mslxdff -chat --model X` 等**不存在**，一律禁止。探活模型**必须**用 `curl` POST 本机网关，见下一条。
- `read_file` 参数：`path: "src/logs.js"` 或 `path: "~/.config/mslxdff/events.log"`（项目内或日志目录）
- `curl` 参数：`url: "upstream"` / `"local/health"` / `"local/models"` / `"bai/models"` / `"https://api.b.ai/v1/models"`，可选 `method`/`headers`/`body`/`timeoutMs`；简写自动补全完整 URL，上游自动补头（含 UA `opencode/<semver>` + opencode 形状 session/request，zen 免费层门禁需要）、本机 /v1/* 自动带 token、已配置供应商（bai/openrouter 等）自动带对应 key
- **模型探活固定写法**：`curl` 工具 `url:"http://localhost:8989/v1/chat/completions"` `method:"POST"` `headers:{"Content-Type":"application/json"}` `body:'{"model":"<前缀/模型>","messages":[{"role":"user","content":"hi"}],"stream":false}'`（如 `cline/z-ai/glm-5.3-flash`、`workbuddy/hy3`）；成功 `200 + x-mslxdff-via:local` 即通，`401` 代表本机 token 失效需提示用户 `mslxdff -stop && mslxdff`，`403 + x-mslxdff-allowlist:1` 代表白名单未放行需 `allowlist add`，`429/5xx` 代表上游限流/故障。
- **禁止重复调用（最高优先级）**：同一 `run_command`/`curl`/`read_file` 在本轮只执行一次，重复会被 `SKIPPED_DUP` 拦截；**查询类（-showtoken/-status/-provider list/-providers list/-model list/-group list/-log 等）调用一次即答案**，拿到 `OK` 后必须**立即用中文直接回答**，禁止再调同类命令。收到 `SKIPPED_DUP` 或“请直接回答”时必须 0 工具直接回答。
- 一次一工具，执行后看结果再决定下一步；拿到工具结果后优先直接回答，不要无故再调。

## 示例

- 用户：`设置hy3为默认模型` → 你先查可用模型确认 `hy3-free` 存在 → `run_command: "-model set hy3-free"`
- 用户：`看看最近日志` → `run_command: "-log 20"` 或 `read_file: "logs"` 视情况
- 用户：`查看组列表` → `run_command: "-group list"`
- 用户：`把 deepseek 加到 opencode` → 先查可用模型确认 `deepseek-v4-flash-free` 全称 → `run_command: "-setto opencode deepseek-v4-flash-free"`（存 `deepseek-v4-flash-free`，选 `mslxdff/deepseek-v4-flash-free` 直达）
- 用户：`把 bai 模型加到 opencode` → 确认 `bai/deepseek-v4-flash` → `run_command: "-setto opencode bai/deepseek-v4-flash"`（存 `bai-deepseek-v4-flash`，到 8989 自动还原 `bai/deepseek-v4-flash`）
- 用户：`把所有模型同步到 opencode` → `run_command: "-setto opencode --all"`（批量 picks 全进菜单）
- 用户：`把当前模型同步到 opencode` → `run_command: "-setto opencode"`（无参取 preferredModel）
- 用户：`测试z-ai/glm-5.3-flash连通性` → **禁止** `run_command: "\"hi\" --model cline/z-ai/glm-5.3-flash"`，必须 `curl: {url:"http://localhost:8989/v1/chat/completions", method:"POST", headers:{"Content-Type":"application/json"}, body:"{\"model\":\"cline/z-ai/glm-5.3-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}"}`
