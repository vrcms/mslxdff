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
mslxdff          # or: node bin/mslxdff.js
```

First run generates a bearer token, writes it to the state file, and prints it:

```
mslxdff listening on http://localhost:8989
auth token: 9b5de021e914...
endpoint:   http://localhost:8989/v1
```

### Port

Default port is **8989**. Persist a different port (and hot-restart the daemon onto it if one is running):

```
mslxdff -port 8000     # set port to 8000; restarts the daemon on 8000
mslxdff -d             # next starts reuse the persisted port (8000)
```

Priority: `-port` arg > persisted port > `PORT` env > default `8989`.

### Daemon (background, stays resident)

```
mslxdff -d        # start detached background daemon
mslxdff -stop     # stop it
```

Logs go to `~/.config/mslxdff/daemon.log`, the daemon pid to `daemon.pid` (both overridable via `MSLXDFF_DAEMON_DIR`). The daemon keeps running after your shell exits.

### Token

```
mslxdff -showtoken      # print the current token (creates one on first use)
mslxdff -refresh-token  # rotate it (prints the new token, does not start the server)
```

## Client configuration

Point any OpenAI-compatible client at the endpoint with the token:

```
Endpoint:   http://localhost:8989/v1
API Key:    <the bearer token>      (sent as Authorization: Bearer <token>)
Model:      oc/deepseek-v4-flash-free   (the oc/ prefix is optional)
```

<x-model list>

```
$ curl -H "Authorization: Bearer <token>" http://localhost:8989/v1/models
{"object":"list","data":[{"id":"big-pickle",...},{"id":"deepseek-v4-flash-free",...}, ...]}
</x-model list>

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8989` | listen port (used when no `-port` arg and no persisted port) |
| `MSLXDFF_STATE_FILE` | `~/.config/mslxdff/state.json` | token/port state file (mode 0600) |
| `MSLXDFF_DAEMON_DIR` | `~/.config/mslxdff` | daemon pid + log directory |
| `UPSTREAM_BASE_URL` | `https://opencode.ai` | upstream base |
| `UPSTREAM_AUTH_TOKEN` | `public` | upstream `Authorization: Bearer <…>` value |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `30000` | upstream connect timeout |
| `LOG_LEVEL` | `info` | (reserved) |

## Clients

Point your OpenAI client at `http://<host>:8989/v1` (or the equivalent config seen above). Works for streaming and non-streaming chat completions.

## Development

```
npm test        # node --test, no network access
```

The reference implementation is 9Router v0.5.45 (`/root/9router`); see `CLAUDE.md`, `CONTEXT.md`, and `docs/adr/` for the contract and the decisions behind it.
