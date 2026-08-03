# mslxdfree Context

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
A random 32-byte hex secret stored in the state file (default `~/.config/mslxdfree/state.json`) that clients must send as `Authorization: Bearer <token>` on `/v1/*`. Generated on first run, rotated with `-refresh-token`. See ADR-0004.
_Avoid_: API key, auth provider, account token

**Zero-state 无状态**:
The proxy keeps no database, no account rotation, no cloud sync, and no persisted cache — everything is per-process memory at most. The single exception is the bearer token in the state file. It is a local proxy by design.
_Avoid_: DB, sessions, oauth, cloud sync (explicit non-features, see ADR-0003)