# ADR-0001: Inject a reasoning_content placeholder on outbound assistant messages

The Zen upstream's thinking-mode models (deepseek-family at minimum) return
`400 "The reasoning_content in the thinking mode must be passed back"` when a
multi-turn request echoes an assistant message without its `reasoning_content`.
Clients speaking plain OpenAI format never send that field, so the proxy writes
a `" "` placeholder into assistant messages before forwarding. Scope is `all`
for deepseek-family models and `tool_calls` for kimi-family models; messages
that already carry non-empty `reasoning_content` are left untouched.

The alternative — telling clients to manage `reasoning_content` themselves —
would break standard OpenAI-compatible clients, so the proxy eats this
compatibility cost instead. Matches `/root/9router` v0.5.45
`open-sse/utils/reasoningContentInjector.js`.