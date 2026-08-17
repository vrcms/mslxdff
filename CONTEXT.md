# mslxdff Context

A standalone, private, zero-config OpenAI-compatible proxy whose only job is forwarding requests to the opencode.ai free Zen gateway, handling model listing and thinking mode.

## Language

**Zen upstream**:
The free gateway at `https://opencode.ai/zen/v1/*` that this proxy talks to — both `/chat/completions` and `/models` live there.
_Avoid_: backend, upstream API server, opencode-go (the paid `x-api-key` subscription is a different service, never to be conflated).

**Proxy 代理**:
The browser/client-facing component this repo builds. It accepts OpenAI-format `/v1/*` requests and forwards them to the Zen upstream.
_Avoid_: server, middleware, reverse-proxy tunnel

**Reasoning 注入 (reasoning_content injection)**:
Writing a placeholder `" "` into the `reasoning_content` field of outbound assistant messages so thinking-mode models accept multi-turn requests. Scope is `all` for deepseek-family models and `tool_calls` for kimi-family models.
_Avoid_: thinking injection, empty reasoning, blank

**oc/ 前缀**:
An optional client-facing model prefix (`oc/<model>`) that the proxy strips before forward; the remainder is passed to upstream verbatim. The upstream accepts arbitrary model ids.
_Avoid_: alias mapping, model normalization

**Free model 免费模型**:
A model exposed on the proxy's `/v1/models` list. Membership = id ends with `-free` OR is the whitelist entry `big-pickle` (which has no suffix). Only the ~7 free models are exposed, never the other ~53 paid ones.
_Avoid_: free tier, free quota (that is an upstream rate quirk, not a model property)

**Passthrough 透传**:
Relaying a request body or SSE chunk to the client without rewriting its fields, preserving `usage`, `cost`, `finish_reason`, and `[DONE]` as received.
_Avoid_: translation, mapping, transformation

**Bearer token 访问令牌**:
A random 32-byte hex secret stored in the state file (default `~/.config/mslxdff/state.json`) that clients must send as `Authorization: Bearer <token>` on `/v1/*`. Generated on first run, rotated with `-refresh-token`. See ADR-0004.
_Avoid_: API key, auth provider, account token

**Zero-state 无状态**:
The proxy keeps no database, no account rotation, no cloud sync, and no persisted cache — everything is per-process memory at most. The single exception is the bearer token in the state file. It is a local proxy by design.
_Avoid_: DB, sessions, oauth, cloud sync (explicit non-features, see ADR-0003)

**Peer 对等节点**:
Another reachable mslxdff instance that this instance can forward chat requests to when the local upstream fails. Peers are configured via named groups (`-group create` / `-addtogroup`): the group leader keeps the member map, and each member periodically re-registers and rebuilds its local peer list (persisted in the state file). The local instance always tries itself first.
_Avoid_: node, remote proxy, upstream alias

**Model lock 模型锁定**:
A forwarding header (`x-mslxdff-model-lock`) that tells a receiving peer to use exactly the named model — the peer must not re-select or fall back to another model for that request. Keeps the same model across machines.
_Avoid_: model pinning, model forcing, alias mapping

**Hop 转发跳数**:
The forwarding depth counter (`x-mslxdff-hops`) attached to peer-forwarded requests, bounded by `maxHops` (default 3) to prevent forwarding loops. Each peer that receives a request with hops ≥ max stops forwarding further.
_Avoid_: TTL, depth, recursion limit

**Peer cooldown 节点冷却**:
A time window (default 30s, `MSLXDFF_PEER_COOLDOWN_MS`) during which a peer that just failed a chat request is skipped, so the mesh keeps trying other peers instead of hammering a down one.
_Avoid_: peer ban, peer quarantine