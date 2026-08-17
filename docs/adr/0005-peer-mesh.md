# ADR-0005: Peer mesh for same-model failover across machines

> **Update (group model):** peers are now configured through named groups, and the
> group name doubles as the join password (supersedes the random join key). CLI:
> `-creategroup <name>` on the leader (no address needed — the first joiner seeds
> the leader's own entry from the address it connects from), `-addtogroup <leader-host> <name>`
> elsewhere. Every member (leader included) re-registers with the leader on a timer
> (`MSLXDFF_GROUP_SYNC_MS`, default 60s) and rebuilds its local peer list from the
> freshest member map, so membership changes propagate to all nodes automatically.
> The `-peer` commands are removed; peers are an internal mechanism. Wrong group
> names/tokens are counted per source IP: `MSLXDFF_BAN_THRESHOLD` (default 5)
> failures ban the IP for `MSLXDFF_BAN_WINDOW_MS` (default 48h); `-resetban [ip]`
> clears bans.

A single mslxdff instance depends on one upstream quota; when that upstream
starts rate-limiting or failing for a model, the only local fallback is
switching to a *different* model. That changes the model out from under the
client. To keep the requested model working while the local path recovers,
multiple instances can be joined into a group: when the local upstream
fails for model X, the instance forwards the request (still model X) to a
group member that runs its own mslxdff and has its own upstream quota.

## Design

- **Peers are plain mslxdff instances.** Each peer is identified by
  `{ url, token }` (its bearer token, per ADR-0004). Configured with
  `mslxdff -peer add <token> <url> [name]`, removed with `-peer remove`,
  listed with `-peer list`; persisted in the state file. No new protocol —
  forwarding is a normal authenticated `POST /v1/chat/completions` to the
  peer, reusing the existing API surface.
- **Local-first routing.** A request always tries the local upstream first.
  Only on local failure (network error or HTTP ≥ 400) does it iterate peers
  for the *same model*, round-robin over currently-available peers.
- **Model lock.** Forwarded requests carry `x-mslxdff-model-lock: <model>`
  so the receiving peer uses exactly that model — it must not re-select or
  fall back to another model, keeping "same model, different machine" true.
- **Hop bound.** Forwarded requests carry `x-mslxdff-hops` (incremented each
  hop). A peer receiving hops ≥ `maxHops` (default 3, `MSLXDFF_MAX_HOPS`)
  stops forwarding further, bounding mesh depth and preventing loops.
- **Peer cooldown.** A peer that fails a request enters a cooldown window
  (default 30s, `MSLXDFF_PEER_COOLDOWN_MS`), during which it is skipped by
  the round-robin, so the mesh rotates to healthy peers instead of
  hammering a down one. Mirrors the model cooldown in ADR-0001.

## Why not alternatives

- **Point the whole proxy at another machine** (client-side failover): the
  client can't detect per-model upstream failure, and every request pays the
  cross-machine latency even when local is healthy.
- **Different model per machine**: violates the requirement of keeping the
  same model, and hides the model-change from the client.
- **Central coordinator / service discovery**: overkill for a handful of
  private instances; static peer config is zero-config and debuggable.
