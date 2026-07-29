# The Goal Floor — design (issue #168)

The factory skin has two graph views and neither is the production line. `TheLine` draws the
**dispatcher** (roboport, bays, belt, headroom gate — subject: agents). `TechTree` draws a **plan's
parts** by `dependsOn` depth (subject: prerequisites, and it stops at the part). Nothing draws what
[`docs/workflow.md`](../workflow.md) describes end to end: a ticket arriving, being checked for
workability, decomposed, each step producing a pull request, each pull request passing its checks and
merging, the merged parts accumulating against one goal, and the goal check firing on the lot.

This is the design for that third view. The mockup it was written against is
[`goal-floor-mockup.html`](../mockups/goal-floor-mockup.html) — open it in a browser; seven goals, one
per state the floor has to be able to draw, including one branching plan and one that reaches the end.

It is checked node by node against [`workflow.md`](../workflow.md); that table is in the mockup, and
the four stages that are deliberately *not* machines are argued below.

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

`layoutFloor(...)` assigns each machine a **(column, lane)** and is pure over **refs and dependency
edges alone** — no status, no tone, no timestamps. Column is dependency depth; lane is the branch the
machine sits on. It is memoised on a structural key (the sorted ref list plus the edge list), so a
machine moves only when the graph's *shape* changes: a part appears, a part is retired, a PR is
opened. Tone, status word, plate text and belt motion are looked up per render off the snapshot.

Without the split, a floor re-laid on every poll jitters exactly when an operator is watching it most
closely, which is when something is going wrong.

This is `layoutTechTree`'s own algorithm — `depths()` walking `dependsOn`, then a row per column —
which is the concrete form of decision 3 above: the floor does not merely replace the tech tree, it
does the tree's job as a proper part of its own.

## Parallel work: the plan is a graph, and it rejoins

A goal's parts are not a chain and not a forest either. The shape to draw is the one
`docs/workflow.md` already draws and the one the floor is designed against:

```
PR1 ─┬─> PR2 ──> PR4 ─┬─> PR5
     └─> PR3 ──────────┘
```

One part unlocking several is a **splitter**; a part waiting on several is a **merger**. Both are
drawn as belt fixtures rather than machines, because a machine is always a *work item* and the
branching is a property of the graph, not a thing anyone does.

### The merger is not expressible today, and the fix is small

`PlanPart.dependsOn` is capped at **one** entry, refused at the plan document's zod boundary alongside
cycle detection. So PR5 cannot currently say it needs both PR3 and PR4.

But that cap is a *static approximation* of the rule that actually matters, and `CLAUDE.md` says so in
as many words: it is **"the static form of _at most one open dependency_"**. The reason behind it is
base selection — with two dependencies both could be in review at once and there would be no single
branch to base on.

**That reason does not bite on the merger.** A part with two prerequisites starts only when both have
*merged*, at which point **zero** are open and its base is unambiguously the default branch. The
dangerous case — two *open* dependencies — is still refused; it is refused **dynamically, at
dispatch**, rather than statically at ingestion, which is where the rule was always true.

| Change | What it becomes |
| --- | --- |
| `planDocument.ts` arity check | Drop the `dependsOn.length > 1` refusal. Cycle detection already walks the whole array and is unaffected. |
| `partBase` | The **single unsettled** dependency's branch, or the default branch when all have settled. |
| `dependencyOf` → `dependenciesOf` | Returns the list. `dependencySatisfied` is already per-dependency and unchanged — it is called N times. |
| `partDepth` | `max` over every dependency, so a merger never draws to the left of something it waits on. |
| The `issue-plan` prompt | Told the new arity, or the planner keeps emitting chains. |

This is **the one part of this design that is not purely a lens.** Everything else reads state that
already exists; this changes what a plan may *say*. Small, and the shape the workflow doc already
draws — but a real change to the planner's contract, and worth deciding separately from the drawing.

