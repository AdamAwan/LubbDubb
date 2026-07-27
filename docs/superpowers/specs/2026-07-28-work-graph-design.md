# The work graph — a durable record of what was done for a work item

**Status:** design, stage 1 of 3
**Date:** 2026-07-28

## The problem

Three things in the harness each claim a piece of "what is left to do", and none of
them can answer it.

`plans` + `plan_parts` describe a decomposition of an issue and roll up to a status.
`issue_conclusions` holds a verdict an agent declared about its own run.
`Issue.state` / `Issue.workItemState` hold what the tracker thinks. They are keyed on
the same `issue:<n>` and they do not join.

Around them sits work that belongs to none: a `pr:42:ci` fix, a `pr:42:comments`
reply, a base update. These are dispatched off the world, are gated by origin and
branch, and are recorded nowhere as belonging to the thing that produced them. A CI
fix on the PR that delivers issue #12 is, structurally, unrelated work.

Two concrete failures follow.

**The harness forgets.** `WorldSnapshot.closedPullRequests` is bounded by
`config.closedPrWindowMs` (6h). Inside the window a merge is observed; outside it the
PR is simply absent, and absence is read as "merged" by inference. For a plan part
that is survivable — `plan_parts.pr_number` persists the join. For an undecomposed
issue nothing persists it: the task records branch `issue/12`, and the PR that was
opened on that branch is known only from the world. Six hours after the merge, the
edge from the issue to its PR is unrecoverable. **This data loss is happening now and
is not reconstructible later.**

**Nothing can say the work is finished.** `resolveIssueConclusion` folds an operator
toggle, an agent's self-declaration and a plan roll-up, and falls back to
`undeclared` — which is correct and deliberate (silence must not read as done), but
it means the common case rests on a working agent remembering to call `conclude_work`
about its own run. CLAUDE.md says as much: the alternative would make the fix
"contingent on model diligence".

## What this is not

An earlier draft of this design tried to compute completion from the graph: enumerate
the PRs an issue is expected to produce, call it done when they are all terminal.
That is wrong, and the reason is worth recording so it is not re-derived.

**Expected work is not enumerable.** An issue can be resolved by a config change, as
a duplicate, or by a conversation — with zero PRs. Any completion test built on
"expected PRs" is wrong for all three, and there is no honest default.

**Completion is not the harness's to decide.** The real terminal marker is the work
item's status in the tracker: an issue closed in GitHub, a work item completed in
Azure DevOps. That is set by a human after testing and sign-off, it is already on the
world snapshot every pulse, and the harness should **read** it, never compute it.

What the harness does need is a weaker, distinct state:

- **delivered** — the harness believes it has done what it can. Assessed, reversible,
  and its only effect is to stop pickup. **Not terminal.**
- **closed** — the human agrees. Tracker status. Terminal, and the only real one.

Conflating these two is the root of the confusion. The gap between them is days
(testing, sign-off), and during it rule 3b's inverse arm still sees no open PR and
still wants to return the item to pickup. `delivered` exists to fill exactly that gap.

The graph's job is therefore **not** to compute completion. It is to be the evidence
an assessing agent reads when it makes that judgement, and the record an operator
reads to see what happened. Both need it to be durable.

## Scope

Three stages. **This document specifies stage 1 in full**; stages 2 and 3 are
outlined only, and each gets its own spec.

1. **The record.** A `WorkGraphRecorder` in the pulse persisting nodes and edges as
   they are observed, plus a cockpit view. Nothing reads it for decisions.
2. **The assessor.** A new dispatch rule `issue-assess` and an assessing agent that
   reads the graph and writes `delivered`; rule 3b's inverse arm gated on it.
3. **Roots for everything.** Operator jobs and unparented PRs get a work item filed,
   reusing the `POST /api/findings/:id/file` mechanism.

Stage 1 goes first because of an asymmetry, not caution: the assessor can be built at
any time, but **the record can only be built forward**. Every pulse that runs without
it loses merge state permanently. It also matches how every other cross-cutting read
here has shipped — `findings`, `overlaps` and `prAttention` all landed as lenses
nothing reads.

### Related, deliberately out of scope

`Story` is vestigial. The registry has `backlog: { fake }` and no real provider —
Azure work items and GitHub issues both map to `Issue`. Rules 5/6/7 (`story-groom`,
`story-waf`, `story-pickup`) have therefore never fired against a real tracker.
Retiring `Story` and folding it into `Issue` is a real simplification and a separate
change; this design treats `issue:<n>` as the only root that exists in practice.

## The node model

