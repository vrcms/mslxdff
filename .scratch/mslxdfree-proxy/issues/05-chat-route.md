# 05 — /v1/chat/completions route (auth + stream + non-stream)

**What to build:** `POST /v1/chat/completions`, protected by `Authorization: Bearer <token>` (constant-time compare; else `401` + `WWW-Authenticate`). On success: inject reasoning, normalize the model (`oc/` strip), forward via the upstream client; `stream:true` → SSE passthrough verbatim (incl. `finish_reason` and terminal `[DONE]`); otherwise JSON passthrough preserving `usage`/`cost`. Same auth middleware gates `/v1/models`.

**Blocked by:** 01, 02, 03, 04

**Status:** ready-for-agent

- [ ] `401` + `WWW-Authenticate` on missing/wrong token
- [ ] Streaming body relays SSE chunks verbatim (`finish_reason`, `[DONE]`)
- [ ] Non-streaming body passes JSON through (`usage`/`cost` preserved)
- [ ] reasoning injection + `oc/` normalization applied before upstream send
- [ ] Honours request body `stream` flag