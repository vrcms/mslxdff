# Spec: mslxdfree — standalone OpenCode Free proxy

Status: ready-for-agent

## Problem Statement

9Router's OpenCode Free provider is tangled into a large Next.js monorepo with 40+ providers, a database-backed account system, an oauth flow, and a cloud-sync layer. A user who only wants the free Zen models (0-rrequiring no account) can't deploy it as a small, private, throwaway endpoint. They need a stripped, self-contained server that speaks OpenAI-compatible `/v1/*` on one port, requires a single locally-managed bearer token, and fowards everything to `https://opencode.ai/zen/v1/*`.

## Solution

A zero-dependency Node server (`node:http`) exposing:

- `POST /v1/chat/completions` — forwards the OpenAI-format body to the Zen upstream (with reasoning-content injection), streams SSE back per chunk, and passes through non-streaming JSON.
- `GET /v1/models` — returns the ~7 free models (filtered, 10-min cache) in OpenAI Shapes shape.
- `GET /health` — public, returns `{"status":"ok"}`.

The `/v1/*` routes are protected by a bearer token that is randomly generated on first run, persisted to a 0600 state file, and rotated via the `-refresh-token` CLI flag. No database, no accounts, no cloud sync.

## User Stories

1. As an operator, I want to run `mslxdfree` once so that a server starts on `PORT` (default 8080).
2. As an operator, I want the first run to generate a random bearer token and print it once, so I can configure my OpenAI client.
3. As an operator, I want the token persisted in a state file, so the same token works across restarts.
4. As an operator, I want `mslxdfree -refresh-token` to rotate the token, rewrite the state file, print the new token, and exit without starting the server.
5. As an operator, I want `/v1/*` to return `401` (constant-time compare) and `WWW-Authenticate: Bearer` when the header token doesn't match.
6. As an operator, I want `/health` to be public so load-balancer / uptime probes work without a token.
7. As an operator, I want to override the state file path via `MSLXDFREE_STATE_FILE` and the upstream settings via env vars.
8. As an operator, I want the token never to appear in logs.
9. As an OpenAI client, I want `POST /v1/chat/completions` to accept a standard OpenAI chat body and receive an upstream-compatible completion.
10. As an OpenAI client, I want to set `model` to any id, including with an `oc/` prefix that is stripped before forwarding.
11. As an OpenAI client, I want streaming (`"stream": true`) to come back as SSE chunks forwarded verbatim, including `finish_reason` and the terminal `[DONE]`.
12. As an OpenAI client, I want non-streaming responses to pass through as JSON, preserving `usage` and `cost`.
13. As a proxy maintainer, I want `reasoning_content` injected on outbound assistant messages for thinking-mode models (deepseek scope `all`, kimi scope `tool_calls`), preventing upstream 400 errors on multi-turn reasoning.
14. As an OpenAI client, I want `GET /v1/models` to list exactly the free models (`-free` suffix or `big-pickle` whitelist), not the full ~60.
15. As a maintainer, I want the models endpoint to behave nicely under an upstream rate limit: a 10-min cache with a configurable timeout and 429 backoff on refresh.
16. As a maintainer, I want to see the registry-documented config flags behave per `CLAUDE.md` §5 without building oauth/DB/cloud-sync.

## Implementation Decisions

- **Server**: Node's `node:http` `createServer`, zero runtime dependencies. Single-entry `server.js` with `bin` script `mslxdfree` handling `-refresh-token`.
- **Runtime stack**: Node 20+ (system has 20.19.6; best-go is Node's built-in `crypto`, `fs`, `http`, `node:test` — no npm deps beyond types runtimes).
- **Upstream**: base `https://opencode.ai`; `POST /zen/v1/chat/completions`, `GET /zen/v1/models`. Always send `x-opencode-client: desktop` and `Authorization: Bearer public`; add `Accept: text/event-stream` only when streaming (harmless to always send).
- **Auth**: constant-time equality on `Authorization: Bearer <token>`; `401` + `WWW-Authenticate: Bearer` on mismatch. `/v1/models` is also protected; `/health` is public.
- **Token**: 32 random bytes hex; written as `{"token": "…", "createdAt": …}` into state file; default `~/.config/mslxdfree/state.json`, `MSLXDFREE_STATE_FILE` overrides; `0600`. Generated-and-persisted on first server start and printed once. `-refresh-token` regenerates, persists, prints, exits 0.
- **reasoning injection**: `PLACEHOLDER = " "`; rules `[kimi-* → toolCalls, deepseek → all]`; only assistant messages without set `reasoning_content`. (ADR-0001.)
- **Models filter**: `id.endsWith("-free")` OR `KNOWN_FREE_OPENCODE_MODELS.includes(id)` where `KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"]`; response shape `{object:"list",data:[…]}`; tolerate upstream array ordering via `data ?? models ?? json`. (ADR-0002.)
- **Models cache**: in-memory Map ttl 10min; single-flight refresh; on upstream failure serve stale (if any) else error.
- **Retry/timeouts**: connect timeout 30s (env `UPSTREAM_CONNECT_TIMEOUT_MS`); retry 429 backoff up to 2 attempts; 502/503/504 up to 2 attempts at ~2s delay; env-configurable. Free quota is shared → prefer not to hammer; keep configurable.
- **Env surface**: `PORT` (8080), `UPSTREAM_BASE_URL`, `UPSTREAM_AUTH_TOKEN` (default `public`), `MSLXDFREE_STATE_FILE`, timeout/retry section vars, `LOG_LEVEL`.
- **oc/ prefix**: strip a single `oc/` prefix from `model` before forwarding; otherwise verbatim.

## Testing Decisions

- **Seam set (pre-agreed)**:
  1. Public HTTP seam — spin the real server on an ephemeral port, hit it with the test protocol (auth + streaming + non-streaming + `/models` + `/health`).
  2. Pure-function seams — `optimizeToSeam` reasoning injector, models filter, token state file read/write/set/rotate, ret/backoff schedule.
- Common seam conventions: only test public behavior, never internals; use a known-good literal upstream fixture, not the live Zen gateway (no network in tests).
- Test tooling: Node built-in `node:test` runner + `fetch` against the ephemeral server. Mock upstream via `http.createServer` stubs the proxy URL resolution to a local forward.

## Out of Scope

- Accounts / registration / oauth / multi-user. (ADR-0003.)

- Database / persistence beyond the token state file.

- Cloud sync / token saver (rtk/headroom/caveman).

- opencode-go paid subscription compatibility (different endpoint).

- Docker orchestration, multi-node, TLS termination.

- Frontend UI of any kind.

## Further Notes

- The reference implementation is `/root/9router` tag `v0.5.45`; files `providers/registry/opencode.js`, `executors/opencode.js`, `utils/reasoningContentInjector.js`, `config/runtimeConfig.js`, `src/app/api/providers/suggested-models/filters.js`.
- Upstream is a shared free quota; configurable timeouts + not hammering on 429.
- Model list size ~7 free vs ~60 total is a hard asymmetry the filter exists to protect (ADR‑0002).
- Tokens must never be logged; the token is only printed to stdout at creation/rotation or requested via flag.