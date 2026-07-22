# World change-history feed — design

Resolves #13.

## Problem

The **Decision log** shows what the _harness_ decided each cycle. There is no timeline of
how the _world itself_ changed: a PR going green, a story moving to `in_progress`, a PR
being approved or merged, a new comment appearing. The World panel only renders the current
snapshot, so the trajectory — how things got to where they are — is invisible.

## Goal

A change-history / activity feed, styled alongside the Decision log, that records world state
transitions as timestamped entries. Scroll back and see how the situation evolved.

## Approach: diff consecutive world snapshots

The harness already fetches a fresh `WorldSnapshot` at the start of every cycle. We compare
each snapshot against the previous one, turn every observed transition into a timestamped
`WorldEvent`, persist it, and stream it to the cockpit.

Why diffing rather than logging the raw injected events:

- It works identically for the **real GitHub provider** (state polled from the network), not
  just the fake connector's injected events. The issue's own examples ("CI went green",
  "PR approved") are exactly what a real provider surfaces without any explicit inject.
- It cannot double-count: an injected event and its resulting snapshot change would otherwise
  both appear. The snapshot is the single source of truth.

Trade-off accepted: the feed shows _observed_ transitions at cycle granularity, not a
blow-by-blow of every inject. Two changes to the same field between cycles collapse to the
net transition. That matches the intent ("how things progressed"), and cycles are frequent
(driven immediately on inject via `/api/inject`).

## Components

### Domain type (`src/types.ts`)

```ts
export type WorldEventKind =
  | 'pr_opened' | 'pr_ci' | 'pr_approved' | 'pr_mergeable' | 'pr_merged' | 'pr_comment'
  | 'issue_opened' | 'issue_closed' | 'issue_linked'
  | 'story_added' | 'story_state'
  | 'meeting_added' | 'meeting_prep';

export interface WorldEvent {
  id: string;
  kind: WorldEventKind;
  /** The world object this concerns, e.g. "pr:42", "story:abc", "issue:12". Null if global. */
  ref: string | null;
  /** Human-readable one-line summary, e.g. "PR #42 CI passing". */
  summary: string;
  createdAt: string; // ISO
}
```

### Pure diff (`src/world/worldDiff.ts`)

```ts
export function diffWorlds(prev: WorldSnapshot, next: WorldSnapshot): Omit<WorldEvent, 'id' | 'createdAt'>[]
```

Detected transitions:

- **PR**: appears → `pr_opened`; `ciStatus` changed → `pr_ci`; `approved` false→true →
  `pr_approved`; `mergeable` falsy→true → `pr_mergeable`; `merged` false→true → `pr_merged`;
  a new unresolved comment (by comment id) → `pr_comment`.
- **Issue**: appears → `issue_opened`; state `open`→`closed` → `issue_closed`;
  `linkedPrNumber` null→set → `issue_linked`.
- **Story**: appears → `story_added`; `state` changed → `story_state`.
- **Calendar**: appears → `meeting_added`; `prepDone` false→true → `meeting_prep`.

Pure and infra-free, so it is unit-tested directly (repo convention: keep mapping/derivation
logic in pure functions). Object identity is by domain id (`pr.id`, `issue.id`, `story.id`,
`event.id`); a removed object emits nothing (disappearance is not a progress signal worth a
line in v1).

### Store (`src/store/schema.ts`, `src/store/store.ts`)

New table:

```sql
CREATE TABLE IF NOT EXISTS world_events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_world_events_created ON world_events(created_at);
```

Methods:

- `recordWorldEvents(inputs): WorldEvent[]` — assign ids + timestamp, insert, return rows.
- `listWorldEvents(limit = 200): WorldEvent[]` — newest first.
- `getWorldBaseline(): WorldSnapshot | null` / `setWorldBaseline(world): void` — the last
  snapshot seen by the harness, persisted as JSON so a restart neither blinds the diff nor
  emits a spurious "everything is new" flood on the first post-restart cycle. Backed by a
  dedicated single-row table (`world_baseline`), keeping it separate from the FakeConnector's
  `connector_state` KV.

### Harness (`src/harness.ts`)

In `runCycle`, right after `connector.getState()`:

```ts
const prev = this.prevWorld ?? store.getWorldBaseline();
if (prev) {
  const changes = diffWorlds(prev, world);
  if (changes.length) {
    const events = store.recordWorldEvents(changes);
    this.emit('world:events', { events });
  }
}
this.prevWorld = world;
store.setWorldBaseline(world);
```

`prevWorld` is an in-memory field seeded from the persisted baseline on the first cycle. The
very first cycle over an empty store has no `prev` → it only sets the baseline (no diff, no
spurious events). Typed `emit`/`on` overrides are added for `world:events` per repo
convention.

### Server (`src/server/hub.ts`, `src/server/app.ts`)

- `Hub` subscribes to `harness.on('world:events', …)` and broadcasts
  `{ type: 'world:events', events }` followed by `dirty`. New `ServerEvent` variant added.
- `buildStateSnapshot` gains `worldEvents: store.listWorldEvents(100)`.

### Cockpit (`web/src/…`)

- `WorldEvent` type + `worldEvents: WorldEvent[]` on `AppState` (`web/src/types.ts`).
- WS handler in `App.tsx` treats `world:events` like `world:changed` → refetch state.
- New `web/src/components/ActivityFeed.tsx`, reusing the existing `auditlog` / `filter-chip`
  styling, with category filter chips (All / PRs / Issues / Stories / Meetings) derived from
  each event's kind. Rendered as a sibling **stacked under the Decision log** in the right
  column with an `<h2>Activity</h2>` heading — no grid reflow.
- Minimal CSS additions in `web/src/styles.css` for the per-kind accent (reusing audit
  colours).

## Testing

- `test/worldDiff.test.ts` — one assertion group per transition kind, plus "no changes → no
  events" and "new object emits a single `*_opened`/`*_added`, not per-field".
- Integration test (`buildSystem` + `FakePtyBackend`, in-memory store): inject a sequence
  (`new_pr` → `ci_passed` → `pr_approved`), run cycles, assert `store.listWorldEvents()`
  contains the expected kinds/summaries and that a `world:events` event was emitted.

## Out of scope (YAGNI)

- Object removal / deletion events.
- Field-level history beyond the transitions above (e.g. title edits, priority changes).
- Per-event WS delivery scoping (the feed is low-volume; broadcast is fine).
