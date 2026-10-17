# mslxdff 缺陷清单

> 采集时间：2026-10-17 15:11–15:26（daemon pid 25716 / v0.1.187）
> 采集范围：`~/.config/mslxdff/` 下的 `mimo-v2.6-flash-free.log`、`deepseek-v4.1-flash-free.log`、
> `talk/*.log`、`talk/full/*.jsonl`、`errors.log`、`events.log`、`state.json`、`daemon.log`
> 说明：每条给出「现象 → 证据坐标 → 根因 → 影响 → 修复方向」。

## 修复进度（2026-10-17 18:00 第一轮）

| 编号 | 状态 | 落地位置 |
|---|---|---|
| BUG-1 | ✅ 已修 | `src/routes/peers.js` forwardToPeer 等待上限提到 120s（与 bodyTimeout 同档），真正的闸门交给阶段总预算 |
| BUG-2 | ✅ 已修 | `src/routes/peers.js` peerStageCtx + `MSLXDFF_PEER_RACE_BUDGET_MS`（默认 45s），三批共享 deadline；peer-handler/hedge 同步接入 |
| BUG-3 | ✅ 已修 | 失败不再上报 `peer-forward`，改报 `peer-attempt`（ok:false + status），成功路径照旧 `peer-forward` |
| BUG-4 | ✅ 已修 | 连接级失败（ECONNREFUSED/ENOTFOUND…）连续 2 次 → `deadFails` 长冷却，且被 `coolingByLastError` 排除；成功清零 |
| BUG-5 | ✅ 已修 | 中间 peer 失败不再写 errors.log（改 events 流），errors.log 只留真正终止客户端的失败 |
| BUG-6 | ✅ 已修 | `peer-request`/`peer-forward`/`peer-attempt`/`peer-error` 全部带 `name`（节点名） |
| BUG-7 | ✅ 已修（收窄口径） | 仅**裸 id free 模型** + 仅**额度类**失败（429/FreeUsageLimitError）才横向切同池兄弟（上限 4）；参数错/5xx 仍原样透传；`MSLXDFF_FREE_POOL_FALLBACK=0` 回退 |
| BUG-8 | ✅ 已修 | `FreeUsageLimitError` 纳入终局判决（裸 "Rate limit exceeded" 不收，换号可能就好） |
| BUG-9 | ✅ 已修 | 删除死代码 `isFastFailStatus` 及其测试（未接入生产逻辑的误导性导出） |

验证：全量 `node --test --test-concurrency=1 test/*.test.js` → 2019 项 0 失败；`npm run docs:check` exit 0；
端到端实测确认（黑洞组员 3×30s → 2.55s 收口、失败不再占 `peer-forward`、死节点不进兜底）。

## 修复进度（2026-10-17 18:2x 第二轮）

> 本轮核对 BUG-10~19：**9 条属实已修**，BUG-18 属设计权衡（见下），BUG-13 仅做显式标注。
> 上一轮 9 条（BUG-1~9）经复查仍成立、无回归。

| 编号 | 状态 | 落地位置 |
|---|---|---|
| BUG-10 | ✅ 已修 | `src/logs.js`：阈值 1MB→4MB，回退由 `slice(-100)` 改为**按字节**保留末尾 3/4（`keepTailByBytes`）。实测 6000 行溢出后保留 **3849 行**（旧行为 99 行，38.9×），且不截半行 |
| BUG-11 | ✅ 已修 | 随 BUG-10 一并删除死常量 `MAX_CALLS`/`MAX_ERRORS`（全仓零引用） |
| BUG-12 | ⚠️ 见第四轮修订 | 第二轮曾把默认 `0`→`120000` 并改文档；**第四轮实测推翻**：全量 6157 条 relay-done 中 103 条（1.67%）单次 >120s，主体是 `finish=tool_calls` 的完整成功流（144s~449s，含 326s / 正文 6933 字那条）⇒ 默认 120s 会腰斩它们。**默认恢复 0（关）**，改文档对齐。保留的真修复：截断时补 `STREAM_TRUNCATED` 错误帧 + errors.log 留痕（用户显式开闸门时才走到）。`STALL_TIMEOUT_MS` 默认 0 同样是刻意的 |
| BUG-13 | ✅ 部分修（仅显式标注） | `src/model-trace.js`：relay-done 缺 usage 时打 `usage(none:peer 未回)` 而非 `usage(prompt=-/completion=-)`，与「真 0 token」可区分。**根因未动**——采样仅 1/165，无法确证是"peer 尾帧未解析"还是上游本就没发 usage，不做无证据的重构 |
| BUG-14 | ✅ 已修 | `src/routes/stream-scan.js`：新增 `countToolCalls`，按 `tool_calls[].index` 去重（WeakMap 存已见 index，不污染 detail）。实测 500 帧同调用 → `toolCalls=1`（旧行为 500），新调用 index:1 → 2 |
| BUG-15 | ✅ 已修 | `src/daemon.js`：新增 `rotateDaemonLog`，每次起 daemon 前按 8MB（`MSLXDFF_DAEMON_LOG_MAX_BYTES`）轮转 daemon.log → `.1` → `.2`（只留两代）。轮转放在父进程启动时——子进程以追加 fd 持着旧 inode，运行中改名会写进 `.1` |
| BUG-16 | ✅ 已修 | `src/upstream-engine/sdk/attempt.js`：`logRequestDiagnosis` 改为 only-if-issues——无断裂只留一行 `issues=none` 摘要，不再打印 head/tail 转储（旧版 3020 次非 2xx 里 2945 次打印"一切正常"，是 daemon.log 膨胀主因） |
| BUG-17 | ✅ 已修 | `src/routes/stream-hold.js` 新增 `endTruncatedStream`；`src/routes/stream.js` 断流分支调用它——流已写内容但上游从未发 `finish_reason` 时，补 `STREAM_TRUNCATED` SSE 错误帧（排在 `[DONE]` 之前），并置 `detail.truncated`；`relay-pipeline.js` 据 `out.truncated` 写 errors.log（旧版零记录）。实测：有效帧排在 `[DONE]` 前、有 finish_reason 时不误判 |
| BUG-18 | ⚠️ 未修（设计权衡） | 见下方说明 |
| BUG-19 | ✅ 已修 | `src/chat-pipeline/terminal-verdict.js`：`FREE_TIER_PATTERNS` 增补 `/ENTITLEMENT_ERROR/i` + `/not subscribed to required model plan/i`。实测 `classifyTerminalUpstream(403, ENTITLEMENT_ERROR)` → `{terminal:true, kind:"free-tier-blocked"}`，且 `isPoolSwitchWorthy` 同时放开（终局必换兄弟，不留"判了终局却不换模型"的半截行为） |

**BUG-18 为何不修**：诉求是「首块快但整体慢」时中途换路。但换路必须靠 STALL 闸门（`STALL_TIMEOUT_MS`），
而默认开启会把**合法**的慢思考流（首块后静默数十秒，本仓已多次实测）掐断换路，换来的组员撞的是**同一个**
慢模型 —— 净效果是更差，且会复现 BUG-1 的老问题。BUG-12 修完后，这类流已有 120s 上界 + 截断错误帧
（客户端能识别被腰斩、errors.log 有记录），核心危害（静默吞半截回答、300s 无上界）已消除。
真正的中途换路需要「流健康度判定 + 候选可用性保证」，属架构级改动，不在本轮 bug 修补范围。

验证：全量 `node --test --test-concurrency=1 test/*.test.js` → **2024 项 0 失败**（新增 5 项用例）；
`npm run docs:check` exit 0；`node scripts/check-file-size.js` 不再有新增超标（stream.js 因本轮改动破 20KB 硬门，
已按「先拆后写」把读取层工具拆到新模块 `src/routes/stream-body.js`，回到 19910 字节）；
端到端实测确认（events.log 保 3849 行而非 99、tool_calls 500 帧计 1 次、ENTITLEMENT_ERROR 判终局且放开同池互备）。

## 修复进度（2026-10-17 18:4x 第三轮：附录 C 采纳项 + BUG-23 复核）

> 本轮核对 **附录 C（外部审计报告复核）** 与 **BUG-23**。附录 C 自己声明的「已独立验证为真」共 6 条，
> 我逐条落到 `file:line` **重新实证**：**4 条为真已修**，1 条真但修法需加深（见下），1 条拒绝修改；**BUG-23 被实测推翻**。

| 编号 | 状态 | 落地位置 |
|---|---|---|
| 附录C① ②③ | ✅ 已修（且比报告描述更深） | `src/routes/responses-route.js`：垫片 `headersSent` 由普通属性改为 **getter**（`headSent \|\| realRes.headersSent`，与 `messages-route.js:121` 同口径），并补 `getHeader("content-type")`。**深层问题（报告未指出）**：即便 `headersSent` 判真，`helpers.json()` 写的 in-band 错误帧是 OpenAI 形状 `{error:{…}}`（无 `choices`），而垫片 `write()` 会把它交给 **chat→responses 翻译器**，翻译器只认 `choices.delta`（`translate.js:259-266`）⇒ **错误帧在翻译层被静默丢弃**。故新增 `passthroughErrorFrames()`：纯错误帧直写、不交翻译器；有 `choices` 的 chat 帧绝不拦 |
| 附录C⑤ | ✅ 已修 | `src/autostart.js:163-164`：`../daemon.js`/`../server.js` → `./daemon.js`/`./server.js`（本文件在 `src/` 下，两文件都在 `src/` 内；第 6 行早已用正确的 `./daemon.js`）。旧路径指向仓库根、两处都不存在 ⇒ 整个「停裸 daemon → 等端口释放 → 让 systemd 接管」分支被 `catch {}` 静默吞掉、**从未执行过** |
| 附录C⑥-traework | ✅ 已修 | `src/providers/traework/chat.js:159`：`keys.includes(key) ? key : (keys[keys.indexOf(key)] \|\| key)` **两分支恒等于 key**（命中取 key；未命中的 `indexOf` 为 -1 ⇒ `keys[-1]` undefined ⇒ `\|\| key` 又取 key）⇒ 整行恒等 no-op，而 `maybeRefresh`→`applyTokenRefresh` 会就地 `keys[idx] = newToken`（`account-store.js:139`），故**刷新后仍拿旧 token 打上游**。改为取 `keys[keyIdx]`（未刷新时即 key，无行为变化） |
| 附录C⑥-qwenwork | ✅ 已修 | `src/providers/qwenwork/index.js:110,112`：两处 find 都拿**刷新后的新值**（`data.refresh_token` / 已被赋新值的 `account.accessToken`）去比环里的**旧 blob** ⇒ 结构性永不命中 ⇒ `if (cur) … else if (oldKey) …` 恒落空 ⇒ 环里永远留旧 blob。改为**刷新前先留底** `prevAccess`/`prevRefresh`，再据此比对；单号时无从比对也强制换（否则旧 blob 永久留环） |
| 附录C① 的「凭据环更新」其余 | ✅ 已销案（第七轮实测） | 疑虑是 `keyring.js:7` 的 `[...new Set(keys)]` 是快照、`replace()` 可能改不动。**实测不成立**：`replace()` 在**内部真实数组 `list`** 上做 `indexOf` + 赋值，`keys` getter 的副本只影响读、不参与写。`createKeyRing(['old','other']).replace('old','new')` → `keys === ['new','other']`。无需改动 |
| BUG-23 | ❌ **实测推翻（不修）** | 报告称「`group sync` 全部走裸 `console.log`，绕过 `log-stamp` 前缀，98.7% 无前缀」。**实测**：`installLogStamp()` 包装的正是 `process.stdout.write`，而 `console.log` 走 stdout ⇒ **必然被覆盖**（隔离脚本实测：装前缀前无前缀、装后带前缀）。本机 `daemon.log` 60,656 行中 `group sync` 28,525 行，**带前缀的样本当前仍在持续产出**（`[18:03:41 25716] group sync my@mslxd: 7 member(s), 5 peer(s)`）。无前缀的 28,109 行是**前缀机制诞生前（2026-10-17 `f2c90bc`）的历史行**，不是当前行为。**报告把历史遗留当成实时缺陷**——与它自己在附录 B.3 批评审计报告的正是同一个错（拿旧状态当现状）。**唯一成立的部分**：失败无告警（`group-sync.js:16,25` 的 `.catch()` 仅 `console.log`），记为独立待办，本轮未改 |

**四道门**：`npm run docs:check` exit 0；`node scripts/check-file-size.js` 的 `✗`（>20KB 必须拆）已 **清零**——
`relay-pipeline.js` 本已是**存量超标**（HEAD 版 20963 字节 > 20480），本轮又加字节，故按「先拆后写」把空转收场记账
抽成新模块 `src/routes/chat/empty-turn-report.js`（`reportEmptyTurn`），该文件回到 19915 字节，**顺带修掉存量违规**。

验证：全量 `node --test --test-concurrency=1 test/*.test.js` **连跑三遍均 0 失败**（2024 项；新增 `test/responses-shim-headers.test.js` 3 项）。
端到端实测：垫片 `write()` 后 `headersSent` 立即判真、`getHeader` 报 `text/event-stream`，错误帧不再被翻译器吞掉。

---

## 修复进度（2026-10-17 19:3x 第四轮：自查推翻上一轮的 BUG-12 修法）

> 本轮**没有新缺陷**，但做了一次必要的**自我推翻**——上一轮我对 BUG-12 的修法是错的，本轮实测证伪并回退。

**被推翻的结论（上一轮第二轮）**：BUG-12 说「流式总时长上限默认被关（0），与文档记载的 120s 矛盾」，
我当时判定「代码是唯一异类」⇒ **把默认值从 0 改成 120000**，并同步「修正」了三处文档。

**推翻它的实测证据**（本轮扫全量模型日志）：
- 全量 **6157 条 `relay-done`** 中，**单次 relay > 120s 的有 103 条（1.67%）**——不是边缘个例。
- 这 103 条的主体是**完整成功流**：`finish=tool_calls`、客户端 `status=200`。实测样本：
  `144s / 160s / 207s / 228s / 249s / 308s / 326s / 343s / 449s`；
  其中 `cline-cline-pass-deepseek-v4.1-flash` 那条 **326s** 的是 `chars=6933`（**正文 6933 字**、上游正常收尾）；
  `cline-cline-free-muse-spark` 那条 **308s** 的是 `finish=tool_calls`、`completion=22131` token。
- 这些是 **agent 长任务**（大上下文 + 多工具轮），单次模型回答天然就慢——**不是挂死**。
- 旁证（bug-list 自己的附录 D.4）：D.4 早已记录「语料中 2 条 `relayMs ≥ 160s` 的长流**正常以 `finishReason=stop` 收尾、`status=200`**，
  若 `MAX_STREAM_MS` 有非零默认值，它们会在阈值处被掐」——**D.4 当时即已给出正确结论，我却在第二轮忽略了它。**

**结论修正**：
- `MAX_STREAM_MS` **默认恢复为 0（关闭）**——这是**刻意且有实测依据**的设计，不是「与文档矛盾」的疏漏。
- **改文档**（三处：`docs/cli_help.md`、`docs/ARCHITECTURE.md` §6/§2 两处、`src/routes/AGENTS.md`）对齐到「默认 0=关」并写明依据；
  顺带修正 `ARCHITECTURE.md:125` 那句「中继 120s 与应用层 `MAX_STREAM_MS` 对齐」——应用层根本不是 120s。
- **保留**第二轮的真修复：截断时补 `STREAM_TRUNCATED` 错误帧 + errors.log 留痕（该机制在用户**显式**开启闸门时仍然正确且必要）。

**这一轮说明了什么**：BUG-12 的「现象」为真（默认 0 与文档 120s 确实矛盾），但**两侧都可能错**——
我当时默认「代码错、文档对」，没有先去量「到底有多少请求会受影响」。1.67% 的成功长流被腰斩是不可接受的代价。
**「确定是 bug」这个判据里，"修好之后不会误伤既有正常行为" 也是必要条件。**

验证：全量测试 2024 项 0 失败；`npm run docs:check` exit 0；`check-file-size.js` 的 `✗` 仍为零。
端到端实测：不设 env 时 `MAX_STREAM_MS === 0`（长流不被掐），显式设 5000 时 === 5000（能生效）。

---

## 修复进度（2026-10-17 19:5x 第五轮：BUG-24[新] —— `[DONE]` 与正文同 chunk 时截断收场失效）

> 本轮从**附录 E.3「须验证」**那条边界入手。结论：E.3 担心的形态（`sawDone=true`）**不成立**——
> 但同一组实测暴露了它没覆盖的另一种形态，且更常见：**BUG-24 为真，已修**。

### 先关掉 E.3 的悬念（实测，非推理）
构造三种形态跑生产 `relay()`，看下游实际字节：

| 形态 | `sawDone` | `sawFinishReason` | 错误帧 vs `[DONE]` |
|---|---|---|---|
| A. 有正文 → 独立 `[DONE]` 帧 → 卡死（E.2 第二例） | true | null | ✅ 错误帧在 `[DONE]` 前 |
| B. 有正文 → 无 `[DONE]` → 卡死（E.2 第一例） | false | null | ✅ 错误帧在 `[DONE]` 前 |
| C. 有正文 + `finish_reason` + `[DONE]` → 卡死 | true | stop | ✅ 不误判截断 |

机理：`[DONE]` 帧走 `isTrivialFrame` → `prefix.hold(..., isDone=true)` → **进 tail 槽暂扣**，
收场时 `flushTail()` 在错误帧之后才写。**E.3 的担忧（`[DONE]` 已透传导致错误帧赶不上）不成立**，
因为留口机制本来就把 `[DONE]` 扣住了。

### BUG-24【高】`[DONE]` 与末个内容帧挤在同一 network chunk ⇒ 终止符抢先、截断错误帧永远看不见

