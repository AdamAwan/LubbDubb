# The cockpit stops fetching the world

`GET /api/state` fanned out to the provider on every request. With the `azure`
provider that is roughly `2 + 3N` REST calls for `N` open PRs, plus two for work
items — about 28 calls with eight PRs open. The cockpit issues that request on
every one of five WebSocket event types, one of which fires **per file an agent
writes**. A busy fleet therefore drove hundreds of Azure DevOps calls a minute,
which is a rate-limit block waiting to happen.

This makes the pulse the only thing that reads the provider.

## What was actually wrong

Two independent faults multiplied.

**The snapshot re-fetched a world the harness had already fetched.**
`buildStateSnapshot` called `connector.getState()`, which is
`CompositeConnector.getState` — a `Promise.all` over every integration's
`snapshot()`. The Azure source-control integration has no cache; only the `az`
token, the project GUID and `viewerUniqueName` are memoized. So each cockpit read
paid the full fan-out, and paid it again for every open tab.

**The client refetched on five event types with no coalescing.** `App.tsx`
refreshes on `dirty`, `world:changed`, `control:changed`, `world:events` and
`cycle:end`, and the `Hub` pairs a coarse `dirty` with almost every specific
frame. One pulse with world changes emits `world:events` + `dirty` + `cycle:end`

- `dirty` — four refetches for one pulse. `agents.on('files')` emits per written
  file, so an edit-heavy agent turned each `Write` into a full provider fan-out.

The two together also closed a loop: a failed provider snapshot records an error,
the `Hub` broadcasts `dirty` for it, the cockpit refetches, the fan-out fails
again. Once Azure DevOps began throttling, the cockpit hammered it as fast as the
network allowed, with `lastGood` hiding the failure in the UI.

## The change

`buildStateSnapshot` reads `store.getWorldBaseline()` — the snapshot
`Harness.recordWorldChanges` persists every pulse — instead of calling the
connector. `connector.getState()` then has exactly one caller, `harness.ts`.

Nothing downstream changes: `prHealth`, `prAttentionStatus`, `issuePickupStatus`
and `buildRefUrls` all take a `WorldSnapshot` and are indifferent to its source,
and `resolveRefUrl` is synchronous string-building with no network. The function
becomes synchronous, since the only reason it returned a promise was the fetch.

Three things carry it.

**The baseline is the unfiltered world, which is the only reason this works.**
`/api/state` read the connector directly so that an `-ignore`d PR stays fully
visible with its health while being hidden from dispatch. `recordWorldChanges`
runs _before_ the exclusion filter is applied, so the persisted baseline carries
every PR — the property is preserved by construction rather than by re-deriving
the unfiltered list.

**The reading is a pulse old and says so.** The snapshot gains
`worldObservedAt`, the baseline's `takenAt`, and the cockpit renders its age
beside the existing heartbeat countdown. This mirrors `world_read`, which reports
`observedAt` for the same reason: a stale reading presented as live is worse than
a stale reading labelled as one. Operator actions are unaffected — every mutating
route already runs a manual cycle, so a toggle or a merge refreshes the baseline
before the cockpit refetches. Only third-party changes lag, by at most
`heartbeatIntervalMs`, and the existing Pulse button already forces a cycle.

**A null baseline ships an empty world, not a live fetch.** Before the first
cycle there is no baseline. Falling back to `connector.getState()` there is the
obvious move and is wrong: it re-arms the loop above at exactly the wrong moment.
Boot while the provider is throttling, and the boot cycle fails, so the baseline
is never written, so every `dirty` refetches, so every refetch fans out and
fails, records an error, and emits another `dirty`. Unbounded, and worst when the
provider is already refusing us. An empty world plus `worldObservedAt: null`
cannot do that, and the window it applies to is one boot cycle wide.

## Coalescing

`refresh` in `App.tsx` is the single choke point, so the fix is contained there:
at most one `/api/state` in flight, at most one queued behind it, and a short
trailing window so a burst collapses into one request. A queued refetch always
runs — coalescing merges the signals in between, and must never drop the last
one, or the cockpit settles on stale state.

The `Hub`'s paired `dirty` frames are deliberately left alone. Coalescing already
collapses `cycle:end` + `dirty` into one fetch, so removing two of the pairs buys
nothing and would break the uniform "the specific frame carries the payload, the
`dirty` makes the panel durable-consistent" pattern every other listener follows.
One intact pattern beats an exception that saves no work.

The error-to-`dirty` loop needs no separate fix. It dissolves: once a refetch
touches no provider, a refetch cannot manufacture the next provider error.

## Testing

The regression guard is the point. A counting connector, one cycle to seed the
baseline, then repeated `buildStateSnapshot` calls asserting the provider call
count **does not move** — so "the cockpit does not read the provider" is a
property a later change fails a test over, rather than an intention in a comment.
This is the treatment `prAttention` gets for "nothing in the dispatcher reads
it".

Also asserted: a null baseline yields empty world lists and a null
`worldObservedAt` without touching the connector, and an `-ignore`d PR is still
present in the snapshot with its health (the existing `prExclusion` coverage,
which now exercises the baseline path).

Cost, stated plainly: about ten existing call sites across eight test files
inject into the fake connector and then call `buildStateSnapshot` with no cycle
in between, so they read an empty baseline and need one line seeding it. Running
a real cycle instead would dispatch agents and break unrelated assertions, so
seeding is correct rather than expedient.

## Result

Provider traffic becomes a fixed fan-out per pulse — once every
`heartbeatIntervalMs`, five minutes by default — plus one per operator action.
It no longer scales with agent tool-call volume, with the number of open cockpit
tabs, or with the provider's own failures.

## Out of scope

A TTL cache in front of `connector.getState()` (the baseline already is one, with
the pulse as its refresh); any change to what the pulse fetches or how often;
per-PR request batching inside the Azure provider; the `Hub`'s event taxonomy.
