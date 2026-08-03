# AGENTS.md

Strip-down of 9Router's **OpenCode Free** provider into a standalone OpenAI-compatible proxy.
The full implementation blueprint lives in `./CLAUDE.md` — **read it first**; it is authoritative and current.

## Source of truth

- **Reference repo**: `/root/9router` (git tag `v0.5.45`). Original implementation and request chains
  are defined there. Never guess behavior from memory — look it up in `/root/9router` when in doubt.
- `/root/mslxdff` currently has **no code yet** — only `CLAUDE.md` + this file. A skeleton
  layout (server, `/v1/*` routes, models cache, SSE forwarder) is proposed in `CLAUDE.md` §5.

## Verified upstream contract (opencode.ai zen gateway)

- `POST https://opencode.ai/zen/v1/chat/completions` + `GET https://opencode.ai/zen/v1/models`.
- **Always** send: `x-opencode-client: desktop` + `Authorization: Bearer public`
  (value unvalidated, "public" works) + `Accept: text/event-stream` when streaming.
- Request body is standard OpenAI chat completions; pass `model` through verbatim.
- May be rate-limited / unstable (it's a shared free quota) → keep configurable timeout + 429/network backoff.
- This is **not** the paid opencode-go subscription (`x-api-key` auth) — don't mix them up.

## Non-obvious gotchas

- **Thinking-mode injection is required.** DeepSeek-family models in thinking mode require the client to
  echo back `reasoning_content` on assistant messages, or the upstream returns
  `400 "The reasoning_content in the thinking mode must be passed back"`. Inject a `" "` placeholder on
  assistant messages before forwarding: DeepSeek = scope `all`, `kimi-*` = scope `tool_calls`.
  Reference: `/root/9router/open-sse/utils/reasoningContentInjector.js`.
- **Free-model filter is whitelist-plus-suffix, not suffix-only**: `id.endsWith("-free")` OR
  `KNOWN_FREE_OPENTECH_MODELS = ["big-pickle"]`. `big-pickle` has no `-free` suffix and would be dropped
  otherwise. Reference: `/root/9router/src/app/api/providers/suggested-models/filters.js`.
- Models endpoint returns `{"object":"list","data":[...]}` (OpenAI shape), not a bare array.
- No-account virtual credential: `public` against a `Bearer header`, `noAuth` provider skips
 401/403 refresh and account fallback.
- Only expose the **free** models (~7) on `/models`, not all 60 from the upstream list.

## Contract to uphold

1. `POST /v1/chat/completions` forwards body upstream unmodified (except middleware injections); model id passes through.
2. Always add both headers named above.
3. reasoning_content injection before send (all-deepseek / tool-tiered-kimi).
4. Stream SSE per-chunk; non-stream non-JSON passthrough.
5. `/models` returns the filtered free model list (10-min cache).
6. `/v1/*` requires `Authorization: Bearer <token>` (constant-time compare, `401` otherwise); `/health` is public.
7. Token lives in the state file (default `~/.config/mslxdff/state.json`, env `MSLXDFF_STATE_FILE`), generated on first run, rotated via `mslxdff -refresh-token`. See `docs/adr/0004.md`.