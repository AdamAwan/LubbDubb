# A negative assessment — what it is, and what it drives

**Status:** design, for approval
**Date:** 2026-07-28
**Closes:** [#159](https://github.com/AdamAwan/LubbDubb/issues/159)
**Follows:** [`2026-07-28-work-graph-stage-2-assessor-design.md`](2026-07-28-work-graph-stage-2-assessor-design.md)

## The premise, corrected

The issue opens with "the assessor can only say `delivered`". That is not quite what the
code does, and the difference matters because it moves where the fix goes.

`ASSESSMENT_VERDICTS` is `['delivered', 'more_work']` (`src/mcp/assessment.ts`), and
`AgentManager.recordAssessment` routes the second arm to
`Store.recordIssueConclusion({ verdict: 'more_work', by: 'assessor' })`. So a negative
verdict **is** recorded, and it **is** distinguishable from silence — a row with
`by: 'assessor'` against no row at all, which `resolveIssueConclusion` resolves to
`undeclared`. The first acceptance criterion is, strictly read, already met.

What is actually wrong is narrower and worse than "no representation". Three things:

**1. The negative verdict is written into somebody else's statement.**
`issue_conclusions` is keyed `origin_ref PRIMARY KEY`, and it is the row `conclude_work`
writes. An assessor's `more_work` therefore **overwrites the working agent's own
declaration** — its note, its author, its timestamp — and `resolveIssueConclusion` reads
`by: 'assessor'` and `by: 'agent'` through the same arm, with no precedence between them.
The schema comment says a conclusion is "declared by the agent that worked it". Two
parties now write it, and the resolver cannot tell them apart.

**2. What it drives is provider-conditional, and for a decomposed issue it is nothing.**
The only consumer of `more_work` is rule 3b's inverse arm, which emits
`set_work_item_state` — a **tracker** move, so it fires only where `issueInReviewState`
is configured, which is Azure. On GitHub the verdict changes no dispatch at all. And on
either provider, for an issue with a plan: rule 4 is gated on
`routes.get(n)?.route === 'single'`, so a decomposed issue is never picked up; rule 4a
walks the plan and finds every part settled. The assessor says "not delivered" and the
harness schedules nothing, anywhere. This is the issue's real complaint and it is right.

**3. It cannot name what fell short**, so nothing could route it even if something read
it. The payload is one free-text summary.

So the fix is not "give the assessor a negative verdict". It is: **give the negative
verdict a shape that can be routed, an owner distinct from the working agent, and exactly
one consumer.**

## Decision 1 — the shape: a fresh `issue_shortfalls` table

Not a `verdict` column on `issue_deliveries`, and the reason is the issue's own point 4.

Every reader of `issue_deliveries` is a **gate**. `deliveryHold` is asked by rule 4's
filter and by `issuePickupStatus`, each pulse, and the row expires on world signal. A
negative verdict must gate nothing — releasing work is the whole point. Putting the two
polarities in one table means every present and future reader has to remember which one
it is holding, from a row that looks identical until you read a column. That is the
drift class this repo has already paid for twice (`proposalHold` vs `planProposalHold`,
detection-vs-stripping in the PTY scanner), and the fix both times was to keep the two
predicates apart rather than to give one a polarity flag.

The proposals-vs-escalations argument runs the same way and lands on separation:

| | `issue_deliveries` | `issue_shortfalls` |
| --- | --- | --- |
| read by | a gate, every pulse | one rule, until it is acted on |
| effect | holds pickup | releases work |
| ends on | world signal, tracker move, operator delete | the effect it drove taking place |

Different reader, different lifecycle, opposite polarity. That is a stronger case for a
second table than `issue_deliveries` had against `issue_conclusions`.

A fresh `CREATE TABLE` also needs no `ensureColumns` entry, which is a convenience rather
than a reason — but the columns it would otherwise have added to `issue_deliveries` would
be permanently null on every existing delivered row, with no way to tell "not a shortfall"
from "not yet caused", which is the argument the `proposals` table was created on.

```sql
-- The assessor's negative verdict: the issue was worked and the goal was not reached.
-- The mirror of issue_deliveries and deliberately not a column on it — that table's
-- every reader is a pickup gate, and this row gates nothing. One row per issue,
-- overwritten per assessment; mutually exclusive with a delivery, enforced in the store.
CREATE TABLE IF NOT EXISTS issue_shortfalls (
  origin_ref TEXT PRIMARY KEY,      -- "issue:12"
  cause      TEXT NOT NULL,         -- plan | part | goal
  part_slug  TEXT,                  -- the part that fell short; only for cause='part'
  summary    TEXT NOT NULL,
  by         TEXT NOT NULL,         -- assessor | operator
  agent_id   TEXT,
  task_id    TEXT,
  decided_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Mutual exclusion with `issue_deliveries` is in the store**, not in the callers, for the
reason the delivery/conclusion pair already gives: a caller that remembered one and forgot
the other would have the pickup gate hold an issue the shortfall rule was trying to
release.

## Decision 2 — the assessor names the cause, and all three are routed

The issue's point 2 is the load-bearing one: three distinct failures wear the same face,
and routing all three to a replan re-decomposes plans whose shape was never the problem.
So the cause is **declared, not derived** — the same discipline as `conclude_part`'s
`kind`, and for the same reason. Deriving "the plan was wrong" from the fact that a part
is missing would be the harness inferring a positive terminal from incidental output.

`assess_issue` grows `cause` and `part`, and keeps `status: 'more_work'` as the verdict:

| cause | means | arm |
| --- | --- | --- |
| `plan` | the decomposition was wrong — a part is missing, or the split was | **A** — replan |
| `part` | the split was right; the named part did not deliver its scope | **B** — a follow-up part |
| `goal` | the issue itself is wrong, ambiguous, or already obsolete | **C** — escalate only |

**Arm A — replan.** Accepting flips the plan to `planning`, which is the *entire* effect,
because rule 3c already routes a `planning` plan back to a planner with the `issue-replan`
prompt and `currentPlanSummary`, and `plannerVerdict` already narrows the cooldown to
decisions since `plan.updatedAt` so the original planner does not throttle it. This is
`releasePlan`'s pattern exactly: one status write, and the rule that was already there
starts working. The shortfall's summary is appended to the replan prompt — **appended,
never interpolated**, for the reason the rejection and outstanding-work notes are:
`issue-replan` is operator-overridable and `loadPromptTemplates` rejects only *unknown*
placeholders, so a new `{shortfall}` token would be silently dropped by exactly the
deployments that customised most.

Arm A is also what a `single` plan's shortfall routes to. Replanning a `single` verdict
re-runs the planner, which may now decompose it — which is the honest response to "one PR
was not enough".

**Arm B — a follow-up part, not a resurrection.** The tempting version is to return the
named part to `ready`. It is wrong, and `partHasWork` is the existing statement of why: a
`merged` part's PR is on the default branch and its branch is spent, so re-dispatching
onto it puts an agent on a branch whose PR is closed, and the issue's own acceptance
criterion forbids retiring parts that have work started. So the effect is **one new part
appended to the plan** — slug `<slug>-followup`, `dependsOn: []`, scope from the
assessor's summary, `expectedKind: 'code'` — through the same `upsertPlanParts` an
amendment uses. The merged part is left exactly as it is. Rule 4a schedules the new one
with no new dispatch path, and the plan moves `complete` → `active` by the roll-up it
already computes.

Routing arm B to a replan instead was considered and refused: it is precisely the issue's
stated failure mode, re-decomposing a plan whose shape was fine, and it would give the
surviving parts new slugs unless the planner happened to preserve them.

**Arm C — escalate, and nothing else.** A wrong goal is not the planner's problem and not
an agent's; #158 owns validating goal text, and this arm's job is to stop pretending
otherwise. It files an escalation carrying the summary, writes the shortfall row so the
cockpit says why the issue is stalled, and schedules nothing. Deduped on both an open
escalation for `issue:<n>:shortfall` and a recent executed one in the audit log — each
covers the other's blind spot, which is rule 1b's pattern.

**Validation is synchronous and plan-aware, which is the tool channel's whole point.**
The pure `validateAssessment` checks the vocabulary; `AgentManager.recordAssessment`
resolves the plan and refuses:

- `cause: 'part'` naming a slug that is not a live part of this issue's plan;
- `cause: 'part'` or `'plan'` on an issue with no plan — there is no decomposition to be
  wrong about, so the honest causes are `goal` or an ordinary `conclude_work`-shaped
  `more_work`;
- a missing `cause` on an issue that **has** a plan.

Each refusal names the alternative, the way `conclusionOrigin` and `partConclusionOrigin`
do. This is the `plan.json` lesson applied: a structured payload whose rejection the agent
never hears costs a whole agent to discover.

## Decision 3 — one consumer, and how rule 3b keeps working

The assessor **stops writing `issue_conclusions`**. That row belongs to the agent that did
the work, and the overwrite in gap 1 above is a bug regardless of this feature.

Rule 3b's Azure behaviour is preserved by **derivation, not by a second write** —
`planDerivedVerdict`'s pattern. `resolveIssueConclusion(stored, plan)` becomes
`resolveIssueConclusion(stored, plan, shortfall)`, with precedence:

1. the operator's toggle — unchanged, always wins;
2. **an open shortfall** → `more_work`, `by: 'assessor'`;
3. the agent's declaration;
4. the plan derivation;
5. `undeclared`.

The shortfall outranks the agent's own declaration because *the assessor is later and
better informed than the agent that declared its own work* — which is the sentence already
in `Store.recordDelivery`'s doc comment, applied consistently. One store record, one
resolver, and rule 3b needs no new arm.

## Decision 4 — the loop is bounded by machinery that already exists

Three bounds, and only the third is new.

**The human is the outer bound.** Every arm is a `Proposal` (decision 5), so the harness
never rewrites a plan on its own. That is the answer to "a plan rewritten every pulse
would churn `plan_parts`": nothing is rewritten without a click.

**The assessor's own attempt cap is the inner bound, and it already exists.** Rule 3e
dispatches on `assessOrigin(n)` = `issue:<n>:assess`, and `dispatchVerdict` applies the
cooldown and the 3-attempt cap to that origin — which was chosen deliberately so
assessments do not consume the pickup budget. So `assess → propose → replan → work →
assess` is bounded at three rounds by a cap already in the code, after which the origin
escalates instead of looping. Nothing new is needed and nothing new should be added: a
second counter claiming to bound the same loop is two answers to one question, which is
the argument that kept `urgent` a boolean rather than a rank.

**`partHasWork` is respected by never touching a started part.** Arm B appends; it does
not retire, resurrect or edit. The acceptance criterion is met by construction rather than
by a check, which is the stronger form.

## Decision 5 — the operator stays in the loop

A fourth `ProposalKind`, `shortfall`, ref `issue:<n>:shortfall`. It hangs off an
escalation like every other, `readProposedAct` learns a fourth act, and accepting runs
through `ActionExecutor.runAuthorized` — the one place an accepted proposal becomes both
its effect and its audit row.

Four things fall out of the existing machinery with no new code:

- **`proposalHold` applies unchanged, with all three arms correct.** `pending` holds
  because re-asking is the duplicate; `rejected` holds durably and expires on world signal
  — and `proposalWorldRef` already maps `issue:<n>:shortfall` → `issue:<n>` without a
  change, since it splits on `:` and takes the first two segments. `accepted`'s
  `SETTLE_WINDOW_MS` is right here too: a replan takes a pulse or two to show up as a
  `planning` plan, which is exactly the "waiting for the world to reflect it" case the
  window exists for.
- **It is *not* excluded from `rejectionSignalQuery`.** `plan` is excluded because
  `planProposalHold` never reads a rejected verdict; a shortfall does, so it must expire
  on signal or a refused replan would veto every future one — the phase-4 failure.
- **Rejection needs no effect of its own.** `refusePlan` exists because a plan is the only
  thing that schedules anything for a decomposed issue, so a bare "no" parks it. A
  shortfall gates nothing, so refusing one leaves the issue exactly where it was: the plan
  stays `complete`, pickup stays free. This is stated because the asymmetry with
  `proposalDesk.settlePlan` is real and will look like an omission otherwise.
- **`rejectionGuidance` reaches the right agent for free.** It matches on exact ref, and
  the ref is `issue:<n>:shortfall`, which is nobody's dispatch origin — so a refused
  shortfall deliberately reaches no agent, exactly as a refused merge does.

The cost the issue names — an inbox item per shortfall on a funnel meant to run unattended
— is real and bounded by the attempt cap above: at most three per issue, ever.

## Decision 6 — `deliveryHold` grows no polarity, and the test says so

The shortfall never enters `deliveryHold`. Its signature takes `IssueDelivery | null`,
which a shortfall is not, so "a negative verdict never holds pickup" is a **type-level**
property rather than a runtime one. `test/delivery.test.ts` asserts it both ways, the way
`test/planApproval.test.ts` asserts `proposalHold` and `planProposalHold` apart:

- structurally — `deliveryHold` and `deliverySignalQuery` name no shortfall type;
- behaviourally — an issue carrying an open shortfall and no delivery row is pickup-
  eligible, and `issuePickupStatus` reports it as eligible.

## Decision 7 — the cockpit

`/api/state` ships `shortfalls` beside `deliveries`. The per-issue row draws a chip from
it, beside — not inside — the `pickup` chip that renders `delivered`. Inside would be
wrong for decision 6's reason: `issuePickupStatus` answers "will this be picked up", and
a shortfall's answer to that is "yes, and that is the point". The chip names the cause,
quotes the summary, and quotes the pending proposal's id so the row and the "Needs you"
inbox join — which is `prAttention`'s `settled` arm's trick, paying the same one-item-in-
two-places cost for the same reason.

## Out of scope, stated

- `conclude_work` / `issue_conclusions` — untouched except that the assessor stops writing
  the table, which is the gap-1 bug fix and not a change to what a conclusion means.
- Defaulting `assessment.enabled` on.
- Validating goal text (#158). Arm C hands to it and does nothing itself.
- A `shortfall` work-graph node. Stage 1's property — nothing under `src/dispatcher/` may
  read the graph — is untouched, and adding a node kind is a separate, purely-additive
  change.
- Any new outbound capability. Every arm writes only to the store; the one thing that
  reaches the world is the escalation, which already exists.

## What ships

| | |
| --- | --- |
| store | `issue_shortfalls` (fresh table, no `ensureColumns`), `recordShortfall` / `listShortfalls` / `clearShortfall`, mutual exclusion with `issue_deliveries` |
| pure | `src/delivery/shortfall.ts` — the cause vocabulary, `shortfallProposalRef`, the arm resolver |
| tool | `assess_issue` gains `cause` + `part`; plan-aware refusals in `recordAssessment` |
| rule | `issue-shortfall` (3f) — proposes the arm the cause names |
| proposal | `ProposalKind: 'shortfall'`, a fourth `ProposedAct`, `runAuthorized` arm |
| resolver | `resolveIssueConclusion` gains the shortfall arm |
| cockpit | `shortfalls` on `/api/state`, a chip beside the pickup chip |
| tests | `test/issueShortfall.test.ts`; polarity assertions in `test/delivery.test.ts` |
| docs | `docs/spec/05-dispatcher.md`, `06-issue-pickup.md`, `11-mcp-tools.md`, `14-persistence.md`, and the delivery notes in `CLAUDE.md` |
