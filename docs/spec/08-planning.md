# 08 — The planning funnel

`src/plans/`. On by default (`planning.enabled: true`); off leaves the funnel out entirely:
every issue routes straight to `single`, rule `issue-pickup` is un-narrowed, no planner is ever dispatched, and
behaviour is exactly what it is without plans. Only the `rule` dispatcher implements it.

On, every watched open issue passes a planning agent before any implementation work — a real change in
what the fleet spends its slots on, which is why it is opt-in where `mcp` is opt-out.

## The four arms

`resolvePlanRoute(input)` in `src/plans/planning.ts` is **the one place** an issue's arm is decided.
Pure over the plan row plus the plan origin's cooldown verdict. Both the dispatcher (rules `issue-plan` and `issue-pickup`)
and `issuePickupStatus` read it, so the cockpit's chip can never disagree with what fires.

| Verdict                                              | Meaning                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{route:'single', failedOpen}`                       | Fall through to normal pickup. `failedOpen` marks the ones that got there because planning gave up.                                                                           |
| `{route:'parts'}`                                    | Decomposed; the part scheduler owns it and pickup stays off.                                                                                                                  |
| `{route:'awaiting_approval'}`                        | Decomposed, and the decomposition is a proposal a human has not answered. Pickup stays off exactly as for `parts`; rule `plan-part` queues the parts without dispatching any. |
| `{route:'planning', planner:'dispatch'\|'cooldown'}` | A planner is owed, now or after the gap.                                                                                                                                      |

Resolution order:

1. Planning disabled → `single`.
2. An `active` plan row with **no live parts** → `single`. That is the shape, and it is read off the
   part rows rather than off the status — see [Shape is the parts](#shape-is-the-parts).
3. A plan row with status `awaiting_approval` → `awaiting_approval`.
4. A plan row with any status other than `planning` (`active`, `complete`, `abandoned`) → `parts`.
5. Otherwise (no plan, or a plan back in `planning` — a replan in flight), the plan origin's cooldown
   verdict decides: `escalate`/`hold` → **fail open**; anything else → `planning`.

**Fail-open is load-bearing.** Narrowing pickup to `single` would turn any planner that crashes or
writes no plan into a permanently parked issue. Once the attempt cap is spent the issue falls open and
gets worked normally. Nothing escalates: the cap is the signal, and an issue that quietly keeps moving
beats one that quietly stops.

A **replan** fails back differently — to `parts`, not `single` — when `existingParts > 0`. An issue
that already has parts has a decomposition to fall back on, and `single` would point rule `issue-pickup` at the flat
`issue/<n>` branch git cannot create beside the existing part refs.

## Origins and branches

| Function                     | Result                                                     |
| ---------------------------- | ---------------------------------------------------------- |
| `issueOrigin(n)`             | `issue:<n>` — the `plans.origin_ref` key                   |
| `planOrigin(n)`              | `issue:<n>:plan`                                           |
| `planBranch(n)`              | `plan/issue/<n>`                                           |
| `partOrigin(n, slug)`        | `issue:<n>:part:<slug>`                                    |
| `partBranch(n, slug)`        | `issue/<n>/<slug>`                                         |
| `planOriginIssue(originRef)` | The issue number behind a **planner's** origin, else null  |
| `planIssueNumber(originRef)` | The issue number behind an `issue:<n>` plan ref, else null |

The planner branch namespace is deliberately separate. Git stores refs as files, so
`refs/heads/issue/12` and `refs/heads/issue/12/plan` cannot coexist — the second needs the first to be
a directory. A planner branch under `issue/<n>/…` would make the very pickup its `single` verdict
authorises impossible to branch for.

`planOriginIssue` is also the fence on plan ingestion via the file path: an ordinary pickup agent that
writes a `plan.json` is ignored, because flipping its own issue to `parts` would strand it while
nothing schedules parts.

## `plannerVerdict`

The plan origin's cooldown verdict, with one adjustment: while a plan row sits in `planning`, attempts
made **before** `plan.updatedAt` are not this replan's attempts. Without it, "Replan" on an
already-planned issue would be met with a 15-minute cooldown from the original planner (or an
already-spent cap) and the button would appear to do nothing. `planning` is only ever reached by an
explicit replan — ingestion writes `active` or `awaiting_approval` — so the narrowed window cannot loosen the
throttle on a first-time planner.

The boundary is **strict** (`>`, not `>=`): an attempt stamped in the same millisecond as
`plan.updatedAt` is the _previous_ planner's. The two writes are ordered by construction — the
dispatch decision is recorded by a cycle that ran before the operator asked, and `/replan` moves the
plan afterwards — so only the clock's millisecond resolution makes them look simultaneous. Reading
that tie as "this replan has already had an attempt" is exactly the dead button the window exists to
prevent; the cost the other way is at most one uncooled re-dispatch when a replan's _own_ planner is
dispatched inside the same millisecond as the request, and the origin gate already stops that being a
second concurrent planner.

## Rule `issue-plan` — the planner

Dispatches a **code** agent (it needs a worktree to read the repo) on `plan/issue/<n>`, origin
`issue:<n>:plan`, from the `issue-plan` template — or `issue-replan`, carrying `currentPlanSummary`,
when the plan row is back in `planning` — or `discuss-plan`, same origin and branch, when
`isPlanInDiscussion` says the plan is being discussed rather than merely replanned (below). Skipped
when an active task already holds the origin, which is what stops a discussion ever getting a second
planner. There is **no escalation arm**.

Whichever of the three templates it renders, `relatedWorkNote` is **appended** to it: the parent
feature's description, the sibling stories with their states, and the orphan flag with its candidate
features (see [06](06-issue-pickup.md#hierarchy)). Reading the related items is the planning step
that stops a decomposition re-cutting scope a sibling story already holds — a planner that cannot see
either side of the item it was handed will happily plan work someone else owns. Empty on a tracker
with no hierarchy, so the GitHub prompt is unchanged.

## The plan document

`src/plans/planDocument.ts`. One schema, two transports.

```json
{
  "version": 1,
  "verdict": "single" | "parts",
  "reason": "<one sentence>",
  "parts": [{ "slug": "schema", "title": "...", "scope": "src/store/...", "dependsOn": [] }]
}
```

Validation (`PlanDocumentSchema`, zod):

- `version` is literally `1`; `reason` is non-empty.
- On `single`, `parts` is ignored.
- On `parts`, at least one part is required.
- `slug` matches `^[a-z0-9][a-z0-9-]*$` and is unique within the document. It is the **merge key**: an
  amended plan merges on it, so it must survive a replan.
- `scope` (files/areas this part owns) is non-empty.
- `dependsOn` names **any number** of siblings, and arity is deliberately **not** constrained here.
  It was capped at one, as the static form of "a part may stack on at most one _open_ dependency" —
  but that cap refused something safe. A part naming several prerequisites is a **rejoin**: it starts
  only once all of them have settled, at which point _none_ is open and its base is unambiguously the
  integration branch. The dangerous case — two dependencies still in flight, with no single branch to
  cut from — is still refused, by `PlanReconciler.readiness` rather than here, because "open" is a
  thing only the scheduler can observe. See [The arity rule](#the-arity-rule-where-it-lives) below.
- A dependency must resolve to a declared slug and must not be the part itself.
- Dependency cycles are rejected (`findDependencyCycle`). A cycle would deadlock every part in it. The
  walk is depth-first over **every** edge, not down a single chain: while arity was capped at one a
  chain walk _was_ the whole graph, but the moment a part may name several a cycle reachable only
  through the second one (`a` → `[x, b]`, `b` → `[a]`) is one a chain walk cannot see.

`parsePlanDocument(raw)` parses JSON then validates; `validatePlanDocument(value)` validates an
already-decoded object. The `plan_submit` tool enters at the second, the file path at the first —
**both reach the same schema**, so the two transports accept and reject exactly the same documents.
The difference is only that the tool can hand the reason back instead of burning an attempt to
discover it.

### The five narrative fields

Five additive, **optional** fields, so a document from an older planner still validates and neither
transport changes shape:

| Field        | Level | What it is                                                   |
| ------------ | ----- | ------------------------------------------------------------ |
| `rationale`  | part  | Why this is its **own** PR rather than folded into a sibling |
| `acceptance` | part  | What makes this part done                                    |
| `risks`      | plan  | What could go wrong with this split                          |
| `outOfScope` | plan  | What the planner deliberately left out                       |
| `document`   | plan  | The full narrative, markdown — the read-in-depth version     |

**The narrative lives on the plan row, not in an artifact chip.** The obvious alternative — the
planner writes `docs/plan.md` and the file-events hook promotes it to a flag chip — is broken by a
lifetime the chip mechanism does not own: `GET /artifacts/:id` serves out of the agent's worktree, and
`system.ts` removes that worktree on a `done` reap. The planner finishes, the worktree goes, and the
write-up 404s at exactly the moment the plan is ready to approve. Storing it on the plan row makes it
outlive the planner, outlive a restart, and stay joined to the row it describes.

**`document` is expected, not merely permitted.** The `issue-plan` / `issue-replan` (and `discuss-plan`
— below) templates ask for it, and a plan without one renders "no write-up" in the plan modal rather
than hiding the tab — a hidden tab would read as "this planner had nothing to add", indistinguishable
from "this planner ignored the instruction". An over-long `document` is **trimmed and stored, with the
trim reported**, never refused: refusing would reject the whole plan submission over its prose, the
`note_progress` trade-off (cheap and frequent beats strict) rather than the `report_finding` one
(testimony, so refuse what cannot be attributed).

`plans` carries `risks`/`out_of_scope`/`document` and `plan_parts` carries `rationale`/`acceptance` —
see [14](14-persistence.md). `Store.upsertPlan` **preserves each on absence** rather than clearing it,
the same discipline it already applies to `statusCommentRef`: a caller updating only what it knows
about must not erase a narrative some other write put there.

### The two transports

- **`plan_submit`** (preferred) — the MCP tool. Validated synchronously, with the rejection reason
  returned so the planner can fix and resubmit in the same turn. Nothing is written on a rejection.
- **`.lubbdubb/plan.json`** — fully wired fallback. The file-events `PostToolUse` hook reports the
  written path; `AgentManager.ingestFileEvent` recognises the reserved path, and `ingestPlan` reads,
  validates and persists it. The read must happen **inside the drain**, while `agent.cwd` still
  exists — `src/system.ts` removes a done agent's worktree on the reap, so a later read finds nothing.
  An invalid document writes no plan row and records an error: the issue stays in the funnel, the
  planner is retried, and the cap eventually fails it open.

`.lubbdubb/` is gitignored, so the plan graph lives only in the store.

## Ingestion

`ingestPlanDocument(store, {doc, originRef, title, requireApproval})` in `src/plans/planIngest.ts` is
the **one** place a plan document becomes plan rows, so the file path and the tool path cannot drift
into two subtly different writes. `requireApproval` is `planning.requireApproval`, passed in by each
transport (`AgentManager` for the file path, `McpToolDeps` for the tool path) rather than read from a
config here, so ingestion stays store-only and neither transport can persist a verdict the other
would not.

The verdict is persisted for **both** outcomes — a single-PR plan is a first-class row with no parts.
Without one the planner would re-run on the same issue every cycle.

For an amendment:

1. `partsToRetire(existing, declaredSlugs)` — parts the new document drops are retired **only when
   nothing was started for them** (`partHasWork`: `dispatched`, `in_review` or `merged`). One with an
   agent, a branch or a PR is left exactly as it is. Retiring it would strand a PR the reconciler
   still folds reality onto, and a reviewer would have no idea the harness had written it off.
   Un-declaring in-flight work is a request to _stop_, which is a kill, not a plan edit.
2. `amendedPlanStatus(verdict, surviving, requireApproval)` — `active`, or `awaiting_approval` when
   approval is required. **Both verdicts are gated**, for the reason under
   [the approval gate](#the-approval-gate). The one arm that is never gated is the _overridden_
   `single` (`singleOverruled`) — parts are in flight, the collapse was refused, and there is no
   decision left in it. Which shape was ingested is not written at all: it is the surviving parts,
   read back by `planShape`.
3. `store.upsertPlan`, then retire, then `store.upsertPlanParts` (which merges on slug and never
   deletes).

An overridden `single` is reported rather than silently applied — asked of the parts
(`singleOverruled`), never of the status, since an honoured single verdict is `active` too:
`overriddenSingle` is returned, the
tool path tells the **agent** and records an operator-facing error, and the file path (which cannot
answer the agent) records the error alone.

## Plan parts

`src/plans/parts.ts` — all pure.

| Function                                                 | Answers                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bySlug(parts)`                                          | An index for the dependency walks.                                                                          |
| `dependenciesOf(part, index)`                            | The declared dependencies, in declared order, skipping slugs the index no longer holds.                     |
| `partDepth(part, index)`                                 | How deep in a stack — **longest path**, so a rejoin never sorts ahead of what it waits on. Cycle-guarded.   |
| `partSettled(part)`                                      | `merged` \| `concluded` — has this part reached a terminal. The one place that says so.                     |
| `partOutcomeKind(part)`                                  | `code` (derived from `merged`), the stored kind for `concluded`, else null.                                 |
| `dependencySatisfied(dep, pushed)`                       | `partSettled` unconditionally; `dispatched`/`in_review` only when the branch carries commits beyond base.   |
| `partBase(part, index, n, defaultBranch)`                | The one unsettled dependency's branch; the integration branch once all have settled or when there are none. |
| `liveParts(parts)`                                       | Everything not `retired`. **Every** count, roll-up, prompt and rule reads this.                             |
| `planProgress(parts)`                                    | `{settled, total}` over live parts.                                                                         |
| `partHasWork(part)`                                      | `dispatched` \| `in_review` \| `partSettled`.                                                               |
| `partOutcomeNote(part)`                                  | What a non-code part is told, appended to its rendered prompt. Empty for a code or unstated part.           |
| `partsToRetire(existing, declared)`                      | Which parts an amendment retires.                                                                           |
| `amendedPlanStatus(verdict, surviving, requireApproval)` | The status an ingested or amended plan resolves to.                                                         |
| `currentPlanSummary(plan, parts)`                        | The current plan rendered for a replanning agent — slug, status, PR/branch, dependency, scope.              |
| `siblingContext(parts, current)`                         | `{done, remaining}` for the part prompt.                                                                    |
| `observePartPr(part, branch, openPrs, closedPrs)`        | The pure core of PR observation (below).                                                                    |

