# bug-list

## BUG-A：agentrouter 弹窗轰炸 + 502 连锁（2026-10-21 修复，待发布）

**现象**（用户机实锤）：agentrouter 供应商完全不可用，且桌面不停弹 curl 控制台窗口。

**根因两处**（均在 `src/providers/curl-fetch.js`，上一提交引入的 curl 传输层）：
1. **弹窗**：`spawn(curlPath, args, ...)` 缺 `windowsHide: true`。daemon 是无控制台后台进程，
   Windows 给每个 console 子进程新开一个窗口；流式+重试+预热叠加 = 窗口轰炸。
2. **502 连锁**（`agentrouter-deepseek-v4-flash.log` 16:15:00）：Claude Code 大 body（>1KB）
   让 curl 自动带 `Expect: 100-continue`，上游先回 `HTTP/1.1 100 Continue` 写进 `-D` 头文件；
   `headerBlobReady`/`parseHeaderBlob` 把它当终局应答 → `new Response(status=100)` 抛
   RangeError `init["status"] must be in the range of 200 to 599` → runner 记 502 →
   唯一 key 冷却 30s → 后续请求全被挡成 `all API keys are in cooldown`。
   （16:09 小 body「从1数到6」测试通过正是因为没超 1KB 不触发 Expect。）

**修复**：
- spawn 加 `windowsHide: true`；
- 请求侧 `-H "Expect:"` 移除 Expect 头（curl 惯用写法）；
- 头解析侧双保险：`INTERMEDIATE_SEGMENT` 统一判 1xx/CONNECT 伪段——`headerBlobReady`
  不交卷、`parseHeaderBlob` 从后往前取终局段，且 1xx 状态一律归 0 按「无响应头」失败处理，
  绝不外泄给 `new Response`。

**回归测试**：`test/curl-fetch.test.js` 新增 2 例（100 段跳过 × parse/ready），9/9 通过。

**顺带发现（未修）**：`daemon_err.log` 有历史 `EBUSY: daemon.log`（同机双 daemon 抢日志 fd 的
启动失败记录，当前 PID 29344 正常在跑，与本次故障无关）；原指向 `src/warp-pool/wireproxy.js` 的
两处 `spawn` 在 win32 的弹窗风险——该模块**已于 2026-10-25 随三套出口池整体移除（ADR-0073），此条作废**。
