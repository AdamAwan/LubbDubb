# Land the stack — one click that merges a chain bottom-up

**Status:** design, approved 2026-08-10.

An operator looking at a stack of N pull requests on the factory skin's Parts Inspection rack
can click once and have the whole chain land, ending as one merged change with nothing left on
the rack.

## What already exists, and why this adds no merge path

Rule `pr-merge-ready` refuses to propose a merge for any rung above the bottom
(`!isStackedPr(pr, defaultBranch)`, `src/dispatcher/rules/prCiFailing.ts`). Only the rung based
on the integration branch is ever put up. When it lands, the provider retargets the rung above
it onto the integration branch; that rung becomes a bottom, and rule `pr-merge-ready` proposes
_its_ merge on a later pulse.

So merging a stack bottom-up, one rung per cycle, is already what the harness does. What is
missing is only an operator who keeps answering "yes" to each proposal as it arrives.

This feature is therefore **entirely a decider**. It writes no merge, adds no second merge path,
and touches neither the dispatcher nor the sink. A merge still happens exactly one way: a `merge`
proposal accepted through `ActionExecutor.runAuthorized`.

There is deliberately no loop over rungs anywhere in this design. A rung above the bottom is not
merge-ready until the one beneath it has landed _and_ the provider has retargeted it, which is
observed on a later pulse — so a synchronous loop could only either block or merge the bottom
rung and claim it merged three.

## The intent is scoped by PR number, not by the stack ref

`Stack.ref` is `stack:<bottom rung's PR number>` (`src/stacks/stack.ts`). The bottom rung is
exactly the one that merges first, so the ref is stable only until the intent's first success —
after that `buildStacks` calls the same chain `stack:<second rung's number>`. An intent keyed on
the ref alone would land the bottom rung and then be orphaned, silently: the exact
merge-one-rung-and-report-success failure this design exists to avoid, reached by a different
door.

So the record keeps the ref for the click and for display, and takes its **authorization scope
from the ordered list of rung PR numbers captured at click time**. Three things follow:

- The auto-accept asks "is PR #N named by a standing intent?", which is a store lookup on a
  number. No `buildStacks` call in the executor and none in the dispatcher, so the lens stays
  where `test/stacks.test.ts` requires it.
- The scope is exactly what the operator read. A rung stacked _on top_ after the click is not
  authorized, because it was not in what was approved. This falls out of the design; it needs no
  rule of its own.
- The cockpit matches an intent to a stack by rung-number overlap rather than by ref, so the
  display survives the ref changing underneath it.

## Shape

| Piece                                                | Home                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `stack_landings` table and its reads/writes          | new module `src/store/landings.ts`                                      |
| `landingScope`, `landingReadiness`, `settleLandings` | `src/stacks/landing.ts`                                                 |
| record / revoke / settle                             | `StackLandingDesk`, sibling of `ProposalDesk`, wired in `src/system.ts` |
| `POST` and `DELETE /api/stacks/:ref/land`            | new `src/server/routes/stacks.ts` + a `ROUTE_MODULES` entry             |
| the auto-accept itself                               | the existing `authorize()` in `src/executor/actionExecutor.ts`          |
| the button and the head-line states                  | `StackRun` in `web/src/skins/factory/components/Inspection.tsx`         |

`src/stacks/stack.ts` keeps the two importers `test/stacks.test.ts` asserts
(`stateSnapshot.ts`, `wire.ts`): that assertion filters out `src/stacks/*` itself, and
`landing.ts` is part of the stack model. Only the **route** resolves a ref to rungs, and it does
so through `landingScope`. The **pulse-side settle never calls `buildStacks`** — it works from
recorded PR numbers against the open and closed world, which is what keeps the model out of the
harness's decision path.

### The table

New table, so no `ALTER TABLE` and no `ColumnMigrations` entry is involved.