**A node's identity is a ref in the vocabulary that already exists** — `issue:12`,
`issue:12:plan`, `issue:12:part:schema`, `pr:41`, `pr:41:ci`, `job:7`. No new naming
scheme. Every gate, priority override and proposal already keys on these strings, so
the graph joins to the rest of the system for free.

**A work node is keyed on the origin, not the task.** Two CI attempts on one PR are
two `tasks` rows but one node, `pr:41:ci`, with its attempts hanging off it by
`origin_ref`. History is preserved without the graph growing a node per agent
restart, and it matches how `activeOrigins` and `dispatchVerdict` already think.

**The issue node is its own pickup work node.** `issueOrigin(12)` returns `issue:12`,
which is also the world ref for the issue. Rather than invent `issue:12:work` and
break the join with every existing gate, the issue node _is_ the root and its pickup
tasks attach directly to it. PR concerns have no such collision (`pr:41:ci` is
distinct from `pr:41`), so this is a one-off, not a pattern.

**Single parent, following work lineage, plus one cross-link.** `pr:42`'s parent is
`issue:12:part:api` — the part that produced it. Stacking is a different relation, so
a PR node also carries `base_ref` naming the PR it is based on. Keeping them apart
matters twice: `basePrOf` and `inheritedCiFailure` already consume the base chain,
and folding it into `parent_ref` would make the graph lie about what _caused_ the
work. It also keeps the graph a tree, so a subtree is one recursive CTE.

**Terminal state is recorded with its provenance.** A PR node stores `merged` /
`closed` plus how that was learned: `observed` (seen in `closedPullRequests`) or
`inferred` (it left the open set and the window never showed it). Absence-means-merged
stays as the deliberate fallback it is, but with a durable record there is no reason
to forget that it _was_ a fallback — stage 2's assessor should treat "I watched this
merge" and "I assume this merged" differently.

## Where edges come from

Every edge is already computed somewhere in the pulse. The recorder's job is mostly
to stop throwing them away.

| Edge                                | Observed from                                              | Existing code    |
| ----------------------------------- | ---------------------------------------------------------- | ---------------- |
| `issue:12` → `issue:12:plan`        | the plan row / planner task origin                         | —                |
| `issue:12` → `issue:12:part:schema` | `plan_parts.plan_id` → `plans.origin_ref`                  | `liveParts`      |
| `issue:12:part:schema` → `pr:41`    | the part's `prNumber`                                      | `observePartPr`  |
| `issue:12` → `pr:40`                | PR branch matches `issueBranch(12)`, else `linkedPrNumber` | `openPrForIssue` |
| `pr:41` → `pr:41:ci`                | the concern task's origin prefix                           | —                |
| `pr:42`.`base_ref` → `pr:41`        | `pr.baseBranch` matches another PR's branch                | `basePrOf`       |

## The recorder

`src/graph/workGraph.ts` holds the pure fold:
`foldWorkGraph(world, rows, now) → WorkNodeObservation[]`. `Store.recordWorkGraph`
does the upsert. Same pure/impure split as every other seam here.

**Position in the pulse:** in `harness.ts`, after `PlanReconciler` — so part→PR
observations are fresh — and before `Dispatcher.decide`, which is where stage 2 will
need it. Inputs are the world snapshot (issues, open PRs, closed PRs) and store rows
(tasks, plans, plan parts, jobs).

Three rules make it durable and idempotent:

- **Never delete.** A node not observed this pulse is left exactly as it was. This is
  the whole feature: a merged PR ageing out of the window changes nothing.
- **Observed beats inferred.** A terminal state learned from `closedPullRequests` is
  never overwritten by a later inference. But an _observed open_ clears a terminal, so
  a reopened PR corrects itself instead of being stuck on a stale guess.
- **Derive, never toggle.** Each fold writes a status computed from this pulse's
  observation, not flipped from the previous value — the `PlanReconciler` discipline,
  for the same reason.

**Backfill on first run.** `tasks`, `plans` and `plan_parts` are still on disk in
existing deployments, so the first record pass seeds the graph from them. It is an
upsert by ref, so this is the normal path with a wider input — no migration step and
no special case. Everything is recovered except PRs already forgotten, which nothing
can recover.

**Errors.** The recorder is wrapped; failures route through `errors.record` and never
fail the cycle. In stage 1 nothing reads the graph for decisions, so it must not be
able to break the pulse.

## Storage

One fresh table, so no `Store.migrate()` entry is needed.

