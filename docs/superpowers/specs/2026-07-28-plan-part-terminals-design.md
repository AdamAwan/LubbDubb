# Plan part terminals — a part that produces no PR can finish

Design for [#160](https://github.com/AdamAwan/LubbDubb/issues/160).

## The problem

`PlanPartStatus` is PR-shaped, and the only terminal meaning _this work finished_ is `merged`.
`retired` is not a counterexample: it means "dropped by an amendment before anything was started",
which `partHasWork` enforces. A part that did its work and concluded no change was needed is the
opposite of retired.

Two consequences. The planner has to invent PRs — asked to decompose _"investigate why deploys are
slow"_ it must produce parts that will never merge, or refuse to decompose. And one no-code part
parks the whole issue: a part whose real answer is _"nothing to do, #98 already fixed this"_ has no
status to move to, so it stays `dispatched`, `liveParts` never empties, `rollUpPlanStatus` never
reaches `complete`, rule 3b keeps the work item parked in the review state for the life of the plan,
and the status comment never says the plan finished. The whole decomposition is held open by the one
part that correctly determined there was nothing to build.

`TaskKind = 'code' | 'desk'` already draws this line for tasks. A plan part cannot say it.

## Decisions

The issue posed five questions and said they should be argued rather than defaulted. The answers,
with the argument for each.

### 1. The agent declares the terminal; the reconciler does not derive it

The candidates were an agent declaring it (the `conclude_work` pattern) or the reconciler deriving it
from an artifact or finding recorded against the part's origin.

**Declaration wins on the harness's own asymmetry.** `undeclared` is kept distinct from `more_work`;
`@@LUBBDUBB_DONE@@` is kept distinct from the `result` event; `note_progress` has no placeholder and
nothing infers progress from output. The rule those share is that a positive terminal is never
inferred from incidental output. Derivation is exactly that inference: a code part that writes a
design note and then dies before opening its PR would close as a report, silently completing a plan
on work that never happened.

The objection to declaration is that an agent can forget, reproducing the parked-plan bug. It does
not, because `PlanReconciler.foldStalled` already covers it: a `dispatched` part whose agent is gone
returns to `ready`, is re-dispatched through the per-part origin's cooldown, and escalates once the
attempt cap is spent. So a forgotten declaration is a **visible loop ending at a human**. A wrong
derivation is an **invisible false completion**. The failure modes are not comparable, and the
cheaper one is chosen deliberately rather than by default.

A derived fallback behind the declaration was considered and rejected: it needs a precedence
argument, and it reintroduces the derivation failure mode in precisely the case where it fires.

### 2. Both an expected and an actual kind

An **actual** kind is required — a part planned as `code` that turns out to be a duplicate must still
close truthfully, which is the bug being fixed.

An **expected** kind earns itself at approval time. `planning.requireApproval` now defaults `true`, so
an operator reads a decomposition before anything is scheduled from it, and a decomposition that
looks uniformly PR-shaped tells them less than it could. Seeing that step 3 is "write it up" is the
whole value.

A mismatch between them is **surfaced, never validated**. It is interesting information — the planner
expected code and the agent found a duplicate — and refusing it would be refusing the truthful close.

### 3. Summary required, evidence optional

`conclude_part` takes a mandatory `summary` and an optional `evidenceRef`, validated against records
on that agent when supplied.

Requiring evidence was tempting: it makes the outcome durable and reviewable rather than a sentence
in a plan comment, and the file-events hook auto-promotes reports through `classifyArtifact` so an
artifact usually exists. But "usually" is the problem. A write-up landing at a path `classifyArtifact`
does not promote would leave the part unable to close — reintroducing the parked-plan bug in a
narrower case, which is a bad trade for a feature whose entire purpose is to remove it.

The summary carries the same weight `conclude_work`'s note does: required, non-empty, and **not
trimmed away**. It is written once per part, not once a minute, and an operator reads it to decide
what the plan achieved.

### 4. One new terminal status, not one per kind

`merged` stays the code terminal, untouched, so the entire PR-observation path (`observePartPr`,
`foldPr`, the closed-PR window readings) needs no new arm. `concluded` covers report and
determination.

The alternative of a status per kind (`reported`, `determined`) is more legible in the database, but
every switch grows two arms and each site can drift independently — the bug class already paid for by
the two-detector sentinel history and by keeping `prHealth` and `prAttention` apart deliberately.
Instead one pure predicate, `partSettled`, replaces every `=== 'merged'` comparison that actually
means _reached its terminal_.

Not adding a status at all — letting `merged` mean any terminal — was rejected because it puts a lie
in the plan's status comment, which the issue's acceptance criteria rule out.

### 5. Stacking degrades, with one guard that is a real bug if missed

`dependencySatisfied` treats `concluded` as satisfied: the dependency is finished, there is nothing
to wait for.

`partBase` **must** return the default branch for a `concluded` dependency. This is not tidying. The
current code returns `dep.branch ?? partBranch(issueNumber, dep.slug)` for any non-`merged`
dependency, and a concluded part's branch may never have been pushed — so a dependent would be cut
from an unresolvable base and `WorktreeManager.ensure` would throw. `ensure` throws rather than
falling back to HEAD by design, so this surfaces as a rejected dispatch rather than a silent wrong
base, but it is still a failure the guard removes.

`basePrOf` and `isStackedPr` are reached only through a `pr_number`, so they degrade cleanly with no
guard. That is asserted by test rather than assumed.

## The design

### Data model

`PlanPartStatus` gains `concluded`.

`plan_parts` gains four columns, each needing an `ensureColumns('plan_parts', …)` entry beside the
existing `rationale`/`acceptance` one. `CREATE TABLE IF NOT EXISTS` never alters an existing table, so
a column without an entry is invisible on every older database:

| column            | meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `expected_kind`   | the planner's declaration; null means unstated, which reads as `code` |
| `outcome_kind`    | the actual kind, written at close; null until then                    |
| `outcome_ref`     | optional evidence — `flag:<id>` or `finding:<id>`                     |
| `outcome_summary` | required at close                                                     |

A merged part's actual kind is **derived, never stored**: the pure `partOutcomeKind(part)` returns
`code` for `merged`, the stored value for `concluded`, and null otherwise. That keeps `observePartPr`
free of any new write, so the PR fold stays exactly what it is.

Every existing plan row loads unchanged: null `expected_kind` reads as `code`, and no existing part
is `concluded`.

### Zod boundary

`PartSchema` gains `expectedKind: z.enum(['code','report','determination']).optional()`, so a bad kind
is refused synchronously through `plan_submit` rather than discovered a pulse later. `PlanPartInput`
carries it through `planPartInputs`.

A `parts` verdict whose parts are all non-code stays valid. "Investigate why deploys are slow" split
into three write-ups is the case the feature exists for.

### The `conclude_part` tool

Added to `MCP_TOOL_NAMES`, which places it in `ALLOWED_MCP_TOOLS` automatically — the drift trap
`names.ts` exists to prevent.

Pure layer in `src/mcp/partOutcome.ts`, mirroring `conclusion.ts` and `assessment.ts`:

- `partConclusionOrigin(originRef)` accepts **only** `issue:<n>:part:<slug>`, refusing every other
  origin with a message naming the right tool for that caller. `conclusionOrigin`'s existing
  part-refusal is updated to point here, the way its assessor refusal already points at
  `assess_issue`.
- `validatePartConclusion(args)` requires a non-empty `summary`, bounded at 2000 characters and
  refused rather than trimmed when over-long — `conclude_work`'s rule, for its reason: a verdict an
  operator reads must not be silently truncated. It accepts an optional `evidenceRef`.
- **`kind` accepts `report` and `determination` only.** A code part finishes by merging a PR, which
  the world observes. Accepting `code` here would let an agent mark its own work finished with no PR
  — the false-terminal failure derivation was rejected for, arriving through the front door. The tool
  covers exactly the two outcomes that have no outside world.

The part is resolved from the credential (agent → task → part origin), so there is no part-id
argument. Structural identity, as with `report_finding`: an agent cannot name another part's work.

Idempotence is in the write — `Store.concludePlanPart` updates
`WHERE id=? AND status IN ('dispatched','in_review')` and returns null when no row changed, so a
second call is refused without anyone remembering to check first, and a merged or retired part cannot
be concluded.

### Reconciliation — the asymmetry, stated

A `concluded` part is skipped in the fold loop alongside `retired`.

`PlanReconciler` is built on "the store holds intent, the outside world is the source of truth". For
a report or a determination **there is no outside world**: the record is durable in the store the
moment the tool returns. So the reconciler's only job for these parts is to not undo them —
specifically, to not let a PR appearing on that branch drag a concluded part back to `in_review`. The
fold genuinely differs by kind, and this is where that is written down rather than discovered.

### Roll-up, progress, and the status comment

`partSettled(part) = status === 'merged' || status === 'concluded'` replaces every `=== 'merged'`
comparison that means _finished_: `rollUpPlanStatus`, `planProgress` (whose field renames `merged` →
`settled`), `dependencySatisfied`, `siblingContext`.

`planComment` stops describing non-code parts as merged: "**Plan complete** — all 4 parts finished",
"2/4 parts done". `statusMark` gives `concluded` a `[x]`; `where()` renders the kind and evidence
(`concluded · determination · finding f_ab12`). A part whose expected and actual kinds disagree says
so on its line.

`currentPlanSummary` carries the kind, so a replanning planner sees which parts were write-ups rather
than assuming every one was a PR.

### Dispatch is unchanged

A part expected to produce a report still dispatches a **code** agent with a worktree and a branch —
it has to read the repository. The branch simply never carries a PR. No new dispatch arm, and origin
and branch stay 1:1, which is what every gate keyed on origin already relies on. The part's prompt
names its expected kind and says `conclude_part` is how it finishes.

### Cockpit

`PlanPanel` rows and `PlanModal` carry a kind chip — expected before close, actual after — plus the
outcome summary. The progress chip reads "2/5 parts done".

## Testing

`test/planPart.test.ts`:

- a determination part closes and **its plan rolls up to `complete`** — the acceptance criterion,
  since this is the parked-issue bug the feature exists to fix
- `retired` and `concluded` remain distinguishable
- a concluded part is not dragged back by a PR appearing on its branch
- a dependent of a concluded part is based on the default branch
- the plan status comment never describes a non-code part as merged
- a plan row written before this change loads unaffected

Pure unit tests for `partSettled`, `partOutcomeKind`, `partConclusionOrigin`, and
`validatePartConclusion`. `test/stackedPrs.test.ts` gains the assertion that `basePrOf` and
`isStackedPr` are unreachable for a part with no `pr_number`. The `MCP_TOOL_NAMES` assertion in
`test/mcpChannel.test.ts` picks up the new tool without editing.

## Out of scope

- The **issue-level** report. Every completed goal produces a write-up; that belongs to the issue's
  conclusion, not to a part, and conflating them would give every plan a mandatory documentation
  part.
- Changing what a `single` verdict means, or encouraging planners to emit non-code parts. Planners
  should be _able_ to, not nudged to.
- Any new outbound capability. All three evidence records are written by paths that already exist.

## Documentation

`docs/spec/08-planning.md` and the plan-parts notes in `CLAUDE.md`, updated in the same change.