**现象**（实测复现，非推理）
上游把正文帧与 `data: [DONE]` **一次 flush** 送进同一个 chunk 时：
```
下游实际收到： ...delta":{"content":"半个回答"}}]}
              data: [DONE]                       ← 终止符先到，客户端立即收尾
              data: {"error":{..."STREAM_TRUNCATED"...}}   ← 永远看不见
              data: [DONE]                       ← 第二个终止符
```
`[DONE]` 出现 **2 次**，错误帧排在第一个 `[DONE]` **之后**。

**根因（两处叠加）**
- `stream.js:249` 提交分支 `prefix.submit(outChunk, size)` 把**整个 chunk 原样直写**。该 chunk 含
  `data:` 与真实正文 ⇒ `isPayload=true` 且 `gained=true` ⇒ 走 submit 而非 `hold(..., isDone)`。
- `stream-hold.js` 的 `submit()` 只做「补 pending + 写本帧」，**从不检查帧内是否夹带 `[DONE]`**
  ⇒ 终止符绕过 tail 槽直接入下游。
- 收场时 `closeSseWithError` 的 `flushTail()` 因 tail 空而返回 false ⇒ 补写第二个 `[DONE]`。

**为什么这是真缺陷而非理论边角**
TCP chunk 边界与 SSE 帧边界**无关**。上游普遍在最后一个 flush 里把「末内容帧 + `data: [DONE]`」
一起写出（OpenAI 兼容实现常见），尤其短回答、缓冲 flush 时。**一旦命中，BUG-17 的修复完全失效**：
客户端既看不到错误帧、又收到两个终止符，仍会把半截回答当完整结果用——正是 BUG-17 要解决的那个危害。

**修复**（`src/routes/stream-hold.js`）
- 新增 `splitTrailingDone(buf)`：从 chunk 里切出 `data: [DONE]` 终止帧行，`{head, rest}`。
- `submit()` 改为：先写 head，再把 rest 扣进 tail 槽（若 tail 已有值先按序 flush）。
- **必须行锚定**：正则 `/(^|\n)[ \t]*data:[ \t]*\[DONE\][ \t]*\r?(?=\n|$)/`，且用 `latin1` 扫描
  （1 字节↔1 字符，索引与字节一一对应）。**不能查 `[DONE]` 子串**——正文里出现字面量 `[DONE]`
  （本仓域内极常见，讨论 SSE 协议的对话）会被误切。首版实现即用裸 `indexOf("[DONE]")`，
  被自查发现后改为行锚定并加了 false-positive 用例。

**实测（修复后）**

| 形态 | 终止符数 | 错误帧次序 |
|---|---|---|
| D1 `[DONE]` 与正文同 chunk（**原缺陷**） | 1 | ✅ 在 `[DONE]` 前 |
| D2 独立 `[DONE]` 帧（对照） | 1 | ✅ |
| D3 多轮正文 + 独立 `[DONE]`（真实 agent 形态） | 1 | ✅ |
| `HOLD_END=0` 显式降级 | 1 | ✅ |
| F1 正文含字面量 `[DONE]` | 1 | ✅ 正文完整 |
| F2 正文含「形似终止帧」片段（JSON 转义） | 1 | ✅ 正文完整 |

**验证**：全量 `node --test --test-concurrency=1 test/*.test.js` → **2030 项 0 失败**
（`test/stream-truncated.test.js` 新增 3 项：合并帧 / 字面量误切 / HOLD_END=0 降级）；
`npm run docs:check` exit 0；`node scripts/check-file-size.js` exit 0（无 `✗`，`stream.js` 20378 字节仍在门内）。

---

## 修复进度（2026-10-17 20:2x 第六轮：BUG-23 残留——`group sync` 连续失败静默无告警）

> 本轮清掉全清单里**唯一还成立且未修**的那一条。复查确认：BUG-1~24 中只有 BUG-18（架构级设计权衡，
> 已论证默认开 STALL 会误杀合法慢流）与「`group sync` 失败静默」两项未落地，其余均已修并复验。

### 为什么只修「失败静默」这一半
BUG-23 报了四件事，复查后**只有一件是真缺陷**：

| 指控 | 复查结论 |
|---|---|
| 输出绕过 `log-stamp`、98.7% 无前缀 | ❌ **已推翻**（第三轮实测）：`installLogStamp` 包的正是 `process.stdout.write`，`console.log` 走 stdout 必然被覆盖；那 28,109 行是前缀机制诞生前（`f2c90bc`）的历史行 |
| 占 daemon.log 47%，稀释有效行 | ⚠️ 部分成立，但 `groupSyncIntervalMs` 默认 60s 是产品选择（成员列表要新鲜）；且前缀已修好后每行可归因，不构成缺陷 |
| 失败不重试 | ❌ 非缺陷：每分钟重拉本身就是重试 |
| **失败不告警、不进 errors.log** | ✅ **真缺陷，本轮已修** |

实测 349 次 sync 失败（288 `aborted` + 61 `fetch failed`）在 `errors.log` 中命中 **0**。
失败意味着 `syncAllJoinedGroups` 卡在 `refreshGroupMembers` 抛错 ⇒ `syncPeersFromMembers` 根本没跑
⇒ **`peers` 静默停在上一次成功的结果**（"组员列表变旧"），而用户侧零信号。

### 修法：去抖升级，不是「每次失败都喊」

单次失败是常态（1.2%），每次都写 errors.log 会把错误率也刷成噪声——正是 BUG-5 刚修掉的那个坑
（"近一半错误日志不是错误"）。故按**连续失败**计：

- 连续 <N 次：只走 `console.log`（轨迹留着，每分钟一行，已带前缀可归因）
- 连续 ≥N 次（`MSLXDFF_GROUP_SYNC_FAIL_ALERT`，默认 **3**，0=关）：升一条 `errors.log`，
  文案明说后果——「成员列表已停留在上一次成功的结果」，不只是报次数
- 恢复时补一条 status 200 的收尾，闭合事件；之后继续只走 console.log 不重复写
- 恢复后再失败：计数从零重来，够阈值仍会再喊

**实现**：`src/runtime/group-sync.js` 新增纯函数 `createGroupSyncReporter`——按**组名**各记
`{fails, alerted}`，多组互不串味；不碰定时器故可直接单测。整个同步抛错（读 state / 令牌等基建问题）
没有组名，归一成 `{name:"(all)"}` 走同一套去抖，不再只是一行 console.log 就消失。
`logs` 经 `bootstrap.js:37` 注入（原本 `startGroupSync` 压根拿不到日志设施）。

顺带清掉一处不一致：定时器路径原本只在 `r.added` 非零时打印成功行，首拉路径无条件打印——
现统一为 `verbose` 参数控制（首拉 `verbose:true`，定时器按 `added`）。

**验证**
- `node --test test/group-sync-alert.test.js` → **8 项全过**（单次不喊 / 连续 3 次才升 / 去抖不重复 /
  恢复闭合且可再告警 / 多组各算各的 / alertAt=0 关闭 / 成功不刷屏 / logs 缺失或抛错不拖垮同步）
- 全量四道门见本轮收尾（`docs:check`、`check-file-size`、`ft-check check`、全量测试）

---

## 修复进度（2026-10-17 20:5x 第七轮：BUG-25[新] —— `[DONE]` 自己被 TCP 切开时，上一轮的修复不生效）

> 本轮 bug-list 无新增条目。自查上一轮 BUG-24 的修复，发现它只覆盖了一半形态，**BUG-25 为真，已修**。
> 顺带销掉第三轮遗留的最后一条「须补验」。

### 先销掉「凭据环 `ring.replace` 能否换掉快照」这条悬念
第三轮标「须补验」的疑虑是：`keyring.js:7` 的 `list` 是 `[...new Set(keys)]` 快照，`replace()` 会不会改不动。
**实测不成立**——`replace()` 是在**内部真实数组 `list`** 上做 `list.indexOf(oldKey)` + `list[idx] = newKey`，
`keys` getter 返回的副本只影响**读**、不参与写：

```
createKeyRing(['old-blob-A','other']) → replace('old-blob-A','new-blob-B') → true
keys → ["new-blob-B","other"]        ← 确实换掉了
```

**该条销案，无需改动。**

### BUG-25【高】终止帧被 TCP 切块 ⇒ BUG-24 的行锚定永不命中，缺陷原样复现

**现象**（实测复现）
上一轮的 `splitTrailingDone` 要求 `data: [DONE]` **整行在一个 chunk 内**。但 TCP 不保证：

```
chunk1: …"半个回答"}}]}\n\ndata: [DO
chunk2: NE]\n\n
```

两个 chunk 各自都不含完整的终止行 ⇒ 行锚定两次都匹配不到 ⇒ 走普通 `writeNow` 直写。
下游实际收到（修复前实测）：

```
data: {...半个回答...}
data: [DONE]                                  ← 终止符先到
data: {"error":{..."STREAM_TRUNCATED"...}}    ← 永远看不见
data: [DONE]                                  ← 第二个终止符
```

终止符 **2 个**、错误帧排在首个之后——与 BUG-24 完全相同的危害，只是触发形态更隐蔽。
`[DONE]` 只有 11 字节，任何一次 8~64 字节的 TCP 分段都可能正好落在它中间；短回答 + 末次 flush 时尤其易撞。

**修复**（`src/routes/stream-hold.js`）
- 新增 `doneLinePrefix(buf)`：检查 chunk 的**最后一个未结束行**是否是 `data: [DONE]` 的字面前缀
  （大小写/空白归一后比对，长度上限 32 字节，避免把普通正文尾巴扣住）。是则返回该尾巴的字节数。
- `submit()` 先拼 `carry`（上一块扣下的半截行）再整体判：完整终止帧 → tail 槽；
  仍是半截 → 继续扣；不是终止帧 → **原样放行**（`data: [DOUBLE-NOT-DONE]` 这类正文不会被吞）。
- 收场新增 `flushPrefixTail(prefix)`：先放 carry、再放 tail——carry 是先到的字节，顺序不能反。

**一个测试逼出来的真细节**：上游若断在半截行上（`…data: [DO` 就没了），carry 必须以**换行**收尾再放，
否则随后补写的错误帧/`[DONE]` 会粘成 `data: [DOdata: [DONE]`——既不是合法 SSE 行，客户端也认不出终止符
（实测终止符数=**0**，比多一个更糟）。故 `flushCarry()` 检测末字节不是 `\n` 就补一个。

**顺带**：`stream.js` 因本轮改动一度破 20KB 硬门（20634B），按「先拆后写」把首块富化块抽成
`stream-body.js` 的 `enrichFirstReply()`（行为逐字不变，只搬家），`stream.js` 回到 **19884B**。

**实测（修复后）**

| 形态 | 终止符数 | 错误帧次序 |
|---|---|---|
| 切成 2 块（`data: [DO` / `NE]\n\n`） | 1 | ✅ 在前 |
| 切成 3 块（`data: [D` / `ON` / `E]\n\n`） | 1 | ✅ 在前 |
| 正文尾巴形似前缀（`data: [DOUBLE-NOT-DONE]`） | 1 | ✅ 正文完整、未被吞 |
| 上游断在半截行上 | 1 | ✅ 半截行原样透传 + 补换行 |

**验证**：`test/stream-done-split.test.js` 新增 **4 项**；
全量 `node --test --test-concurrency=1 test/*.test.js` → **2042 项 0 失败**；
`check-file-size.js` exit 0（`✗` 清零）；`docs:check` exit 0；`ft-check check` exit 0。

---

## 修复进度（2026-10-17 21:0x 第八轮：BUG-26[新] —— carry 被 hold() 与直写路径绕过）

> 本轮 bug-list 无新增条目。自查上一轮 BUG-25 的 carry 机制，发现它只在 `submit()` 里被消化，
> `hold()` 的两个分支与注释帧直写都绕过了它 —— **BUG-26 为真，已修**。

### BUG-26【高】`carry` 只在 `submit()` 内消化 ⇒ 两条路径分别复现「粘行」与「乱序」

第七轮给 BUG-25 加的 `carry`（暂扣半截终止行）只接在 `submit()` 里。但 `stream.js` 还有两条
**不经过 submit** 的写出路径，实测确认它们各自出问题：

**路径一：`hold(…, isDone=true)` 把 carry 直接塞进 tail 槽**

```js
if (carry) { const c = carry; carry = null; if (tail) flushTail(); tail = { buf: c.buf, size: c.size }; }
```

carry 若没以换行结尾（`…data: [DO`），会被原样接上随后的 `data: [DONE]\n\n`：

```
下游实测：data: {"choices":…"A"…}\n\ndata: [DOdata: [DONE]\n\n
```

`data: [DOdata: [DONE]` **不是合法 SSE 行** ⇒ 客户端认不出终止符，实测**终止符数量 = 0**
——比 BUG-25 的「2 个」更糟（2 个至少还能收尾，0 个直接让客户端挂到超时）。

**路径二：`hold()` 的 committed 分支 / 注释帧直写绕过 carry**

```js
if (committed) { writeNow(buf, size); return true; }
```

`writeNow` 只保证「tail 在后」，不保证「carry 在前」。已提交后来一个 trivial 空帧，
它会抢在半截行之前写出：

```
下游实测：…"\n\ndata: {"choices":[{"index":0,"delta":{}}]}\n\ndata: [DO\n
                                              ↑ 空帧(后到)      ↑ 半截行(先到)
```

（危害较轻：空帧无载荷，不会破坏解析；但它是「先到的字节后写出」的次序破坏，
与 `[DONE]`/错误帧的次序铁律同一个根源，一并修掉。）

**修复**（`src/routes/stream-hold.js`）
- `writeNow()` 开头统一 `if (!inCarryFlush && carry) flushCarry();` —— 所有直写自动先放 carry；
  `inCarryFlush` 是重入护栏（`flushCarry` 内部也要走 `writeNow` 记账）。
- `flushCarry` 提升为模块级闭包（原先是 `return {}` 字面量里的方法），补换行逻辑只留一份。
- `hold(isDone=true)` 改为先 `if (carry) flushCarry();` 再处理 tail，不再把 carry 塞进 tail 槽。

**实测（修复后）**

| 形态 | 终止符数 | 次序 |
|---|---|---|
| 半截行 + trivial 空帧 + 独立 `[DONE]` | **1** | ✅ 半截行在空帧前、错误帧在 `[DONE]` 前 |
| 已提交后 trivial 空帧（单测直接调 prefix） | 1 | ✅ carry 先出 |
| 半截行 + 下一块普通正文（原 BUG-25 用例） | 1 | ✅ 不变 |

端到端（经生产 `relay()`）下游实际字节：
```
data: {"choices":[…"正文"…]}\n\ndata: [DO\ndata: {"choices":[{"index":0,"delta":{}}]}\n\n
data: {"error":{…STREAM_TRUNCATED…}}\n\ndata: [DONE]\n\n
```

**验证**：`test/stream-done-split.test.js` 新增 1 项（共 5 项全过）；
全量 `node --test --test-concurrency=1 test/*.test.js` → **2043 项 0 失败**；
`check-file-size.js` exit 0（`✗` 零，`stream-hold.js` 14.8KB / `stream.js` 19.4KB 仍在门内）；
`docs:check` exit 0；`ft-check check` exit 0。

### 顺带复核：`keyring.js:47` 的死变量（不修）

`if (errAt.has(oldKey)) { const t = errAt.get(oldKey); errAt.delete(oldKey); }` —— `t` 取了不用。
**经复核是刻意的**：下一行注释明写「新 token 刚刷新，不应继承旧冷却，直接清掉」。留着 `t`
只是改动残留，删它会与那条注释错位；`errAt.delete` 本身正确。**非缺陷，不动**。

---

## 修复进度（2026-10-17 21:3x 第九轮：BUG-27[新] —— 截断收场把自己记成 client-abort）

> 本轮 bug-list 无新增条目。自查 `relay()` 的**收场退出路径**，发现截断分支与正常分支不对称
> —— **BUG-27 为真，已修**。

### BUG-27【中】截断收场的两条 `return` 漏了摘 close 监听 ⇒ 服务端掐断被记成「客户端断开」

`relay()` 有三条收场出口，只有一条做了「收场后摘监听 + 置 finishedNormally」：

| 出口 | 位置 | `finishedNormally` | 摘 close 监听 |
|---|---|---|---|
| 首块超时未写字节（504 可 failover） | `:266-269` | ❌ | ✅ |
| **截断收场（有正文但无 finish_reason）** | `:271-282` | **❌** | **❌** |
| 正常收场 | `:288-291` | ✅ | ✅（留口时**刻意**不摘，注释已说明理由） |

真 Node 里 `res.end()` 之后 socket 关闭会触发 `'close'` ⇒ `onClose` 判 `!finishedNormally` 为真
⇒ 执行「下游断开」分支：置 `detail.downstreamClosed = true` 并调 `onDownstreamAbort()`
⇒ 上层记一条 **`client-abort`**（`src/cli/format.js:87` 渲染成「client abort」）。

即：**服务端自己按截断收场掐掉的流，被归因成客户端逃跑。**

**实测（三形态对照，模拟真 Node 在 end() 后 emit close）**
```
A 截断收场:  end 后 close 监听=1 → emit 后 abortCalls=1   ❌
B 正常收场:  end 后 close 监听=0 → emit 后 abortCalls=0   ✅
C 空轮留口:  end 后 close 监听=1 → emit 后 abortCalls=0   （刻意保留，非缺陷）
```

**影响**
- 事件流误导：`client-abort` 是「客户端主动断开」的语义事件，排查时会把它当作客户端行为，
  而真相是网关自己按闸门截断。
- `detail.downstreamClosed` 被误置真。截断收场时它已被 `endTruncatedStream` 写过响应，故本轮不再有
  二次写入；但 relay 返回的 detail 会带着一个**错的**下游状态（`exhausted-handler` 等下游消费方可见）。