`dependencySatisfied` is why `dispatched` is not enough on its own: a dispatched part's branch exists
the moment its worktree does, and basing on an empty branch gains nothing.

### The arity rule: where it lives

A part may declare any number of prerequisites, and exactly one rule governs what that means:

> Every dependency must be satisfied, **and at most one of them may still be unsettled.**

Both halves are enforced in one place, `PlanReconciler.readiness`, because both are readings of the
world rather than of the document. The second half is what the zod arity cap used to approximate: it
exists because `partBase` cuts this part's branch from the unsettled dependency, and with two in flight
there are two candidate branches and no way to choose between them.

What that buys is the **rejoin** — a part naming two prerequisites that ran in parallel lanes. It is
held `pending` while either is in flight, becomes `ready` once both have settled, and bases on the
integration branch, because by then there is nothing open to stack on. The chain is unchanged: one
dependency means the part starts as soon as that dependency has _pushed_ (not merged) and stacks on its
branch, which is the existing behaviour of every plan written before this.

Two consequences worth stating:

- **A chain costs exactly the git reads it always did.** Only an unsettled dependency is worth a
  shell-out — `dependencySatisfied` answers for a settled one without asking git — and after the
  at-most-one test there is at most one such dependency, so `readiness` makes at most one
  `hasCommitsBeyond` call per part either way.
