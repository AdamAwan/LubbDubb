# Generalized `-watch` / `-ignore` labels for issue & story pickup

**Date:** 2026-07-24
**Status:** Approved for planning

## Problem

Issue pickup and PR exclusion each grew their own label mechanism, and they don't
line up:

- **PRs** are opt-out: watched by default, an operator tags `prExclusionLabel`
  (default `lubbdubb-ignore`) to make the harness leave one alone, and the cockpit
  has a per-PR **watch/ignore** toggle for it.
- **Issues** are opt-in but expressed differently: `issuePickupLabel` gates whether
  an agent starts, and separately the GitHub provider's `github.filters.issueLabel`
  **hides** non-matching issues from the world entirely before they ever reach the
  cockpit. There is no operator toggle — an issue's watched/ignored state can only
  be changed by editing labels in GitHub/DevOps directly.

The operator wants issues (and stories) to behave like PRs in the cockpit: **every
item shows up**, each is **clearly marked watched or ignored**, and there's a
one-click toggle — while keeping the opt-in vs opt-out defaults that make sense per
type.

## Goals

1. A single configurable label prefix drives both watch and ignore across PRs,
   issues, and (fake) stories — no more per-type free-form label fields.
2. Every open issue is visible in the cockpit; nothing is hidden at ingest time.
3. Issues and stories carry a cockpit watch/ignore toggle, mirroring PRs.
4. Keep the defaults: **PRs opt-out** (watched unless ignored), **issues/stories
   opt-in** (ignored unless watched).

## Non-goals

- A real (non-fake) story provider. `Story` is fake-backlog-only today; this change
  adds `labels` to it for cockpit/demo parity but introduces no DevOps/GitHub story
  source.
- Changing how PRs are dispatched or how CI/merge health is computed.
- Migrating persisted data. Labels live in the provider (GitHub/DevOps), not our DB.

## The label model

### Config

Add `labelPrefix: string` (default `"lubbdubb"`). From it we derive two labels:

- `watchLabel` = `${labelPrefix}-watch`
- `ignoreLabel` = `${labelPrefix}-ignore`

**Removed** in favor of the prefix: `issuePickupLabel`, `prExclusionLabel`, and
`github.filters.issueLabel`. Retained and re-pointed at `watchLabel`:
`issuePickupRequireOwnLabel`, `issuePriorityLabels` / `issueDefaultPriority`,
`issuePickupStates`, `issueInReviewState`.

The default `prExclusionLabel` was already `lubbdubb-ignore`, so PR ignore behavior
is unchanged by name; it's just now derived from the prefix.

### The resolver (pure)

One pure function is the single source of truth for effective watch state, used by
both the PR side and the issue side:

```
type WatchState = 'watched' | 'ignored';

resolveWatchState(labels: string[], opts: {
  watchLabel: string;
  ignoreLabel: string;
  defaultWatched: boolean;   // PR: true, Issue/Story: false
}): WatchState
```

Precedence:

1. `ignoreLabel` present → `ignored` (ignore always wins, both types).
2. else `watchLabel` present → `watched`.
3. else → `defaultWatched ? 'watched' : 'ignored'`.

This makes both labels meaningful on both types; only the no-tag default differs.

Lives in a new small pure module (e.g. `src/watchLabels.ts`) with its own unit
test, so neither the dispatcher nor `prHealth` inlines the precedence.

### Behavior change (accepted)

Today, an **unset** `issuePickupLabel` means "act on all open issues". Under the new
model an issue with no tag is **ignored** (opt-in). Existing deployments that relied
on the act-on-all default must start tagging issues `lubbdubb-watch`. This is the
explicitly requested behavior ("no tag also = ignore"). PRs are unaffected (still
watched unless `lubbdubb-ignore`).

## Component changes

### 1. Retire the ingest hide (`src/integrations/github/issues.ts`)

Stop passing `issueLabel` to `api.listOpenIssues(...)`; fetch all open issues so
they all display. Remove the `issueLabel` opt from the github issues provider and
its wiring in `src/integrations/registry.ts`, and drop `github.filters.issueLabel`
from config. The Azure WIQL already fetches all open work items (no type/tag filter
unless configured), so DevOps needs no ingest change.

### 2. Dispatcher pickup verdict (`src/dispatcher/issuePickup.ts`)

`IssuePickupPolicy` gains `watchLabel` / `ignoreLabel` (replacing `pickupLabel`).
`isIssuePickupEligible` becomes: eligible iff `resolveWatchState(issue.labels or
labelsAddedByViewer, { defaultWatched: false })` is `watched`. When
`requireOwnLabel` is set, the watch check reads `labelsAddedByViewer` (the ownership
gate), same as today.

`IssuePickupStatusKind` splits the current single `skipped` into two so the cockpit
can mark items the way PRs are marked:

- `ignored` — carries `ignoreLabel` (operator said "leave it alone"); reason names
  the label.
- `unwatched` — no `watchLabel` (never opted in); reason names the label.

