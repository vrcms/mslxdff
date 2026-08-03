# 06 — /v1/models: free filter + 10-min cache

**What to build:** `GET /v1/models` (auth-gated) fetches upstream `/zen/v1/models`, filters to `-free` suffix or the `big-pickle` whitelist, returns OpenAI shape `{object:"list",data:[...]}`; in-memory 10-min cache with single-flight refresh; on upstream failure serve stale data if warm, else error. (ADR-0002.)

**Blocked by:** 02, 04

**Status:** resolved

- [ ] `-free` suffix or `big-pickle` included; paid models excluded
- [ ] `{object:"list",data:[...]}` response shape
- [ ] 10-min TTL cache, single-flight refresh
- [ ] Cold + upstream failure → error; warm → stale serve
- [ ] Tolerates upstream array-vs-object wrap (`data ?? json`)