- 现网 `events.log` 中 `client-abort` 命中 **0**、`STREAM_TRUNCATED` 命中 **0** ——
  因为截断修复从未上线运行过（daemon 仍是修复前进程），**暂无运行时痕迹**，属代码级确证。

**修复**（`src/routes/stream.js`）
截断分支进入时先 `finishedNormally = true; res.removeListener("close", onClose);`，
与正常收场同口径。两条 `return` 共用这一处前置，不重复写。

**顺带**：`stream.js` 因本轮改后达 **20475 字节**（硬门 20480，只剩 5 字节），
按「先拆后写」把非流式「先判后写」抽成 `stream-body.js` 的 `scanNonStreamReply()`（行为逐字不变），
`stream.js` 回到 **19939 字节**，`stream-body.js` 3956 字节。

**验证**：`test/stream-truncated.test.js` 新增 1 项（共 6 项全过）；
流式三文件共 **31 项全过**；全量 `node --test --test-concurrency=1 test/*.test.js` → **2044 项 0 失败**；
`check-file-size.js` exit 0（`✗` 零）；`docs:check` exit 0；`ft-check check` exit 0。

---

## 修复进度（2026-10-17 第十轮：BUG-28[新] —— 杀 daemon 失败仍删 pid 文件）

> 本轮 bug-list 无新增条目。转而清附录 C.3 里最后一条「未验证」疑点
> （`src/daemon.js:106-111` 杀失败仍删 `daemon.pid`）—— **BUG-28 为真，已修**。

### BUG-28【中】杀失败仍删 `daemon.pid` ⇒ 在跑的 daemon 从台账消失；杀者牌还会开出假死亡证明

`stopDaemon()` 原顺序是「尝试杀 → **无条件** `unlinkSync(pidFile())` → 最后才判 `killFailed`」：

```js
let killFailed = false;
try { process.kill(pid, "SIGTERM"); }
catch (err) { /* ESRCH 忽略；EPERM 走 taskkill，失败则 killFailed = true */ }
try { unlinkSync(pidFile()); } catch {}          // ← 无论成没成
if (killFailed) return { stopped: false, pid, ... };
```

**缺陷一：仍在世的 daemon 从台账消失。** `killFailed === true` 意味着 `victimAlive` 为真且
SIGTERM 与 `taskkill /F` 都失败了 ⇒ 进程**还活着、还在监听 8989**，但 pid 文件已删。
下一轮 `readPid()` 返回 `null`：

| 消费方 | 后果 |
|---|---|
| `-stop`（`commands/daemon.js:24-29`） | 打印「mslxdff daemon not running」——**假话**，人以为可以安全重启 |
| `-restart`（`commands/daemon.js:35-45`） | `pid=null` ⇒ 走「daemon not running — starting...」⇒ 起新进程与老的抢端口 |
| `-uninstall`（`commands/system.js:85-87`） | 打印「not running」，**紧接着删 state/logs** —— 在跑的 daemon 被抽掉地基 |
| `stopDaemonIfOutdated`（`cli/policy.js:60-65`） | 升级路径也判「runningVersion 未知」而放弃停旧版 |

这正是 `daemon.js:158` 注释里记的真机事故类型：「不在 daemon.pid 里的幽灵 daemon，`-restart` 结构性盲区」。

**缺陷二：杀者牌留在盘上，开出假死亡证明。** `writeExitMarker()` 在动手**前**写着
（`:117`，仅 `victimAlive` 时），语义是「我把它杀了」。杀失败时不撤牌 ⇒ 下次启动
`collectAutopsy` 读到新鲜牌 ⇒ `classifyPrevExit` 判 **`killed-by-cli`**（`lifecycle-forensics.js:82-84`），
把一个**从没死过、一直在跑**的 daemon 记成「被 CLI 以 stop 名义主动杀死」，落进 `errors.log`。

**修复**（`src/daemon.js`）
1. `if (killFailed)` 提前到 `unlinkSync` **之前**，并在其中 `dropMarker()` 撤牌；
2. 非 ESRCH/EPERM 的其他错误抛出前也 `dropMarker()`（同一笔账：没杀成就不许留牌）；
3. 给 `stopDaemon` 加 `kill` / `taskkill` 注入点（对齐 `waitPidGone` 已有的注入式签名，
   否则这条失败路径无法在测试里覆盖 —— 真打桩 `process.kill` 会动到测试进程）。

**消费方文案同步**（`-stop` / `-uninstall`）
「有 pid 但没停成」与「没在跑」是两件事，原先都打印 not running：
- `handleStop`：改为 `mslxdff daemon NOT stopped (pid N): <reason>` + `exit 1`；
- `handleUninstall`：如实报「still running」并**中止删除**（`exit 1`），附上管理员停进程的指引。

**验证**
- 新增 `test/daemon.test.js` 2 项：①杀失败 ⇒ pid 文件仍在、`readPid()` 仍认得、牌已撤；
  ②taskkill 兜底成功 ⇒ 仍按杀成功删 pid 文件。
- **变异验证**：临时把 `if (killFailed)` 挪回 `unlinkSync` 之后跑测试 ⇒ `not ok 7`（1 失败），
  恢复修复版 ⇒ 9 项全过。证明这两条测试真的钉住了该行为，不是空跑。
- 全量 `node --test --test-concurrency=1 test/*.test.js` → **2046 项 / 2043 pass / 0 fail**；
  `check-file-size.js` exit 0；`docs:check` exit 0（结构四道门全过）。

---

## 修复进度（2026-10-17 第十一轮：BUG-29[新] —— 停不掉还起新的，并谎报 restarted）

> 本轮 bug-list 无新增条目。自查上一轮 BUG-28 的**同族缺陷面**（`stopDaemon` 返回值被谁消费），
> 发现三条「重启」路径全都丢弃了它 —— **BUG-29 为真，已修**。

### BUG-29【中】`-restart`/`-port`/`-update` 不看 `stopDaemon` 返回值 ⇒ 停不掉仍起新进程 + 谎报成功

BUG-28 修好了「杀失败别删 pid 文件」，但**调用方照样不关心结果**：

```js
// handleRestart（commands/daemon.js:41-43，修复前）
if (alive) { console.log(`restarting daemon (pid ${pid})...`); await stopDaemonHard("restart"); }
// ↑ 返回值直接丢弃，杀失败也往下走
const spawnedPid = startDaemon([]);          // 起新的
await waitForHealth(port, 4000);             // 打的是**旧** daemon 的 /health
```

**谎报链条（Windows 实测坐实）**

| 步 | 行为 | 证据 |
|---|---|---|
| 1 | 旧 daemon 停不掉，仍监听 8989 | BUG-28 的 `killFailed` 分支 |
| 2 | 新进程 bind 同端口 ⇒ `EADDRINUSE` | 实测：`第二个 listen 错误 = EADDRINUSE` |
| 3 | 新 daemon 的 EADDRINUSE 自愈跑 `ss -lptn` / `fuser -k` | `server-lifecycle.js:75,94` —— **Linux-only 工具** |
| 4 | Windows 上 `ss` 不存在 ⇒ `pids.size=0` ⇒ 重试仍失败 ⇒ `throw` | `server-lifecycle.js:90,101` |
| 5 | `bin/mslxdff.js` 无 try/catch ⇒ 子进程退出（stderr 进 daemon.log，CLI 无感） | `bin/mslxdff.js:4` |
| 6 | `waitForHealth` 打旧 daemon 的 `/health` ⇒ **200，立即返回** | `cli/policy.js:39-50` |
| 7 | `findDaemons` 读 `/proc` ⇒ **Windows 恒返回空** ⇒ `leftover.length===0` | `runtime/proc-info.js:109` |
| 8 | 打印 `mslxdff vX restarted as a background daemon (pid <新进程的 pid>)` | `commands/daemon.js:67` |

**结论**：在 Windows 上杀不掉旧 daemon 时，`-restart` 会打印「restarted (pid N)」，而 N 是一个已经 EADDRINUSE 退出的死进程，
真正在服务的是**旧版本**。用户以为升级/重启成功了，实际一点没变 —— 与 BUG-28 的「谎报 not running」是同一类归因错误。

**修复**（三处调用点统一）
1. `handleRestart`（`commands/daemon.js`）：`const r = await stopDaemonHard("restart")`，`if (!r.stopped && r.pid)` ⇒
   打印「旧 daemon 没能停掉 + 继续起新的只会 EADDRINUSE 秒退」并 `exit 1`，**不启动新进程**；
2. `handlePort`（同文件）：同样前置判断，附「端口已保存为 N，但要等旧进程退出后才生效」；
3. `handleUpdate`（`commands/system.js`）：打印「新版本已装好，但旧版仍在运行（未生效）」，`exit 1`。

判据统一用 `!r.stopped && r.pid`：`r.pid` 为空才是真的「本来就没在跑」，可以放心继续。

**验证**
- 全量 `node --test --test-concurrency=1 test/*.test.js` → **2046 项 / 2043 pass / 0 fail**；
- `check-file-size.js`：仅 10KB 级 `⚠` 建议拆分（`commands/daemon.js` 10.1KB、`daemon.js` 12.2KB），**未破 20KB 硬门**；
- 端口独占行为实测：`第二个 listen 错误 = EADDRINUSE`（谎报链条第 2 步的直接证据）。

---

## 修复进度（2026-10-17 第十二轮：BUG-30[新，高] —— `/health` 无法自证身份，且没人检查新进程死没死）

> 用户指示「先修 P0/P1」。逐条核验 10 条「高」严重度条目后确认 **BUG-1/2/7/8/10/12/17/24/25/26 的修复均已落码**；
> 但在核查 BUG-29 的根因时发现更深的一层 —— **BUG-30 为真，已修**。

### BUG-30【高】`/health` 只回 `{status:"ok"}` ⇒ 健康检查无法区分新旧 daemon；且无一处检查新进程是否活着

**缺陷一：`/health` 不自证身份。**

```js
// src/routes/index.js（修复前）
{ method: "GET", path: "/health", handler: ({ res }) => json(res, 200, { status: "ok" }) }
```

`waitForHealth` 的唯一判据是 `res.ok`。旧 daemon 仍在监听同一端口时，它对 `/health` 一样回 200
—— 于是「新进程 EADDRINUSE 秒退、旧版继续服务」在健康检查眼里与「启动成功」**完全无法区分**。
这是 BUG-29 那条谎报链的**最后一环**：修了调用方的返回值判断，仍缺一个能证伪的手段。

**缺陷二：没有任何一处检查 `spawnedPid` 是否还活着。**

四个启动路径（`-restart` / `-port` / `-d` / `-update`）全是「`startDaemon()` → `waitForHealth()` → 打印成功」，
中间从不问一句「我刚起的那个进程还在吗」。而 Windows 上 EADDRINUSE 的退出发生在**子进程内部**
（`server-lifecycle.js` 的 EADDRINUSE 自愈只认 Linux 的 `ss`/`fuser`，Windows 上 `pids.size=0` ⇒ 重试仍失败 ⇒ `throw`），
`bin/mslxdff.js` 又没有 try/catch ⇒ 子进程静默退出，父进程**收不到任何信号**。

**修复**

1. `/health` 增加 `pid` 与 `version`（`src/routes/index.js`）。version 走 `createRouter` 传参，
   未传时读 `package.json` 兜底（测试直接 `createRouter()` 也能拿到真版本）。为拿到闭包内的 version，
   `/health` 从模块级 `ROUTES` 常量移到 router 函数内前置处理。
2. `waitForHealth(port, timeoutMs, { expectPid })` 新增身份校验（`src/cli/policy.js`）：给了 `expectPid` 就
   **只认那个 pid**，老版本 daemon（无 pid 字段）继续等而不误判通过。返回值改为 `{ ok, pid, version }`。
3. 四个启动路径统一补「新进程是否还活着」：`!isPidAlive(spawnedPid)` ⇒
   打印「启动后立即退出 —— 端口大概仍被占用（EADDRINUSE）」+ 指向 daemon.log + `exit 1`，
   **不再打印 started/restarted**。

**契约变更**：`test/server.test.js` 的 `deepEqual({status:"ok"})` 改为逐字段断言（`status` + `pid === process.pid` + `version` 是字符串）。
这不是放宽断言 —— 新字段正是修复所必需，且 `pid` 用严格相等锁住了「http 应答者确实是本进程」。

**验证**
- 全量 `node --test --test-concurrency=1 test/*.test.js` → **2046 项 / 2043 pass / 0 fail**；
- `check-file-size.js` 无 `✗`；`docs:check` 结构四道门全过；
- 首轮改动曾因 `version` 为 `null` 让该测试变红（`expected: 'string', actual: 'object'`），
  说明新断言真的在校验而非空转；补 package.json 兜底后转绿。

### 附：10 条「高」严重度条目的落地核验（用户点名 P0/P1）

| 条目 | 关键代码 | 状态 |
|---|---|---|
| BUG-1 peer 30s 硬超时 | `routes/peers.js:151` `DEFAULT_PEER_HEADERS_TIMEOUT_MS = 120_000` | ✅ |
| BUG-2 hedge 串行 90s+ | `routes/hedge.js:132` `peerStageCtx` 三批共享 deadline | ✅ |
| BUG-7 非 auto 锁死单模型 | `chat-pipeline/index.js:115` `wantFreePool` + `poolFallback` | ✅ |
| BUG-8 429 不判终局 | `terminal-verdict.js:27` `/FreeUsageLimitError/i` | ✅ |
| BUG-10 events.log 断崖 | `logs.js:12` `MAX_BYTES = 4MB` + `keepTailByBytes` | ✅ |
| BUG-12 闸门默认 0 | `stream.js:43` `MAX_STREAM_MS` 保持 0（第四轮实测 1.67% 成功流 >120s，默认 0 是对的，改的是文档） | ✅ 设计如此 |
| BUG-17 截断按 200 返回 | `stream.js:281` `endTruncatedStream` | ✅ |
| BUG-24 `[DONE]` 同 chunk | `stream-hold.js:38` `splitTrailingDone` | ✅ |
| BUG-25 `[DONE]` 被切块 | `stream-hold.js:62` `doneLinePrefix` + `carry` | ✅ |
| BUG-26 carry 被绕过 | `stream-hold.js:99` `writeNow` 统一 `flushCarry` | ✅ |

---

## 修复进度（2026-10-17 第十三轮：BUG-30 补完 —— 漏了两条启动路径）

> 本轮 bug-list 无新增条目。自查上一轮 BUG-30 的**覆盖完整性**：全仓 `startDaemon(` 共 6 处调用，
> 上轮只修了 4 处，**漏了用户最常敲的那条**。

### 覆盖矩阵（修复前）

| 调用点 | 场景 | 上轮是否验活 |
|---|---|---|
| `commands/daemon.js:63` | `-restart` | ✅ |
| `commands/daemon.js:105` | `-port` | ✅ |
| `commands/daemon.js:133` | `-d` | ✅ |
| `commands/system.js:69` | `-update` | ✅ |
| **`commands/daemon.js:217`** | **裸跑 `mslxdff`** | **❌ 漏** |
| **`cli/join-wizard.js:54`** | **入组向导 `ensureServiceRunning`** | **❌ 漏** |

裸跑是用户最常敲的命令，却恰恰没有验活 —— 旧 daemon 占着 8989 时，`mslxdff` 会打印
`started as a background daemon (pid <已死的 pid>)`，用户以为起来了。

### 修复

1. **`handleBareRun`**（`commands/daemon.js:217`）：补 `waitForHealth(..., { expectPid })` +
   `!isPidAlive(spawnedPid)` ⇒ 打印「启动后立即退出 —— 端口大概仍被占用」+ `exit 1`。
2. **`ensureServiceRunning`**（`cli/join-wizard.js:54`）：同样按 pid 校验，失败时返回
   `{ failed: true, reason }` 而非伪造 pid。
3. **向导展示层**（同文件 `runJoinWizard`）：原先只认 `service.error`，`failed` 会掉进
   「✓ 后台服务已在运行（pid null）」分支 —— 又一次谎报。改为 `service?.error || service?.failed`
   同走失败分支，打印 `✗ 后台服务启动失败：<reason>`。

**验证**
- 全量 `node --test --test-concurrency=1 test/*.test.js` → **2046 项 / 2043 pass / 0 fail**；
- `check-file-size.js` 无 `✗`；`docs:check` 结构四道门全过。

---

## 修复进度（2026-10-17 第十四轮：BUG-31[新] —— model-trace 断崖裁剪，BUG-10 的同型缺陷）

> 本轮 bug-list 无新增条目。转向此前从未审计的 `model-trace.js`，发现 BUG-10 那个坑**在另一处原样复现**。

### BUG-31【中】`model-trace.js` 按行数裁剪配按字节阈值 ⇒ 超限时一次丢掉 98% 历史

```js
const MAX_TRACE_BYTES = 1024 * 1024;
// ...
if (existsSync(file) && statSync(file).size > MAX_TRACE_BYTES) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  writeFileSync(file, lines.slice(-100).join("\n") + "\n");   // ← 按行数回退
}
```

**阈值按字节（1MB），回退按行数（100 行）** —— 两个量纲不匹配，行越长断崖越狠。
这与 `logs.js` 里已修的 BUG-10 是同一个错误，只是发生在 model trace 上。

**现网实测**（离线读取，未改动任何文件）：
```
cline-cline-pass-deepseek-v4.1-flash.log
  行数 = 5346
  字节 = 1,006,482   ← 已超 1MB 阈值
  平均行字节 = 188.3
```
即：**下一次写入**就会触发裁剪，从 5346 行砍到 100 行 —— 一次丢弃 **5246 行（98.1%）**。
按字节留 3/4 的话，每次只丢约 1/4（约 1300 行），能保留十余倍的历史深度。