- **`partBase` is never asked to choose.** Readiness holds the part `pending` in the only case where it
  would have to. If it somehow is asked, declared order decides rather than the function throwing: a
  base that is merely the wrong one of two is a rebase, where a throw takes the pulse's whole dispatch
  down with it.

`siblingContext` splits by whether the work exists yet, because the halves mean different things to
the agent: `done` is code it may find on its branch and must not redo, `remaining` is work explicitly
not its to do.

### Statuses

`pending` → `ready` → `dispatched` → `in_review` → `merged`, plus `concluded`, `blocked` and
`retired`. Retiring is a status transition, not a disappearance: the row stays so the graph remains
readable after a replan, and nothing schedules it again.

### Terminals that are not a merge

`merged` is the terminal for a part that ends in a pull request. `concluded` is the terminal for one
that does not: it produced a **report** (a write-up, a measurement, a document) or reached a
**determination** (nothing needs building — it is already done, it duplicates other work, or the
premise was wrong). Both are terminals, and everything that means _finished_ asks `partSettled` rather
than comparing to `merged`, so those sites cannot drift into disagreeing.

Without this a plan could only contain work the planner could imagine merging, and — the expensive
half — one no-code part parked the whole issue: it stayed `dispatched`, `liveParts` never emptied, the
roll-up never reached `complete`, and rule `work-item-in-review` held the work item in the review state for the life of
the plan.

### A step for a person