```sql
CREATE TABLE IF NOT EXISTS work_nodes (
  ref           TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,   -- issue | plan | part | pr | concern | job | assess
  parent_ref    TEXT,
  base_ref      TEXT,            -- PR nodes only: the PR this one is stacked on
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  terminal      INTEGER NOT NULL DEFAULT 0,
  provenance    TEXT,            -- observed | inferred, for a terminal PR state
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_nodes_parent ON work_nodes(parent_ref);
CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_ref);
```

`kind` is listed complete rather than staged: `assess` is written only by stage 2, and
`job` only once an operator job exists. Stage 1 writes `issue`, `plan`, `part`, `pr`,
`concern` and `job`.

**`terminal` is stored, not derived, and that is not a drift risk.** Terminality
depends on kind as well as status — a `merged` PR is terminal, a `closed` issue is
terminal, a concern node never is — so deriving it at read time puts that logic in the
recursive CTE and in the panel, where the two can disagree. It is recomputed from the
observation on every fold and never toggled, which is the same discipline that makes
the copied statuses safe.

**No attempts table.** `tasks.origin_ref` already is the attempt list for a node; it
only lacked an index (`tasks` has one on `status` alone).

**`parent_ref` is write-once once non-null.** Work lineage does not change: the part
that produced a PR does not become a different part. An immutable edge removes cycle
risk by construction, which matters because a recursive CTE that meets a cycle loops
forever — better impossible than guarded. The "once non-null" wrinkle is deliberate: a
stray PR can be recorded parentless and adopted later when `linkedPrNumber` appears,
but nothing can ever be _re_-parented.

**No pruning and no TTL**, unlike `priority_overrides` which is explicitly reconciled
away each pulse. Durability is the feature.

**Three store methods**, because knip runs every rule at `error` and an unused export
turns `npm run check` red: `recordWorkGraph`, `listWorkRoots`, `listWorkSubtree` — the
last a single recursive CTE bounded to the requested root.

## Cockpit surface

**The snapshot does not carry the graph.** `/api/state` is polled continuously, so
shipping the forest on every poll is the wrong shape. Two new routes under the guarded
`/api` prefix:

- `GET /api/work` — roots, with counts.
- `GET /api/work/:ref` — one subtree.

`web/src/components/WorkTreePanel.tsx` fetches on open. The route resolves refs through
the connector's existing `resolveRefUrl`, so a historical PR still links even though it
is long gone from the snapshot's `refUrls` map.

## Testing

`test/workGraph.test.ts`, built at the `buildSystem(config, opts)` seam like everything
else.

- **Durability (the headline).** Drive pulses through a merge, advance past
  `closedPrWindowMs` so the PR leaves the world entirely, assert the graph still reports
  it merged with provenance `observed`. This is the feature; if it passes, the thing
  works.
- Pure fold: one case per edge source in the table above.
- Idempotence: the same fold twice produces no change.
- Observed beats inferred: a PR disappears (inferred merged), reappears open, status
  corrects to open.
- Never delete: a world omitting everything leaves the graph intact.
- **Structural**: nothing in `src/dispatcher/` imports the graph module. Stage 1 is a
  lens, asserted the way `test/prAttention.test.ts` asserts its single importer rather
  than trusting the import graph to stay that way.

`npm run check` must pass: two typecheck passes (`src/` and `web/`), knip with no
unused exports, Prettier, and the suite.

## Stage 2 outline (separate spec)

A new dispatch rule `issue-assess`, origin `issue:<n>:assess`, firing when: the issue
is open and watched; not already delivered; nothing live under it in `activeOrigins`;
no open PR and no schedulable plan part; and **at least one task has existed in the
subtree**. That last condition is not decoration — without it a brand-new issue
satisfies the others trivially (nothing is in flight because nothing ever started) and
every fresh issue gets an assessor reporting "nothing has been done".

It reuses `dispatchVerdict` on its own origin for cooldown and attempt cap, and
composes with what exists: a `more_work` verdict is the existing `issue_conclusions`
row, rule 3b's inverse arm returns the item to pickup, and rule 4 re-picks it with the
outstanding-work note appended — a loop already bounded by the attempt cap on
`issue:<n>`.

Open questions for that spec: whether the assessor is a desk agent using `world_read`
or a code agent with a read-only worktree on the default branch; and what clears a
`delivered` verdict, where the phase-4 rejection-expiry pattern (world signal on
`issue:<n>`) is the obvious precedent.

## Stage 3 outline (separate spec)

"Nothing gets done without a recorded work item; if one is missing we create it."
Operator jobs (`job:<id>`) and unparented PRs currently root their own trees with no
work item behind them, so nothing external can ever mark them delivered. Filing one
reuses `POST /api/findings/:id/file` — an agent files the ticket via
`trackerCoordinates`, with the wording owned by an overridable prompt template.
