# 02 — Token state: generate, persist, refresh

**What to build:** On first run, generate a 32-byte hex bearer token, persist it to the state file (default `~/.config/mslxdff/state.json`, overridable via `MSLXDFF_STATE_FILE`), and print it once to stdout. `mslxdff -refresh-token` rotates the token, rewrites the file, prints the new token, and exits 0 without starting the server. File mode 0600; token never logged.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [ ] Token = 32 random bytes, hex
- [ ] State file default path + `MSLXDFF_STATE_FILE` override
- [ ] State file mode 0600, JSON `{token, createdAt}`
- [ ] Existing token reused across restarts
- [ ] `mslxdff -refresh-token` rotates, persists, prints, exits without starting the server
- [ ] Token never written to logs