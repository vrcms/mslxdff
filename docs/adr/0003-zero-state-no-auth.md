# ADR-0003: Zero-state, no-DB, no-account local proxy

Status: partially superseded by [ADR-0004](./0004-bearer-token.md) — the
no-auth clause below is replaced; the zero-DB / no-account / no-cloud principles
stand.

By design this proxy holds no database, no token store, no account rotation,
and no cloud sync. A single static bearer token is the only credential, kept
in a 0600 state file (see ADR-0004); everything else is stateless per-process
memory at most.