`issuePickupStatus` reports these before the cooldown/capacity gates, in the order
rule 4 applies them (state gate → ignore → watch → active/cooldown/capacity), so the
verdict still predicts the next cycle.

### 3. PR exclusion (`src/prHealth.ts`)

`isPrExcluded(pr, { watchLabel, ignoreLabel })` delegates to `resolveWatchState(...,
{ defaultWatched: true })` and returns `state === 'ignored'`. `needsBaseUpdate` /
`isConflicted` / `prHealth` unchanged. The harness's exclusion filter
(`src/harness.ts`) passes the derived labels instead of `prExclusionLabel`.

### 4. Outbound capability: write issue labels

New capability on the `ActionSink` seam mirroring `setPrLabel`:

```
interface IssueLabelInput { number: number; label: string; present: boolean; }
setIssueLabel(input: IssueLabelInput): Promise<SendResult>;
```

Implemented by the fake connector, the github issues provider (`setIssueLabel` on
its `*Api` seam), and the azure work-items provider (add/remove a `System.Tags`
entry via a work-item PATCH). Routed by `CompositeConnector`. Add to the seam + its
scripted fake together, following the `setPrLabel` / `setWorkItemState` pattern.

### 5. Endpoint + cockpit toggle

- `POST /api/issues/:number/watch` with body `{ watched: boolean }`:
  - `watched: true` → add `watchLabel`, remove `ignoreLabel`.
  - `watched: false` → add `ignoreLabel`, remove `watchLabel`.
  - Two label writes (add one, remove the other), then kick a harness cycle so a
    now-watched issue is considered (or a now-ignored one dropped), same as the PR
    exclude endpoint. Returns `{ ok, watched }`.
- Cockpit `web/src/App.tsx`: issue rows get the same watch/ignore `AsyncButton` +
  `ignored` / `watched` chip as PRs, driven by `resolveWatchState` on the client (or
  the `pickup` verdict's new statuses). Ship `labelPrefix`-derived labels in the
  `/api/state` config block (replacing `prExclusionLabel`) so the client can render
  the effective state.

### 6. Fake stories parity (`src/types.ts`, fake backlog)

`Story` gains `labels: string[]`. The fake backlog seeds some stories tagged
`lubbdubb-watch`. The story-work dispatch rule (rule in `ruleDispatcher.ts` around
the `story:*:work` origin) applies the same opt-in gate via `resolveWatchState({
defaultWatched: false })`. The cockpit story rows get the same toggle, writing
through `setIssueLabel`'s story equivalent or a shared label-write path. (Fake-only;
no real provider.)

## Data flow

```
provider labels ──► resolveWatchState (pure) ──► watched | ignored
                         │
   PR side  ─────────────┼──► isPrExcluded ──► harness drops ignored PRs from
                         │                      dispatch world (still shown in cockpit)
   Issue side ──────────┘──► isIssuePickupEligible / issuePickupStatus
                                     │
                                     ├─ eligible → rule 4 dispatch
                                     └─ ignored / unwatched → cockpit chip

cockpit toggle ──► POST /api/{prs|issues}/:n/{exclude|watch}
              ──► ActionSink.set{Pr|Issue}Label (add one, remove other)
              ──► harness cycle
```

## Error handling

- Label writes go through the existing `ActionSink` throw-on-failure contract; the
  endpoint surfaces failures as it does for `/api/prs/:number/exclude`, and any
  caught error routes through `errors.record(...)` (never a swallowed catch).
- The resolver is total (never throws); unknown/empty labels resolve to the type
  default.
- Providers that can't write labels (none expected, but the fake for a story with no
  backing) return a clear `SendResult { ok: false }` / throw, surfaced to the
  operator.

## Testing

- `test/watchLabels.test.ts` — resolver precedence: ignore wins, watch, default per
  type, both-labels, empty.
- `test/issuePickup.test.ts` — extend: `ignored` vs `unwatched` statuses and
  reasons; `requireOwnLabel` reads `labelsAddedByViewer`; priority still parses.
- `test/prExclusion.test.ts` — PR exclusion via derived `ignoreLabel`; watched
  default preserved.
- github/azure integration tests — `setIssueLabel` add/remove through the scripted
  fake `*Api`; github `listOpenIssues` now fetches without a label filter.
- Endpoint test — `POST /api/issues/:number/watch` writes the right label pair and
  triggers a cycle.
- Fake story parity — a `lubbdubb-watch` story is eligible, an untagged one is
  `unwatched`.

Run `npm run check` (format, lint, both typecheckers, knip, tests) before commit;
knip will flag the removed config fields if any dead reference remains.

## Docs

Update the example config (`lubbdubb.config.example.json` or equivalent) and its
"every option documented" coverage: add `labelPrefix`, remove `issuePickupLabel`,
`prExclusionLabel`, and `github.filters.issueLabel`. Update `CLAUDE.md`'s label
mechanisms section — the "two orthogonal label mechanisms" / "three label
mechanisms" notes collapse into the single prefix model.
