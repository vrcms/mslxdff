# ADR-0009: 对话终端 mslxdff -chat（mimo 优先，独立进程，历史压缩）

- 状态：已接受
- 日期：2026-08-27
- 版本：0.1.58

## 背景

`mslxdff` 的 CLI 参数已达 30+，用户常说简称（`hy3`→`hy3-free`）且希望自然语言直接执行。需要一个常驻终端把自然语言翻译成精确命令，保持与 daemon 生命周期解耦，且不引入额外运维负担。

## 决策

- 新增 `mslxdff -chat ["prompt"]`：
  - 无 prompt → 常驻 REPL（`mimo> `，readline，上下历史，`/help /clear /history /exit`）
  - 有 prompt → 单次执行后退出
- 模型：**优先 `mimo-v2.5-free`，失败自动降级 `big-pickle`**（`chatWithFallback`），与上游共用 `createUpstreamClient`（`x-opencode-client: desktop` + `Bearer public`）。
- 工具仅 2 个：`run_command`（执行 `cli_help.md` 所列任意命令，**仅拦截 `-uninstall`**，`-stop`/`-port` 可执行，模糊匹配与精确性由大模型负责）与 `read_file`（限项目根 `pkgRoot` + `logDir()` + `stateDir`，超限截断）。
- 提示词：`docs/cli_help_mini.md`（AI 精简版，4.3KB）+ 实时可用模型列表（`models.json` 缓存或硬编码兜底）注入 system。
- 历史：`~/.config/mslxdff/chat-history.json`（`MSLXDFF_CHAT_HISTORY` 可覆盖），存最近 60 条；REPL 为前台独立进程（`bin` 中 `await startChat()` 直接跑，不经 `startDaemon`），daemon 重启不影响。
- 压缩：当 `estimateChars(messages) > 18000` 时触发——保留 `system + 最近 8 条`，将其余旧消息让**大模型自己摘要**（`summarizeHistory` 发一次 mimo/big-pickle 调用，约束“300 字内中文摘要，保留关键操作与偏好”），成功用 `【历史摘要】` 替代，失败则截断。原理是**用模型压缩模型**，避免固定截断丢上下文。

## 后果

- 正面：自然语言可用，模糊匹配由模型完成，无需代码归一；历史持久化且长期对话不爆上下文；独立进程语义清晰。
- 负面：每轮多一次上游调用（工具循环最多 6 次），且压缩时额外一次摘要调用。
- 兼容：不影响 daemon、group、provider 等现有链路；`printHelp` 新增 `-chat` 行。

## 备选

- 代码侧做 `hy3`→`hy3-free` 归一：被否，用户明确要求由大模型自行查精确名称。
- 把 chat 做成 daemon 子进程：被否，用户要求 daemon 重启不影响 chat。

## 关联

- `docs/cli_help_mini.md`（AI 专用手册）
- `src/chat/*`（config/store/tools/prompt/upstream/repl/index）
- `ARCHITECTURE.md §6/§7` 与 `cli_help.md §9`
