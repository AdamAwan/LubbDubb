# The Goal Floor draws goals we have a claim staked to

The floor's patch strip listed **every** open issue the provider returned. Issues are
**opt-in** (`labelPrefix`-derived `-watch`), so on any real world most of that strip is
tickets the harness will never touch — and the floor's default pick has to hunt past them
for one that is actually in production. A goal nothing has staked a claim to has no
production line; drawing a full one for it is the same false-terminal mistake as claiming
a machine that was never built.

## The rule

One pure predicate, `floorGoals(issues, { watchLabel, ignoreLabel })`, in
`web/src/skins/factory/goalFloor.ts` — beside the fold, so it is testable without the
component.

- **Gates off wins first.** An empty watch label (`labelPrefix: ''`, the documented "act on
  everything" escape hatch) → the list is returned unfiltered. Issues default opt-out, so
  filtering there would hide every goal on the deployments that turned the gate off. Same
  reason `WorldSummary`'s `gated` check exists — that one reads _either_ label because it
  files rows into three tabs, while the watch label alone decides this one: with none, there
  is nothing a claim could be staked with.
- **Otherwise keep `watched`**, through the existing `watchBucket(issue.labels, { …,
defaultWatched: false })`. The World panel's tabs and the floor's strip ask one predicate
  what a claim is, rather than two agreeing by coincidence.
- **Unless something is in flight.** `inProduction` (`active` / `has_pr` / `planning` /
  `delivered`) keeps a goal on the floor whatever its tags say. A `-watch` tag removed
  mid-flight must not make a live plan, an open PR or a running agent invisible — the work
  carries on either way, and the floor is where it is seen. It applies to `ignored` as well
  as `unwatched`: the reason is the visibility of live work, not the tag's polarity.
- **Order is claimed first, then by issue number ascending.** The strip is a place an
  operator learns positions in; sorting by anything that moves (status, activity) would
  shuffle it under them exactly while something is going wrong. `inProduction`-only goals
  sort after the claimed ones, so the tail of the strip is where the tagless survivors are.

`inProduction` moves out of the component into the same module, since it is now both the
filter's escape hatch and the default pick's heuristic — two files deriving it
independently is the drift class this codebase has paid for twice.

## The component

`GoalFloor` takes `watchLabel` / `ignoreLabel` (required, from `state.config` in
`FactoryRoot`) and reads the **filtered** list everywhere: the strip, the default pick and
the `picked` lookup — so un-watching the goal you were looking at falls back to another
floor rather than blanking.

A second empty state: _"No goals have a claim staked"_, with where to stake one. Distinct
from today's "No goals in the world" because "nothing is tagged" and "the provider
returned nothing" are different facts and only one of them has an action.

## Tests

`test/factorySkin.test.ts`: an unwatched goal is hidden; a watched one is drawn; an
unwatched one with a live plan is drawn; both labels empty draws everything; claimed goals
sort ahead, and by number within each group.
