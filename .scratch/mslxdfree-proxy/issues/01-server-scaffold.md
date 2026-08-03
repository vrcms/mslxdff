# 01 — Zero-dep server scaffold: PORT, /health, CLI entry

**What to build:** A Node `node:http` server that binds `PORT` (default 8080), answers `GET /health` with `{"status":"ok"}` (public), and 404s anything else. The `mslxdfree` CLI entry starts the server. No upstream calls yet.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [ ] `node:http` server binds to `PORT`, default 8080
- [ ] `GET /health` → 200 `{"status":"ok"}`, public
- [ ] Unknown routes → 404 JSON
- [ ] SIGINT/SIGTERM graceful shutdown
- [ ] `mslxdfree` binary starts the server (`bin` entry, `#!/usr/bin/env node`)