**修复**（`src/model-trace.js`）
1. 新增 `TRACE_KEEP_RATIO = 3 / 4` 与 `keepTailByBytes()`（与 `logs.js` 同算法口径；
   那边没导出，这里留一份最小实现，不为一行日志把 model-trace 反向依赖到 logs 内部函数）；
2. 触发裁剪时按字节回退到 3/4，不再 `slice(-100)`；
3. 裁剪结果补尾换行 —— 否则下一次 `appendFileSync` 会把新行接到半截行尾巴上。

**验证**
- 新增 `test/model-trace.test.js` 1 项（共 17 项）：构造 5300 行 / >1MB 的真实体量，
  断言裁剪后行数 >1000、体量仍在阈值内、末尾有换行、新写入的行未丢。
- **变异验证**：临时还原 `slice(-100)` ⇒ `not ok 17`（1 失败）；恢复 ⇒ 17 项全过。
- 全量 `node --test --test-concurrency=1 test/*.test.js` → **2047 项 / 2044 pass / 0 fail**；
- `check-file-size.js` 无 `✗`；`docs:check` 结构四道门全过。

---

## BUG-1【高】peer 转发 30s 硬超时，与慢模型首字延迟不匹配 ⇒ 组员竞速永远不可能获胜

**现象**
同一请求，本地直连 8~10s 拿到「响应头」，但 SSE **首个内容块**要 30s+。peer 侧 `latency` 精确卡在
`30001ms` 被 abort —— 30s 只够拿到响应头，永远等不到首块。

**证据**
- 代码：`src/routes/peers.js:8` `PEER_TIMEOUT_MS = 30_000`；`:117`
  `const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS)`
  —— 注释自称「30s timer 仅覆盖等响应头」，但 abort 掐的是**整个响应**（含 body 读取）。
  对照 `:16` `PEER_BODY_TIMEOUT_MS = 120_000`（注释写明「首块后可静默思考远超 30s」）——
  设计上已知首块会超 30s，却仍由 `PEER_TIMEOUT_MS` 抢先 abort。
- 日志（mimo-v2.6-flash-free.log）：
  ```
  15:20:18 peer-request  peer=141.98.198.197:8989
  15:20:48 peer-forward  peer=141.98.198.197:8989 latency=30001ms
  15:20:48 peer-error    peer=141.98.198.197:8989 status=502 "This operation was aborted"
  ```
  同批 152.67.222.233 / 172.93.221.187 全部 `latency=30001~30007ms` + aborted。
- 佐证：本地 `upstream-done timing=9745ms`，而该轮 `hedge-win ttfMs=63804` —— 首块实际在 ~30s 后才到。

**根因**
`forwardToPeer` 的 abort 定时器与该请求的「首块到达时间」不匹配。`PEER_TIMEOUT_MS`（30s）既是
headers 超时又是整体 abort 超时，二者被混用。

**影响**
组网兜底实际退化为「每次白等 30s」。今日 mimo 统计：27 次 `peer-request` 全部未产出有效首块；
4 次 `hedge-win reason=race` **全部是 `via=local`** —— peer 从未翻盘，只是把响应时间往后拖。

**修复方向**
把 peer 的超时拆开：连接+响应头一个阈值、首块另设（对齐本地首字容忍度，或直接以
`PEER_BODY_TIMEOUT_MS` 为界），不要把 30s 作用于整条流。

---

## BUG-2【高】hedge 的 peer 重试最多跑三批、每批 30s 串行 ⇒ 单请求可被拖到 90s+

**现象**
一次 hedge 里 peer 被分三批依次尝试，每批各自吃满 30s，串行累加。

**证据**
- 代码：`src/routes/hedge.js:136-140`
  ```
  (await racePeerCandidates(candidates, handlerCtx)) ||
  (await racePeerCandidates(handlerCtx.peers.orderedByLastError(), handlerCtx)) ||
  (await racePeerCandidates(handlerCtx.peers.coolingByLastError(), handlerCtx));
  ```
  三次 `await` 串行，每次内部受 `PEER_TIMEOUT_MS`（30s）约束。
- 日志（同一 reqId=mvc2gxdq-2jxu）：
  ```
  15:20:16 hedge-trigger reason=slow
  15:20:18 第一批 peer-request（141.98 / 152.67 / 172.93）
  15:20:48 第一批全部 30001ms abort
  15:20:49 第二批 peer-request（127.0.0.1:3500 / 124.71.84.211 / 149.13.91.10）
  15:21:19 第二批 149.13.91.10 返回 → hedge 结束
  ```
  即 peer 阶段实耗 ≈ 63s，超出本地首块所需的 30s 一倍以上。
- 代码内自相矛盾的预算：`src/routes/hedge.js:147` `const remaining = 25_000 - hedgeDelay;`
  —— 该常量暗示 hedge 总预算 25s，但 peer 阶段**没有任何总预算控制**，三批叠加可到 90s。

**根因**
peer 阶段只按「批次」限流，没有按「总时长」限流；`tried` 集合（`src/routes/peers.js:181`）虽防重复
节点，但不阻止三批串行把时间堆满。

**影响**
最坏路径 total 被拉到 100s+。实测这条 percent 记录：`15:16:55 total=115027ms`、
`15:15:00 total=28529ms`，方差极大，客户端体验为「随机转圈」。

**修复方向**
给 peer 阶段加总预算（与 `hedge.js:147` 的 25s 假设对齐），或把三批改为并发而非串行。

---

## BUG-3【中】`peer-forward` 事件对「失败」也上报 ⇒ 转发成功率无法统计

**现象**
同一 peer 同一次尝试，日志里先出现 `peer-forward`，紧接着 `peer-error`。失败尝试也占用
`peer-forward` 这个名字。

**证据**
- 代码：`src/routes/peers.js:222`
  ```
  ctx.evt("peer-forward", { peer: peer.url, model: target, hops: ctx.hops + 1, latencyMs, ok: !failed });
  ```
  `failed` 为真时**仍然**打 `peer-forward`（只把 `ok` 置 false）；`:232` 再打 `peer-error`。
- 日志：
  ```
  15:20:48 peer-forward  peer=141.98.198.197:8989 latency=30001ms
  15:20:48 peer-error    peer=141.98.198.197:8989 status=502 "This operation was aborted"
  ```

**根因**
事件命名与语义不符：`peer-forward` 字面是「已转发」，实现里是「转发已结束（含失败）」。

**影响**
统计口径失真。今日 mimo 的 `peer-forward = 229`（全量）中混入大量失败，无法据此判断组员真实可用率；
按名字读日志的人会误以为转发成功。

**修复方向**
失败分支不再上报 `peer-forward`（或改名为 `peer-attempt` 并保留 `ok` 字段）。
`peer-forward` 的 `status=-` 也说明该字段未填实际状态码。

---

## BUG-4【中】明确不可达的 peer 被反复竞速；`coolingByLastError` 把它从冷却里捞回来

**现象**
`node-b`（`http://127.0.0.1:3500`）在本机根本没有服务，却每次 hedge 都被尝试，且失败次数已累积到 1569。

**证据**
- `state.json` → `peerStats`：
  ```
  "http://127.0.0.1:3500": { "fails": 1569 }
  "http://152.67.222.233:62028": { "fails": 338, ... }
  ```
- `state.json` → `peers` 中该条目：`{"name":"node-b","url":"http://127.0.0.1:3500","group":"mygroup"}`，
  token 是占位串 `aaaa…`（测试遗留），group 还是 `mygroup`（与真实组 `my@mslxd` 不同）。
- 日志：`15:20:49 peer-request peer=127.0.0.1:3500` → `15:20:49 peer-forward latency=17ms` →
  `peer-error "fetch failed"`（17ms 即失败，典型连接被拒）。
- 代码：`src/routes/peers.js:164-174` `coolingByLastError()` 会**故意把冷却中的 peer 重新纳入**兜底：
  ```
  return t - err < cooldownMs;   // 冷却窗口内 ⇒ 仍被返回，供第三批重试
  ```
  而 `:103-105` `available()` 只排除 `isCooling`，兜底路径绕过了它。

**根因**
连接级永久失败（ECONNREFUSED/ENOTFOUND）与暂时性故障共用同一套 30s 冷却，且兜底逻辑对
「明确不存在」的节点一视同仁地给机会。

**影响**
每次 hedge 多一次无意义竞速轮次，叠加 BUG-2 放大耗时；`peerStats.fails` 被这类噪音撑爆。

**修复方向**
连接级失败应提升冷却时长或标记 dead，不进入 `coolingByLastError` 兜底；`node-b` 这类遗留测试节点
应从 `state.json` 清理。

---

## BUG-5【中】「最终成功」的请求，其中间 peer 失败被写进 errors.log ⇒ 错误率虚高

**现象**
一个请求最终 **200 成功**，但 errors.log 里为它记了 4 条 `status=502`。

**证据**
- `errors.log` 15:17:38，reqId=`mvc2cusn-ufru`，连续 4 条：
  ```
  peer http://141.98.198.197:8989 This operation was aborted
  peer http://152.67.222.233:62028 This operation was aborted
  peer http://172.93.221.187:8989 This operation was aborted
  peer http://127.0.0.1:3500 fetch failed
  ```
- 同一 reqId 在 `events.log` / 模型日志里是成功：
  ```
  15:17:38 result          client status=200 via=local total=73007ms
  15:17:38 client-response client status=200 via=local total=73008ms
  ```
  同样情况见 reqId=`mvc2ef62-fz0a`、`mvc2gxdq-2jxu`。

**根因**
中间失败走 `ctx.logError`（`src/routes/peers.js:231`、`:268`）写入 errors.log，未区分「已恢复的中间失败」
与「最终失败」。

**影响**
`-stats` / 错误率面板被污染；运维按 errors.log 排查会误判「服务在持续报错」。风险评估失真。

**修复方向**
中间失败降级为事件（events.log）或 warn 级，只有真正终止客户端的失败才进 errors.log。

---

## BUG-6【低】`peer-request` 事件不带 peer 名称 ⇒ 多节点归因困难

**现象**
日志只有 `peer=141.98.198.197:8989` 这种 URL，没有节点名。

**证据**
- `src/routes/peers.js:207` `ctx.evt("peer-request", { peer: peer.url, ... })` 只传 `url`。
- `state.json` 中部分 peer 确有独立 `name`（如 `node-b`、`leader`），但事件里被丢弃。

**根因**
事件字段未透传 `peer.name`。

**影响**
多组员时「哪个节点慢/挂」只能靠 IP 记忆，日志可读性差（本次排查即需反复对照 `state.json`）。

**修复方向**
`evt` 里带上 `name: peer.name || peer.url`。

---

## BUG-7【高·用户重点关注】非 auto 请求「指定模型 = 死锁单模型」⇒ free 模型额度满时**不会自动切换**

**现象**
客户端显式请求某个 free 模型（如 `deepseek-v4.1-flash-free`、`mimo-v2.6-flash-free`）时，
候选链长度为 1、`fallback=0`。该模型若额度耗尽，只会把 429 原样返回，不会切到同供应商其他 free 模型。

**证据**
- 代码：`src/chat-pipeline/index.js:76-95`
  ```
  // 语义：指定模型 = 死锁单模型（本机→组员同款，挂了就报挂，不兜其他 picks）；只有 auto 才轮 picks
  if (lockModel) order = [requested];
  ...
  else {                    // 非 auto 分支
    if (auto && requested) { try { await auto.candidatesFor(requested); } catch {} }
    order = [requested];    // ← 恒为单元素
  }
  const canFallback = order.length > 1;   // ⇒ false
  ```
- 日志：deepseek-v4.1-flash-free 今日 3 次请求全部
  ```
  ordered route order=deepseek-v4.1-flash-free hops=- fallback=0
  ```
  （`events.log` 中该模型 3×`ordered` / 3×`model-try` / 3×`upstream-try`，无任何 fallback 事件。）
- 实测额度耗尽的后果（errors.log，另一 free 模型）：
  ```
  2026-10-16 16:29:53 status=429 model=muse-spark-1.3-contributor-free
    upstream 429 body={"error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded..."}}
  ```
  客户端直接吃 429，未切换。

**根因**
`order` 在非 auto 路径被写死为 `[requested]`，`canFallback` 随之为 false —— 设计上「显式指定即锁定」，
但用户诉求是「同一供应商 free 模型池应互备」。

**影响**
**这正是「额度满不会自动切换」的根因**。对 opencode 免费池（`mimo-v2.6-flash-free` /
`deepseek-v4.1-flash-free` 等裸 id 模型）而言，单模型额度耗尽即整条链路失败，与「免费层无限用」的预期不符。

**修复方向**
对同一供应商的 free 模型池，允许额度类失败（429/额度判决）时横向切换到池内其他模型；
或提供开关让指定 free 模型时启用同池回退。

---

## BUG-8【高】`429 FreeUsageLimitError` 被判为「非终局」⇒ 白跑组员接力 70s 后才回错

**现象**
额度类 429 不触发终局短路，网关继续把请求转发给全部组员；组员与本地同源，撞的是同一堵墙，
于是客户端在长时间等待后才拿到错误。

**证据**
- 代码：`src/chat-pipeline/terminal-verdict.js:20-24` 终局模式**只含** `/FreeTierError/i`，
  **不含** `FreeUsageLimitError`：
  ```
  const FREE_TIER_PATTERNS = [
    /FreeTierError/i,
    /free tier can only be used/i,
    /免费(?:层|额度).{0,12}(?:只能|仅限|不可)/,
  ];
  ```
  而 `:43-50` 的 `TRANSIENT_MARKERS` 含 `/rate.?limit|too many requests|over.?quota|retry after/i`，
  实测 429 body 为 `"Rate limit exceeded. Please try again"` ⇒ 命中 transient ⇒ `{ terminal: false }`。
- 文件头注释（`:9-11`）明确其设计意图：「一切可能随号/随额度/随时间恢复的都**不算**终局，接力与
  failover 照常：401/402/429/5xx、fetch 异常。」
- 现网取证（同文件 `:3-7` 注释记录的原始事故，`deepseek-v4.1-flash-free.log` req=`mv9m1d2v-n2y5`）：
  ```
  22:04:41 上游 6s 就回 403 FreeTierError
  22:05:45 peer-race-lose
  22:05:46 exhausted-local status=502
  22:05:46 result client status=502 via=none total=72752ms
  ```
  真相 6s 可得，客户端 72.7s 后才看到。

**根因**
判据只覆盖「身份/资格闸门」类拒绝，未覆盖「额度已耗尽」类 —— 二者对**同源组员**而言同样不可恢复。

**影响**
额度满时用户要等 ~70s 才拿到错误，且看不到任何「额度已满」的明确提示。

**修复方向**
把 `FreeUsageLimitError` 一并纳入终局判定（或至少对「额度类」跳过组员接力，直接返回带明确文案的错）。
⚠️ 注意与 BUG-7 的配合：理想行为是「先横向切同池模型，池内全满才判终局并快速失败」。

---

## BUG-9【低】`isFastFailStatus` 是死代码：定义了、导出了、被测试覆盖，但生产逻辑从未调用

**现象**
`isFastFailStatus`（判定 429/502/503/504）在 `src/routes/hedge.js` 定义并导出，测试文件引用它，
但**没有任何生产路径调用**。

**证据**
- `src/routes/hedge.js:11-14` 定义；`:84` `export { hedgeDelayMs, isFastFailStatus, shouldHedge };`
- 全仓 grep 命中仅三处：定义处、导出处、`test/hedge-race.test.js:12,55-62`（纯断言测试）。
- `shouldHedge`（`:16-25`）内部**未引用**它 —— hedge 只按 `hedgeDelayMs` 慢触发，快速失败不提前 hedge。

**根因**
设计意图（快速失败状态码应提前触发对冲）未接进 `shouldHedge`/hedge 主流程，函数被孤立。

**影响**
上游 429/502/503/504 快速失败时，要等满 `hedgeDelay` 才启动对冲，浪费本可提前的切换时机；
同时留下「看起来已实现、实则未生效」的误导。

**修复方向**
要么把 fast-fail 接进对冲触发条件，要么删除该导出与其测试（避免继续误导）。

---

## 附：deepseek-v4.1-flash-free 专项观察（用户点名）

**结论：额度满时不会自动切换，会直接把错误返回客户端。** 支撑见 BUG-7（候选链锁死单模型）+ BUG-8（额度类不短路）。

**今日状态（2026-10-17）**：3 次请求，均正常。
```
15:11:07 upstream-try（随后 daemon 于 15:11:38 重启，该请求无 upstream-done，属重启中断，非缺陷）
15:11:25 upstream-try（同上）
15:25:11 upstream-done status=200 timing=8188ms
15:25:32 result client status=200 via=local total=20626ms
16:55 前无 429/额度类错误
```
**历史额度耗尽实例**（errors.log，同供应商 free 池）：
```
2026-10-16 16:29:53 muse-spark-1.3-contributor-free  429 FreeUsageLimitError "Rate limit exceeded"
2026-10-16 16:31:05 muse-spark-1.3-contributor-free  429 FreeUsageLimitError
2026-10-16 16:32:18 muse-spark-1.3-contributor-free  429 FreeUsageLimitError
2026-10-16 16:54:41 ll-alpha-free                    429 FreeUsageLimitError
```
这些 429 均未触发模型切换。另注：`mimo-v2.6-flash-free` 今日全程未出现额度耗尽，
瓶颈是**速度**（首字 8~10s、整场 20~115s）而非额度。

---

## BUG-10【高】events.log 溢出后断崖式砍到 100 行 ⇒ 保留窗口仅约 3 分钟，出问题后日志已不可查

**现象**
`events.log` 是排查运行问题的**主入口**（`mslxdff -log` 读它、`-debug` 消费它），但它的实际保留窗口
只有 **3 分钟左右**。一旦要回看半小时前的异常，记录已经不存在。

