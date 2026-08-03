# ADR-0004: Single static bearer token, persisted in a 0600 state file

The proxy requires a bearer token on `/v1/*` so an accidentally-exposed port
isn't an open relay. There is no account system: the token is a random
`crypto` 32-byte value (hex), generated once on first run, persisted to a
state file (default `~/.config/mslxdff/state.json`, `0600`, path overridable
via `MSLXDFF_STATE_FILE`), and printed to stdout on creation. Rotate with
`mslxdff -refresh-token`, which regenerates, rewrites the file, prints the
new token, and exits (does not start the server).

Auth is enforced with a constant-time string compare on
`Authorization: Bearer <token>`; mismatches get `401` with `WWW-Authenticate`.
`/health` stays public (no token). Tokens never appear in logs.

Alternatives rejected: a fixed default token (same key on every install),
per-user accounts (needs a DB — that's the 9Router provisioning surface we
rejected in ADR-0003), and unauthenticated local-only binding (fragile;
a proxy relay deserves an explicit secret even on localhost).