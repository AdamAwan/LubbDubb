# The assessor — `delivered`, and who decides it

**Status:** design, stage 2 of 3
**Date:** 2026-07-28
**Follows:** [`2026-07-28-work-graph-design.md`](2026-07-28-work-graph-design.md) (stage 1, shipped in #150)

## The problem stage 1 left standing

Stage 1 built the record. Nothing reads it, deliberately — it is a lens, the way
`findings`, `overlaps` and `prAttention` shipped. This document specifies the first
consumer, and the consumer is not a rule reading the graph: it is an **agent**.

The gap is narrow and concrete. An issue is worked, a PR is opened, the PR merges.
`openPrForIssue` reads only the open list, so the moment that PR leaves it the issue is
once again "open, watched, no open PR" — which is rule 4's entire pickup precondition.
A fresh agent is dispatched onto work already sitting on the default branch.

Azure deployments are half-protected by accident: rule 3b parks the work item in
`issueInReviewState` while a PR is open, and its inverse arm returns it to pickup only
on an explicit `more_work` verdict. That park is a **tracker state**, so it exists only
where the tracker has one. CLAUDE.md states the consequence plainly and it is the
starting point here:

> Consequence, stated: on GitHub/fake there is no review state, so a conclusion is
> recorded and shown but changes no dispatch.

So on GitHub — the primary provider — nothing stops re-pickup. What bounds it today is
`dispatchVerdict`'s attempt cap: three agents redo merged work, and then the origin
escalates. That is the bug, and it is bounded rather than fixed.

**`delivered` is the harness's own park, for the providers that have no tracker park.**
That framing is the whole design. It is not a new notion of completion; it is rule 3b's
review-state hold, generalised off the tracker and onto a row the harness owns.

## `delivered` against `closed`

Restating from stage 1, because every decision below turns on it:

- **`delivered`** — the harness believes it has done what it can. Assessed, reversible,
  and its only effect is to stop pickup. **Not terminal.**
- **`closed`** — the human agrees. Tracker status, read never computed, terminal.

The gap between them is days of testing and sign-off. During it, rule 3b's inverse arm
still sees no open PR and still wants to return the item to pickup; on GitHub rule 4
wants to re-dispatch outright. `delivered` exists to fill exactly that gap and nothing
wider. It must not grow into a completion test — the stage-1 design already argued why
completion is not enumerable and not the harness's to decide, and none of that changes
here.

## Open question 1: desk agent or code agent

**Settled: a code agent, on branch `assess/issue/<n>`, based on the default branch.**

The rejected alternative was a desk agent reading `world_read`. It is cheaper and needs
no worktree, and it is wrong for one reason: `world_read` returns titles, states, CI
verdicts and comments. Judging whether issue #12 was _delivered_ from the title of the
PR that closed it is judging from the label on the box. That is the same
model-diligence failure the stage-1 design named when it refused to rest completion on
an agent remembering to call `conclude_work` — reintroducing it one layer up, with more
ceremony, would be the worse version because it would look rigorous.

The precedent is exact and already in the tree. Rule 3c dispatches the **planner** as a
code agent for the same reason — "it needs a worktree to read the repo". An assessor
needs the repo more, not less: the planner reads it to decide a split, the assessor
reads it to check that something is actually there.

The branch namespace is not cosmetic, for the reason `plan/issue/<n>` is not. Git stores
refs as files, so `refs/heads/issue/12` and `refs/heads/issue/12/assess` cannot coexist,
and `issue/<n>` is exactly what a pickup agent wants. `assess/issue/<n>` sits beside
`plan/issue/<n>` in a namespace of its own and collides with neither.

`base` is `config.defaultBranch`, threaded through the action the way rule 4a threads a
part's base. That is not incidental: merged work is _on_ the default branch, so the
default branch is the only checkout in which the question can be answered at all.

**The worktree is read-only by convention, not by enforcement.** No mechanism stops the
assessor writing, and none is proposed — the harness has no read-only worktree mode, and
inventing one for a single rule would be a mechanism nothing else could use. What
actually bounds it is that the assessor's branch is never pushed and its PR is never
opened: `assess/issue/<n>` has no rule that would ever act on it, so a write lands in a
worktree that the `done` reap removes. Stated so it is not mistaken for a guarantee.

## Open question 2: what clears a `delivered` verdict

Three things clear it, and the third is not part of the predicate at all.

**1. The issue is observed in a pickup state again.** This is the state-based arm, and
it is the one the phase-4 precedent does _not_ cover. CLAUDE.md already promises it for
conclusions — "moving the ticket in the tracker _is_ the override" — and that promise
must hold for `delivered` or an Azure operator dragging a card back to `Ready` would be
silently ignored. It cannot be an event: `worldDiff` emits `issue_opened`,
`issue_closed` and `issue_linked` and **nothing for a `workItemState` transition**, so
there is no signal to match. Reading the _current_ state instead of a transition is also
the more robust half of the trade — state survives a restart and a missed baseline,
where an event between two pulses does not.

Adding an `issue_state` event to `worldDiff` was considered and rejected: it would make
the verdict depend on the harness having observed the moment of the move, which is
exactly the fragility the durable record was built to escape.

**2. A world transition on `issue:<n>` strictly after the verdict.** This is the
phase-4 rejection-expiry pattern, and it is what covers GitHub, where arm 1 can never
fire because there are no work-item states. **Any** transition counts, for the reason
`expiringSignal` gives: a per-kind filter would be a second opinion about which changes
matter, sitting nowhere near the rule it second-guesses. In practice the transition that
matters is `issue_linked` — a new PR referencing the issue is the world saying there is
more here — and a reopen, which is the same statement in stronger terms.

**There is deliberately no timer arm**, for phase 4's reason, which transfers whole: a
`delivered` verdict that expires on a clock means "delivered for now", and re-picking
work that was genuinely delivered is the precise bug this exists to stop. If both
existed, signal would have to dominate anyway, and a timer that may only ever _delay_ an
expiry the signal already granted decides nothing.

**3. The operator clears it.** A delete, not a status — clearing a conclusion is
already a delete "so `undeclared` has exactly one representation", and the same holds
here. Because it is a delete it is not part of the hold predicate, which keeps that
predicate at two arms rather than three.

**Expiry lifts the hold; it does not retract the verdict.** The row stays, so the
assessor's note remains readable as the last thing said about the issue, and the
cockpit can show that an assessment was made and then overtaken. A fresh assessment
upserts over it.

## The rule

`issue-assess`, number **3e** — after the plan-approval gate, ahead of `plan-part` (4a)
and `issue-pickup` (4). Origin `issue:<n>:assess`.

It fires for issue N when all of:

- N is open and passes `issueWatchGateReason` — the same watch/ignore gate rule 4a
  applies to a plan's parts, evaluated once on the issue.
- No `delivered` verdict stands (arms 1 and 2 above are what "stands" means).
- No open PR for N (`openPrForIssue`), and no schedulable plan part.
- Nothing live under it: no active task on `issue:N` or any `issue:N:*` origin.
- **At least one task has ever existed on `issue:N` or a descendant origin.**
- `dispatchVerdict('issue:N:assess', …)` says dispatch.

### The prior-task condition does two jobs

The stage-1 outline called it out as anti-noise — without it a brand-new issue satisfies
every other condition trivially (nothing is in flight because nothing ever started) and
every fresh issue gets an assessor reporting "nothing has been done". That remains true
and is reason enough.

It also does a second job that only becomes visible once the rule is placed: it is the
**discriminator between "never started" and "may be finished"**, which is what lets
assess and pickup coexist. An open watched issue with no open PR is a candidate for
both. Prior tasks decide: none → pickup, some → assess first, and the assessment decides
whether the issue goes back round (`more_work` → rule 3b / rule 4) or stops
(`delivered`).

### It is answered from `ctx.tasks`, never from the graph

This is the point at which stage 1's structural property is most tempting to break, so
it is worth being explicit. "At least one task has existed in the subtree" reads as a
graph query, and the graph would answer it. It must not be asked of the graph.

`ctx.tasks` already carries every task with its `originRef`, and `issue:N` plus
`issue:N:*` is exactly the subtree's origin vocabulary — the graph is keyed on those
same strings, which is why it looks like the same question. It is the same question,
answered from the source the dispatcher already holds.

The prohibition stands unchanged: **nothing in `src/dispatcher/` may read the graph.**
`test/workGraph.test.ts` asserts it structurally and that assertion is not to be
relaxed. The graph is what the _assessor agent_ reads, through `world_read` — a
different layer, a different failure mode, and one where an agent's own record cannot
suppress another agent's dispatch.

### Suppression, and failing open

An issue that is an assess candidate this cycle is skipped by rule 4. Without that both
rules fire and two agents land on one issue, one assessing and one redoing the work.
The set is computed once and shared, so the two cannot disagree about which issues are
in it — the same "two call sites, one predicate" discipline as the jobs 409/defer pair.

**The assessor fails open, exactly as the planner does.** A spent attempt cap on
`issue:N:assess` returns the issue to ordinary pickup, with no escalation. This is not
politeness: narrowing rule 4 without it turns any assessor crash into a permanently
parked issue, which is the failure the planner's fail-open was written to prevent and
the reason it carries no escalation either. A cooling-down assessor suppresses pickup
for that cycle only.

### Off by default

`assessment.enabled`, default false. The `mcp` channel is on by default because it is
purely additive; this is not — it gates pickup and spends an agent per assessed issue.
`planning` is the right precedent and this follows it. With the flag off, no rule fires,
no verdict is written, and rule 4 behaves byte-for-byte as it does today.

## What the assessor writes

One new MCP tool, `assess_issue(verdict, summary)`, fenced to `issue:<n>:assess`
origins. Identity is structural, as for every other write tool: no issue argument, the
origin resolved from the credential, so an assessor cannot address another issue's
assessment.

Two verdicts, landing in two different places, because they are two statements that
already exist:

- **`more_work`** → an `issue_conclusions` row, author `assessor`. This is the
  design's own choice and it is right: `more_work` is exactly what that table already
  means and what rule 3b's inverse arm already reads. A second source for one statement
  would be the duplicate-opinion bug this repo has paid for twice.
- **`delivered`** → an `issue_deliveries` row.

**Each write clears the other**, so an issue never carries both. A working agent's
`more_work` and a later assessor's `delivered` would otherwise contradict: rule 3b would
return the item to pickup while the delivery gate blocked it. The assessor is later and
better informed — it read the graph and the repo — so its verdict replaces, and the
clear is a delete for the one-representation reason above.

`conclusionOrigin` gains a refusal arm naming `assess_issue`, alongside the ones that
already tell a part agent and a planner why `conclude_work` is not theirs. An assessor
that reaches for the wrong tool gets told which one is right, rather than a generic "not
an issue" that is also false.

### Why `issue_deliveries` is a fresh table and not a third verdict

Adding `delivered` to `IssueConclusionVerdict` is the smaller diff and the wrong shape,
for the reason phase 1 gave for `proposals` against columns on `escalations`.

A conclusion is **declared once, by the agent that did the work, and gates nothing** —
CLAUDE.md is emphatic that nothing gates pickup on it, and gives the reason. A delivery
verdict is **re-read by a gate every pulse and expires on world signal**. Folding them
puts a value whose meaning depends on which member it is into one row, gives
`resolveIssueConclusion` an expiring member its other two do not have, and overwrites
the working agent's note with the assessor's. One fresh `CREATE TABLE`, so no
`Store.migrate()` entry.

```sql
CREATE TABLE IF NOT EXISTS issue_deliveries (
  origin_ref  TEXT PRIMARY KEY,   -- issue:<n>, the same key everything else uses
  summary     TEXT NOT NULL,
  by          TEXT NOT NULL,      -- assessor | operator
  agent_id    TEXT,
  task_id     TEXT,
  decided_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

`by` carries `operator` because the cockpit can mark an issue delivered directly — the
same escape hatch the conclusion toggle is, and the same reason: an operator looking at
a finished issue must not have to wait for an agent to agree.

## The gate

One pure predicate, `deliveryHold(delivery, issue, ctx)` → `string | null`, in
`src/delivery/delivery.ts`. Null means free to pick up; a string is the reason, rendered
to the operator.

Asked in **two places off the one predicate**, which is the pattern proposals and jobs
both use and for the same reason — a hold the two disagreed about would have one
surface promise what the other refuses:

- `RuleDispatcher`, gating rule 4's `eligibleIssues`.
- `issuePickupStatus`, which gains a `delivered` status kind so the cockpit chip
  predicts what the next cycle will do. `QueueItem` needs nothing new: a held issue is
  not a candidate at all, the way an unwatched one is not.

It is **not** asked in the executor. The jobs and proposals pairs put a check there
because those acts can arrive from the LLM dispatcher, which reasons in prose and cannot
be gated rule-side. A pickup dispatch for an issue is world-driven only, and the
ClaudeDispatcher gets the delivery list in its prompt the way it gets the job queue.

## Reading the graph

The assessor reads the record through `world_read('issue', 'issue:<n>')`, whose payload
gains the work subtree. No new tool.

This is the natural home rather than a convenient one. That payload already carries "an
issue's plan graph, which lives only in the store" — a store read attached to a world
item, which is exactly what the subtree is. The tool is already available to every
agent, already suffix-tolerant so `issue:12:assess` resolves to `issue:12`, and already
the answer to "the harness's own view, never re-fetched".

It also keeps the layering honest. `src/mcp/` reading the graph breaks nothing:
`world_read` forges and mutates nothing, and the property stage 1 protects is that no
**rule** consults the graph. An agent reading its own history is the intended consumer;
a gate reading it is the thing that was refused.

What the subtree gives the assessor that the world cannot: the PRs that delivered the
issue and have since aged out of `closedPullRequests` entirely, with `provenance`
distinguishing "I watched this merge" from "I assume this merged". Stage 1 recorded that
distinction specifically so this agent could weigh it, and the prompt says so — an
`inferred` merge is weaker evidence than an `observed` one and the assessment should
say when it rested on one.

## Cockpit

- `/api/state` ships the standing delivery per issue, beside `pickup`. The chip reads
  `issuePickupStatus`'s new `delivered` kind, so it cannot disagree with the rule.
- `POST /api/issues/:n/delivered` — `{delivered, summary?}`. Sets the operator verdict
  or clears it (the delete above). Under the guarded `/api` prefix like every other
  route; `test/cockpitAuth.test.ts` walks the table and will require a refusal from it.
- The `assess` node kind, reserved by stage 1's schema and unwritten until now, is
  emitted by the fold for `issue:<n>:assess` task origins, parented to the issue. It is
  **never terminal**, for the reason a concern is not: an assessment is a step toward a
  verdict, not a leaf, and an issue with a live assessor is not finished.

## Testing

`test/issueAssess.test.ts`, at the `buildSystem(config, opts)` seam.

- **The headline.** Drive an issue through pickup → PR → merge → the PR leaving the
  world, with `assessment.enabled`. Assert no second pickup agent is dispatched, and
  that an assessor is. This is the bug; if it passes, the thing works.
- Fires only with prior tasks: a fresh open watched issue gets pickup, not an assessor.
- Suppression: assess and pickup never both fire for one issue in one cycle.
- Fails open: a spent attempt cap on `issue:N:assess` returns the issue to pickup, with
  no escalation.
- Each clearing arm, separately: a pickup-state observation, an `issue:<n>` transition
  after the verdict, and the operator's delete. Plus the negative — a standing verdict
  with no signal and no state change still holds.
- Mutual exclusion: `delivered` clears a standing conclusion and `more_work` clears a
  standing delivery.
- Off by default: with the flag unset nothing is written and rule 4 is unchanged.
- **Structural, unchanged from stage 1**: nothing in `src/dispatcher/` imports the graph
  module. `test/workGraph.test.ts` keeps that assertion exactly as it is.

`npm run check` must pass: both typecheck passes, knip with no unused exports, Prettier,
and the suite.

## Out of scope, stated

- **Stage 3.** Operator jobs and unparented PRs rooting their own trees with no work
  item behind them, and filing one through `POST /api/findings/:id/file`. Nothing here
  assumes it.
- **Any change to what `autoSend` may authorize.** The assessor proposes nothing and
  sends nothing outward; `delivered` is an internal park, not an act.
- **Closing the issue.** The assessor never moves the tracker. `closed` is the human's,
  and that is the line the whole design rests on.
- **The stage-1 backfill gap.** `WorkGraphRecorder.record` reads `existing` through
  roots-then-subtrees, so a node whose ancestor chain is incomplete is invisible to the
  fold. Ruled on and deliberately left: the consequence is conservative (such a node
  stays stale at `open` rather than being falsely marked merged), and closing it costs a
  fourth store method where the stage-1 spec argued for three.