**证据**
- 代码：`src/logs.js:10` `const MAX_BYTES = 1024 * 1024;`；
  `:36-47` `trimIfOversized()` → `:42` `const keep = lines.slice(-100);`
  `:49-60` `trimIfOversizedAsync()` → `:55` 同样是 `lines.slice(-100)`
  —— 溢出时**不按字节回退**，而是把整个文件替换为最后 100 行。
- 实测两次采样（间隔约 2 分钟）：
  ```
  15:42:53   events.log = 824,790 字节
  15:44:50   events.log = 191,550 字节   首条时间戳已跳到 15:38:42
  15:47:00   events.log = 256,800 字节   首条时间戳 = 15:44:28（263 行）
  ```
  文件字节数**下降**且首条时间戳持续前移 ⇒ 确证发生了裁剪。
- 事件产生速率：`deepseek-v4.1-flash-free` 单模型今日 142 个请求 × 约 11 条事件/请求 ≈ **1500+ 条事件**；
  事件行含 `detail` 对象，实测均值约 **1,008 字节/行** ⇒ 约 1000 行即触达 1MB。
- 直接后果（本次排查亲身踩到）：15:35:23 的 3 次 `client-abort` 在模型日志里有记录，
  但在 `events.log` 中按 reqId 检索 **0 条命中** —— 已被裁剪掉。

**根因**
`MAX_BYTES`（1MB）与 `slice(-100)`（保留行数）不匹配：触发阈值设计成 1MB，但回退策略只留 100 行
（约 100KB），**一次裁剪丢弃 90% 的容量**；同时 1MB 的阈值在高事件速率下仅够覆盖数分钟。

**影响**
- 事后排查能力被摧毁：用户诉求正是「看看运行过程是否有问题」，而主日志只留 3 分钟。
- 与 `calls.log`(997 行/覆盖 17 小时)、`errors.log`(1244 行/覆盖 3 天) 的保留能力严重不对称，
  说明该裁剪并非全仓一致策略。
- 用户本轮遇到的 `client-abort`（客户端主动断开）无法在 events.log 回溯，只能靠模型日志拼凑。

**修复方向**
改为**按字节保留**（如保留末尾 3/4 而非固定 100 行），或按时间窗口轮转；同时把阈值与
实际事件速率对齐。仅调整 `MAX_BYTES` 而不改 `slice(-100)` 无效——断崖仍在。

---

## BUG-11【低】`MAX_CALLS` / `MAX_ERRORS` 是死常量，从未被引用

**现象**
`src/logs.js` 顶部定义了 `MAX_CALLS = 500`、`MAX_ERRORS = 200`，但全仓无任何引用。

**证据**
- `src/logs.js:8-9` 定义；全仓 grep 仅命中这两行本身。
- 实际的裁剪走 `trimIfOversized` 的 `MAX_BYTES`，与这两个常量无关。

**根因**
遗留常量：函数级上限（500/200）的设计被文件级字节阈值取代后未清理。

**影响**
误导后来者以为日志有 500/200 条的保留保证（实际是 100 行断崖）。与 BUG-9 同类。

**修复方向**
删除，或按设计意图接进实际裁剪逻辑。

---

## 附二：两模型行为对照（2026-10-17 15:47 观测）

**deepseek-v4.1-flash-free 今日爆发式使用，全成功**
```
142 个 reqId；97 次 model-try，90 次 result —— 全部 status=200 via=local，fallback=0，零额度错误
最近 10 条 result 耗时(ms)：13762/34220/7554/11144/18947/12322/6157/12321/8033/9016
3 次 client-abort（15:35:23 同一秒，reqId mvc30j3p-e7t5 / mvc30his-fmex / mvc30hg5-xiaj）
```
- 3 次 `client-abort` 发生在同一秒，且均已完成 `relay-first-chunk`（流已开始）⇒ 典型的**客户端主动断开**
  （如并发请求被取消），非网关缺陷。但如上所述，其 events.log 记录已被 BUG-10 裁掉。
- **仍未出现额度耗尽**，故 BUG-7/BUG-8 的「额度满不切换」本日未被触发实证。

**mimo-v2.6-flash-free 自 15:23:25 后静默**
```
最后一条：15:23:25 client-response total=62928ms
此后至今（15:47）无任何新请求，文件停留在 416,405 字节
```
静默原因推测：调用方改用了 deepseek（同池、更快）。两模型同供应商同免费层，速度差异显著：
```
mimo 最近 10 条 result(ms)：35101/19573/39146/28529/115027/73029/73691/43170/136985/62925
deepseek 最近 10 条(ms)：   13762/34220/7554/11144/18947/12322/6157/12321/8033/9016
```
mimo 严重偏慢（多次 60~137 秒），这与其「思考很长」的特性相符（见 talk 日志中大量 `[模型思考]` 段），
属**模型特性**而非网关缺陷；但 BUG-1/BUG-2 的 hedge 超时问题会把它进一步放大。

---

## BUG-12【高】流式总时长上限默认被关（0），与文档记载的 120s 矛盾 ⇒ 单请求可挂 3.5 分钟

**现象**
一个请求实测挂到 **209.5 秒**（3 分 29 秒）才返回 200。文档明写总时长上限默认 2 分钟，实际代码
默认关闭（0），该闸门从未生效。

**证据**
- 文档：`docs/cli_help.md:1395`
  ```
  | `MSLXDFF_MAX_STREAM_MS` | `120000` (2m) | 流式总时长上限 |
  ```
- 代码：`src/routes/stream.js:75-78`
  ```
  export const MAX_STREAM_MS = (() => {
    const n = Number(process.env.MSLXDFF_MAX_STREAM_MS);
    return Number.isInteger(n) && n > 0 ? n : 0;   // ← 默认 0（关）
  })();
  ```
  `:211-217` `const maxTimer = MAX_STREAM_MS ? setTimeout(...) : null;` ⇒ 默认下 `maxTimer = null`，
  **完全无总时长闸门**。
- 同类：`:64-67` `STALL_TIMEOUT_MS` 默认也是 `0` ⇒ **停顿保护同样关闭**。
- 三方注释互斥：`src/routes/peers.js:11-16` 声称「与应用层 MAX_STREAM_MS(120s) 对齐」，
  但应用层的 120s 并不存在（默认 0）。三处说法两两矛盾。
- **实测（reqId `mvc394zg-s9ws`，全生命周期）**：
  ```
  15:42:01 request          近 600KB 对话上下文（messages=90）
  15:42:11 relay-first-chunk
  15:43:04 relay-done  finish=length completion=8192  ← 思考刷满 token，正文 0 字
  15:43:04 upstream-error   502 empty turn
  15:43:04 fallback         from=deepseek-v4.1-flash-free reason=empty turn  ← 换组员
  15:43:10 peer-race-win    winPeer=124.71.84.211:8989 latencyMs=5234  ← 组员赢了
  15:45:31 relay-done  elapsed=140615ms  chunks=624
  15:45:31 slow-model  elapsedMs=140615 threshold=0 interrupted=true  ← threshold=0 暴露默认值
  15:45:31 result       client status=200 via=peer total=209510ms
  ```
  `threshold=0` 直接印证 `STALL_TIMEOUT_MS=0`；整条链**无任何闸门生效**。

**根因**
`MAX_STREAM_MS`/`STALL_TIMEOUT_MS` 的 env 读取把「未设置」与「设为 0」都归成 0，且默认值选的是
「关闭」；文档却按「默认 120000」记载。默认关闭 = 设计上的防挂死闸门形同虚设。

**影响**
- 最坏路径无上界：`PEER_TIMEOUT_MS`(30s) × 三批 + 空轮重试阶梯（`empty-turn.js:10` `[2000,8000,30000]`）
  + 无总时长的 peer 中继 ⇒ 实测 209s，链路越长越糟。
- 今日 deepseek 164 次 result 中：**34 次 >20s、1 次 >120s、1 次 >180s**，长尾明显。
- 用户视角即「偶发长时间转圈」，且因 BUG-10 日志只留 3 分钟，这类长请求事后难追溯。
- 与 `ADR-0035`（SDK 通道 headers 默认 120s 闸门）形成反差：那条通道有闸门，流式通道反而没有。

**修复方向**
让默认值与文档一致（120000），或修正文档；并明确「0 = 显式关闭」而非「未设置即关闭」。
`STALL_TIMEOUT_MS` 同理——背离它自己的注释（`peers.js:11-14` 描述的「首块后 ~31s 必断」问题）。

---

## BUG-13【低】经组员中继的响应拿不到 usage / finish_reason，成本统计静默失真

**现象**
`relay-done` 的 `usage(prompt=-/completion=-)`、`finish=-`：经 peer 中继返回的流未解析出用量与结束原因。

**证据**
- `mimo-v2.6-flash-free.log`（2026-10-10 22:10:53）
  ```
  stage=relay-done status=200 finish=- chunks=46 bytes=11647 tools=0 chars=0 usage(prompt=-/completion=-)
  ```
- `deepseek-v4.1-flash-free.log`（2026-10-17 15:45:31，即 BUG-12 那条 `via=peer`）
  ```
  stage=relay-done status=200 finish=- chunks=624 bytes=278608 usage(prompt=-/completion=-)
  ```
- 比例：deepseek `relay-done` 165 条中缺 usage 1 条；mimo 120 条中缺 1 条 —— 发生频率低。

**根因**
本地直连与 peer 中继对 SSE 尾帧的解析口径不一致（peer 流的 usage/finish_reason 未被提取），
`relay-pipeline.js` 的 `detail.usage` 因此为空。

**影响**
`-stats` / usage JSONL 对经组员中继的请求漏记 token 消耗，成本报表偏低。低频但会静默累积。

**修复方向**
统一 peer 与本地路径的尾帧解析；解析不到时在日志中显式标注「peer 未回 usage」，避免与真 0 混淆。

---

## BUG-14【中】`detail.toolCalls` 计的是「tool_calls 片段出现次数」而非「工具调用个数」⇒ 读数虚高数千倍

**现象**
日志里出现 `tools=4894`、`tools=4837`、`tools=4072` 这类数字，看起来像模型一轮调用了近五千次工具。
实际是计数口径错误——同一批工具调用的参数字节流被切成数千个 SSE 分片，每片都被计一次。

**证据**
- 代码：`src/routes/stream-scan.js:127-128`
  ```js
  const tc = txt.match(/"tool_calls"\s*:\s*\[\s*\{/g);
  if (tc) detail.toolCalls = (detail.toolCalls || 0) + tc.length;
  ```
  它对**每个 SSE chunk 的文本**做匹配并**累加**。流式协议下同一工具调用的 `arguments` 是分片传输的，
  几乎每个分片都含 `"tool_calls":[{` ⇒ 一次工具调用被计成 N 次（N ≈ 参数字节数 / 分片大小）。
- 实测（`deepseek-v4.1-flash-free`，events.log 的 `detail`）：
  ```
  mvc3kvcs-3shs  chunks=5999  bytes=1639279  toolCalls=4894  chars=223
  mvc3onr0-tgr2  chunks=4908  bytes=1337689  toolCalls=4837  chars=0
  mvc3mjb2-yrq1  chunks=4124  bytes=1123358  toolCalls=4072  chars=27
  ```
  占比：4894/5999=**82%**、4837/4908=**98.5%**、4072/4124=**98.7%** —— 即绝大多数分片都命中该正则。
  若真为 4894 次工具调用，响应须含 4894 个 call id，与 OpenAI 协议及 `chars≈0` 均不相容。

**根因**
计数按「正则命中次数」累加，未去重、未按 `"index":N` 归并。而该字段的真实用途只是**布尔判断**
——`stream-scan.js:125-126` 注释自陈：「工具调用计数（空数组不算）：tool_calls 无正文是合法 agent 轮，
空转闸门必须豁免它，否则所有工具轮都会被误判为空轮」。既然只需 `> 0`，累加计数纯属多余且有害。

**影响**
- 功能未坏（闸门只用 `> 0`），但**日志与统计读数是错的**，实测数千倍的量级。
- 本次排查中该读数一度把我引向「模型陷入疯狂工具调用」的错误推断——正是「统计口径与实际语义不符
  导致误读」的典型（与 BUG-3、BUG-8 同族）。
- 非流式路径 `:184-185` 用的是 `_tcList.length`（**正确**口径），两条路径口径不一致。

**修复方向**
改为布尔标记（`hasToolCalls`），或按 `"index":N` 去重后计数，与 `scanNonStreamBody` 对齐。

---

## BUG-12 补充实证：首块快但整体慢的请求完全没有对冲保护

**现象**（2026-10-17 15:52–15:55，2 分钟内连续 4 次）
```
mvc3kvcs-3shs  stallHits=1 maxGapMs=22730  elapsed=77460ms  首块 ttfMs=277
mvc3mjb2-yrq1  stallHits=1 maxGapMs=15652  elapsed=37280ms  首块 ttfMs=1
mvc3nijk-xamy  stallHits=1 maxGapMs=20059  elapsed=42544ms  首块 ttfMs=1
mvc3onr0-tgr2  stallHits=1 maxGapMs=23813  elapsed=40739ms  首块 ttfMs=5
```
4 条全部 `via=local`、`hedge-win reason=no-hedge-needed`。

**关键推理**
hedge 的触发条件是「首块超过 1000ms 未到」（`hedge-trigger reason=slow`）。这 4 条的**首块都在 5ms 内到达**，
因此 hedge 判定「不需要对冲」。但真正的耗时发生在首块**之后**——单次停顿 15~24 秒，整轮 37~77 秒。

换言之：**「首块快、流很慢」这一类退化，同时绕过了两层保护**：
1. hedge 不触发（它只看首块，不看后续流速）；
2. `STALL_TIMEOUT_MS`/`MAX_STREAM_MS` 默认 0（BUG-12），停顿与总时长闸门都不存在。

于是这类请求只能**硬等到底**。`slow-model reason=stall` 事件只做事后记分（`relay-pipeline.js:233-238`
调用 `auto.recordError` 降权），**对当前这一发毫无补救**。

**修复方向**
对冲条件除「首块慢」外，应补充「已写出首块但后续停顿 > N 秒」；或启用 `STALL_TIMEOUT_MS` 默认值，
让 stall 能真正掐断并换路——目前它只是个记分器。

---

## BUG-10 实时确证：捕获到裁剪发生的瞬间（2026-10-17 16:00）

**逐秒采样 `events.log`，完整记录了一次裁剪**：
```
第1次: 行=1039  字节=1,045,999  首条=2026-10-17 15:44:28
第2次: 行=1039  字节=1,045,999  首条=2026-10-17 15:44:28
第3次: 行=1043  字节=1,047,270  首条=2026-10-17 15:44:28   ← 越过 1MB 阈值
第4次: 行=99    字节=102,345    首条≈15:59                  ← 约 2 秒后
```
**一次丢弃 1043 − 99 = 944 行（90.5%）**，覆盖窗口从约 16 分钟骤降到**约 1 分钟**。
`slice(-100)` 的行为完全如代码所写（`src/logs.js:42`/`:55`）。

**对本轮排查的直接影响**：15:55–15:56 那次最坏路径（`mvc3pocj-9t47`，见下）的 events.log 记录
在裁剪中丢失，只剩模型日志可查。

---

## BUG-1/BUG-2 量化影响：`peer-miss` 把 18 次请求的首字拖到 34~65 秒

**全仓 `hedge-win` 按 reason 分布**
```
no-hedge-needed  714   （首块够快，未对冲——正常）
race              38   （本地与 peer 竞速，本地赢）
peer-miss         18   （peer 全败，回本地兜底）← 每次都是纯浪费
```
**`peer-miss` 的 `ttfMs`（客户端首字延迟）实测**：
```
65,128ms / 65,061ms / 64,204ms / 64,155ms / 63,354ms / 63,324ms / 63,170ms / 63,063ms
62,351ms / 61,314ms / 60,314ms / 39,965ms / 38,752ms / 35,273ms / 35,114ms / 34,938ms
34,751ms / 34,452ms / 34,373ms
```
即：**18 次请求的客户端首字被迫等待 34~65 秒，最后拿到的仍是本地已有的那份数据**——
peer 阶段没有带来任何收益，纯粹是 BUG-1（30s 硬超时掐断慢首块）+ BUG-2（三批串行）叠加的代价。
典型路径（`mvc3pocj-9t47`，2026-10-17）：
```
15:55:01 hedge-trigger reason=slow
15:55:03 第一批 peer-request × 3
15:55:33 三个 peer 全部 latency=30001~30011ms + aborted     ← 吃满 30s
15:55:35 第二批 peer-request × 3（含死节点 127.0.0.1:3500）
15:55:35 peer-error 127.0.0.1:3500 "fetch failed"           ← 17ms 即失败，BUG-4
15:56:05 第二批全部 30002~30014ms + aborted                 ← 又吃满 30s
15:56:05 hedge-win reason=peer-miss ttfMs=65128 via=local   ← 白等 65 秒后回本地
15:56:05 result  client status=200 via=local total=72431ms
```
**另注**：该请求的 6 条 peer 失败被逐一写进 `errors.log`（reqId 相同、`status=502`），
而它最终 `status=200` 成功——即 BUG-5 在同一实例上再次复现。

---

## 附三：两个「曾经崩溃、现已修复」的确认（不计为新缺陷，但值得归档）

### 已修复 A：`ERR_STREAM_WRITE_AFTER_END` 曾 673 次打进 `uncaughtException`