**Decided and landed (issue #170).** One thing the table above omitted: the invariant does not simply
vanish from ingestion, it *moves* to `PlanReconciler.readiness`, which holds a part `pending` unless
every dependency is satisfied **and at most one is still unsettled** — without that second half
`partBase` has two candidate branches and no way to choose. `findDependencyCycle` also had to be
widened to walk every edge; following `dependsOn[0]` was the whole graph only while arity was capped.
The drawing needed no change, as intended. See [08](08-planning.md#the-arity-rule-where-it-lives).

Parallel lanes are also where three readings become visible that a single chain never shows, and each
is an existing field with nothing new required:

| Reading | Source |
| --- | --- |
| Two PRs open at once on one base | `part.prNumber` + `pr.baseBranch`; `isStackedPr` already holds the merge |
| A lane ready with no bot | `maxConcurrentPartsPerIssue` → the `capped` `QueueItem.status` |
| Two bots writing one file | `overlaps[]`, which only concurrency can produce |

The cap especially has to be drawn rather than dropped: a limit you cannot see looks exactly like an
idle fleet, which is the invisibility `capped` and `unapproved` were added to `QueueItem` to fix.

## The splitter and the merger — belt fixtures, not machines

They are drawn on the belts rather than as machines, and the rule is worth keeping: **every machine on
the floor is a work item.** A splitter has no status, no agent and no origin ref — it is where the
edge list branches — so making it a machine would break the one property that keeps the floor a view
of the work rather than a diagram of it. (It also drew a four-lane-tall tile the first time a floor
had lanes, which is the visual symptom of the same mistake.)

The furnace stays the **planner** (rule 3c) and is a machine, because it is an act: an agent reads the
repository and decides the shape. The splitter is that decision's *structure*, re-read every pulse.
Folding them would lose the distinction the moment a replan changes the split without re-running the
planner.

The pair also draws something nothing currently draws: a **`single` verdict is one lane straight
through, with neither fixture on it**. The planner ran, considered the goal, and decided it was one
pull request's worth of work — today that outcome is indistinguishable from a floor that was never
planned.

*Considered and not taken:* making the **assay** a filter splitter (workable one way, unclear the
other). It is a real two-way division, but one output is a dead end rather than a lane, and a splitter
feeding a siding is a weaker picture than a drill that has stopped and says why. The assay stays a
machine with a verdict.

## The tail: report, and update the ticket

`workflow.md`'s loop does not end at the goal check — it ends `Goal achieved? → yes → Report what was
done → Update the ticket → Done`. Both stages run today, so both get machines:

- **Manifest** — report what was done. Reads `issue.conclusion.note`.
- **Signal post** — update the ticket. Reads `issue.workItemState` (which already rides the snapshot
  via the spread, undeclared in `web/src/types.ts`) plus the plan's status comment, which is **not on
  the wire** — `plans.status_comment_ref` is server-side only. Either ship it or draw the state move
  alone; do not imply a comment the cockpit cannot see.

They sit on the goal check's **yes** arm, which is why no in-flight floor reaches them: a shortfall
returns before this point. The mockup therefore needed a seventh goal (`issue:187`) that actually
finishes — the absence of one was a hole in the mockup, not only in the tail.

**Quality-pillar commentary is deliberately not drawn.** `workflow.md`'s own "where this stands
today" says there is no step that folds a run's outcome into it, so a third line on the signal post
would be a machine reading a field nothing writes.

## Four workflow stages that are deliberately not machines

Checked node by node against `docs/workflow.md`; these four are decisions rather than omissions:

- **The self-review step.** It is becoming a check, so it arrives as one more scanner on the belt and
  needs no shape of its own.
- **Human review.** Likewise a scanner — but note the source differs from its neighbours: reviewer
  policies deliberately do *not* fold into `ciChecks` (they map to `approved` / `unresolvedComments`,
  see the Azure CI aggregation), so this one scanner is fed from a different field. Drawing it from
  `ciVerdict` would leave it permanently absent.
- **Inherited CI attribution.** `inheritedCiFailure` already renders `CI failing on base PR #n`, so
  the stacked case reads through the scanner row unchanged. No new shape.
- **"Plan accepted? → no, revise".** Deferred. Rejection settles the plan; the return arrow is not
  drawn, unlike the shortfall's, which is.

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
| Splitter                  | A part that unlocks several — the graph branches | out-degree > 1 in `layoutFloor`'s edge list           |
| Merger                    | A part that waits on several — the graph rejoins | in-degree > 1 (**needs the arity change above**)      |
| Blueprint ghosts          | `awaiting_approval`                              | `plan.status` + `upcoming` item `unapproved`         |
| Assembly machine          | A plan part; its recipe is the part's scope      | `planParts[]`, `dependsOn`, `scope`                  |
| What comes out of it      | `PartOutcomeKind` — code, report, determination  | `part.expectedKind` / `part.outcomeKind`             |
| Pull request machine      | The PR the code arm produced                     | `part.prNumber` → `world.pullRequests`               |
| Scanners on the belt      | CI checks, classified                            | **new** `pr.ciVerdict`                               |
| Ship part                 | A merged PR, or a concluded part's artifact      | `part.status` via the `partSettled` reading          |
| Silo                      | The goal, filling with delivered parts           | the roll-up the pickup chip already counts           |
| Satellite                 | The assessment, rule 3e                          | `issue.conclusion` (`by: 'assessor'`)                |
| Manifest                  | Report what was done                             | `issue.conclusion.note`                              |
| Signal post               | Update the ticket — state and comment            | `issue.workItemState` + the plan status comment (**not on the wire**) |
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
- A pure `layoutFloor` test: same structure in, same positions out, regardless of any state field —
  plus the `PR1 → {PR2, PR3}, PR2 → PR4, {PR3, PR4} → PR5` graph asserting that a merger lands to the
  **right of every part it waits on** (the longest-path property), which is what a naive
  `dependsOn[0]` depth gets wrong.
- If the arity change lands: `partBase` returning the default branch when every dependency has
  settled, and a part with two *open* dependencies never reading as ready — the invariant moving from
  ingestion to dispatch, asserted where it now lives.
- `test/cockpitSkins.test.ts` picks up the conformance render for free.
- Server-side: `ciVerdict` on the snapshot asserted against `classifyCiFailures` directly, so the two
  can never answer differently.
