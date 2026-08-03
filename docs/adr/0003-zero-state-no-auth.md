# ADR-0003: Zero-state, no-auth, no-DB local proxy

By design this proxy holds no authentication, no database, no token store,
and no persisted state — a deliberately local, open OpenAI-format endpoint
(`Authorization: Bearer public` is a constant passthrough, validated nowhere).
The only state kept is an in-memory, process-local models cache.

9Router's surrounding feature set (oauth, account rotation, cloud sync,
token saver) is out of scope on purpose: the strip-down exists to do exactly
one thing, and adding an auth layer would require the very provisioning DB we
are explicitly cut in this stripped project. See also `CLAUDE.md` §6.