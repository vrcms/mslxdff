# 04 — Upstream client: fetch + headers + timeout + retry/backoff

**What to build:** The upstream caller: builds URL + headers (`x-opencode-client: desktop`, `Authorization: Bearer public`, `Accept: text/event-stream`), POSTs the body to `/zen/v1/chat/completions`, applies a connect timeout (env-configurable, default 30s), and retries 429 with backoff (up to 2) and 502/503/504 (up to 2). Env-configurable `UPSTREAM_BASE_URL`, `UPSTREAM_AUTH_TOKEN`, timeouts. Returns upstream status + response so routes can stream or forward.

**Blocked by:** None — upstream caller, depends only on Node fetch.

**Status:** ready-for-agent

- [ ] Builds upstream URL + required headers
- [ ] POST passthrough with injected body
- [ ] Connect timeout (env, default 30s) aborts slow upstream
- [ ] 429 backoff + 502/503/504 retry per config
- [ ] 400/401/403 from upstream not retried