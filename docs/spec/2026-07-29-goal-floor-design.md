# The Goal Floor — design (issue #168)

The factory skin has two graph views and neither is the production line. `TheLine` draws the
**dispatcher** (roboport, bays, belt, headroom gate — subject: agents). `TechTree` draws a **plan's
parts** by `dependsOn` depth (subject: prerequisites, and it stops at the part). Nothing draws what
[`docs/workflow.md`](../workflow.md) describes end to end: a ticket arriving, being checked for
workability, decomposed, each step producing a pull request, each pull request passing its checks and
merging, the merged parts accumulating against one goal, and the goal check firing on the lot.

This is the design for that third view. The mockup it was written against is
[`goal-floor-mockup.html`](../mockups/goal-floor-mockup.html) — open it in a browser; five goals, one
per state the floor has to be able to draw.

## The four decisions

### 1. Scope — one floor per goal

A world floor answers "is the factory producing", which is a **rate**, and `production.ts` already
answers it numerically over a time window. A second, worse answer to a question already answered is
not worth a panel. The per-goal floor is the readable picture and the one the issue's mapping
describes, so the panel draws one goal and carries a strip of ore patches to pick which.

The strip is not a nav bar bolted on: a patch is the first machine of its own floor, so the selector
is drawn in the same vocabulary as the thing it selects, and a glance down the strip is the world
reading the floor cannot hold.

### 2. Source — the snapshot for state, the work graph for existence

The tension in the issue is real and does not resolve by picking one. It resolves by giving them
different jobs:

- **`/api/state` is the live reading and wins wherever both speak.** Every stage the floor draws in a
  live colour — a running assembler, a red scanner, a pending stamp — is a snapshot field, polled at
  the same cadence as every other panel. Nothing on the floor is fresher or staler than the rest of
  the cockpit, which is what stops it disagreeing with the chip beside it.
- **`GET /api/work/issue:<n>` is fetched once when a floor is opened**, and may only **add** settled
  machines the world has forgotten — a PR merged past `closedPrWindowMs`, a part of a plan the
  reconciler has since rewritten. It never contradicts a live reading and never re-fetches on a poll.

Keyed by ref, snapshot-wins-on-conflict. The rule is one line and it is the whole of the merge, which
is the point: two sources that each partly own a field is how they start disagreeing.

Cost, stated: one fetch per floor opened, on a route that is already rate-limited and already
fetch-on-open for `WorkTreePanel`. No new route, no new polling.

### 3. `TechTree` — the floor replaces it

The floor lays its assembly machines out **in dependency order along the belt**, so the tech tree's
one unique claim — depth is how many merges must land before a part can start — survives the move
intact. What the floor adds is everything on either side of the part: the patch, the assay, the
furnace, the PR the part produced, the scanners on it, the silo it fills and the launch it is for.

Keeping both would leave two components deriving a part's state from `PlanPart.status` independently,
which is the outcome the issue rules out and the drift class this codebase has already paid for
twice. So `TechTree.tsx`/`techTree.ts` go, and their pure `stateOf` and `depths` move into the
floor's own pure module — nothing is lost, and knip stays green because the dead file is deleted
rather than left exported.

The **Research** rail slot becomes the floor. `PlanModal` is untouched and stays the place a plan's
prose is read.

### 4. Layout vs reading — position from structure, state from the poll

`layoutFloor(...)` is pure over **refs and dependency edges alone** — no status, no tone, no
timestamps — and is memoised on a structural key (the sorted ref list plus the edge list). A machine
therefore moves only when the graph's *shape* changes: a part appears, a part is retired, a PR is
opened. Tone, status word, plate text and belt motion are looked up per render off the snapshot.

Without the split, a floor re-laid on every poll jitters exactly when an operator is watching it most
closely, which is when something is going wrong.

## The scanners are generated, never named

Machine state comes from the verdict `classifyCiFailures` returns, never from a check's name:

| Verdict arm | Machine                                                     |
| ----------- | ----------------------------------------------------------- |
| `dispatch`  | damaged, repair icon, a bot on the way                      |
| `escalate`  | stopped, marked not-ours, waiting on the outside world      |
| `ignore`    | muted — drawn, not alarming                                 |

So a floor running against a config naming any check at all renders correctly with no code change,
and no check name from any particular workplace appears in this repository. The same discipline the
CI policy itself is built on.

## What the server has to add

Two per-item fields. Both are **verdicts the browser cannot compute without importing server code**,
which is the one case the issue's "no new snapshot keys" leaves open. Both sit beside the verdicts
already riding their item, never inside them — the relationship `attention` has to `health`.

### `pr.ciVerdict`

