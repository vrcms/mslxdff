# ADR-0002: /v1/models exposes only free models, matched by suffix or whitelist

The upstream `/zen/v1/models` list contains ~60 models; exposing them all would
pollute clients with paid models this proxy can't serve for free. `/v1/models`
therefore filters to: `id` ending in `-free`, OR the explicit whitelist entry
`big-pickle`. The whitelist exists because `big-pickle` is a free model without
the `-free` suffix, and a suffix-only filter would silently drop it.

A plain `endsWith("-free")` filter was considered and rejected for exactly that
reason. Matches `/root/9router` v0.5.45
`src/app/api/providers/suggested-models/filters.js`
(`KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"]`).