**证据**（`daemon.log`）
```
673 条  [lifecycle] uncaughtException (kept running): Error [ERR_STREAM_WRITE_AFTER_END]: write after end
        at ServerResponse.end (node:_http_outgoing:1100:15)
        at json (file:///D:/www/wwwroot/mslxdff/src/routes/helpers.js:24:7)
        at handleExhaustedAll (.../exhausted-handler.js:54|59|49:3)
        at runSerialTrial (.../serial-trial.js:208|273|173:9)
        at async Object.execute (.../chat-pipeline/index.js:113|116|91:5)
```
- 成因清晰：`handleExhaustedAll` 的 `terminal(res, …)` 会对**已经结束**的响应再写一次。
- **现已修复**：`src/routes/stream-hold.js:105`
  ```js
  export function endHeldFailure(res, message, flushTail) {
    if (!res || res.writableEnded) return false;   // ← 恰好一次的守卫
  ```
  配合 `:107` `if (!res.headersSent)` 分流（未 flush → 502 JSON；已 flush → SSE 错误帧 + `[DONE]`，
  注释明写「绝不抛 ERR_HTTP_HEADERS_SENT」）。
- **修复已生效的验证**：673 次全部落在 `daemon.log` 行 15681–36874（历史版本区段）；
  行 36875 之后为 **0 次**，而该区段有 **6,225 条** `sdk-upstream` 诊断（说明其间有大量请求经过）。
  当前运行版本 v0.1.187 的启动横幅位于行 60091+，确实再无该异常。

### 已修复 B：`Error: listen` 启动期端口占用（1 次）
`daemon.log` 另有 1 条 `uncaughtException: Error: listen`，属启动阶段端口未能绑定。
现由 `src/warp-pool/ports.js` 的 `reclaimPort/portInUse/portOwner/waitPortFree`（见功能树叶 13.6.7
「端口占用守卫与上一代进程清理」）接管，当前版本未见复发。

**归档理由**：这两条本身不是待办，但它们印证了「`daemon.log` 是唯一能事后回溯崩溃的载体」——
而该文件**没有任何大小上限**（7MB / 60,321 行且持续增长）。若哪天被清理或被 BUG-10 式的策略波及，
这类「曾经崩过 673 次」的事实将永久丢失。见下条。

---

## BUG-15【中】`daemon.log` 无大小上限，7MB / 60,321 行持续增长

**现象**
唯一的崩溃回溯载体 `daemon.log` 从不轮转、不裁剪。

**证据**
- `src/daemon.js:34` `const logFd = openSync(logFile(), "a", 0o600);`
  `:41` `stdio: ["ignore", logFd, logFd]` —— 子进程直接以追加模式持有该 fd，
  全仓**没有任何**对 `daemon.log` 的大小检查/轮转代码。
- 实测：`6,997,474 字节 / 60,321 行`（对比 `events.log` 有 1MB 阈值，见 BUG-10；二者的
  日志管理策略完全不对称）。
- 内容构成：`[sdk-upstream]` 诊断 **9,126 行**、`uncaughtException` 堆栈 674 条（含 673 次
  `ERR_STREAM_WRITE_AFTER_END` 的历史记录）、以及每 60 秒一条的 `group sync` 心跳
  （`[16:01:39] [16:02:39] [16:03:38] [16:04:39]` 等，单日即 1,440 行）。

**根因**
设计上把 `daemon.log` 当作「stderr 直连文件」，未纳入 `src/logs.js` 的日志桶管理（那里只管
calls/errors/events/timeline）。

**影响**
- 长期运行磁盘无界增长；CoW 文件系统（btrfs）上反复追加同一文件曾引发「幽灵盘占用」问题
  （参见该目录下遗留的 `daemon_err.log`）。
- 崩溃取证依赖此文件的存在与完整，一旦人工清理，历史崩溃证据即丢失。
- 排查时 `-log` 读的是 `events.log`（只 1 分钟窗口，BUG-10），而真正有料的 `daemon.log` 又因
  过大不适合直接读——**两个日志桶各自坏在相反的方向**。

**修复方向**
给 `daemon.log` 加轮转（按大小保留 N 个 `.1/.2`），并把 `[sdk-upstream]` 的常规转储降级
（见 BUG-16），二者配合才能既保住取证又不失控。

---

## BUG-16【中】`sdk-upstream` 诊断在 97.5% 的情况下打印无用转储，是 daemon.log 膨胀主因

**现象**
每次上游非 2xx，都会往 `daemon.log` 打印**三行大文本**（含最长 40 条消息的序列转储），
而其中绝大多数是「没问题」的诊断。

**证据**
- 代码：`src/upstream-engine/sdk/attempt.js:80-90`
  ```js
  function logRequestDiagnosis(bodyText, status) {
    ...
    const { issues, summary } = diagnoseToolSequence(msgs);
    console.error(`[sdk-upstream] ${status} ${summary} issues=${issues.length ? issues.join(" | ") : "none"}`);
    console.error(`[sdk-upstream] head: ${compactSequence(msgs, 0, 6)}`);
    console.error(`[sdk-upstream] tail: ${compactSequence(msgs, Math.max(0, msgs.length - 40))}`);
  }
  ```
  对**任何**非 2xx 触发，不看 `issues` 是否为空。
- 实测分布（`daemon.log` 全量）：
  ```
  状态码：401×1829  429×1023  403×105  400×35  402×24  503×13  404×5  500×4  410×2  550×2
  诊断结论：issues=none  2945 次（97.5%）  ← 问题为空，仍打印
            issues 非空   仅 75 次
  ```
  即 **3,020 次非 2xx 里有 2,945 次打印了「一切正常」的转储**，每行含数十个 call_id。
- 典型噪音：daemon.log 里 `msgs=275 calls=77 results=77 issues=none` 连续 3 行 × 每请求。
- `daemon.log` 中 `[sdk-upstream]` 共 9,126 行，是 7MB 文件的主要组成。

**根因**
诊断日志的触发条件是「非 2xx」，而它的**价值条件是「issues 非空」**——两者被混同。
工具序列断裂（`#64 assistant 打断未闭合{call_…}`）才是有用的 75 条，其余 2,945 条纯噪音。

**影响**
- 与 BUG-15 互为因果：噪音撑大 `daemon.log`，而该文件无上限。
- 淹没真信号：真正有价值的 75 条序列断裂记录被埋在两万余行噪音中。
- 401 大比例源于未带 key 的探测请求（`msgs=1 calls=0`），本就无需诊断转储。

**修复方向**
仅在 `issues.length > 0` 时打印 head/tail 转储；`issues=none` 时只留一行摘要（或降级为
计数），大幅削减噪音同时保住真信号。

---

## BUG-17【高】上游超时后流被中途掐断，却仍以 `status=200 + interrupted:true` 当成功返回 ⇒ 客户端不知情地吞下被腰斩的回答

**现象**
2026-10-17 16:18:07，`raccoon/sn-deepseek-v4-1-flash` 一次请求跑满 **300,143ms** 后返回。
calls.log 记为 `status=200`（成功），客户端侧看到的是一份**不完整、中途截断、且没有终止信号**的回答。

**证据（events.log + 模型日志）**
```
16:18:07  request    mvc4d48f-fezx  stream=true  model=raccoon/sn-deepseek-v4-1-flash
16:18:07  ordered    order=["raccoon/sn-deepseek-v4-1-flash"] canFallback=false
16:18:07  group-skip reason="provider local-only（禁组员，仅本机直连）"   ← 本机直连，无 peer
16:18:12  upstream-done status=200  durationMs=25246                     ← 25s 才拿到响应头
16:18:12  relay-first-chunk ttfMs=0                                      ← 首块立即到
16:22:46  relay-done   status=200  totalMs=274793  interrupted=true
          detail.exitReason="upstream-error"
          detail.upstreamError="The operation was aborted due to timeout"
          detail.receivedChunks=2012 receivedBytes=416738
          detail.sawDone=false  sawFinishReason=null
          detail.maxGapMs=794   ← 全程活跃，非卡死
16:22:46  slow-model    elapsedMs=274793  interrupted=true
16:22:46  result        status=200  via=local  interrupted=true
16:22:46  client-response status=200  interrupted=true
```

**根因（三处叠加）**
1. **300s 闸门来自 provider 自身的请求级超时**：`src/providers/raccoon/index.js:38`
   `timeoutMs = Number(process.env.MSLXDFF_RACCOON_TIMEOUT_MS) || 300_000`，
   经 `src/providers/raccoon/chat.js:153` 的 `timeoutSignal(timeoutMs)` 施加到整个流式响应体上。
   `timeoutSignal` → `AbortSignal.timeout()`（`src/compat.js:21-27`），其抛出的正是
   `TimeoutError: The operation was aborted due to timeout` —— 与 `detail.upstreamError` 逐字吻合。
   时间对账：25,246ms（等头）+ 274,793ms（读体）= **300,039ms ≈ 300,000ms**，误差 39ms。

2. **中途断流被降级为「成功」**：`src/routes/stream.js:297-301` 捕获读取异常后，
   因 `wrotePayload=true` 走 `:314-319` 分支 → `interrupted=true`、
   `detail.exitReason="max"`（`detail.exitReason` 若未设则填 `stalled ? "stall" : "max"`），
   最终 `return { status: 200, ... }`。

3. **`relay-pipeline.js:200-220` 把 `interrupted` 的 200 完全按成功处理**：只发 `slow-model`
   与 `result` 事件、落一条 usage，**不向客户端写任何错误帧**，返回值交给下游 `res.end()`。

4. **`flushHeldTail` 只在尾部补 `[DONE]`，不补生成终止标记**（`src/routes/stream.js:317`
   调 `prefix.flushTail()`）：`sawFinishReason=null` 说明**上游从未发出 `finish_reason`**，
   网关也没补——客户端收到的是一个有 `[DONE]` 却**没有 `finish_reason`** 的流，
   按流式协议这属于「异常终止」，但 HTTP 状态与 calls.log 均记为 200。

**影响**
- 客户端**不知道**回答被截断（无 `finish_reason`、无错误帧、HTTP 200）。
  agent 类客户端会把半截回答当作完整结果继续用——比直接报错更危险。
- `calls.log` 记 `status=200`，所有成功率统计把这次算作成功，**300 秒的失败被计为一次成功的慢请求**。
- 越长的生成越容易撞上 300s 墙（本次 2012 chunks / 416KB，是极长的生成），
  即「回答越长越可能被静默腰斩」。

**决定性旁证（2026-10-17 16:42 核对）**
```
errors.log 中 "mvc4d48f-fezx" 匹配行数 = 0     ← 300 秒被腰斩，错误日志零记录
calls.log  中该请求                     = {"status":200,"durationMs":300143,...}
```
即：网关**既不报错、也不告警、也不留痕**，只把这次事故记成一次「成功的慢请求」。
（该 reqId 在 calls.log 中出现两次——16:13:32 / 25247ms 与 16:18:07 / 300143ms，
同一 reqId 复用两次，会使归因混淆；此点证据不足，仅备注待查，未列为独立缺陷。）

**修复方向**
- `interrupted=true && sawFinishReason===null` 时，收尾应写一个 SSE 错误帧（对齐
  `stream.js:338-341` 的 `reasoning-only` 做法：错误帧排在 `[DONE]` 之前），
  让客户端能识别「本次回答被截断」。
- `calls.log` / `result` 事件的 status 不应记 200，至少要与 `interrupted` 一起呈现
  （当前已带 `interrupted` 字段，但 calls.log 只记 status）。
- 核对 `MSLXDFF_RACCOON_TIMEOUT_MS` 的 300s 是否合理：它同时充当「请求级超时」，
  而本仓文档对慢流的预期上限是 120s（`docs/cli_help.md:1395`），二者不一致（参见 BUG-12）。

---

## BUG-18【中】300s 请求级超时与「首块快、整体慢」的长生成天然冲突，且无对冲、无分档

**现象**
同一次请求（BUG-17 的 `mvc4d48f-fezx`）揭示了另一层问题：**它从头到尾没有任何补救机制**。

**证据**
```
detail.maxGapMs=794      ← 全程数据间隔从未超过 794ms，流一直健康
detail.stallHits=0       ← 从未触发停顿判定
16:18:07 group-skip      ← local-only，禁组员，peer 对冲在第一道门就被关掉
detail.exitReason="upstream-error"  ← 直到 300s 墙才被动结束
```
`STALL_TIMEOUT_MS=0`、`MAX_STREAM_MS=0`（`src/routes/stream.js:64-78`，见 BUG-12），
所以 300s 是**唯一**生效的墙，且它是**被动终结**而非**主动换路**。

**根因**
- 对冲（hedge）的触发条件是「首块慢」，本次首块 `ttfMs=0`，**不触发**；
  但整体耗时 274s —— 与 BUG-12 补充实证描述的情形完全一致。
- `local-only` provider 被显式排除在 peer 竞速外（`group-skip` 事件），
  所以连「换节点」这条兜底也不存在。
- 结果是：一个健康但极慢的流，只能**硬等到 300s 被 provider 超时掐死**。

**影响**
- 长生成（agent 场景常见）没有任何「超时后换路/中止并告知」的机制，
  只能牺牲 300 秒再返回一份被腰斩的回答（叠加 BUG-17）。
- `slow-model reason=stall` 类记分器对此**无补救作用**，只做事后降权（`relay-pipeline.js:233-238`），
  对当前这一发毫无意义。

**修复方向**
- 为「首块已到但总时长超阈值」的长流引入**分档策略**：例如到 X 秒仍无 `finish_reason`
  就主动收尾并带上断流错误帧（配合 BUG-17 的修复），而不是等 provider 层的 300s 硬墙。
- `MSLXDFF_RACCOON_TIMEOUT_MS` 与 `MAX_STREAM_MS` 的口径应统一到同一套时钟，
  避免「应用层以为已关（0）、provider 层却在 300s 处动手」的错位。

---

## BUG-19【中】上游具名资格判决 `ENTITLEMENT_ERROR` 漏判 ⇒ 白跑组员接力，且连「换同池兄弟模型」也被一并关闭

**现象**
上游用**具名判决**明确拒绝资格（`ENTITLEMENT_ERROR`，403，"the user is not subscribed to required model plan"），
网关的终局分类器**完全失明**：既不判终局（照跑组员接力），也不承认它"值得换模型"
（`isPoolSwitchWorthy` 返回 `false`）。同一个"拒绝"既可被 free 层判决识别，又可被**具名**，
但分类器只认 free 层那几条。

**证据**
```
errors.log 2026-10-17 14:26:13  reqId=mvc0j99b-giyq  cline/cline-pass/deepseek-v4.1-flash  403
  upstream 403 body={"error":{"code":"ENTITLEMENT_ERROR","message":"Error 403: the user is not subscribed to required model plan"}}
errors.log 2026-10-17 15:44:44  reqId=mvc3ch83-63d0  cline/cline-pass/deepseek-v4.1-flash  403
  （同一具名判决，与上条逐字相同）
```

实测分类器（`node`，直接 import 生产函数）：
```
classifyTerminalUpstream(403, '{...ENTITLEMENT_ERROR...}')  →  {"terminal":false}
classifyTerminalUpstream(403, '{...FreeTierError...}')      →  {"terminal":true,"kind":"free-tier-blocked"}
classifyTerminalUpstream(429, '{...FreeUsageLimitError...}')→  {"terminal":true,"kind":"free-tier-blocked"}
isPoolSwitchWorthy({status:403, terminal:false})            →  false
```

**根因**
- `src/chat-pipeline/terminal-verdict.js:20-30` —— `FREE_TIER_PATTERNS` 只收 `FreeTierError` /
  `FreeUsageLimitError` / `free tier can only be used` / 中文"免费层…只能"，**没有 `ENTITLEMENT_ERROR`**。
  文件头注释明说边界是"只判换节点也不会变的拒绝"，而"你没订阅这个模型套餐"恰恰是**换号换节点都不会变**的判决
  ——属于该判据的射程内，却因不在名单里而漏判。
- `:96 return { terminal: false };` —— 未命中任何模式时兜底放行，即"照跑接力"。
- `:125-129 isPoolSwitchWorthy` —— `terminal` 为 false 且 `status !== 429` ⇒ 返回 false，
  于是**指定 free 模型横向切同池兄弟的路径也被一并关闭**。

**影响**
1. **遍历组员白跑**：与 BUG-8 同形——判决早已明确"换谁都不行"，网关仍逐个 peer 转发，
   最坏三批串行各吃满等头超时（`DEFAULT_PEER_HEADERS_TIMEOUT_MS=120s`，工作区已改；旧版 30s）。
   今天**未暴雷是运气**：cline 是 `local-only`（`group-skip reason=provider local-only`，模型日志两处可见），
   禁组员直连，接力路径根本没被走到。任何**能走组员**的 provider 撞上同一条 403 即复现。
2. **不换模型**：`isPoolSwitchWorthy` 返回 false，即使调用方发现"这个模型用不了"也不会尝试同池兄弟，
   与 BUG-7（非 auto 锁死单模型）叠加后，指定模型的用户只能拿到 403 收场。
3. Cline 这类 provider 该判决是**账号套餐**层面的（"not subscribed to required model plan"），
   比 free 层判决更"硬"，判终局的把握比 `FreeTierError` 更大——漏判的代价却更大。

**修复方向**
- 在 `FREE_TIER_PATTERNS` 增补具名资格判决：`/ENTITLEMENT_ERROR/i`，以及
  `/not subscribed to required model plan/i`（文案兜底，防上游改 code 名）。
- 顺带补 `isPoolSwitchWorthy` 的判据覆盖自检：新增具名判决时必须同时确认"换兄弟"路径也被放行，
  否则会出现"判了终局却仍不换模型"的半截行为。
- 提醒（非本仓代码问题）：该判决已出现两次且逐字相同，说明 cline 号套餐确有缺口；
  若确认长期不可用，应考虑在配置层摘除而不是每发请求吃一次 403。

---

## 附录 B —— 本轮巡检的量化观察（2026-10-17）

### B.1 BUG-5 的当日实证（23/48，占 48%）
今日 `errors.log` 共 48 条，其中 **23 条**是 `peer …` 中间失败，
而这 4 个请求最终**全部 200 成功**：