`{ actionable, dispatch[], escalate[], ignored[], urgent }` — literally `classifyCiFailures(pr.ciChecks,
config.ci)`, computed in `buildStateSnapshot` beside `health` and `attention`, from the same call the
dispatcher makes.

The alternative is shipping `config.ci` and re-matching in the browser, which means a second
implementation of the glob matcher and the first-match-wins ordering, sitting nowhere near the rule it
duplicates. That is the drift class, and it would fail silently: the floor would say *repair* while
the harness held.

### `issue.assay`

`{ verdict, summary, by, decidedAt }`, or null.

`pickup.reasons[0]` already carries the refusal text — but "refused" and "awaiting a verdict" differ
**only in that prose**, and telling them apart by reading the string is precisely what
`signalPolarity` refuses to do, for the reason stated there: the summary is written for a human and
nobody promised to keep its wording stable. The acceptance criterion is that a refused goal is
*visibly distinct* from an untouched one, so the discriminator has to be structural.

Sits beside `conclusion` and `shortfall`, not inside `pickup`, for their reason: pickup answers "would
an agent start next cycle", and the assay answers "is there anything here to start on".

Nothing else. No new top-level snapshot key, no new route, no dispatcher change.

## The mapping

Every noun lands in `web/src/skins/factory/vocabulary.ts` and nowhere else.

| Factory                   | Harness                                          | Read from                                            |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| Ore patch                 | A ticket                                         | `world.issues[]` + `issue.pickup`                    |
| Unsurveyed patch          | A job with no ticket behind it                   | `/api/work` → `unrecorded`                           |
| Assay drill               | The goal assay, rule 3f                          | **new** `issue.assay`                                |
| Furnace                   | The planner, rule 3c                             | `plan.status`, `plan.reason`                         |
| Blueprint ghosts          | `awaiting_approval`                              | `plan.status` + `upcoming` item `unapproved`         |
| Assembly machine          | A plan part; its recipe is the part's scope      | `planParts[]`, `dependsOn`, `scope`                  |
| What comes out of it      | `PartOutcomeKind` — code, report, determination  | `part.expectedKind` / `part.outcomeKind`             |
| Pull request machine      | The PR the code arm produced                     | `part.prNumber` → `world.pullRequests`               |
| Scanners on the belt      | CI checks, classified                            | **new** `pr.ciVerdict`                               |
| Ship part                 | A merged PR, or a concluded part's artifact      | `part.status` via the `partSettled` reading          |
| Silo                      | The goal, filling with delivered parts           | the roll-up the pickup chip already counts           |
| Satellite                 | The assessment, rule 3e                          | `issue.conclusion` (`by: 'assessor'`)                |
| Launch                    | `delivered`                                      | `issue.pickup.status === 'delivered'`                |
| Launch fails verification | A shortfall, rule 3g — routed by what fell short | `issue.shortfall.cause`                              |
| Energy                    | Cap, `paused`, rate limits                       | `control`, `usage` — `power.ts` already folds it     |
| Pollution                 | Concurrent agents writing one file               | `overlaps[]`                                         |

## Three readings the floor has to keep apart

- **Absent is not stopped.** A goal nothing has started on draws a patch and *no drill*. A goal
  refused at intake draws a drill that is *red and stopped*, carrying its reason. This is the whole
  point of #158 having given intake a verdict, and collapsing the two would put the feature back.
- **A stopped machine says why, in the harness's own words.** Every red or amber machine carries a
  plate with the reason the harness already computed. No prose is assembled in the browser.
- **The belt is the harness running.** Belts move only while cycles run — paused, or held on
  recovery, and they stop — exactly as `TheLine`'s does. A belt still moving under a stopped harness
  is the one confidently-wrong thing this layout could draw, so it is asserted rather than trusted to
  the CSS.

## Out of scope

Unchanged from the issue: no dispatcher behaviour, no check/tool/pipeline name in code, no
replacement of the classic skin. Nothing under `web/` imports `src/dispatcher/` or `src/graph/` —
which is *why* the two verdicts above are computed server-side, and the structural assertion in
`test/workGraph.test.ts` gains a sibling for `web/`.

## Tests this implies

- `test/factorySkin.test.ts` — every arm of the new vocabulary function, exhaustively, as it already
  covers `QueueItem.status`; the belt-stops-with-the-harness assertion extended to the floor.
- A pure `layoutFloor` test: same structure in, same positions out, regardless of any state field.
- `test/cockpitSkins.test.ts` picks up the conformance render for free.
- Server-side: `ciVerdict` on the snapshot asserted against `classifyCiFailures` directly, so the two
  can never answer differently.