```sql
CREATE TABLE IF NOT EXISTS stack_landings (
  id         TEXT PRIMARY KEY,
  ref        TEXT NOT NULL,   -- "stack:124" as it read at the click; display only
  rungs      TEXT NOT NULL,   -- JSON array of PR numbers, bottom-first — the authorization
  status     TEXT NOT NULL,   -- standing | landed | stopped | revoked
  reason     TEXT,            -- why it stopped, in the words the rack and the escalation quote
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

At most one row may be `standing` for a given PR number; recording an intent that overlaps a
standing one replaces it, because the second click is the operator looking again.

Progress is derived, never stored: a rung is landed when it is no longer in the open set and the
world says it merged. Storing a counter would be a second answer to a question the world already
answers.

### The decider

`Proposal.decidedBy` gains a third arm: `'human' | 'auto_send' | 'stack_landing' | null`. The
column carries no `CHECK` constraint, so this is a change to `src/types.ts`, `decidedByLabel` and
`authorityOf` and nothing else.

Reusing `auto_send` was rejected. Auto-send means "the harness cleared its own confidence
threshold"; this means "the operator authorized this chain in advance", and the audit row exists
to tell those apart. The note carried on the proposal names the intent:
`you authorized landing stack:124 (3 rungs) on <date>`.

The accept runs through `ActionExecutor.runAuthorized`, the same function a human accept and an
auto-send accept run through, so "who authorized this" keeps one answer shape.

## The three decisions

### 1. A rung that goes red stops the intent

When a rung above the one that just landed fails CI on its new base, or a conflict appears, the
intent **stops and surfaces**. It does not wait, and it does not resume on its own.

The reason is sharper than "not what they authorized", though that is true. Rule
`pr-merge-ready` already refuses to propose a red rung, so nothing merges either way — the only
question is whether the intent waits silently or says so. Waiting silently means CI goes red, an
agent fixes it three cycles later, the rung goes green, and the merge is auto-accepted, landing
code in a state no operator ever saw. An operator authorized landing a chain they had read; a
rung that has changed since is not that chain.

Three things stop an intent:

- a remaining rung is no longer clear (see below);
- a remaining rung left the open set without merging — someone closed it;
- a merge this intent authorized failed at the sink. Without this arm the failed merge would be
  re-proposed on a later pulse and auto-accepted again, retrying forever behind an escalation
  nobody asked for.

Stopping records the reason **and raises an escalation**. The rack chip is the glance; the
escalation is the guarantee, because a chain that drops below two rungs stops being a stack and
its head line leaves the rack entirely.

A stopped intent is not resumed. The button is offered again once the rungs are clear, and that
click is the operator re-authorizing a chain they have looked at again.

### 2. The button is offered only when every rung is clear

Not offered-and-warning: **disabled**, with no way to click through it. Offering it while a rung
above the bottom is unread would authorize merging code whose ladder the operator cannot see.

Clear, per rung, is: CI passing, approved, no unresolved review comments, and no real conflict
(`mergeableState` is not `dirty`).

`behind` and `blocked` are deliberately **excluded**. A rung is behind precisely because the rung
beneath it has not landed yet, and it clears itself the moment the provider retargets. Counting
it would mean the button could never appear on any real stack, which is the feature not existing.
The line this draws, and the one to keep: _the operator is authorizing code they have read;
`behind` is a fact about the queue, not about the code._

Readiness is decided **on the server** (`landingReadiness`), shipped on the snapshot, and drawn
by the skin. The route re-checks it before recording, because a disabled button is a courtesy and
not a gate. One answer, two readers — a client-side re-derivation would be the second opinion
this repo splits `prAttention` out to prevent.

When a rung is not clear, the button is disabled and the first blocker is named beside it.

### 3. The rack shows the intent standing

A click whose effects arrive over the next several cycles must leave a visible state, or it reads
as having done nothing.

```
offered     #12 Fix intake   3 PRs   [ land the stack ]
withheld    #12 Fix intake   3 PRs   [ land the stack ] (disabled) — #126 not ready · CI failing
landing     #12 Fix intake   2 PRs   ◆ landing · 1 of 3   [ stop ]
stopped     #12 Fix intake   2 PRs   ▲ stopped · 1 of 3   [ land the stack ]
                                       #126 CI failing since #124 landed
```

`1 of 3` counts merged rungs against the rungs authorized, both from the intent record — the
derived stack shrinks as rungs land, so it cannot supply the denominator.

`[ stop ]` is the revoke, and it is offered throughout: an intent that could only be set would
make an accidental click unrecallable.

## Wire

`/api/state` gains `stackLandings`: one entry per currently derived stack, carrying its ref, its
readiness (`offer`, `blockedBy`), and the standing or stopped intent matched to it by rung
overlap. `Stack` itself is unchanged and `buildStacks` stays pure.

## Tests

At the `buildSystem` seam, fakes injected, `test/*.test.ts`:

- a standing intent auto-accepts a rung's merge proposal, the merge reaches the sink once, and
  the audit row names `stack_landing` as the authority;
- a rung that goes red above the one that just landed stops the intent, records the reason, and
  raises an escalation — and a later merge proposal for that rung is _not_ auto-accepted;
- the intent survives a restart: two `buildSystem` calls over one temp-file `dbPath`, since
  `:memory:` cannot express a restart.

Plus unit tests for `landingReadiness` (notably that `behind` does not withhold the button and
`dirty` does) and for `settleLandings`.

## Specs to update in the same change

- `docs/spec/07-pull-requests.md` — the intent, its scope by PR number, and the stop rule.
- `docs/spec/17-cockpit.md` — the button, its gate, and the four rack states.