| reqId | 最终状态 | 残留错误条数 |
|---|---|---|
| `mvc2cusn-ufru` | 200 / 73,011ms | 6 |
| `mvc2ef62-fz0a` | 200 / 73,672ms | 6 |
| `mvc2gxdq-2jxu` | 200 / 73,565ms | 4 |
| `mvc27ran-fl3e` | 200 / 29,264ms | 1 |

即：**近一半的错误日志不是错误**，是成功请求留下的中间失败。任何按 `errors.log` 条数
算错误率的口径（含人工巡检）都会被系统性高估约一倍。
工作区已删掉 `peers.js` 那行无条件 `logError`（HEAD 版 `:231` 仍在），**但见 B.3。**

### B.2 今日错误构成（无额度错误）
```
peer 转发失败                23   ← BUG-5，成功请求的残留
empty turn                    8   ← 机制正常：重试后恢复（见 B.4）
其他                          7
Cannot connect to API         5   ← cline，Connect Timeout（上游侧不可达）
sdk-channel headers timeout   3   ← cline 120s 等头超时
upstream 403 ENTITLEMENT      2   ← BUG-19
```
**两个目标 free 模型（mimo / deepseek-v4.1-flash-free）今日 0 条额度错误**，
BUG-7 / BUG-8 仍无当日本地实证。

### B.3 当前 daemon 运行的是**修复前**的代码（重要，影响今日全部观测结论）
| 项 | 值 |
|---|---|
| daemon pid | 25716 |
| 启动时刻 | 2026-10-17 **15:11:38**（由 `daemon.alive` 的 `at` + `uptimeMs` 反推，heartbeat `uptime=90m` 佐证） |
| `src/routes/peers.js` mtime | 2026-10-17 **16:22:16** |
| `src/chat-pipeline/index.js` mtime | 2026-10-17 **16:25:51** |
| `src/chat-pipeline/terminal-verdict.js` mtime | 2026-10-17 **16:17:30** |

工作区 8 个文件已改（`git status`：`chat-pipeline/*`、`peers.js`、`hedge.js`、`model-trace.js`、
`routes/chat/peer-handler.js`、`routes/peers.js` + 2 个测试），改动时间**全在 daemon 启动之后**
⇒ **这些修复一条都没有生效**。今日观测到的 peer 30s 掐流、错误日志污染，
都是修复前的旧行为——**不能据此认为修复无效**。新代码需重启 daemon 才会加载。

### B.4 空轮重试机制验证通过（非缺陷，记录以免误判）
`mvc51e7u-uwi0`（`raccoon/sn-deepseek-v4-1-flash`，api=messages，88 条消息，262 个 tools）：
```
16:31:59  upstream-try  maxTokens=64000
16:32:16  空轮 finish=stop  chunks=3 bytes=568 tools=0 chars=0 usage(completion=0)  → 502 empty turn
16:32:16  empty-turn-retry 1/3  delay=2000ms
16:32:31  空轮（同参，仍 64000）
16:32:31  empty-turn-retry 2/3  delay=8000ms
16:33:24  relay-done  finish=tool_calls  chunks=118 bytes=97093 tools=37 chars=63  ← 成功
16:33:30  empty-turn-recovered  第 2/3 次重拉拿到真实输出，本轮共白等 10000ms
```
三次 `upstream-try` 的 `maxTokens` **均为 64000**（未被改写）。这符合设计：
`empty-turn.js:89` 的 `if (!cap || cur >= cap) return payload;` —— 当前值 64000 已 ≥ 默认 cap 16384，
按"只加不减、有顶"的契约**不抬额、退还同参重拉**，靠偶发空轮恢复。实测确实恢复了。

> 备注（排除一次误判）：初次查看时曾把该行读成 `maxTokens=6400`（10 倍缩水），
> 经原样打印核对，是 `Substring(0,260)` 截断造成的错觉，三处**都是 64000**。**不是缺陷，已销案。**

---

## 附录 C —— 外部审计报告的复核结果（2026-10-17 17:03）

**来源说明（重要）**：本轮读 `talk/deepseek-v4.1-flash-free-talk.log` 时发现，该文件内容不是普通对话，
而是**另一个 AI 会话经本网关转发产出的《mslxdff 代码审计报告》**（`[END]` 结尾，另一条会话在做同类巡检）。
其中的结论**属于二手证据**，且该报告明确**不掌握本仓工作区的未提交修复**。以下逐条自证，**不采信其结论**。

### C.1 采纳（我已独立验证，均为真）

**① `src/routes/responses-route.js:68` —— 垫片 `headersSent` 是普通属性（真）**
```js
68:    headersSent: false,          // 只在这里初始化
79:    res.headersSent = true;      // 只在 end() 里置真
```
`write()`（:70-75）只调 `sendHead()`，**从不把 `headersSent` 置真**。

**② 同文件 `:168` 的错误收场被静默吞掉（真，后果比报告描述的更宽）**
```js
168:  if (!res.headersSent) return json(res, 502, {...});   // ← 垫片的 headersSent 恒假，永远走进去
```
`json()`（`src/routes/helpers.js:20-41`）**不是"写 JSON"，而是个分流器**：
```js
23:  if (!res.headersSent) { res.statusCode = status; setHeader("Content-Type","application/json"); res.end(JSON.stringify(body)); return; }
32:  const ct = typeof res.getHeader === "function" ? String(res.getHeader("content-type") || "") : "";
33:  if (ct.includes("text/event-stream")) { res.write(`data: {"error":...}`); res.write("data: [DONE]"); }
40:  try { res.end(); } catch {}
```
而垫片**没有 `setHeader` 实现**（:69 `setHeader() {}` 是 no-op），`getHeader` 也未定义
⇒ `ct` 为空 ⇒ **既不写错误 JSON，也不写 SSE 错误帧** ⇒ 落到 `:40 res.end()` **静默关流**。
后果（✓ 由 (1)(2) 直接推出）：只要 SSE 头已发出**且下游 disconnect**，
`res.headersSent` 两条判据**双双失效** ⇒ 流无声关闭，**客户端既收不到错误帧也收不到 `[DONE]`**。

**③ 对照组：同仓另一条路由已修（真，反证 ① 是遗漏）**
`src/routes/messages-route.js` 用 getter 正确实现，并在注释里**点名了这个坑**：
```
121:  const sent = () => headSent || realRes.headersSent === true; // headersSent 与 getHeader 的唯一口径
171:  get headersSent() { return sent(); },
 11:  2. `headersSent`/`getHeader` 必须真反映已发头，否则 `helpers.js:32` 的「已 flush 走 in-band 错误帧」守卫永远判假，
169:  // helpers.js 的 json() 靠 headersSent + getHeader("content-type") 判「能不能回头」
```
**同一个 `helpers.json()` 契约，`messages-route` 修了、`responses-route` 没修** ⇒ 不是"有意设计"，是遗漏。

**④ `BUG-8` 的解决路径（真，且**推翻**审计报告的核心建议）**
审计报告第 6 条主张：「BUG-8 不该按 bug 修，429 不判终局是有意设计（注释明写 + 测试锁着）」。
**该结论对 HEAD 成立、对工作区已失效**，`git diff` 为证：
```
HEAD:src/chat-pipeline/terminal-verdict.js      仅 /FreeTierError/i        ← 无 FreeUsageLimitError
工作区 diff（+20 行）：
+  // 实测（errors.log，2026-10-16）：muse-spark / ll-alpha 的 429 体是
+  // `{"error":{"type":"FreeUsageLimitError",...}}`，旧判据漏掉它 ⇒ 白跑组员接力 70s 才回错。
+  /FreeUsageLimitError/i,
+ export function isPoolSwitchWorthy(lastErr) { ... }   ← BUG-7 收窄口径
```
且 `bug-list.md:19` 已登记「BUG-8 ✅ 已修」。⇒ **审计报告错在拿未重启 daemon 里跑的旧代码当现状**。
（本项目已反复踩这个坑：见附录 B.3 与 BUG-17。）

**⑤ `src/autostart.js:163-164` 的 `import("../daemon.js")` 从 `src/` 出发指向仓库根（真）**
```
Test-Path daemon.js        → False        Test-Path src/daemon.js → True
Test-Path server.js        → False        Test-Path src/server.js → True
```
`:163` 在 `src/autostart.js` 内，`../daemon.js` = **仓库根** —— 不存在。
注释自称的「停裸 daemon → 杀端口占用者 → 等端口释放」整段**从未执行**，被其后的 `catch {}` 吞掉。
**限定**：报告举证的后果（A 机 141.98.198.197 该段没跑）是**跨机样本，我无法在本机核实**；
本机可确证的只有「该 import 永不解析成功」这一条。**不声称影响范围。**

**⑥ 凭据环更新（真，两处）**
`src/providers/qwenwork/index.js:110,112` —— 两处 `searchKey` 都拿
**轮换后的新值**去比环里的**旧 blob**，结构性**永不命中**：
```js
110:  const oldKey = ring.keys.find((k) => { const b = accountFromBlob(k); return b && b.refreshToken === data.refresh_token; });
112:  const cur    = ring.keys.find((k) => accountFromBlob(k)?.accessToken === account.accessToken);
```
（`data.refresh_token` 与 `account.accessToken` 都是本次刷新后的新值 ⇒ 与旧 blob 不相等 ⇒
`if (cur) … else if (oldKey) …` 恒落空 ⇒ 环里留旧 blob。**须补读 `updateQwenworkTokens` 定义确认赋值时序**，
此处仅记录"按函数名与 `:106` 的调用形态看，结构上命中不了"。）
`src/providers/traework/chat.js:159` —— `const curKey = keys.includes(key) ? key : (keys[keys.indexOf(key)] || key);`
**两边分支恒等于 `key`**（若 `includes` 为真取 `key`；否则 `indexOf` 为 -1 ⇒ `keys[-1]` 为 `undefined` ⇒ `|| key` 取 `key`）
⇒ **整行是恒等 no-op**，刷新后**仍用旧 key**。这一条**已在源码逐字确认，无需补证**。

### C.2 驳回 / 需更正（审计报告此处错）

**✗ 报告称「BUG-4 坐标写错，在 `src/peers.js:164-174`，不是 `src/routes/peers.js`」——该指正本身是错的。**
实测（✓）：`coolingByLastError` 的**唯一定义**在 `src/peers.js:175`（`git` 未修改该文件）；
`src/routes/peers.js:9` 只在**注释里**提到这个名字。而 `bug-list.md` 的 BUG-4 说的就是这个顺序函数
⇒ **`bug-list.md:975` 的 `src/routes/peers.js:164-174` 才是写错的那个**，报告给的正确位置是对的、
但"你在别处写错了"的归因方向反了。**待修：`bug-list.md` 该坐标应改为 `src/peers.js:164-182`。**

**✗ 报告称「BUG-1 的根因错了：不是 abort 掐了整个 body，而是 30s 等不到响应头」——问题本身仍真，但表述可更准。**
实测（✓）：`src/routes/peers.js` 工作区版 `forwardToPeer`（:152-178）的 timer 在 `finally` 里
`clearTimeout`（:176），**头一返回就清** ⇒ 确实只覆盖"等头"。
但报告的定性漏了一层：**组员自己的响应头也压着首块不发**（`ADR-0043` 空轮留口），
故"等头"实际等价于"等对方首块"（该处代码注释 :144-149 已自述）。
⇒ 结论：BUG-1 的**症状描述正确**，根因应表述为「30s 等不到**对方首块**（响应头被对端压后）」。

**✗ 报告援引的多数结论不适用**：它基于"HEAD/未重启的 daemon"，
而 `BUG-1/2/3/4/5/6/7/8/9` 在工作区**均已修复**（见 `bug-list.md:12-20`），待重启生效。

### C.3 未验证（既未采纳也未驳回）

报告还提出若干条目测合理但我**本轮未逐条落到 `file:line`** 的项，登记备查，**不计为新缺陷**：
`src/responses-route.js:68` 之外的第 4 条一半（`response.failed/incomplete` 零命中 —— **此项我已验证为真**：
`src/` 全库命中数 = **0**）；`src/daemon.js:106-111` 杀失败仍删 `daemon.pid`；
`src/v6pool/claim.js:60,130-144,84-88` 清账与删除时序；`src/routes/relay.js:24-29` 的 SSRF 空块；
`src/routes/hedge.js` 的 `isFastFailStatus` 死代码（**与已有 BUG-9 重复**）。
以上**跨机/跨文件，本轮只读本机日志与源码，未做跨机取证**，**不声称影响**。

---

## 附录 D —— 本轮巡检（2026-10-17 17:14）

**结论：本轮无新代码缺陷。** 以下是验证过程与状态更新，供后续对照。

### D.1 运行时状态：安静，无异常
| 项 | 值 | 判读 |
|---|---|---|
| daemon pid | 25716（**未重启**） | `uptimeMs` 5400s→7200s，与 `at` 恒差 1800s ⇒ 启动时刻仍 **15:11:38**；工作区修复**仍未生效**（续 B.3） |
| 端口 | `127.0.0.1:8989` LISTENING | 正常 |
| `errors.log` mtime | **16:32:31** | 至 17:14 已 **42 分钟零新增** |
| 最新调用（calls.log） | 连续 200，19~44s | 无失败 |
| `auto-update-*` | 4 条，`current=latest=0.1.187` | 良性 noop |

### D.2 语料（talk/full）完整性验证 —— 正面结论
用 Node 流式扫 `raccoon-…-talkfull.jsonl`（153~159 条，137MB）：

| 指标 | 值 | 判读 |
|---|---|---|
| `meta.truncated=true` | **0** | 无撞顶截断 |
| `finishReason=null` | **0** | 无「账本外」记录 |
| `status` 非 200 | **0** | 语料只收成功轮 |
| `meta.droppedFrames>0` | **4/153** | 见下 |

- **`droppedFrames` 的语义**（`src/talk-full.js:122` 注释）："不可逆丢弃帧显式计数（行缓冲切点内多字节字符/超限半行）"
  ⇒ 4 条记录各丢 **1 帧**，是真实缺损，但**语料主动把它写进读数**（设计透明，非静默）。
  出处标注为 openspec `fix-talk-capture-frame-loss` review P1-1 ⇒ **已知限制的显式暴露，不记为缺陷**。
- **`responseChars=0` 的 20 条**：其中 **18 条 `response.toolCalls` 非空** ⇒ 正常的纯工具调用轮；
  仅 **2 条**（`mvc51e7u-uwi0` 的两次空轮）既无正文也无工具 —— 与 `errors.log` 完全一致 ⇒ **语料如实记录，未隐瞒**。

### D.3 语料是 57 分钟滚动窗口 —— 取证盲区再确认
本次读到的时间范围：**16:24:42 → 17:21:48（57.1 分钟）**，且同一文件多次读取条数在 150~160 间波动
（写入 + 滚动裁剪并发）。**直接后果**：
`BUG-17` 的那条 300s 请求（`mvc4d48f-fezx`，16:18:07）**已不在语料中**
（搜 `mvc4d48f` 只命中被后续对话引用的那次，`responseChars=22`）。
⇒ BUG-17 只能用 `calls.log`（不裁剪）取证；**语料对它的沉默不代表未发生**。
与 BUG-10（events.log 仅 3 分钟）叠加后，长流事故的**可回溯窗口极短**。

### D.4 反证 BUG-12：闸门确实关着
语料中 **2 条 `relayMs ≥ 160s`** 的长流（163.1s / 159.6s）**正常以 `finishReason=stop` 收尾、`status=200`**。
若 `MAX_STREAM_MS` 有非零默认值，它们会在阈值处被掐（`interrupted`）。
实测未被掐 ⇒ **续证 BUG-12「默认关闭(0)」的判断**，且本次这两条**没有被 BUG-17 的 300s 墙波及**（未达 300s）。

### D.5 用户重点关注项：额度满自动切换 —— 本轮仍无触发条件
`api=messages` 语料 156 条 **全部 `via=local`**；`events.log` 窗口内 **10/10 `group-skip = provider local-only`**。
⇒ 流量形态**根本不具备触发条件**：没有 hedge（首块快 + 非 auto）、没有 peer 竞速、没有额度耗尽。
今日 `errors.log` 中 `status=429` **0 条**、具名额度判决 **0 条**
（另注：`errors.log` 全文件共存 39 条具名判决命中，**全为 10-15 / 10-16 的历史**，非今日）。
**BUG-7 / BUG-8 仍只有代码级证据**（且工作区已修、待重启）。

### D.6 待修项（我自己的错误，上一轮已记，此处复述状态）
`bug-list.md` 汇总表 `BUG-4` 的坐标 `src/routes/peers.js:164-174` **是错的**，
`coolingByLastError` 的唯一定义在 **`src/peers.js:175`**（`src/routes/peers.js:9` 只在注释里提过该名字）。
**未擅自改动** —— 按「只追加、不改既有条目」的约束留给维护窗口。

## BUG-23【低】`group sync` 全部输出绕过日志设施：每分钟一条无 `[时间 pid]` 裸行，占满 `daemon.log` 的 47%，且失败静默无告警

**现象**
本轮在 `daemon.log` 尾部看到一条此前未见过的行：
```
group sync my@mslxd: failed — This operation was aborted      ← 无 [HH:MM:SS pid] 前缀
```
进一步统计发现这是个**长期高频、且格式不一致**的现象：

| 指标 | 值 |
|---|---|
| `daemon.log` 总行数 | 60,569 |
| `group sync` 行 | **28,492（47.0% 的文件）** |
| 其中**无** `[时间 pid]` 前缀 | **28,109（98.7%）** |
| 其中有前缀 | 383 |
| 前缀出现的起始行 | **行 59425**（`[11:10:27 9400]`）—— 之前 59,424 行全部无前缀 |

`group sync` 是**文件内第一大行源**（第二是 `[sdk-upstream]` 9,276 行 / 15.3%），
远超 BUG-15/BUG-16 已记账的 `daemon.log` 膨胀来源。