`expectedKind` has a fourth value, `human`, and it is the only one no agent ever produces: the part is
work a person does by hand — flipping a setting in a console nobody gave the fleet an account for,
plugging something in, looking at a rendered screen. Ingestion backs each declared human part with a
`human_tasks` row keyed on `part_id`; the part is the scheduling node and the row is the work item.
→ [13](13-jobs-and-findings.md#human-tasks)

**No new blocking machinery was needed, and that is the argument for this shape.** A part is already
the only node the harness knows how to make other work wait on, so a human step reuses every property
`dependsOn` and `PlanReconciler.readiness` already have:

- Rule `plan-part` produces no candidate for one (`partIsHuman`), so it is never dispatched.
- It has no branch, so `dependencySatisfied` is false for anything naming it until it is
  `partSettled` — its dependents stay `pending` with no code added anywhere.
- The operator marking its task **done** writes `concluded` with `outcomeKind: 'human'`
  (`Store.concludeHumanPart`), and readiness releases the dependents on the next pulse.

`concludeHumanPart` is its own write rather than a widened `concludePlanPart`, and the guards are
opposites: that one insists the part was `dispatched` or `in_review`, which is exactly right for a
part an agent worked and exactly wrong here, since a human part is never dispatched at all and
settles from `pending`, `ready` or `blocked`. Widening the other guard would have let an agent
conclude a part nobody had started.

`conclude_part` refuses `human` for the reason it refuses `code`: only the operator settles a step a
person owns, and an agent handed `{ok: true}` would believe it had closed something.

A human part may itself declare `dependsOn` — "do this by hand once the schema part merges" — and
readiness then decides when the ask becomes actionable, exactly as it does for a code part.

#### Declining one blocks the part rather than concluding it

`PlanReconciler` reads the backing rows once per plan and writes a part whose task is `declined` to
`blocked`, with `declinedStepReason` on the row. **Not `concluded`**: concluding it would make
`partSettled` answer true and release every dependent waiting on the thing that was refused — a plan
completing on work nobody did. The dependents stay `pending`, the goal page draws the part under
**Held** with the reason on it, and the ways out are the two on the plan modal — Replan, or
[abandon the decomposition](#when-the-collision-arrives-after-approval). Nothing escalates: the
operator is the one who declined, and both buttons are in front of them.

That makes a declined step the **second** thing that can block a part, beside the ref collision. The
readiness pass is still not one of them — it answers `pending` or `ready` and never `blocked` — and
each blocking reading states its own reason from its own pure function, so a part is never left
claiming a collision that has been resolved or a refusal that was withdrawn.

`concluded` is **not** a kind of retirement. `retired` means "dropped by an amendment before anything
was started", which `partHasWork` enforces; a concluded part did its work and found there was nothing
to build, and collapsing the two would discard the provenance of what it found.

`partOutcomeKindOf` (`src/store/plans.ts`) is the row mapper's narrowing of those columns, and **a new
kind must be added to it**. It is not a type guard the compiler checks against the union, so a kind
missing from it is written to SQLite, read back as `null`, and reads as `code` everywhere downstream
— which for `human` means a step for a person handed to an agent, silently.

Four columns carry it on `plan_parts`, each with an `ensureColumns` entry (`CREATE TABLE IF NOT
EXISTS` never alters an existing table, so a column without one is invisible on every older database):
`expected_kind` (the planner's declaration; null means unstated, which reads as `code`),
`outcome_kind`, `outcome_ref` (optional, `flag:<id>` or `finding:<id>`) and `outcome_summary`.

A merged part's actual kind is **derived, never stored** — `partOutcomeKind` returns `code` for
`merged`. Storing it too would put a second answer inside `observePartPr`'s path, one more thing the
PR fold could get wrong for no gain.

**The agent declares it; the reconciler does not derive it.** Deriving a terminal from an artifact or
a finding recorded against the part's origin would infer a positive terminal from incidental output —
the thing the harness refuses everywhere else (`undeclared` kept distinct from `more_work`, the DONE
sentinel from the `result` event). A code part that wrote a design note and died before opening its PR
would close as a report, silently completing a plan on work that never happened. Declaration's failure
mode is far cheaper: `foldStalled` returns a `dispatched` part whose agent is gone to `ready`, it is
re-dispatched, and the attempt cap escalates — a visible loop ending at a human.

**Stacking degrades, with one guard.** `partBase` returns the default branch for a `concluded`
dependency, because such a part may never have pushed a branch at all and basing on it would hand
`WorktreeManager.ensure` an unresolvable ref. `basePrOf` and `isStackedPr` are reached only through a
`pr_number`, so they degrade with no guard.

**Dispatch is unchanged.** A part expected to produce a report still gets a code agent, a worktree and
a branch — it has to read the repository. The branch simply never carries a PR, so origin and branch
stay 1:1 and no new dispatch arm exists. `partOutcomeNote` is **appended** to the rendered `plan-part`
prompt rather than filled into it: templates are operator-overridable and `loadPromptTemplates` rejects
only _unknown_ placeholders, so a `{kind}` token would be silently dropped by exactly the deployments
that customised most — and this is the instruction without which the part cannot finish.

The `conclude_part` tool is where an agent casts it; see [11](11-mcp-tools.md).

## Rule `plan-part` — scheduling parts

For each plan with status `active` — or `awaiting_approval`, which dispatches nothing (below) —
whose issue is open and passes `issueWatchGateReason`:

- Parts are read from `ctx.plans`/`ctx.planParts` **directly, not from `eligibleIssues`**. That list
  gates on the issue having no open PR, and a part's PR is exactly what makes the parent look taken.
- Only the **watch/ignore tag** is applied, evaluated once on the parent. Not the workflow-state gate
  — rule `work-item-in-review` parks a decomposed item in the review state for the life of the plan.
- `inFlight` counts **live tasks** on part origins, not the `dispatched` status, so a part whose agent
  died is not occupying a slot. `room = maxConcurrentPartsPerIssue - inFlight`.
- Ready, unstaffed parts are ordered by dependency depth, then `seq`.
- Per part: a `hold` verdict is skipped entirely (it must not eat a slot a sibling could use — that is
  how one stuck part would stall a whole plan); an `escalate` verdict emits `escalate_to_human` from
  `plan-part-escalation`; beyond `room` the part is queued as **`capped`** rather than skipped, so the
  limit is visible instead of looking like nothing happened.
- For an `awaiting_approval` plan every ready part is queued **`unapproved`** and nothing else: the
  cooldown and attempt-cap arms are skipped, because they would answer "why did this part not get an
  agent" with the wrong reason. Skipping the plan outright would make an unapproved decomposition
  look exactly like an idle fleet — the invisibility `capped` is named to fix.
- Candidates from all plans are then sorted by depth, issue number, `seq` and appended to the ranked
  list.

The emitted `dispatch_code_agent` carries `base` (from `partBase`) and `partId`. The executor passes
`base` to `WorktreeManager.ensure` and calls `Store.markPartDispatched` **only after** the agent
actually spawns, so a held dispatch leaves the part `ready`.

## The approval gate

`planning.requireApproval`, **on by default** (`src/config.ts` and `DEFAULT_PLANNING` in
`src/plans/planning.ts` agree). On, a planner's verdict is a **proposal** before it is work (issue
#109 phase 3) — **either verdict**. Off, an enabled funnel behaves byte-for-byte as it did before
phase 3 existed, on both arms: the verdict commits the moment the planner writes it, and no proposal
row is written for anyone.

**Both arms, because both are verdicts about shape.** The gate started on the `parts` arm alone, on
the reasoning that a `single` verdict proposes nothing — it is the path the funnel already falls open
to. That was wrong in the one direction that matters: it made the _commonest_ route the one with no
acceptance step in it. A planner deciding an issue is one pull request has decided something an
operator may well disagree with (it is the same decision, differently answered), and "nothing is
scheduled until you approve" was the whole promise of the gate. So a `single` verdict lands
`awaiting_approval` too, is put to the operator by rule `plan-approval` exactly as a decomposition is,
and rule `issue-pickup` starts nothing until it is released.

**One `single` arm is never gated, at either setting**: the verdict the harness _overruled_. When live
parts already carry a branch or a PR, `singleOverruled` is true, `amendedPlanStatus` keeps the plan
`active` ungated, and the caller says so out loud (`overriddenSingle`) — the collapse was refused, so
there is no decision left in it, and asking a human to approve a verdict that will not be honoured
would be a question with no answer. That is also why `overriddenSingle` keys on the **parts** rather
than on the status: an honoured single verdict is `active` too, and `awaiting_approval` is the verdict
honoured and waiting, not overridden.

**The default changes nothing for a deployment that has not turned the funnel on**, because
`planning.enabled` is still `false` by default — this only decides what happens once an operator
enables it, which is the honest place for the safe default: the thing being defaulted is whether a
decomposition into N branches and N agents starts itself the moment a planner writes it.
Both polarities are asserted, and separately: `test/planApproval.test.ts` asserts the default **does**
write a proposal — on each arm, and that accepting it releases the arm's own status — while
`test/planPart.test.ts` pins `requireApproval: false` and asserts that path writes none. So the two
default sites (`config.ts`, `DEFAULT_PLANNING`) cannot drift apart unnoticed.

**The gate is the plan's status.** Ingestion persists the verdict as `awaiting_approval` instead of
`active`; releasing writes `active` on **either** arm, and that is the whole effect, because
`awaiting_approval` is the released status with the gate closed. Rule `plan-part`'s question — "is
this plan released" — is therefore the status check it already had, and a superseded verdict
structurally cannot release a new one, because a replan resets the row.

### Shape is the parts

Which arm a released plan is on is **read off its parts, never stored** — `planShape(parts)` in
`src/plans/parts.ts`. A `parts` verdict always declares at least one part (`planDocument` refuses an
empty one) and ingestion writes them before the gate closes, while a `single` verdict retires every
part nothing was started for. So **no live parts _is_ the single arm**, and a verdict column on the
row would be a second answer to a question the parts already answer.

It was a `single` plan **status** until it was not, and the reason it moved is worth stating: shape
and life are independent, and a status cannot hold both. A plan being delivered as one pull request is
still being delivered — but `single` sat in the same field as `active`, so every consumer that
switched on status had to know about the shape, and the one that forgot was silent. `PlanReconciler`
lists `active`, `complete` and `awaiting_approval`; a `single` plan was in none of them, so it was
never reconciled and **never wrote its status comment** — an issue worked whole told the tracker
nothing at all, with no error anywhere. `absorbSinglePlanStatus` (`src/store/plans.ts`) carries those
rows into `active` on boot.

The consumers that ask the shape rather than the status: `resolvePlanRoute` (arm 2 above),
`PlanReconciler.reconcilePlan` (the partless arm writes the status comment and folds nothing),
`planInFlightVerdict` in `src/issueConclusion.ts` (a single-PR plan is _not_ in flight — its agent's
declaration is what speaks), `abandonDecomposition` (a plan with no parts has nothing to collapse),
and the cockpit's furnace and plan cards.

| Step                 | What happens                                                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict lands        | `amendedPlanStatus(…, requireApproval)` → `awaiting_approval`, on either arm. Parts are written normally: the gate holds scheduling, not the record of the verdict.                                                                                |
| Rule `plan-approval` | Emits `propose_plan` for an `awaiting_approval` plan whose issue is open and watched, unless `planProposalHold` finds a pending one. Read off `ctx.plans`, not `eligibleIssues` — a replan of a live plan is re-approved while its parts have PRs. |
| The executor         | Creates an `approve_change` escalation plus a `plan` proposal with ref `issue:<n>:plan`, and re-asks the same hold (every path that reaches the executor is covered, not just the one that checks first).                                          |
| Accept               | `ProposalDesk.accept` → `ActionExecutor.runAuthorized` → `releasePlan`: the plan becomes `active` (a decomposition) or `single` (one pull request), audited under `human:<proposal id>` as `authorized by you`.                                    |
| Reject               | `ProposalDesk.reject` → `refusePlan`, carrying the operator's note.                                                                                                                                                                                |
| Replan               | `POST /api/plans/:id/replan` withdraws a pending proposal (below).                                                                                                                                                                                 |

**What the ask says** is one template and two appended paragraphs. `plan-approval` is rendered with
`{parts}` — the pull requests the plan produces, `1` on a single verdict — and `{list}`, which is
`describeProposedParts` for a decomposition and `describeSingleRoute` for a single verdict (naming the
`issue/<n>` branch, because a branch that already exists is what the other warnings on this ask are
about). What approving and rejecting _this_ verdict do is then **appended** by `planApprovalNote`,
never interpolated: the template is operator-overridable and `loadPromptTemplates` rejects only
_unknown_ placeholders, so an `{arm}` token would be silently dropped by exactly the deployments that
customised most — and the two arms settle differently enough that a reader given the wrong paragraph
would answer the wrong question. The built-in template is arm-neutral for the same reason: an override
written before the single arm existed still frames the question correctly, and the appended paragraph
completes it. `planApprovalWarnings` appends after that, unchanged.

`planProposalHold(ref, proposals)` in `src/proposals/proposals.ts` holds on **`pending` only**, unlike
`proposalHold`. A merge is proposed off world state that persists, so it needs a durable "no" and a
settle window; a plan proposal is made once per **verdict**, and both verdicts rewrite the row the gate
reads. A holding `rejected` would let one refusal veto every future decomposition (only an operator's
replan can bring the question back); an expiring `accepted` would re-propose a decomposition whose
agents are already running.

It follows that **phase 4's signal expiry stops here**, and could not have been inherited: it ends a
rejected hold, and this predicate never applies one — the signature says so, since it takes no signals
at all. It would also read the wrong thing if it did. The transitions on `issue:<n>` are its comments
and its links, none of which say anything about whether a decomposition is the right _shape_, while the
row that **is** that verdict is rewritten by both settlements. `test/planApproval.test.ts` asserts the
polarity in both predicates rather than trusting the two to stay apart.

**Rejection has an effect of its own**, because a bare "no" would park the issue: once the funnel is
on, a plan is the only thing that schedules work for a planned issue (rule `work-item-in-review` parks the work item in
the review state for the life of the plan, and `resolvePlanRoute` fails a spent replan back to `parts`).
`refusePlan` (`src/plans/planApproval.ts`) therefore leaves the issue a **route**, and which route
depends on the arm it is refusing.

A refused **decomposition** retires every part `partHasWork` says nothing was started for, then writes
`amendedPlanStatus('single', survivors)` — `active` either way, with the survivors deciding what that
means:

- **no survivors** — nothing was in flight, so the shape is now single and the issue falls back to
  being worked as one PR by rule `issue-pickup`.
- **survivors** — parts are in flight, which means a _replan_ is being refused: the work already
  running carries on and the amendment's new parts are the ones retired. Collapsing here is impossible
  anyway, since git cannot create the flat `issue/<n>` branch beside the existing part refs.

A refused **single** verdict (no live parts) is the arm with nowhere to fall: the single-PR route is
what a refused decomposition falls _back_ to, so releasing it here would perform the very thing the
operator declined, and `abandoned` would park the issue. "Not as one pull request" is a question
only a planner can answer again — so the plan goes to **`planning`** with the operator's note appended
to `plan.reason`, which is the same one status write `POST /api/plans/:id/replan` makes, and rule
`issue-plan` dispatches a replan from it on the next pulse. The note is not decoration: a planner shown
only "declined" has no reason to decide differently to the way it just decided. It cannot loop — the
planner's attempt cap ends it, and a spent cap fails the issue open to `single` and gets it worked,
which is the funnel's existing answer to a planner that cannot settle.

An operator who wants a _different_ plan can also press Replan, which is on the same panel.

**Both settlements are compare-and-set against `awaiting_approval`**, the same discipline as
`Store.decideProposal`'s against `pending`: a verdict arriving after the plan moved on — an operator
who hit Replan with the card still open — releases and refuses nothing, and is audited as such.

Two consequences elsewhere:

- Reconciliation **runs** for an `awaiting_approval` plan (readiness is what makes the held parts
  visible in the queue, and a replan's in-flight parts must keep being folded) but does **not** write
  the tracker status comment for one: an unapproved decomposition announces nothing, and a refusal
  would otherwise leave that announcement standing.
- `QueueItem.status` gained **`unapproved`**, for the reason `capped` exists.

## Reconciliation

`src/plans/planReconciler.ts` runs each pulse, next to `worldDiff` and **before** `decide`. The store
holds intent; the outside world stays the source of truth. Tracking that only records what LubbDubb
meant to do goes fictional within a day — a human merges a part by hand, or closes its PR, and the
store still says `dispatched`.

Two sources, good at different things:

- **Git** (`GitObserver`) for branch reality. It is the only source that sees a branch before a PR
  exists, and `hasCommitsBeyond` _is_ "has the dependency actually pushed". It cannot see a merge:
  `merge_pr` squashes, and a squash-merged branch has no ancestry link to its base.
- **The provider**, from the world snapshot, for PR and merge state.

It returns immediately when planning is disabled (including for a stale database) or when no plan is
`active`/`complete` — so it never pays for a fetch it does not need.

### `git fetch`

`fetchRemote(repoRoot)` (`git fetch --prune origin`) runs on the pulse, floored by
`planning.gitFetchIntervalMs`. It is wired **only for the real observer**: the `GitObserver` seam is
fetch-free by design, so refreshing the remote is the caller's half of the split. Tests injecting
`FakeGitObserver` via `buildSystem`'s `gitObserver` option get no fetch at all. A fetch failure is
recorded **once per distinct message**, so a repo with no `origin` does not fill the Errors panel with
the same line every pulse.

### The folds

Per part, in order, first non-null wins:

1. **`foldPr`** → `observePartPr`, which orders its readings deliberately:
   - An **open PR on the branch** → `in_review` (or `merged` if the row says so).
   - A **merged PR** in the closed window, matched by branch _or_ number. Merged is terminal and
     idempotent, so the looser match is safe and catches a part whose PR opened and merged between two
     pulses.
   - A **closed-unmerged PR**, matched by **`prNumber` only**, and only when the part was tracking
     that number → back to `ready` with `prNumber` cleared. Matching by branch here would be a trap: a
     dead PR sits in the retention window for hours, so the part would be yanked back to `ready` every
     pulse, including after it was re-dispatched. Clearing the number is what makes the transition
     fire exactly once.
   - **Absence** — the pre-existing inference, and still the fallback: a part that _was_ `in_review`
     whose PR is in neither list merged, out of sight. It has to stay, or a PR that merged before the
     retention window would read as un-merged and reopen days of finished work. The observed signals
     replace the inference only _inside_ the window.
2. **`foldStalled`** — a `dispatched` part whose task is no longer active goes back to `ready`, and is
   re-dispatched through the per-part origin's cooldown and attempt cap.

Then readiness: for parts in `pending`/`ready`/`blocked`, `ready` once every dependency has pushed a
branch worth stacking on **and at most one of them is still unsettled**, else `pending` — see
[The arity rule](#the-arity-rule-where-it-lives), which lives here and nowhere else. Readiness is
computed against a **working copy** with this pulse's observations already applied, so a dependency that
merged this cycle unblocks its dependent in the same cycle — which is also what releases a rejoin the
moment its last prerequisite merges.

Retired parts are skipped entirely — there is no reality to fold on, and nothing should quietly bring
them back.

**Concluded parts are skipped too, for the opposite reason, and this is where the fold genuinely
differs by kind.** The reconciler is built on "the store holds intent, the outside world is the source
of truth" — but a report and a determination have no outside world: the record was durable in the
store the moment the agent wrote it. The only thing the fold could do to such a part is undo it, which
is exactly what a stray push or a PR opened on its branch would otherwise achieve.

### The ref-collision guard

`refs/heads/issue/12` and `refs/heads/issue/12/<slug>` cannot coexist. An issue worked as `single`
first and then replanned to `parts` has exactly that branch, and every part branch would fail to
create with a git error nobody can act on. The reconciler checks `git presence(issue/<n>)`; if the
flat branch exists locally or remotely, every uncut part is parked `blocked` and **one** clear error is
recorded naming the branch to delete or rename.

The wording is `refCollisionReason(issueNumber)` (`src/plans/planReconciler.ts`, pure) and it is
written in **two places from that one function**: the error above, and `plan_parts.blocked_reason` on
each part it parks. This is the only thing that blocks a part — the readiness pass answers `pending`
or `ready` and never `blocked` — so the stored string is a complete account of the status, and it is
cleared with the status when the branch goes away, so a part never claims a collision that has been
resolved.

**Why both.** The error is recorded only on the pulse a part _flips_, which is the honest shape for a
feed — a feed carries news, and a line per pulse for a standing condition is how a feed stops being
read. But it means a plan blocked yesterday explains itself to nobody today, and to nobody at all
across a restart. So the feed keeps the news and the reason moves onto the row beside the status it
explains, where the [goal page](17-cockpit.md#the-plan) quotes it verbatim on the held part. That was the other half of the gap: a blocked part is never queued, so the queue's held-reason
plate could not speak for it and it had no pull request to be read for one — it drew a red word and
no reason anywhere.

### When the collision arrives after approval

An issue worked `single` first, replanned, and then **approved** onto its own taken branch is the bad
case: the parts block instantly, and every exit is closed. `refusePlan` compare-and-sets against
`awaiting_approval` — correctly, since refusing is a verdict on a question you have not yet answered
— so the fall-back-to-`single` arm is gone the moment the decomposition is released; and
`resolvePlanRoute` fails a spent replan back to `parts`, never open to `single`. The plan sits there,
nothing is dispatched, and nothing says so. Three things close it, kept separate because they are
three different jobs (`src/plans/planWedge.ts`):

- **Noticing** — `planIsWedged(parts)`: every _live_ part blocked, not any. The collision blocks them
  together or not at all, so a mixture is a plan still making progress. [Rule `plan-blocked`](05-dispatcher.md#the-rules-in-evaluation-order) escalates it once, deduped on an open
  escalation for `issue:<n>:plan` **and** a recent executed one, exactly as rule `pr-ci-blocked` is. No agent is
  dispatched, because none could help. Only `active` plans: an unapproved one is already in front of
  a human, with the same fact in the ask.
- **Warning first** — `planApprovalWarnings(issue, parts, openPrs)` is **appended** to rule `plan-approval`'s ask
  (never interpolated, for `ciFailureNote`'s reason) and names both the blocked parts and any open PR
  for the issue that no part claims. It **warns and does not block**: refusing to approve would put a
  git fact in front of a judgement about _shape_, the branch is one command from being gone, and the
  operator's only exit would become the opposite verdict to the one they were giving.
- **A way out** — `abandonDecomposition` (`planApproval.ts`, `POST /api/plans/:id/abandon`) retires
  the parts, which **is** the collapse to one pull request — the shape is the live part list, so there
  is no second status write that could disagree with it, and a plan that already has no parts is
  refused rather than answered `ok` for retiring nothing. A separate act rather than a loosened `refusePlan`
  guard because it is a different sentence: refusing says _I will not authorize this_, abandoning says
  _I authorized it, it cannot run, work the issue whole instead_. The bar is `partHasWork`, so nothing
  with an agent, a branch or a PR behind it is retired — which is also what makes the collapse safe,
  since a part that never pushed has no branch to strand and the flat `issue/<n>` branch is exactly
  the one rule `issue-pickup` now wants.

**Nothing attaches the existing pull request to a part.** The single-arm PR claims to resolve the
whole issue — the claim the decomposition overruled — so nothing knows which part, if any, it
satisfies. Deriving it would infer a positive terminal from incidental evidence, refused everywhere
else in the harness. It is named to the operator and left alone.

### The status comment

Each plan owns exactly **one** living comment on its issue, via
`IssueCommentCapable.upsertIssueComment` and `plans.status_comment_ref`, edited in place. It is written
when there is news: the plan appearing (no comment yet), a part moving, or the plan rolling up. Because
it is one comment rather than a stream, it is mechanical bookkeeping rather than authored prose, which
is why it is **not** auto-send gated. A failure to write it is recorded and the pulse continues —
progress reporting never takes the pulse down with it.

It is also the one act the plan path performs against the world without asking anyone, so the operator
has to be able to read it: `/api/state` ships `plan.statusCommentRef` as a **canonical comment ref**
(see [15](15-integrations.md#comment-refs)) rather than the store's provider id, resolved through
`buildRefUrls` like every other link. Not auto-send gating it and keeping it to one comment are both
right, and both rest on it being visible — which, until #171, it was not except by opening the
tracker. Absent (no comment written yet) and unresolvable (a provider that builds no URLs) both reach
the cockpit as silence rather than as a link to nowhere.

**Both shapes write one.** A decomposition renders its part rows; the single-PR arm has none, and
renders the shape and the planner's reason instead — "one pull request, this issue is being delivered
whole, not decomposed". Rendering that arm through the part count said "0/0 parts done", a progress
report on work that was never split. It is the arm that wrote **nothing at all** until the shape came
out of the status: a `single` plan was in none of the statuses `PlanReconciler.reconcile` lists, so it
was never reconciled, and an issue worked whole told its tracker nothing — silently, since there was
no failure to record.

The partless arm has no observed news to gate on (its body is the verdict, which only a replan
changes), so the **body itself** is the signal: `writeStatusComment` memoises the last body sent per
plan and sends only on a difference. Memoised rather than stored — a restart costs one idempotent
edit, and a column would be a copy of the comment there is already a ref to. Nothing is written while
a plan is `awaiting_approval`, on either shape: an unapproved verdict has no progress to report, and
posting one would announce a commitment on the tracker that the operator has not made.

`Store.rollUpPlanStatus` moves a plan to `complete` when every live part is `merged`. A partless plan
is never touched by it: what finishes the single-PR arm is the issue's own delivery, which the plan
does not own.

## Replan

`POST /api/plans/:id/replan` flips the plan row to `planning`, clears `discussing` if it was set,
withdraws any pending plan proposal, and kicks a cycle. That is all it does.

Clearing `discussing` is not optional when a replan is requested mid-conversation: the flag is what
picks the template rule `issue-plan` renders from `planning`, so leaving it set would render `discuss-plan` on
the next dispatch instead of the `issue-replan` this call actually asked for — the two routes would
disagree about what plain `planning` means. The route is **not** gated on `discussing` — it is
callable throughout, and the cockpit's plan modal gives a running discussion its own footer — so
clearing the flag has to be the route's own job rather than a caller's.

The withdrawal is not optional under `requireApproval`: a pending verdict holds rule `plan-approval` off the plan,
so the amended decomposition would never be put to anyone — and the stale card, if accepted, would
release a decomposition its reader never saw. It routes through the ordinary `ProposalDesk.reject`,
which is safe precisely because the status write above already moved the plan, so `refusePlan` finds
nothing to settle and the withdrawal is only the inbox item closing.

**Nothing is torn down.** Every part row is left exactly as it is: agents keep running, branches stay,
open PRs stay open. What an amended plan does to them is decided at ingestion, where the planner's new
declaration is actually known. Until that lands, the existing plan keeps scheduling — a replan that
fails or is never picked up leaves the issue exactly where it was, not parked.

Three things make replan work rather than merely fire:

1. `plannerVerdict` narrows the cooldown window to decisions since `plan.updatedAt`.
2. `resolvePlanRoute` fails a spent replan back to `parts`, not open to `single`.
3. Ingestion does the amendment (and, under `requireApproval`, asks again — an amended verdict is a
   new proposal): `partsToRetire` respects started work, and `amendedPlanStatus`
   refuses to collapse to `single` while any part has a branch or a PR, recording an error rather than
   overriding the planner silently.

## Discussing a plan

**Discuss is a replan with a conversational planner**, not a new mechanism — framing it that way is
what lets it inherit every safety property already argued for above rather than earning parallel ones.

`isPlanInDiscussion(plan)` (`src/plans/planDiscussion.ts`, pure) is the one predicate that tells a
discussion apart from an ordinary replan: both put the plan row in `planning`, which is the whole
mechanism rule `issue-plan` already dispatches a planner from. `discussing` (new `plans` column) only picks the
prompt.

`POST /api/plans/:id/discuss`:

1. 404 when the plan is unknown.
2. **409 unless `plan.status === 'awaiting_approval'`.** Every framing of Discuss — the design, this
   section, the `discuss-plan` prompt itself ("before approving it") — only ever contemplates talking
   through a decomposition that is still a pending question. Without the guard, discussing a `single`
   plan and then ending the discussion writes `awaiting_approval` over zero parts: rule `plan-approval` proposes it,
   an operator approves an empty decomposition, `resolvePlanRoute` now returns `parts` instead of
   `single`, and the issue is parked with no ready part, no agent and no chip explaining why. Discussing
   an already-`active` plan is the milder version of the same mistake — it reopens the gate rule `plan-part`
   already cleared and stops scheduling the remaining parts, which is exactly the harm `/discuss/end`'s
   own 409 (below) exists to prevent on the way back out. `PlanModal.tsx` hides the Discuss button
   outside `awaiting_approval` so the UI cannot offer what the route refuses.
3. `store.setPlanStatus(id, 'planning')` — exactly what `/replan` does.
4. `store.setPlanDiscussing(id, true)`.
5. Withdraw any pending plan proposal (`ProposalDesk.reject`, "superseded by a discussion"). Safe for
   the reason the replan withdrawal is safe: the status write lands first, so `refusePlan` finds the
   plan no longer `awaiting_approval` and no-ops — the withdrawal only closes the inbox item. And
   **necessary**: a pending proposal holds rule `plan-approval` (`planProposalHold`), so the amended decomposition
   would never be put to anyone, and the stale card, if accepted, would release a plan its reader never
   saw.
6. Broadcast, run a cycle.

Returns `{ ok: true, plan }`.

Rule `issue-plan` renders the `discuss-plan` template instead of `issue-replan` when `discussing` is set — same
origin (`issue:<n>:plan`), same branch (`plan/issue/<n>`), same cooldown window, same attempt cap, same
fail-open. `discuss-plan` is an ordinary overridable entry in the template book and tells the agent:
this is a conversation, not a fresh decomposition; here is the current plan and its part states; use
`escalate` to ask and answer; call `plan_submit` with the amended document once the operator is
satisfied; then finish.

**Nothing is scheduled while you talk**, and each property is an existing gate rather than a new one:

- rule `plan-part` schedules parts only for `active` / `awaiting_approval` plans — `planning` schedules none;
- rule `issue-plan` cannot dispatch a second planner while the discussion agent holds `issue:<n>:plan`
  (`findActiveTaskByOrigin`);
- rule `plan-approval` proposes only for `awaiting_approval`, so no fresh approval card appears mid-conversation.

**The conversation needs no new transport.** The agent parks with `escalate`; replies go through
`POST /api/agents/:id/respond`, which works on any live agent and drives another turn on the default
stream runtime; the transcript comes from `GET /api/agents/:id/transcript`. The plan modal's discussion
pane is those two calls plus a link to the real drawer for tool calls.

**Three endings:**

- **It amends.** `plan_submit` → `ingestPlanDocument` clears `discussing` as part of ingestion (not
  `upsertPlan` — folding the clear into ingestion is what stops an amendment silently re-opening a
  discussion it did not ask to close) and lands `awaiting_approval`, so the next pulse's rule `plan-approval` puts a
  **fresh** proposal up. The stale card was withdrawn at step 4 above, so nothing holds it.
- **You end it.** `POST /api/plans/:id/discuss/end` — 404 when the plan is unknown, **409 when
  `plan.discussing` is false** (the same compare-and-set discipline `releasePlan`/`refusePlan` apply to
  `awaiting_approval`: an unguarded restore would force _any_ plan back to `awaiting_approval` on a
  stale or duplicate call, reopening the approval gate on a plan whose parts are already dispatched).
  Otherwise it sets the plan back to `awaiting_approval`, clears `discussing`, broadcasts and runs a
  cycle — restoring the status is not an afterthought: clearing the flag alone would leave the plan in
  `planning`, which is exactly what rule `issue-plan` dispatches a fresh planner from. It **does** end the
  discussion agent — the live task on `planOrigin(planIssueNumber(plan.originRef))`, completed through
  the same `AgentManager.complete` the cockpit's own agent-complete button uses, the clean `done`
  terminal that reclaims the worktree rather than `kill`'s abandonment. Left alive, the planner holds a
  fleet slot and a worktree with nothing to talk to — the modal's discussion pane is gated on
  `plan.discussing`, so the reply box is already gone — and a late `plan_submit` from that stale agent
  would revert this very approval back to `awaiting_approval` through ingestion's unconditional
  `requireApproval` re-check. A missing agent (already gone) or a completion that fails is a no-op, not
  a route failure: the plan restore is the important half and must land regardless. Returns
  `{ ok: true, plan }`.
- **It dies.** The plan stays `planning` with `discussing` set, so rule `issue-plan` re-dispatches, bounded by the
  existing `dispatchVerdict` attempt cap on `issue:<n>:plan`; a spent cap fails the plan back to `parts`
  exactly as a spent replan does. Deliberately the same failure envelope as replan, not a new one.

**The cost, stated:** a discussion holds a fleet slot and a worktree for as long as you take to reply.
Nothing reclaims it on a timer, and adding one would end a conversation mid-thought.

## Tests

`test/issuePlan.test.ts`, `test/planIngestion.test.ts`, `test/planPart.test.ts`,
`test/planApproval.test.ts`, `test/planReconcile.test.ts`, `test/planDiscussion.test.ts`,
`test/stackedPrs.test.ts`, `test/closedPrs.test.ts`.
