# 03 — reasoning injection + oc/ passthrough (pure funcs)

**What to build:** Pure helpers: `injectReasoningContent(body)` writes a `" "` placeholder into `reasoning_content` on assistant messages per rule (kimi-* → tool_calls scope; deepseek* → all scope), skipping messages that already carry non-empty `reasoning_content`; `normalizeModel(model)` strips a single `oc/` prefix and otherwise passes the model through verbatim. (ADR-0001.)

**Blocked by:** None — pure functions, can start immediately.

**Status:** ready-for-agent

- [ ] deepseek assistant messages get `reasoning_content: " "`
- [ ] kimi-* scoped only to assistant messages with tool_calls
- [ ] Assistant messages already carrying reasoning_content untouched
- [ ] `oc/<m>` → `<m>`; otherwise model verbatim
- [ ] Returns a new body, never mutates input