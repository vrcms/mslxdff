export function printHelp(VERSION) {
  console.log(`mslxdff v${VERSION} — OpenCode Free OpenAI-compatible proxy

Usage:
  mslxdff                          start as a background daemon and exit (status + help if one is already running)
  mslxdff -d                       start as a background daemon
  mslxdff -status                  show current status (daemon/health/port/config, upstream providers, models + metrics/体检表, autostart/plugins, groups/peers, recent calls with ttfb/tps, last error)
  mslxdff -log [N]                 show last N events (default 10, e.g. -log 100)
  mslxdff -models                interactive picker: ↑/↓ select a model, Enter sets it as the default (non-TTY: plain list)
  mslxdff -model list            list the free models this proxy serves (cached)
  mslxdff -model set <id>        set the default (preferred) model without the interactive picker
  mslxdff -model status [--all]    show per-model health status (normal/limit/error, 默认隐藏孤儿 --all 看全部)
  mslxdff -model stats [--all]     监控：每模型 请求/首字/总耗时/速度 样本（--all 含孤儿，精简版 -status）
  mslxdff -model refresh           force-refresh the model cache from the upstream
  mslxdff -debug                   live-follow the daemon event stream (requests, errors, peer forwards)
  mslxdff -stop                    stop the running daemon
  mslxdff -restart                 restart the daemon
  mslxdff -uninstall               stop the daemon and delete all state/log files
  mslxdff -port N                  persist the listen port (restarts the daemon on it if running)
  mslxdff -update                  update mslxdff to the latest published version
  mslxdff -showtoken               print the current auth token
  mslxdff -refresh-token           rotate the auth token (prints the new one)
  mslxdff -setto workbuddy [modelId]  set default model and sync to WorkBuddy models.json (insert or update 127.0.0.1/v1 entry)
  mslxdff -provider add <id> <baseUrl> <key> [allowedModel...]  add a generic OpenAI-compatible provider (myapi/gpt-4, baseUrl https://api.example.com/v1; extra models = allowlist)
  mslxdff -provider add workbuddy https://copilot.tencent.com <key> [allow...]  add WorkBuddy专用供应商（workbuddy/hy3 前缀路由，auths 与 keys 一一对应）
  mslxdff -provider <id> [key...|add|remove|list|clear|share|set-url]  configure provider API keys/URL (multiple keys = rotating, set-url for generic)
  mslxdff -provider <id> allowlist [list|set|add|remove|clear]  manage allowed models (empty=allow all, non-empty=only listed) 
  mslxdff -workbuddy checkin        daily 100 credits（双域幂等，已签 code 10001 视为成功）
  mslxdff -providers list          list all configured upstream providers (opencode, openrouter, generic, workbuddy)
  mslxdff -creategroup <name>      create a group on this node (the group name is the password)
  mslxdff -addtogroup <leader-host> <name> [--broadband]  join a group via its leader host (default port 8989) — broadband: 宽带动态IP成员（经Leader中继，无需公网入站，默认127.0.0.1）
  mslxdff -group sync              pull the freshest member list for all joined groups
  mslxdff -group leave <name>      leave a group (removes its members from this node)
  mslxdff -group list              list groups on this node (numbered members)
  mslxdff -group remove <seq>      leader only: kick a member by its list sequence number
  mslxdff -leavegroup              leave every joined group as a member (leaders: use -delgroup)
  mslxdff -delgroup <name>         disband a group this node leads (deletes it and its members)
  mslxdff -free                    V2EX 白嫖雷达（仅 V2EX 单源：latest+hot 按 白嫖|限免|免费额度|注册送|羊毛 过滤）
  mslxdff -free-watch              V2EX 白嫖雷达 watch 模式（每 5 分钟轮询）
  mslxdff -enable-autostart        开机自启：注册 Windows 任务计划 / Linux systemd user（重启后自动拉起）
  mslxdff -disable-autostart       关闭开机自启
  mslxdff -autostart status        查看自启状态
  mslxdff -chat ["prompt"]       chat REPL（mimo-v2.5-free 优先/big-pickle 兜底，自然语言转命令，模糊匹配由模型完成，历史持久化，超长自动压缩，仅拦 -uninstall，daemon 重启不影响）
  mslxdff -resetban [ip]           clear join-failure bans (all, or one ip)
  mslxdff -help                    show this help

Environment:
  MSLXDFF_PORT          listen port (default 8989; use mslxdff -port N to persist)
  MSLXDFF_STATE_FILE      token/port state file
  MSLXDFF_DAEMON_DIR      daemon pid/log/models dir
  UPSTREAM_BASE_URL       upstream base (default https://opencode.ai)
  UPSTREAM_AUTH_TOKEN     upstream bearer value (default "public")
  MSLXDFF_OPENROUTER_KEY  openrouter provider API keys(s) (single env value; multiple use "mslxdff -provider openrouter k1 k2 ..." to persist)
  UPSTREAM_CONNECT_TIMEOUT_MS  upstream connect timeout (default 30000)
  MODELS_REFRESH_MS       model-list background refresh interval (default 7200000)
  MSLXDFF_MODEL_COOLDOWN_MS  fallback cooldown after a model error (default 60000)
  MSLXDFF_PEER_COOLDOWN_MS   peer failover cooldown (default 30000)
  MSLXDFF_PEER_HEAT_MS       how long a peer success stays hot for fast reuse (default 300000)
  MSLXDFF_GROUP_SYNC_MS   group membership sync interval (default 60000)
  MSLXDFF_MAX_HOPS           max peer-forwarding depth (default 3)
  MSLXDFF_BAN_THRESHOLD   failed joins before an ip is banned (default 5)
  MSLXDFF_BAN_WINDOW_MS   ban duration after too many failures (default 48h)
  MSLXDFF_HEDGE_DELAY_MS  hedge peer race when local stream first chunk slow (default 1000, 0/off to disable)
  MSLXDFF_AUTO_UPDATE   auto-update: hourly by default, 0/off/false to disable, 1/true or ms
  MSLXDFF_AUTO_UPDATE_MS  same as above, explicit ms (overrides AUTO_UPDATE)
`);
}