**证据**
- 代码：`src/runtime/group-sync.js:12,21`（失败）与 `:13,22`（成功）**全部走裸 `console.log`**：
  ```js
  12: if (r.error) console.log(`group sync ${r.name}: failed — ${r.error}`);
  13: else console.log(`group sync ${r.name}: ${r.total} member(s), ${r.added} peer(s)`);
  ```
  **没有一次经过 `daemon.log` 的写入设施** ⇒ 不带前缀。
- 对照：前缀由 `src/runtime/log-stamp.js` 提供（安装点在 `src/runtime/bootstrap.js:17`
  的 `if (process.env.MSLXDFF_DAEMON === "1") installLogStamp()`）。
- 间隔：`src/cli/policy.js` 的 `groupSyncIntervalMs()` 默认 **60_000ms** ⇒ 每分钟一条 ⇒
  47% 的占比与运行时长吻合。
- 失败的 `aborted` 来源：`src/groups.js:9` `const SYNC_TIMEOUT_MS = 15_000;`
  → `:165 const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);`

**根因（两层，须分开看）**
1. **格式层**：`group-sync.js` 的输出绕过了 `log-stamp` 前缀机制。
   该机制是 **2026-10-17 当天刚加入的**（`log-stamp.js:2` 注释直书
   「**2026-10-17 组长 VPS 事故就卡在这里**——同一份 daemon.log 里……」，提交 `f2c90bc`）。
   其本意（`bootstrap.js:16` 注释）：**"一份 daemon.log 被多进程/多版本写过时，这是唯一能回答
   「谁写的、哪一轮」的东西"**。`group-sync` 这条每分钟一条的高频流**恰好绕过了它**——
   机制想解决的正是这个场景，却漏掉了文件内最大的行源。
2. **失败处理层**：`group-sync.js:16,25` 的 `.catch()` 仅 `console.log`，
   失败**不重试、不告警、不进 `errors.log`**（实测 `errors.log` 中 `group sync` 命中 **0**）。

**影响**
- **`daemon.log` 47% 的体量是每分钟一条的常规心跳**，把真正需要回溯的行（崩溃栈、
  `[sdk-upstream]` 诊断、lifecycle）稀释掉。与 BUG-15（无上限）叠加后，轮转窗口被这类噪声挤占。
- **归因能力缺口**：占比 98.7% 的这段行**答不出"谁写的、哪一轮"**——
  正是 `log-stamp` 立项要解决的问题。本机今日另有 `pid 23292 → 25716` 的换进程事件，
  若不靠这段前缀，跨进程的行无法区分。
- **失败静默**：1.2% 的 sync 失败（349 次：288 `aborted` + 61 `fetch failed`）**没有任何告警**。
  成员列表同步不上时，`peers` 会停留在**上一次成功**的结果（`syncAllJoinedGroups` 是先
  `refreshGroupMembers` 成功后才 `syncPeersFromMembers`，见 `group-helpers.js`），
  即"组员列表静默变旧"——而用户侧没有任何信号。**须补验**：连续多分钟失败时，
  是否真的完全不刷新（本轮只确认单次失败与失败后立即恢复，未构造连续失败样本）。

**限定**：本轮仅验证边界的"静默"性质（无重试、无告警、不进 errors.log），
**未验证收敛后果**（连续失败 N 分钟后 `peers` 是否过期）——该点标"须补验"，不计入已确认影响。

**修复方向**
- `group-sync.js` 的成功/失败输出改走带前缀的日志设施（或直接调 `log-stamp` 的 `stamp()`），
  与 `bootstrap.js:16` 立此机制的**本意**对齐——它就是为了这种多进程同写一个文件的场景而加的。
- 失败加**去抖告警**：单次失败是常态（1.2%），不必喊；**连续 N 次（如 ≥3）失败**再升级到
  `errors.log` + 显式提示"成员列表已变旧"。
- 顺带：`groupSyncIntervalMs` 默认 60s 是否必要？若成员列表变化不频繁，
  一分钟一条只为了刷新人数，代价是全文件近半的体量。

---

## 附录 E —— BUG-17 第二例实证 + 修复已就位（2026-10-17 17:42）

### E.1 又抓到一次，且这次证据更全
新实例 `mvc7aotk-9jo6`（`raccoon/sn-deepseek-v4-1-flash`，`api=messages`，
259 条消息 / 262 tools / `maxTokens=64000`）：

```
17:35:12  request
17:35:34  upstream-done status=200           （等头 22,081ms）
17:40:12  relay-done  status=200  totalMs=277,996  interrupted=true
          detail.exitReason    = "upstream-error"
          detail.upstreamError = "The operation was aborted due to timeout"
          detail.receivedChunks=2639  receivedBytes=542,309  wroteBytes=542,309
          detail.chars=25,157   toolCalls=0   chatShaped=true
          detail.sawDone=true   ← 上游的 [DONE] 到了
          detail.sawFinishReason=null   ← 但从未发出 finish_reason
          detail.lastChunkGapMs=74   maxGapMs=1782   stallHits=0   ← 全程活跃，非卡死
17:40:13  slow-model  elapsedMs=277,996  threshold=0  interrupted=true
17:40:13  result / client-response  status=200  interrupted=true  durationMs=300,704
calls.log {"ts":"2026-10-17 17:40:13","durationMs":300697,"status":200}
errors.log 中 "mvc7aotk" 命中 = 0
```
时间对账：22,081 + 277,996 = **300,077ms ≈ 300,000**（±77ms）。

**两例并列**：

| 项 | 第一例 `mvc4d48f-fezx` 16:18 | 第二例 `mvc7aotk-9jo6` 17:40 |
|---|---|---|
| 耗时 | 300,143ms | 300,697ms |
| 块 / 字节 | 2,012 / 416,738 | 2,639 / 542,309 |
| 正文 | — | 25,157 字 |
| `maxGapMs` | 794 | 1,782 |
| `sawDone` | **false** | **true** ← 形态不同 |
| `sawFinishReason` | `null` | `null` ← 判据一致 |
| `errors.log` | 0 | 0 |
| `calls.log` | 200 | 200 |

间隔 **82 分钟**发生两次，都是长 agent 会话（259msgs/262tools）⇒
**不是偶发，是 300s 墙对长生成的必然结果**（BUG-18 已述）。

语料佐证：该时刻 `raccoon-…-talkfull.jsonl` 仅 26 条，**唯一一条 `finishReason=null`
就是这条**（`relayMs=277,996`、`responseChars=26,505`、`droppedFrames=0`）。

### E.2 修复已写好、躺在工作区、daemon 没加载
维护窗口已经实现了 BUG-17 的修复，**但当前进程用的是旧代码**：

| 项 | 值 |
|---|---|
| 新函数 | `src/routes/stream-hold.js:137` `endTruncatedStream(res, detail, flushTail)`（`M` 未提交，mtime **17:26:50**） |
| 判据 | `:139` `if (detail?.sawFinishReason) return false;` —— 正是 `sawFinishReason=null` 走这条 |
| 接线 | `src/routes/stream.js:285`（`M` 未提交，mtime **17:29:33**） |
| 触发条件 | `:280` `if ((stalled \|\| tooLong \|\| detail.exitReason === "upstream-error") && wrotePayload)` |
| daemon 启动 | **15:11:38**（pid 25716，`uptime=150m` @ `[17:41:38]`） |

⇒ 修复比 daemon 启动晚约 **2 小时 18 分**，**未生效**。17:40 这次是该修复上线前
**最后一次已知复现**（与附录 B.3 同一成因，但这次是"修复已存在却未加载"，证据更硬）。

补充：`stream.js:284` 的注释**逐字引用了 BUG-17 第一例的数据**
（"300s 腰斩 416KB 输出，旧行为只补 `[DONE]` 并按 200 返回，errors.log 零记录"）
⇒ 我的风控分析已被维护窗口采纳并落地为代码。**修复方向与我建议一致，无需再提。**

### E.3 须验证（不计入已确认缺陷）
修复的判据是 `sawFinishReason=null`，**第一例与第二例都满足**，故两例都会被新逻辑捕获。
但第二例多出一个 `sawDone=true`，带来一个**尚未验证的边界**：

`stream-hold.js:116-118` 的注释写明「错误帧必须排在上游的 `[DONE]` **之前**，
否则客户端一见 `[DONE]` 就收尾，原因永不可见」，机制靠"暂扣 `[DONE]`、收尾时按序补写"实现。
**问题**：当上游的 `[DONE]` 已经随流透传出去（`sawDone=true`）时，
错误帧还能不能赶在它前面？若不能，第二例这种形态**仍会静默截断**。
**本轮未验证**：需构造/复现一次 `sawDone=true + sawFinishReason=null` 的截断，
观察客户端最终收到的是错误帧还是只有 `[DONE]`。**标"须验证"，不声称结论。**

> **已闭环（第五轮实测）**：构造 A/B/C 三形态跑生产 `relay()` —— `sawDone=true` 时错误帧**仍排在
> `[DONE]` 之前**（`[DONE]` 帧走 `isTrivialFrame` → 进 tail 槽暂扣，收场才放行）。**E.3 的担忧不成立**。
> 但同组实测暴露了另一种形态：`[DONE]` 与正文**挤在同一 chunk** 时终止符抢先、错误帧失效——见 **BUG-24**（已修）。

### E.4 用户重点关注项：额度满自动切换
本轮窗口 `17:35:30 → 17:42:50`（192 行）内 **15/15 `group-skip = provider local-only`**；
`errors.log` 今日仅 2 条具名判决命中（均为**历史**，非今日）；**0 条 429**。
两目标模型 `mimo-v2.6-flash-free` / `deepseek-v4.1-flash-free` 的 talk 与 talkfull
mtime 仍分别停在 **15:23** / **15:56**，**本轮无新活动**。
⇒ **仍无触发条件，BUG-7 / BUG-8 无新增实证**（工作区已修、待重启）。

---

## 汇总表

| 编号 | 严重度 | 一句话 | 关键坐标 |
|---|---|---|---|
| BUG-1 | 高 | peer 30s 硬超时掐掉慢首块 ⇒ 组员竞速永不获胜 | `src/routes/peers.js:8,117` |
| BUG-2 | 高 | hedge 三批 peer 串行各 30s ⇒ 可拖到 90s+ | `src/routes/hedge.js:136-140,147` |
| BUG-3 | 中 | `peer-forward` 对失败也上报 ⇒ 成功率失真 | `src/routes/peers.js:222` |
| BUG-4 | 中 | 不可达 peer 被兜底捞回反复竞速（fails=1569） | `src/peers.js:164-182`（`coolingByLastError` 唯一定义处；`src/routes/peers.js:9` 只在注释里提过该名字——旧坐标写错，见附录 C.2/D.6） |
| BUG-5 | 中 | 成功请求的中间失败写入 errors.log ⇒ 错误率虚高 | `src/routes/peers.js:231,268` |
| BUG-6 | 低 | `peer-request` 不带节点名 ⇒ 归因困难 | `src/routes/peers.js:207` |
| BUG-7 | 高 | 非 auto 锁死单模型 ⇒ free 额度满不切换 | `src/chat-pipeline/index.js:76-95` |
| BUG-8 | 高 | 429 额度类不判终局 ⇒ 白跑接力 70s | `src/chat-pipeline/terminal-verdict.js:20-24,43-50` |
| BUG-9 | 低 | `isFastFailStatus` 死代码，未接入对冲 | `src/routes/hedge.js:11-14,84` |
| BUG-10 | 高 | `events.log` 溢出后断崖砍到 100 行 ⇒ 只剩 ~3 分钟可查 | `src/logs.js:10,42,55` |
| BUG-11 | 低 | `MAX_CALLS`/`MAX_ERRORS` 死常量，从未引用 | `src/logs.js:8-9` |
| BUG-12 | 高 | 流式总时长/停顿闸门默认关闭(0)，与文档 120s 矛盾 | `src/routes/stream.js:64-78,211`（**第四轮结论：默认 0 是对的，改文档；实测 1.67% 成功流 >120s**） |
| BUG-13 | 低 | 经组员中继的响应缺 usage/finish_reason | `src/routes/chat/relay-pipeline.js` |
| BUG-14 | 中 | `detail.toolCalls` 按片段累加 ⇒ 虚高数千倍 | `src/routes/stream-scan.js:127-128` |
| BUG-15 | 中 | `daemon.log` 无上限，7MB/60,321 行持续增长 | `src/daemon.js:34,41` |
| BUG-16 | 中 | `sdk-upstream` 97.5% 打印无用转储，撑大 daemon.log | `src/upstream-engine/sdk/attempt.js:80-90` |
| BUG-17 | 高 | 300s 超时腰斩长流却按 200 成功返回，客户端不知被截断 | `src/providers/raccoon/index.js:38`、`src/routes/stream.js:297-319`、`src/routes/chat/relay-pipeline.js:200-220` |
| BUG-18 | 中 | 首块快但整体慢的长流无对冲、无分档，只能硬等 300s 被掐 | `src/routes/stream.js:64-78`、`src/providers/raccoon/chat.js:153` |
| BUG-19 | 中 | `ENTITLEMENT_ERROR` 具名拒绝漏判 ⇒ 白跑接力且不换兄弟模型 | `src/chat-pipeline/terminal-verdict.js:20-30,96,125-129` |
| BUG-20 | 中 | `/v1/responses` 垫片 `headersSent` 恒假 + 无 `setHeader`/`getHeader` ⇒ 流内错误在两种情况下无声丢失 | `src/routes/responses-route.js:68,79,168`、`src/routes/helpers.js:23,32,40` |
| BUG-21 | 中 | `autostart.js` 的 `import("../daemon.js")` 路径指向仓库根（不存在）⇒ 停旧 daemon 段从未执行 | `src/autostart.js:163-164` |
| BUG-22 | 低 | 凭据环刷新后仍握旧 key（qwenwork 两处比对结构上永不命中；traework 恒等 no-op） | `src/providers/qwenwork/index.js:110,112`、`src/providers/traework/chat.js:159` |
| BUG-23 | 低 | `group sync` 全部输出绕过 log-stamp：每分钟一条裸行占满 daemon.log 的 47%，且失败无告警 | `src/runtime/group-sync.js:12,13,21,22`、`src/groups.js:9,165` |
| BUG-24 | 高 | `[DONE]` 与末内容帧同 chunk ⇒ 终止符抢先、截断错误帧失效且补出第二个 `[DONE]`（BUG-17 在此形态下完全失效） | `src/routes/stream-hold.js`（`submit` + `splitTrailingDone`）、`src/routes/stream.js:249` |
| BUG-25 | 高 | `[DONE]` 自己被 TCP 切块 ⇒ 行锚定永不命中，BUG-24 的修复不生效，缺陷原样复现（终止符 2 个、错误帧在后） | `src/routes/stream-hold.js`（`doneLinePrefix` + `carry` + `flushPrefixTail`）、`src/routes/stream.js` 收场 |
| BUG-26 | 高 | `carry` 只在 `submit()` 内消化 ⇒ `hold(isDone)` 把它塞进 tail 槽与 `[DONE]` 粘成非法行（终止符数 **0**）、`hold(committed)` 与注释帧直写让它错序 | `src/routes/stream-hold.js`（`writeNow` 统一先 `flushCarry` + `inCarryFlush` 护栏、`hold(isDone)` 改走 `flushCarry`） |
| BUG-27 | 中 | 截断收场漏摘 close 监听 ⇒ `res.end()` 触发的 close 被当「下游断开」⇒ 服务端主动掐断记成 `client-abort`、detail 误标已断 | `src/routes/stream.js:271-282`（补 `finishedNormally` + `removeListener`）、`src/routes/stream-body.js`（抽出 `scanNonStreamReply` 腾体积） |
| BUG-28 | 中 | 杀 daemon 失败（EPERM 且 taskkill 也没成）仍删 `daemon.pid` ⇒ 在跑的 daemon 从台账消失变 `-restart` 盲区；且杀者牌留在盘上，下次启动把**在世的**它验成 killed-by-cli；`-stop`/`-uninstall` 还打印「not running」 | `src/daemon.js:118-146`（`killFailed` 提前返回 + `dropMarker` + `kill`/`taskkill` 注入点）、`src/cli/commands/daemon.js:22-33`、`src/cli/commands/system.js:83-92` |
| BUG-29 | 中 | `-restart`/`-port`/`-update` 丢弃 `stopDaemon` 返回值 ⇒ 停不掉仍起新进程：新进程 bind 必 EADDRINUSE 秒退，`waitForHealth` 打的是**旧** daemon 的 /health（照样 200）、Windows 上 `findDaemons` 读不到 /proc 恒返回空 ⇒ 打印「restarted (pid <新的死 pid>)」，把「重启失败且旧版还在跑」谎报成成功 | `src/cli/commands/daemon.js`（handleRestart/handlePort）、`src/cli/commands/system.js`（handleUpdate） |
| BUG-30 | **高** | `/health` 只回 `{status:"ok"}`，无 pid/版本 ⇒ 健康检查根本无法区分「新起的」与「仍占端口的旧 daemon」，这是 BUG-29 谎报的最后一环；且所有启动/重启路径都不校验新进程是否活着 | `src/routes/index.js`（/health 加 pid+version）、`src/cli/policy.js`（waitForHealth 加 expectPid）、`commands/daemon.js`（restart/port/daemon-flag/bare-run）、`commands/system.js`（update）、`cli/join-wizard.js`（ensureServiceRunning） |
| BUG-31 | 中 | `model-trace.js` 超限裁剪用 `slice(-100)`（按**行数**）配 1MB（按**字节**）阈值 —— 与已修的 BUG-10 同型：实测某 model log 到 1,006,482 字节 / 5346 行时触发，一次丢 5246 行（**98.1%** 历史） | `src/model-trace.js:9,147-150`（`TRACE_KEEP_RATIO` + `keepTailByBytes`） |
