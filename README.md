# mslxdff

测试项目，请勿使用。

Zero runtime dependencies: Node ≥ 20, built-in `node:http`, `node:crypto`, `node:test`.

## What it does

- `POST /v1/chat/completions` — forwards your OpenAI-format request to the upstream (with reasoning-content injection for thinking-mode DeepSeek/Kimi models), streams SSE back chunk-by-chunk, or passes through JSON for non-streaming calls.
- `GET /v1/models` — the ~7 free models (`*-free` plus `big-pickle`), filtered from the full upstream list, cached for 10 minutes.
- `GET /health` — public liveness check.

## Install & run

```
npm install      # no deps actually fetched; just links the bin
mslxdfree        # or: node bin/mslxdfree.js
```

First run generates a bearer token, writes it to the state file, and prints it:

```
mslxdfree listening on http://localhost:8080
auth token: 9b5de021e914...
endpoint:   http://localhost:8080/v1
```

### Daemon (background, stays resident)

```
mslxdfree -d        # start detached background daemon
mslxdfree -stop     # stop it
```

Logs go to `~/.config/mslxdfree/daemon.log`, the daemon pid to `daemon.pid` (both overridable via `MSLXDFREE_DAEMON_DIR`). The daemon keeps running after your shell exits.

### Token

```
mslxdfree -showtoken      # print the current token (creates one on first use)
mslxdfree -refresh-token  # rotate it (prints the new token, does not start the server)
```

## Client configuration

Point any OpenAI-compatible client at the endpoint with the token:

```
Endpoint:   http://localhost:8080/v1
API Key:    <the bearer token>      (sent as Authorization: Bearer <token>)
Model:      oc/deepseek-v4-flash-free   (the oc/ prefix is optional)
```

<x-model list>

```
$ curl -H "Authorization: Bearer <token>" http://localhost:8080/v1/models
{"object":"list","data":[{"id":"big-pickle",...},{"id":"deepseek-v4-flash-free",...}, ...]}
</x-model list>

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | listen port |
| `MSLXDFREE_STATE_FILE` | `~/.config/mslxdfree/state.json` | token state file (mode 0600) |
| `MSLXDFREE_DAEMON_DIR` | `~/.config/mslxdfree` | daemon pid + log directory |
| `UPSTREAM_BASE_URL` | `https://opencode.ai` | upstream base |
| `UPSTREAM_AUTH_TOKEN` | `public` | upstream `Authorization: Bearer <…>` value |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `30000` | upstream connect timeout |
| `LOG_LEVEL` | `info` | (reserved) |

## Clients

Point your OpenAI client at `http://<host>:8080/v1` (or the equivalent config seen above). Works for streaming and non-streaming chat completions.

## Development

```
npm test        # node --test, no network access
```

The reference implementation is 9Router v0.5.45 (`/root/9router`); see `CLAUDE.md`, `CONTEXT.md`, and `docs/adr/` for the contract and the decisions behind it.