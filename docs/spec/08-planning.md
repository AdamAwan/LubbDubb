# 08 — The planning funnel

`src/plans/`. **Always on** — there is no switch, and no deployment in which an issue reaches an
implementation agent without a plan row saying how it is being worked. Only the `rule` dispatcher
implements it.

Every watched open issue passes a planning agent before any implementation work. The funnel was a
switch while it was new; keeping one meant every gate that read it was a branch to reason about and
test, and the off arm — `issue-pickup` un-narrowed, no plan row anywhere — is not a configuration
anything else in the harness is written for any more. A config file still setting `planning.enabled`
is warned about and ignored ([02](02-configuration.md#retired-keys)).

## A plan is a list of parts

**Every plan has at least one part, and a plan with one part is not a different kind of thing from a
plan with eight.** `PlanDocumentSchema` refuses a document declaring none; rule `plan-part` schedules
every plan there is; each part gets `issue/<n>/<slug>`, its own agent and its own pull request,
whether it has siblings or not.

That is a change, and it is worth stating what it replaced, because the old shape is the reason so
many surfaces used to fork. A plan document carried a `verdict` of `single` or `parts`, and **`single`
meant _zero_ parts**: no part row, no branch of its own, no acceptance criteria, no scope to drift
from — the issue was handed back to rule `issue-pickup` and worked whole on the flat `issue/<n>`
branch. So the commonest plan the harness writes was the one encoded as the absence of a plan's
contents, and everything downstream had to ask which of the two it was holding. The cost was paid in
a dozen places at once: `planShape`, a `singleOverruled` override the planner could have its verdict
refused by, a `describeSingleRoute` sentence for the approval card, two settlements in `refusePlan`,
an `abandonDecomposition` route and cockpit control whose entire job was collapsing one shape into
the other, a partless arm in the reconciler and another in the status comment, and a ref-collision
guard that existed because the two shapes wanted branches git cannot hold at once.

None of that was wrong for the encoding it had. It was all downstream of one decision — that "one
pull request" is a _shape_ rather than a _size_ — and removing that decision removes the rest.

The `verdict` field is gone from the document. A document still carrying one is not refused for
carrying it (zod strips unknown keys), but one carrying no parts is, with a sentence saying so — so
an operator override written against the old shape is corrected on its first submission rather than
quietly ingesting as something else. `plan_submit` hands the reason back in the same turn.

## The four arms

`resolvePlanRoute(input)` in `src/plans/planning.ts` is **the one place** an issue's arm is decided.
Pure over the plan row plus the plan origin's cooldown verdict. Both the dispatcher (rules `issue-plan` and `issue-pickup`)
and `issuePickupStatus` read it, so the cockpit's chip can never disagree with what fires.

| Verdict                                              | Meaning                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{route:'parts'}`                                    | Planned; the part scheduler owns it and pickup stays off. One part or eight — the route does not count them.                                                      |
| `{route:'awaiting_approval'}`                        | Planned, and the plan is a proposal a human has not answered. Pickup stays off exactly as for `parts`; rule `plan-part` queues the parts without dispatching any. |
| `{route:'planning', planner:'dispatch'\|'cooldown'}` | A planner is owed, now or after the gap.                                                                                                                          |
| `{route:'unplanned'}`                                | **The fail-open arm, and the only one rule `issue-pickup` works.** No plan, and none coming.                                                                      |

Resolution order:

1. A plan row with status `awaiting_approval` → `awaiting_approval`.
2. A plan row with any status other than `planning` (`active`, `complete`, `abandoned`) → `parts`.
3. Otherwise (no plan, or a plan back in `planning` — a replan in flight), the plan origin's cooldown
   verdict decides: `escalate`/`hold` → **fail open**; anything else → `planning`.

The part count is not asked about. It used to be the _first_ question — "an `active` plan with no
live parts → `single`" — and that one line is what made a one-part plan a different kind of thing
from a two-part one all the way down.

**Fail-open is load-bearing.** Narrowing pickup to nothing would turn any planner that crashes or
writes no plan into a permanently parked issue. Once the attempt cap is spent the issue falls open to
`unplanned` and gets worked whole. Nothing escalates: the cap is the signal, and an issue that quietly
keeps moving beats one that quietly stops.

`unplanned` is named after the failure because that is now all it is. The `single` route it replaced
meant two unrelated things reached by the same arm — "a planner decided one PR is right" and "no
planner ever answered" — told apart by a `failedOpen` flag every reader had to remember to check. The
first is an ordinary one-part plan now, so only the failure is left.

A **replan** fails back differently — to `parts`, not `unplanned` — when `existingParts > 0`. An issue
that already has parts has a plan to fall back on, and `unplanned` would point rule `issue-pickup` at the flat
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
a directory. A planner branch under `issue/<n>/…` would collide with the parts of the
very plan it is writing.

The planner branch namespace also has to stay clear of the part branches, which is the same fact from
the other side: `plan/issue/<n>` cannot live under `issue/<n>/…` without colliding with the very parts
the planner is writing.

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
when the plan row is back in `planning`. Skipped when an active task already holds the origin, which
is what stops one goal ever getting a second planner. There is **no escalation arm**.

There used to be a third arm, `discuss-plan`, on the same origin and branch. Discussing a plan is a
deep link into the operator's own Claude Code now and dispatches nothing at all (below), so what is
left here is the distinction that was always load-bearing: whether there is an existing decomposition
to plan _from_.

A planner has **two** verdicts, and only one of them is a plan. The other is
[`plan_not_needed`](#when-there-is-nothing-to-plan) — the goal is already met, so nothing is written to
the plan graph at all. It is refused on the replan arm, so this rule's two templates are not two routes
to it: only a cold planner may cast it.

Whichever of the two templates it renders, `relatedWorkNote` is **appended** to it: the parent
feature's description, the sibling stories with their states, and the orphan flag with its candidate
features (see [06](06-issue-pickup.md#hierarchy)). Reading the related items is the planning step
that stops a decomposition re-cutting scope a sibling story already holds — a planner that cannot see
either side of the item it was handed will happily plan work someone else owns. Empty on a tracker
with no hierarchy, so the GitHub prompt is unchanged.

## When there is nothing to plan

A planner reads the repository before it decides what the work is, and sometimes what it finds is that
the work is done: somebody fixed it by hand, another goal's part covered it, or the ticket was filed
against a version that predates the fix. **That is a verdict, and it has a tool of its own —
`plan_not_needed`** ([11](11-mcp-tools.md#plan_not_needed)). It takes a one-line `summary` and a
required `detail`, writes **no plan row at all**, and records the issue's delivery park
([06](06-issue-pickup.md#the-delivery-park-delivered)) with `by: 'planner'`.

It exists because the refusal above is right and still cannot say this. Every plan has at least one
part, and work that is one pull request is a one-part plan — so a planner holding "there is nothing to
build" has to encode it as *something*, and each way of doing that spends an agent to rediscover what
this planner already knows:

| What it does instead      | What it costs                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Invents a part            | An agent, a branch and a worktree, to arrive at `conclude_part` with kind `determination`.                                  |
| Writes a part that redoes it | The same, plus a pull request nobody wanted, against code that already does the thing.                                    |
| Submits nothing           | Its attempts, and then the fail-open arm: `unplanned` puts rule `issue-pickup` on the issue, which is the first row again — with the planner's finding thrown away. |

All three end with a human being asked to approve, or review, work that did not need to happen. The
verdict is cast where it is known instead.

**Why a delivery row rather than a fifth thing.** `issue_deliveries` already means exactly this —
"what the issue asked for is present, schedule nothing further" — and `deliveryHold` already filters
`eligibleIssues`, which is the list both rule `issue-plan` and rule `issue-pickup` draw from. So one
row stops the planner being re-dispatched *and* stops pickup taking the issue instead, with no new
gate anywhere. It is reversible by the operator and expires on world signal, which is the right
lifetime for a claim about a goal nobody has worked: the moment the ticket moves or something links to
it, the question is open again.

**Two refusals, both at the fleet seam** (`AgentManager.recordGoalMet`), because both are store
questions and both are silent if nobody asks them:

- **A replan.** An issue that already has a plan row cannot be settled this way: the plan would go on
  owning the issue — `planInFlight` reads `planning` as more work, so the goal would read delivered
  *and* mid-decomposition — and any part already dispatched or in review would keep running underneath
  it. A replanner that believes the goal is met amends the plan, or raises it: the operator asked for
  this replan and it is theirs to end.
- **A standing shortfall.** Writing a delivery clears one through the exclusion matrix
  ([14](14-persistence.md#issue-verdicts-and-the-exclusion-matrix)), so without this refusal a planner
  would erase an assessor's "the goal is not reached" — a verdict cast with the delivered state in
  front of it — with nothing anywhere red.

**The bar is _met_, not _unworkable_.** A goal that is half there is a plan for the other half, and a
goal nobody can make sense of is `appraise_issue`'s `unclear`, which puts the ticket back in front of
the person who wrote it. The `issue-plan` prompt says both, and says the tool takes evidence: a planner
that cannot point at what already does the thing is not sure enough to say this.

## The plan document

`src/plans/planDocument.ts`. One schema, two transports.

```json
{
  "version": 1,
  "reason": "<one sentence: why this shape>",
  "diagnosis": "<what is actually wrong>",
  "approach": "<what is going to be done about it>",
  "parts": [{ "slug": "schema", "title": "...", "scope": "src/store/...", "dependsOn": [] }],
  "validation": { "resources": [], "checks": [] }
}
```

Validation (`PlanDocumentSchema`, zod):

- `version` is literally `1`; `reason` is non-empty.
- **At least one part is required**, and this is the refusal that replaced the `single` verdict. The
  message says what to do about it (`a plan needs at least one part — work that is one pull request
is a plan with one part`), because the deployments most likely to submit a partless document are
  the ones running an operator-overridden prompt written against the old shape.
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

`validation` is the executable form of the `verification` narrative below — how anyone checks the
_goal_ was met, as steps rather than as a paragraph. Optional, read whatever the plan's size, and owned
entirely by [20](20-validation.md), which states its schema, its refusals and what an amendment may do
to a check somebody has already run. Two things are worth knowing here: a check declares no actor, and
a document that gives one is refused; and a check is only ever something running the _delivered_ goal
can answer ([the bar](20-validation.md#the-bar)) — what the diff, the suite or a green build settles
is `acceptance`'s business, not validation's.

`parsePlanDocument(raw)` parses JSON then validates; `validatePlanDocument(value)` validates an
already-decoded object. The `plan_submit` tool enters at the second, the file path at the first —
**both reach the same schema**, so the two transports accept and reject exactly the same documents.
The difference is only that the tool can hand the reason back instead of burning an attempt to
discover it.

### The seven narrative fields

Seven additive, **optional** fields, so a document from an older planner still validates and neither
transport changes shape:

| Field        | Level | What it is                                                   |
| ------------ | ----- | ------------------------------------------------------------ |
| `rationale`  | part  | Why this is its **own** PR rather than folded into a sibling |
| `acceptance` | part  | What makes this part done                                    |
| `diagnosis`  | plan  | What is actually wrong — the root cause, found in the code   |
| `approach`   | plan  | What is going to be done about it                            |
| `risks`      | plan  | What could go wrong with this split                          |
| `outOfScope` | plan  | What the planner deliberately left out                       |
| `document`   | plan  | The full narrative, markdown — the read-in-depth version     |

**`diagnosis` and `approach` are separate from `reason` because they answer different questions, and
one field asked all three answered whichever the planner reached for.** `reason` is the verdict's own
justification — why _this shape_, one PR or these parts — and it is what the approval card, the
provider status comment and `currentPlanSummary` have always quoted. Nothing asked what was broken or
what would be done about it, so a planner supplied a diagnosis only when it happened to feel like one,
and the plan sheet led with a paragraph about splitting on an issue whose reader wanted the fix. The
prompts now ask for all three by name and say what each is not.

**The verdict's three fields — `diagnosis`, `approach` and `verification` — are asked for as bullets,
in plain English, with no file paths in them.** They are read side by side on the plan sheet by someone
deciding in a minute whether the work happens, and the three things that cost them that minute are all
form rather than substance: a paragraph, so the claims have to be hunted for; a lecture, when what was
wanted was an overview; and a path mid-sentence, which is a token the reader cannot click and did not
ask for. So the prompt and the `plan_submit` schema both ask for one plain point per bullet, four or
five at most, the code named in words rather than in paths. The paths already have a home — `evidence`,
which the sheet draws beside the diagnosis as links — and so does the argument: `document`, which is a
tab away for the reader who wants it. `alternatives`, `openQuestions` and `reason` stay sentences,
because each is an argument rather than a list.

Nothing renders this: `renderMarkdown` has always understood lists and `.pm-prose` has always styled
them, so this is entirely a change of what the planner is _asked_ for. Which is also why it is stated
in two places that must agree — `PLAN_DOCUMENT_SCHEMA` and the `issue-plan` / `issue-replan` /
`discuss-plan` templates — and why a deployment running an overridden prompt keeps whatever form its
own prompt asks for.

`diagnosis` is legitimately absent on work that is not a defect — there is no root cause of a feature —
and the modal simply omits the section. `approach` is not: every plan is a plan to do something. Both
are optional in the _schema_ for the reason every post-v1 field is, which is that an operator-overridden
prompt that never learned them must keep validating.

**The narrative lives on the plan row, not in an artifact chip.** The obvious alternative — the
planner writes `docs/plan.md` and the file-events hook promotes it to a flag chip — is broken by a
lifetime the chip mechanism does not own: `GET /artifacts/:id` serves out of the agent's worktree, and
`system.ts` removes that worktree on a `done` reap. The planner finishes, the worktree goes, and the
write-up 404s at exactly the moment the plan is ready to approve. Storing it on the plan row makes it
outlive the planner, outlive a restart, and stay joined to the row it describes.

**`document` is expected, not merely permitted.** The `issue-plan` and `issue-replan` templates ask
for it, and a plan without one renders "no write-up" in the plan sheet rather
than hiding the tab — a hidden tab would read as "this planner had nothing to add", indistinguishable
from "this planner ignored the instruction". An over-long `document` is **trimmed and stored, with the
trim reported**, never refused: refusing would reject the whole plan submission over its prose, the
`note_progress` trade-off (cheap and frequent beats strict) rather than the claim intake's
(testimony, so refuse what cannot be attributed).

`plans` carries `diagnosis`/`approach`/`risks`/`out_of_scope`/`document` and `plan_parts` carries
`rationale`/`acceptance` —
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

`ingestPlanDocument(store, {doc, originRef, title})` in `src/plans/planIngest.ts` is
the **one** place a plan document becomes plan rows, so the file path and the tool path cannot drift
into two subtly different writes. It writes `awaiting_approval` unconditionally, and takes no policy
at all: ingestion stays store-only, and neither transport (`AgentManager` for the file path,
`McpToolDeps` for the tool path) can persist a verdict the other would not.

The plan is persisted whatever its size — a one-part plan is an ordinary row with one part. Without a
row the planner would re-run on the same issue every cycle.

For an amendment:

1. `partsToRetire(existing, declaredSlugs)` — parts the new document drops are retired **only when
   nothing was started for them** (`partHasWork`: `dispatched`, `in_review` or `merged`). One with an
   agent, a branch or a PR is left exactly as it is. Retiring it would strand a PR the reconciler
   still folds reality onto, and a reviewer would have no idea the harness had written it off.
   Un-declaring in-flight work is a request to _stop_, which is a kill, not a plan edit.
2. The status is `awaiting_approval`, and **nothing is consulted** to arrive at it. This was a
   function once — `ingestedPlanStatus`, taking the verdict and the surviving parts while a `single`
   verdict could be _overruled_ by a part already carrying a branch, and later a `requireApproval`
   flag: shape arithmetic and a policy read on the write path, for a decision that is the same one
   every time. An amendment lands the same way whatever it does to the part count.
3. `store.upsertPlan`, then retire, then `store.upsertPlanParts` (which merges on slug and never
   deletes). **A slug the document re-declares is un-retired**, back to `pending` with its
   `blocked_reason` cleared: retirement is a *declaration* verdict, not progress, so a document that
   declares a slug again is a plan delivering it again. Every other status is progress and survives
   untouched, which is the split `upsertPlanParts` is made of. Retirement is therefore reversible by
   the planner and by nothing else — the operator's Reject retires, and only the replan that follows
   can lift it.
4. `store.ingestValidation`, on the same terms one layer down: merged on the check id, letters
   assigned once, and a check the amendment stopped declaring superseded rather than deleted. Written
   whenever the document carries a validation block, which is the only condition there is.
   → [20](20-validation.md)

## Plan parts

`src/plans/parts.ts` — all pure.

| Function                                          | Answers                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bySlug(parts)`                                   | An index for the dependency walks.                                                                          |
| `dependenciesOf(part, index)`                     | The declared dependencies, in declared order, skipping slugs the index no longer holds.                     |
| `partDepth(part, index)`                          | How deep in a stack — **longest path**, so a rejoin never sorts ahead of what it waits on. Cycle-guarded.   |
| `partSettled(part)`                               | `merged` \| `concluded` — has this part reached a terminal. The one place that says so.                     |
| `partOutcomeKind(part)`                           | `code` (derived from `merged`), the stored kind for `concluded`, else null.                                 |
| `dependencySatisfied(dep, pushed)`                | `partSettled` unconditionally; `dispatched`/`in_review` only when the branch carries commits beyond base.   |
| `partBase(part, index, n, defaultBranch)`         | The one unsettled dependency's branch; the integration branch once all have settled or when there are none. |
| `liveParts(parts)`                                | Everything not `retired`. **Every** count, roll-up, prompt and rule reads this.                             |
| `planProgress(parts)`                             | `{settled, total}` over live parts.                                                                         |
| `partHasWork(part)`                               | `dispatched` \| `in_review` \| `partSettled`.                                                               |
| `partOutcomeNote(part)`                           | What a non-code part is told, appended to its rendered prompt. Empty for a code or unstated part.           |
| `partDeclarationNote(part)`                       | The part's `touches` and `acceptance`, appended to its prompt — an agent judged on a criterion is shown it. |
| `acceptanceCriteria(part)`                        | `acceptance` as the checklist the sheet draws, each criterion's tick folded in.                             |
| `partsToRetire(existing, declared)`               | Which parts an amendment retires.                                                                           |
| `currentPlanSummary(plan, parts)`                 | The current plan rendered for a replanning agent — slug, status, PR/branch, dependency, scope.              |
| `siblingContext(parts, current)`                  | `{done, remaining}` for the part prompt.                                                                    |
| `observePartPr(part, branch, openPrs, closedPrs)` | The pure core of PR observation (below).                                                                    |

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
→ [13](13-jobs-and-tickets.md#human-tasks)

**No new blocking machinery was needed, and that is the argument for this shape.** A part is already
the only node the harness knows how to make other work wait on, so a human step reuses every property
`dependsOn` and `PlanReconciler.readiness` already have:

- Rule `plan-part` produces no candidate for one (`partIsHuman`), so it is never dispatched.
- The reconciler folds no pull request onto one, stalls it on no agent, and **does not read it
  against the ref-collision guard** — three skips, one reason: there is no branch and no agent.
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
**Held** with the reason on it, and the way out is Replan, on the plan sheet. Nothing escalates for the
decline itself: the operator is the one who declined, and the button is in front of them. What *does*
ask is a decline that leaves other work stranded behind it — see [the wedge](#the-ref-collision-guard)
below, which is a question about the plan rather than about the refusal.

That makes a declined step the **second** thing that can block a part, beside the ref collision. The
readiness pass is still not one of them — it answers `pending` or `ready` and never `blocked` — and
each blocking reading states its own reason from its own pure function, so a part is never left
claiming a collision that has been resolved or a refusal that was withdrawn.

**Which of the two blocked a part is carried on the row**, as `plan_parts.blocked_by`
(`collision | declined`), written by the reconciler beside the reason and cleared with it. It is on the
row rather than re-derived because the two blockers now have different consequences and the reconciler
is the only thing that knows which it wrote: a reader sniffing `blocked_reason`'s prose to tell them
apart would be one rewording away from escalating the operator's own refusal back at them. Null is
*unattributed* — every blocked row on a database from before the column — and counts toward the wedge
the way it did when there was nothing to count.

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
- Only the **watch tag** is applied, evaluated once on the parent. Not the workflow-state gate
  — rule `work-item-in-review` parks a decomposed item in the review state for the life of the plan.
- `inFlight` counts **live tasks** on part origins, not the `dispatched` status, so a part whose agent
  died is not occupying a slot. `room = maxConcurrentPartsPerIssue - inFlight`.
- Ready, unstaffed parts are ordered by dependency depth, then `seq`.
- Per part: a `hold` verdict is skipped entirely (it must not eat a slot a sibling could use — that is
  how one stuck part would stall a whole plan); an `escalate` verdict emits `escalate_to_human` from
  `plan-part-escalation`; beyond `room` the part is queued as **`capped`** rather than skipped, so the
  limit is visible instead of looking like nothing happened; a `cooldown` verdict is the same—it must
  not eat a slot, so the part stays queued as held without spending one.
- For an `awaiting_approval` plan every ready part is queued **`unapproved`** and nothing else: the
  cooldown and attempt-cap arms are skipped, because they would answer "why did this part not get an
  agent" with the wrong reason. Skipping the plan outright would make an unapproved plan
  look exactly like an idle fleet — the invisibility `capped` is named to fix.
- Candidates from all plans are then sorted by depth, issue number, `seq` and appended to the ranked
  list.

The emitted `dispatch_code_agent` carries `base` (from `partBase`) and `partId`. The executor passes
`base` to `WorktreeManager.ensure` and calls `Store.markPartDispatched` **only after** the agent
actually spawns, so a held dispatch leaves the part `ready`.

## The approval gate

A plan is a **proposal** before it is work (issue #109 phase 3), on every deployment. It was
`planning.requireApproval` — on by default, and switchable — until the switch was removed: what it
turned off was the acceptance step on the one decision in the funnel that is a human's, and a
deployment reaching for it was asking for N branches and N agents to start themselves off a verdict
nobody read. The undo for a plan is a replan, which is strictly worse than not starting.

**Every plan, whatever its size.** The gate started on the `parts` arm alone, on the reasoning that a
`single` verdict proposes nothing — it was the path the funnel already fell open to. That was wrong in
the one direction that mattered: it made the _commonest_ route the one with no acceptance step in it.
A planner deciding an issue is one pull request has decided something an operator may well disagree
with, and "nothing is scheduled until you approve" was the whole promise of the gate. The distinction
is gone entirely now — there is one arm — but the reasoning is worth keeping, because it is the
argument that generalised: what is being approved is _this work, described this way_, and the number
of parts it is cut into is not what makes it worth asking about.

There is also no longer an ungated arm. A `single` verdict the harness had _overruled_ — parts already
carrying branches, so the collapse was refused — was released without asking, because there was no
decision left in it. Nothing overrules a plan any more, so nothing bypasses the gate.

**There is one landing.** `test/planApproval.test.ts` asserts that ingestion writes a proposal, that
one part is asked about on an eight-part plan's terms, and that accepting releases the plan. A test
downstream of the gate starts from a released plan — `active` written straight to the store, or an
accepted proposal — rather than from a config that turned the gate off, because there is no longer
such a config and an operator has no such route either.

**The gate is the plan's status.** Ingestion persists the plan as `awaiting_approval` instead of
`active`; releasing writes `active`, and that is the whole effect, because `awaiting_approval` is the
released status with the gate closed. Rule `plan-part`'s question — "is this plan released" — is
therefore the status check it already had, and a superseded plan structurally cannot release a new
one, because a replan resets the row.

### The status is the plan's life, and only that

`PlanStatus` carries `planning`, `awaiting_approval`, `active`, `complete` and `abandoned` — where the
plan is in its life, and nothing about its shape.

It carried the shape twice, in two different ways, and both are worth recording because the second is
subtler than the first. It was a `single` plan **status** to begin with: shape and life are
independent, and a status cannot hold both, so a plan being delivered as one pull request could not
also be `active`. `PlanReconciler` lists `active`, `complete` and `awaiting_approval`, so a `single`
plan was in none of them, was never reconciled, and **never wrote its status comment** — an issue
worked whole told the tracker nothing at all, with no error anywhere.

The fix was to read the shape off the parts instead (`planShape`), and that was better but still a
second question every consumer had to ask: `resolvePlanRoute`, `PlanReconciler.reconcilePlan`,
`planInFlightVerdict`, `abandonDecomposition`, the cockpit's furnace and plan cards each had to know
that a plan with no live parts was a different kind of plan. What removes the question is a plan
always having parts. Nothing reads a shape now, because there is one.

Two boot migrations carry the old rows over, and they run in this order because the second reads what
the first writes (`src/store/store.ts`):

- `absorbSinglePlanStatus` — the retired `single` **status** becomes `active`.
- `backfillWholePlanParts` — every plan with **no part rows** gets the one part it always was, slug
  `whole`. Without it those rows are scheduled by nothing at all: rule `issue-pickup` no longer looks
  at a planned issue and rule `plan-part` finds no part, so a live goal parks itself silently on the
  deploy that ships this. The part carries `branch = issue/<n>` when the plan was already being
  delivered (`active`/`complete`), so the flat branch's open PR, pushed commits and running agent land
  on it through the ordinary `part.branch ?? partBranch(…)` resolution and `foldPr` picks the PR up on
  the next pulse; `null` before anything was scheduled, so the part is cut in the normal namespace.
  `abandoned` plans are skipped — nothing schedules them, so there is no silence to fix, and inventing
  a part for work somebody stopped would put a row in the graph claiming the opposite.

| Step                 | What happens                                                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The plan lands       | Ingestion writes `awaiting_approval`. Parts are written normally: the gate holds scheduling, not the record of the plan.                                                                                                                           |
| Rule `plan-approval` | Emits `propose_plan` for an `awaiting_approval` plan whose issue is open and watched, unless `planProposalHold` finds a pending one. Read off `ctx.plans`, not `eligibleIssues` — a replan of a live plan is re-approved while its parts have PRs. |
| The executor         | Creates an `approve_change` escalation plus a `plan` proposal with ref `issue:<n>:plan`, and re-asks the same hold (every path that reaches the executor is covered, not just the one that checks first).                                          |
| Accept               | `ProposalDesk.accept` → `ActionExecutor.runAuthorized` → `releasePlan`: the plan becomes `active`, audited under `human:<proposal id>` as `authorized by you`.                                                                                     |
| Reject               | `ProposalDesk.reject` → `refusePlan`, carrying the operator's note.                                                                                                                                                                                |
| Close the ticket     | `ProposalDesk.backOut(id, 'close')` → `backOutOfPlan` → `declinePlan`: comment, close, un-watch, conclude, abandon. Below.                                                                                                                          |
| Hold the ticket      | `ProposalDesk.backOut(id, 'hold')` → the watch tag comes off and the plan is refused, so watching it again gets a new one. Below.                                                                                                                   |
| Replan               | `POST /api/plans/:id/replan` withdraws a pending proposal (below).                                                                                                                                                                                 |

**What the ask says** is one template, a quoted block, and two appended paragraphs.

The **body of the card is `planApprovalDetail(plan)`** — the plan's `diagnosis` and its `approach`,
labelled _What's wrong_ and _What we'll do_ — carried as the escalation's `context.detail` with
`context.detailFrom` of `What the plan says`, never spliced into the prompt. Same discipline as a
shortfall's assessor quote and for the same two reasons: it is the planner's prose, and the cockpit can
label a block whose edges it can see ([17](17-cockpit.md#how-an-escalation-card-is-laid-out)). It falls
back to `reason` when the planner filled in neither, and is absent when it said nothing at all.

**The split is not in the ask.** It used to be its body — `describeProposedParts`, every part
in dispatch order with every prerequisite — and that is the wrong half of a plan to put in front of
someone about to authorise it: how the work is cut up is a question you reach _after_ agreeing the work
is right, and the parts are one click away in the plan panel, drawn as waves, where they read far
better than a flat list did. The card's **Read the full plan** control is the route to it, and the
built-in template says so.

`plan-approval` is rendered with `{parts}` — how many parts the plan has — and with `{list}`,
`describeProposedParts`. The built-in template no longer interpolates `{list}`; it is rendered anyway,
so an operator override written when the split _was_ the body keeps working. What approving and
rejecting do is then **appended** by `planApprovalNote`, never interpolated: the template is
operator-overridable and `loadPromptTemplates` rejects only _unknown_ placeholders, so a
`{settlement}` token would be silently dropped by exactly the deployments that customised most.

`planApprovalNote` names **four** answers, and two of them are not about the plan — see _Backing out
of a plan_ below. Stating them is not decoration: before they existed the only "no" on the card was
the one that re-plans the goal, so an operator who had decided the _ticket_ was wrong pressed it and
the harness answered by re-deriving a plan for work nobody wanted.

`planApprovalNote` is **one paragraph** now. It was two, and picking between them was the reason it
was appended in the first place: a one-pull-request plan settled somewhere else entirely — approving
it handed the issue to ordinary pickup, and refusing it had nowhere to fall back to — so a reader
given the other arm's paragraph would answer the wrong question. Both settle identically, so there is
no wrong paragraph left to hand anyone. `caveatNotice` appends after that — see below.

### What the plan raises is acknowledged, not merely rendered

A plan approval starts every agent, branch and pull request the plan declares, and what an operator
was told before that click was **prose**: the planner's own uncertainty on the plan sheet, and the
`Before you decide:` paragraph appended to the ask when a part is already blocked or an unclaimed pull
request is open on the issue. A paragraph above a primary button is the most skippable thing on a
card, and nothing recorded whether it had been read — the careful approval and the blind one wrote
identical rows.

`src/plans/planCaveats.ts` turns that paragraph into a list of things the operator **ticks**, and the
accept is refused while any of them is unticked.

`planCaveats(plan, issue, parts, openPrs)` builds it from four sources, which are two kinds of thing:
the planner's own `openQuestions` and `risks` — written for this moment and read at it — and two facts
about the world the plan lands in, a part that is already blocked and a pull request open on the issue
that belongs to no part of the plan (`wedgeReasons` and `unclaimedIssuePrs`, exported from
`planWedge.ts` so the wedge escalation and the approval ask keep quoting one sentence).

`outOfScope` and `alternatives` are deliberately **not** caveats. Both are the planner being explicit
about the shape it chose, which is what the plan sheet is for; neither goes wrong if unread, and a gate
that fires on every plan ever written is one operators learn to tick blind. A plan whose planner
declared no uncertainty and whose issue is clear raises none, and approving it is the click it always
was.

**The list is stored on the action, never re-derived at accept time.** Rule `plan-approval` resolves it
once and carries it on `propose_plan`, so `caveatNotice` renders the ask's prose from the same list the
gate compares the operator's ticks against. Re-deriving it on the accept would ask a world that has
moved since the card was drawn: a blocker cleared in that window would drop a caveat they ticked
(harmless), and a pull request opened in it would add one they were never shown and refuse their accept
for a sentence nobody put in front of them. The verdict is on what was proposed — the same principle as
`Proposal.action` being kept verbatim.

**The gate is on the desk, not on the route.** `ProposalDesk.accept(id, note, acknowledged)` asks
`unacknowledgedCaveats` **before** the compare-and-set and returns what is still unticked, so a refused
accept leaves the proposal `pending` and its inbox item open — the operator ticks the boxes and clicks
again, rather than finding a verdict spent on a 400. `POST /api/proposals/:id/accept` turns that into a
400 naming the outstanding caveats
([16](16-http-api.md#post-apiproposalsidaccept)); the cockpit holds the button a step earlier
([17](17-cockpit.md#how-an-escalation-card-is-laid-out)), which is the same answer given sooner and not
the enforcement.

**Only the accept is gated.** Reject, Hold and Close the ticket are all ways of _not_ releasing the
work, and putting a reading list in front of them would be friction on the safe verdict.

A tick is not proof of reading, and is not meant to be. What it does is make the skip **deliberate**,
and give the harness a row that says the operator met the caveat rather than that the card rendered it.

`planProposalHold(ref, proposals)` in `src/proposals/proposals.ts` holds on **`pending` only**, unlike
`proposalHold`. A merge is proposed off world state that persists, so it needs a durable "no" and a
settle window; a plan proposal is made once per **plan**, and both settlements rewrite the row the gate
reads. A holding `rejected` would let one refusal veto every future plan (only an operator's
replan can bring the question back); an expiring `accepted` would re-propose a plan whose
agents are already running.

It follows that **phase 4's signal expiry stops here**, and could not have been inherited: it ends a
rejected hold, and this predicate never applies one — the signature says so, since it takes no signals
at all. It would also read the wrong thing if it did. The transitions on `issue:<n>` are its comments
and its links, none of which say anything about whether the plan is the right one, while the
row that **is** the plan is rewritten by both settlements. `test/planApproval.test.ts` asserts the
polarity in both predicates rather than trusting the two to stay apart.

**Rejection has an effect of its own**, because a bare "no" would park the issue: once the funnel is
on, a plan is the only thing that schedules work for a planned issue (rule `work-item-in-review` parks the work item in
the review state for the life of the plan, and `resolvePlanRoute` fails a spent replan back to `parts`).
`refusePlan` (`src/plans/planApproval.ts`) therefore leaves the issue a **route**, and it is the same
route every time: the plan goes to **`planning`** with the operator's note appended to `plan.reason`,
which is the same one status write `POST /api/plans/:id/replan` makes, and rule `issue-plan` dispatches
a replan from it on the next pulse. The note is not decoration: a planner shown only "declined" has no
reason to decide differently to the way it just decided. It cannot loop — the planner's attempt cap
ends it, and a spent cap fails the issue open and gets it worked, which is the funnel's existing answer
to a planner that cannot settle.

**The parts a refusal retires take their asks with them.** A retired human part's `human_tasks` row is
`declined` with a resolution saying why, through the one `withdrawPartAsks` both refusal and ingestion
reach — an open ask pointing at a part no plan schedules is an obligation on the operator that nothing
will ever settle, and the bench is their own to-do list, so a row on it nothing can settle is what makes
the bench stop being read. Retiring the node and withdrawing the item are one act, in one place, for the
reason `IssueVerdictStore.recordVerdict` is one place: a second retirer that settled its own asks would
compile, pass, and leave a row an operator cannot tell from one they still owe.

**Rejecting used to fork on the part count**, and the fork is what this replaces. A refused plan with
parts collapsed to the no-parts "single" shape and was picked up whole; a refused plan that was
_already_ that shape had nowhere to fall — the single route is what the other arm fell _back_ to — so
it went to a planner instead. One button meant two unrelated things depending on a number it did not
mention, and only one of them was ever the operator's intent: _this plan is wrong, write a better one_.

**What is still keyed on the parts is work that has left the harness**, which is not a question about
shape. Every part `partHasWork` says nothing was started for is retired, so the graph says what
happened instead of leaving `ready` rows nothing schedules; parts with a branch or a PR are left
exactly as they are, because they are not the refusal's to withdraw. A refusal that finds work in
flight is a _replan_ being refused, and the work already running carries on while the planner rewrites
around it.

**The retirement lifts when the replan re-declares the slug**, and that is what makes the route a route
rather than a dead end. A replan *must* reuse slugs — the slug is the merge key and has to survive one —
so a retirement that outlived a re-declaration would merge every part of the new plan onto a retired
row and release a plan with nothing live in it: rule `plan-part` schedules nothing, `rollUpPlanStatus`
returns early on no parts, `planIsWedged` is false because nothing is `blocked`, and the goal sits
`active` and idle for good. `upsertPlanParts` therefore un-retires (see Ingestion above), and
`releasePlan` **refuses a plan with no live parts** as the backstop: any future route to that shape is
a visible no on the approval card rather than a silent park.

### Backing out of a plan

Approve and Reject are the two answers to _is this the right plan_ — and both of them agree the work
is worth doing. That left the card with no way to say the thing an operator most often concludes
while reading a plan: **the ticket is the problem**. A rejection was the only "no" on offer, so it
was the one that got pressed, and it sends the goal straight back to a planner — which re-derives a
plan for work nobody wants and puts the same card up again, until the planner's attempt cap ends it.

So there are two more settlements, and both are deliberately about the **ticket** rather than the
plan. They live in `src/plans/planBackOut.ts` and are applied by `ProposalDesk.backOut`, which
settles the proposal exactly as `reject` does — the one-way transition, the inbox item answered, the
decision row under `human:<proposal id>` — and then does something else entirely with the goal.
`refusePlan` is not reached at all.

**`close` — this is not really an issue.** Four writes, in this order and for this reason:

1. `declinePlan` — the plan goes **`abandoned`** with the operator's words appended to its reason.
   `abandoned` rather than `complete` because rule `plan-part` schedules from neither and the work
   graph reads both as terminal, but only one of them is honest about a plan whose parts were never
   done. It compare-and-sets against `awaiting_approval` like the other two settlements, retires the
   parts nothing was started for and withdraws their asks through the same `withdrawPartAsks`; parts
   carrying a branch or a pull request are left exactly as they are, because work that has left the
   harness is not this verdict's to withdraw (**End the run** is).
2. The **conclusion** — `done`, `by: 'operator'`, carrying the note. This is the write that actually
   stops the re-pickup, and it is done before anything that can fail on somebody else's network.
3. The **watch tag** comes off, through the same `watchCascadeTargets` walk the cockpit's own toggle
   uses, and both mirrors are patched (`patchWorldLabels`, `patchTicketLabels`) for the reason
   [16](16-http-api.md#why-both-watch-routes-patch-the-baseline) gives. A closed ticket that kept the
   tag would come back the day somebody reopens it.
4. The **comment**, then the **close** — `IssueCloseCapable`, `state_reason: not_planned`. The
   operator's words are a comment beside the close rather than anything smuggled into it: a close
   reason is the provider's own two-word vocabulary, and the words are the whole point.

Every step is best effort and **each one is reported in the audit line**. The function makes up to
four writes across two systems, and a partial failure is the normal case: a tracker that refuses the
close still took the comment. An operator told "closed" over a ticket that is still open has been
lied to about the thing they were deciding, so the detail says which of the four happened and every
failure also goes through `errors.record`.

**Where the provider has no close, that is said rather than approximated.** GitHub closes an issue;
Azure has a dozen workflow states and no generic close, and which of them means _we are not doing
this_ belongs to the project's process template. So `canCloseIssue()` is false there, the back-out
says the ticket was left open, and the goal is still concluded and un-watched — the fleet is stopped
either way, and the card on the board stays a human's to move
([15](15-integrations.md#the-capabilities)).

**A close requires the comment.** `POST /api/proposals/:id/back-out` refuses `close` with no note,
and `backOutCommentDraft` exists for the operator who would rather edit one than write one from
nothing — it quotes the plan's own `diagnosis` and `approach`, because the ticket's readers have not
seen the plan and a "not doing this" with no account of what was considered reads as nobody having
looked. It is **served and never posted**: nothing goes on the tracker but what the operator sends
back with the verdict.

**`hold` — this needs more thought.** Two writes: the watch tag comes off, and the plan is
**refused** — `refusePlan`, the same settlement Reject makes, so it goes to `planning` with the
operator's words on its reason and its unstarted parts retired. Nothing is concluded and nothing is
commented: a hold is not a verdict about the work, and the goal is not finished.

The two halves are what make each other safe. A refusal alone would have rule `issue-plan` start a
replan on the next pulse, which is the opposite of a hold; the tag being off is what stops it, since
that rule dispatches for an **eligible** issue. So the refusal sits there costing nothing, and
watching the ticket again is what starts a planner — and what comes back is a **new plan**, written
in the light of why it was held.

Parking the plan at `awaiting_approval` instead was the first shape of this and is the wrong one: a
hold says the thinking is not finished, so re-proposing the *same* decomposition weeks later asks the
operator to approve a plan written before whatever they were waiting on happened. The plan they get
back should be one that knows about it.

Neither verdict widens `ProposalStatus`. Both settle the row as `rejected`, because that is what
happened to the *act* — the plan was not authorized — and what distinguishes them lives where it can
be read: the decision detail, the plan's reason, and the conclusion.

An operator who wants a _different_ plan without refusing this one can press Replan, on the same panel.

**Both settlements are compare-and-set against `awaiting_approval`**, the same discipline as
`Store.decideProposal`'s against `pending`: a verdict arriving after the plan moved on — an operator
who hit Replan with the card still open — releases and refuses nothing, and is audited as such.

Two consequences elsewhere:

- Reconciliation **runs** for an `awaiting_approval` plan (readiness is what makes the held parts
  visible in the queue, and a replan's in-flight parts must keep being folded) but does **not** write
  the tracker status comment for one: an unapproved decomposition announces nothing, and a refusal
  would otherwise leave that announcement standing.
- `QueueItem.status` gained **`unapproved`**, for the reason `capped` exists.

## Scope drift

`src/plans/scopeDrift.ts`, pure. `planScopeDrift(issueNumber, parts, tasks, files)` returns, per part,
the paths its agents wrote that its `touches` did not declare.

The plan has always carried the claim and nothing has ever compared it to anything, which made a
decomposition a promise rather than a check: two parts declared to own disjoint directories could
quietly both edit the same file, and the only surface that would ever say so is `detectFileOverlaps`,
which needs them to be **concurrent** to notice. This needs nothing but a merged part and its writes.

- **It reports and blocks nothing.** Writing outside a declared scope is often right — a type has to
  move, an import has to be updated. What is wrong is doing it invisibly.
- **A declaration is a prefix**, tested on a path segment, so `src/store/` covers `src/store/plans.ts`
  and not a sibling directory whose name merely starts the same way. Prefix rather than glob because that is the form the prompt asks for, and
  a glob dialect would be a syntax the planner has to get right for the check to mean anything.
- **`.`, `./`, `/` and the empty string all declare the repository**, and are the same declaration. A
  sweep, a tree-wide rename or a lint-fix part is entitled to say so in whichever of those spellings its
  planner reaches for, and a part that declared the widest possible scope cannot have left it — so the
  one spelling that read as an ordinary prefix drew a drift line under every file the part touched,
  which is exactly the noise that stops the badge being read.
- **It reads every agent a part had**, joined by part origin rather than by `part.taskId` — that holds
  only the last dispatch, and a part that stalled and was re-dispatched has writes from both on its
  branch.
- **A part that declared no `touches` is absent from the result**, not empty: it has not been
  contradicted by anything, and a `0 outside scope` badge would read as a check that had passed.

## Acceptance, ticked

`acceptanceCriteria(part)` splits `acceptance` on lines, strips list markers and folds in
`plan_parts.acceptance_met`. `POST /api/plans/:id/acceptance` writes a tick.

**The tick is a reviewer's, never the harness's.** Nothing derives whether a criterion holds — the
same refusal `conclude_part` makes, for the same reason: inferring a positive terminal from incidental
evidence is what the harness declines everywhere. What this adds is only that the criteria are in
front of the merged pull request instead of in a plan nobody reopens.

**Keyed on the criterion's text, not its index**, so a re-worded criterion loses its tick. That is the
behaviour worth having: an amendment that changes what "done" means has withdrawn the thing that was
confirmed. An index would silently carry it onto a criterion nobody looked at.

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

`refs/heads/issue/12` and `refs/heads/issue/12/<slug>` cannot coexist. An issue picked up **unplanned**
first — the funnel's fail-open arm — and planned afterwards has exactly that branch, and every part
branch would fail to create with a git error nobody can act on. The reconciler checks
`git presence(issue/<n>)`; if the flat branch exists locally or remotely, every uncut **code** part is
parked `blocked` and **one** clear error is recorded naming the branch to delete or rename.

**A human part is outside the guard, because it is outside the branch namespace entirely.** It is
never cut, so the flat branch is not in its way — the same reason the fold loop skips it, and the
reason a plan of nothing but human steps records no collision at all and is not `planIsWedged` for
one. Parked by it, such a part carries a reason that reads correctly and is *false about that part*:
the person is not waiting on git, and their step starts no sooner for the branch going away (it is
settled by `Store.concludeHumanPart`, not by readiness).

**A part whose branch _is_ the flat one does not collide with it** — it is what is on it. That is the
shape a plan backfilled onto an issue the funnel had already worked has (`backfillWholePlanParts`),
and blocking it against its own branch would wedge exactly the plans the backfill exists to keep
moving.

The wording is `refCollisionReason(issueNumber, presence)` (`src/plans/planReconciler.ts`, pure) and
it is written in **two places from that one function**: the error above, and
`plan_parts.blocked_reason` on each part it parks.

**It takes the `BranchPresence`, not the boolean the reconciler acts on**, because _where_ the branch
is decides which action works and the two are not interchangeable:

- **Local only** — delete or rename the local ref, and the parts start on the next pulse.
- **Remote, with or without a local ref** — it has to be deleted on the remote. The reason says that,
  and says that a local delete does nothing here, because `maybeFetch` runs `git fetch --prune` every
  pulse (floored by `planning.gitFetchIntervalMs`, which may be `0`) and restores the remote-tracking
  ref straight away. A remote-only collision is therefore untouchable by any local command — and that
  sentence is the whole reason the presence is threaded through. Told only "delete or rename the
  branch", an operator deletes the local ref, watches nothing change, and repeats it: a reason that
  reads correctly and is useless is the failure mode a standing explanation exists to avoid.

Still **one function with one rendering** — the goal page quotes the stored string verbatim, so a
second rendering anywhere would be the drift this shape prevents. The stored reason is compared for
`differs`, so a branch moving from local-only to remote rewrites the row (and posts the news) on that
pulse, which is wanted: the operator stops being told to do the local thing the moment it stops being
the answer. This is the only thing that blocks a part — the readiness pass answers `pending`
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

An issue picked up unplanned first, then planned and **approved** onto its own taken branch is the bad
case: the parts block instantly. `refusePlan` compare-and-sets against `awaiting_approval` —
correctly, since refusing is a verdict on a question you have not yet answered — so it is gone the
moment the plan is released; and `resolvePlanRoute` fails a spent replan back to `parts`, never open
to unplanned pickup. The plan sits there, nothing is dispatched, and nothing says so. Two things close
it, kept separate because they are two different jobs (`src/plans/planWedge.ts`), and the way _out_ is
Replan — which is the way out of every plan that is wrong for any other reason too:

- **Noticing** — `planIsWedged(parts)`: something blocked, and **nothing moving**. It judges movement
  rather than blocked-ness, and the reason is that the two blockers behave differently. It read "every
  live part blocked" while the collision was the only one — a collision blocks them together or not at
  all, so a mixture was a plan still making progress — and that reading broke in both directions once
  a decline could block one part alone. It escalated a one-part plan whose only part was a step the
  operator had just refused; and it *missed* a real wedge as soon as one sibling had settled, since a
  merged part is not a blocked one and `every` then said no. `[merged, blocked, pending]` is the
  ordinary shape of that, and it stalled the goal permanently with nothing in "Needs you": `plan-part`
  finds no `ready` part, `rollUpPlanStatus` keeps the plan `active` so `issue-assess` skips it, and the
  route stays `parts` so `issue-pickup` skips it too. A `ready` part counts as moving even when it is a
  **human** part, since the bench is where that one is visible
  ([05](05-dispatcher.md)). And a plan blocked **only** by declines asks nothing, matching the
  paragraph above: what makes it a question is an **unfinished** part nobody refused waiting behind one
  somebody did — `liveParts` keeps merged and concluded rows, so "live" and "still to do" are not the
  same set, and counting a finished part among the stuck ones is what the old reading did in reverse. [Rule `plan-blocked`](05-dispatcher.md#the-rules-in-evaluation-order) escalates it once, deduped on an open
  escalation for `issue:<n>:plan` **and** a recent executed one, exactly as rule `pr-ci-blocked` is. No agent is
  dispatched, because none could help. Only `active` plans: an unapproved one is already in front of
  a human, with the same fact in the ask. `wedgedPlanPrompt(issueNumber, issue, parts, openPrs)`
  quotes the blocked parts' stored reasons — all of them, since two declines name two different steps —
  and words its way out for the blocker that is actually there: "clear what is blocking the parts" is
  offered only when something clearable is blocking them, because a decline is not a branch and
  clearing reaches nothing. It **names any open PR for the issue that no part claims** — its
  number, title and branch, and that it must be merged or abandoned before the branch can go. It is
  the same `unclaimedIssuePrs` the approval caveats use — exported from the module for that one reader,
  because approval can be days behind the moment the operator is standing in front of the wedge, and
  "clear what is blocking the parts" is unfollowable while a PR holds the branch open.
- **Warning first** — both readings feed `planCaveats`, whose prose (`caveatNotice`) is **appended** to
  rule `plan-approval`'s ask (never interpolated, for `ciFailureNote`'s reason) and names both the
  blocked parts and any open PR for the issue that no part claims. It **holds the accept until they are
  acknowledged and refuses nothing else** — see _What the plan raises is acknowledged_ above. It does
  not refuse the approval outright: that would put a git fact in front of a judgement about the _work_,
  the branch is one command from being gone, and the operator's only exit would become the opposite
  verdict to the one they were giving.

There was a third thing, `abandonDecomposition` (`POST /api/plans/:id/abandon` and a control on the
plan sheet), which retired the unstarted parts and worked the issue as one pull request. It was a
distinct act only while a plan with no parts was a _different kind of plan_ — "I authorized this, it
cannot run, work the issue whole instead" was a sentence about a shape. It is not one now, so the
route and the control are gone and the exit is Replan.

**Nothing attaches the existing pull request to a part.** A PR on the flat branch claims to resolve
the whole issue, so nothing knows which part, if any, it satisfies. Deriving it would infer a positive terminal from incidental evidence, refused everywhere
else in the harness. It is named to the operator and left alone.

### The status comment

Each plan owns exactly **one** living comment on its issue, via
`IssueCommentCapable.upsertIssueComment` and `plans.status_comment_ref`, edited in place. It is written
when there is news: the plan appearing (no comment yet), a part moving, or the plan rolling up. Because
it is one comment rather than a stream, it is mechanical bookkeeping rather than authored prose, which
is why it goes through no proposal. A failure to write it is recorded and the pulse continues —
progress reporting never takes the pulse down with it.

**It carries the planner's reasoning as well as its progress.** The diagnosis, the approach, what was
rejected, how anyone will know it worked, the citations and the write-up are the product of an agent
that read the whole repository, and until #206 they reached the cockpit and stopped there — someone
looking at the issue on the tracker got a progress table and no reasoning at all, on work a plan had
been approved for. They are folded into `<details>` after the part rows, because the progress list is
what a reader of the thread comes back to several times and the reasoning is what they read once.

The validation checklist rides in the same comment, and **open rather than folded** — the reasoning
is what a reader reads once, but whether the goal was actually checked is what a reader of the thread
next month is trying to find out, and that reader is not on the operator's machine.
→ [20](20-validation.md)

Two fields are deliberately **not** carried: `risks` and `openQuestions`. Both are caveats _on the
verdict_, addressed to whoever is deciding whether the work happens — and by the time anything is
written here that decision is made, because nothing is written while a plan is `awaiting_approval`.
That gate is also what keeps this honest: what lands on the tracker is a commitment the operator has
made, the pulse after they make it.

It is also the one act the plan path performs against the world without asking anyone, so the operator
has to be able to read it: `/api/state` ships `plan.statusCommentRef` as a **canonical comment ref**
(see [15](15-integrations.md#comment-refs)) rather than the store's provider id, resolved through
`buildRefUrls` like every other link. Keeping it off the proposal path and to one comment are both
right, and both rest on it being visible — which, until #171, it was not except by opening the
tracker. Absent (no comment written yet) and unresolvable (a provider that builds no URLs) both reach
the cockpit as silence rather than as a link to nowhere.

**Every plan renders the same body**: the part rows and a progress count, pluralised honestly
(`0/1 part done`). There is no second rendering, and getting rid of the second rendering is most of
the point — a goal delivered as one pull request used to post `**One pull request** — this issue is
being delivered whole, not decomposed`, which told a reader of the thread about the harness's internal
taxonomy rather than about the work. It is also the arm that posted **nothing at all** until the shape
came out of the status: a `single` plan was in none of the statuses `PlanReconciler.reconcile` lists,
so it was never reconciled, and an issue worked whole told its tracker nothing — silently, since there
was no failure to record.

`writeStatusComment` memoises the last body sent per plan and sends only on a difference — a second
guard behind the caller's own news check, which is what makes a re-render free. Memoised rather than
stored: a restart costs one idempotent edit, and a column would be a copy of the comment there is
already a ref to. Nothing is written while a plan is `awaiting_approval`: an unapproved plan has no
progress to report, and posting one would announce a commitment on the tracker that the operator has
not made.

`Store.rollUpPlanStatus` moves a plan to `complete` when every live part is `merged`.

## Replan

`POST /api/plans/:id/replan` flips the plan row to `planning`, withdraws any pending plan proposal,
and kicks a cycle. That is all it does.

The withdrawal is not optional: a pending verdict holds rule `plan-approval` off the plan,
so the amended plan would never be put to anyone — and the stale card, if accepted, would
release a plan its reader never saw. It routes through the ordinary `ProposalDesk.reject`,
which is safe precisely because the status write above already moved the plan, so `refusePlan` finds
nothing to settle and the withdrawal is only the inbox item closing.

**Nothing is torn down.** Every part row is left exactly as it is: agents keep running, branches stay,
open PRs stay open. What an amended plan does to them is decided at ingestion, where the planner's new
declaration is actually known. Until that lands, the existing plan keeps scheduling — a replan that
fails or is never picked up leaves the issue exactly where it was, not parked.

Three things make replan work rather than merely fire:

1. `plannerVerdict` narrows the cooldown window to decisions since `plan.updatedAt`.
2. `resolvePlanRoute` fails a spent replan back to `parts`, not open to unplanned pickup.
3. Ingestion does the amendment, and asks again — an amended plan is a new proposal: `partsToRetire` respects started work, so an amendment cannot withdraw a part that has
   a branch or a PR behind it.

### The other three doors into `planning`

The status write is the whole mechanism, so anything that wants a replan makes it and stops. Besides
this route there are three, and each is specified where it belongs:

- **A refused plan** — `refusePlan` writes `planning` with the operator's note appended to the reason
  (above).
- **An accepted shortfall with cause `plan`** — `shortfallArm`'s arm A, the assessor saying the
  decomposition itself was wrong ([05](05-dispatcher.md#issue-shortfall--routing-a-failed-assessment)).
- **An instruction written on a goal whose plan has rolled up `complete`** — the cockpit's **More work**
  control, the operator saying it there ([16](16-http-api.md#post-apiissuesnumberinstruction)). Only a
  settled plan is rewound; one still in flight already has a next dispatch or a decision the operator
  owes.

## Discussing a plan

**Discuss is a link, not a dispatch.** It opens the operator's own Claude Code on the goal's checkout
with a prompt already in the box, and the conversation happens there — with the repository open, in a
client built for talking. It was a replan with a conversational planner, dispatched from the same
`planning` status with only the prompt telling the two apart, and the operator answered it a line at a
time through a text box in the plan sheet. That surface was the whole problem: a conversation
conducted through a single-line input, costing a fleet slot and a worktree for as long as you took to
reply.

Nothing on the harness side happens when you click it. **No status write, no flag, no agent.** The
plan stays `awaiting_approval`, which is a status rule `issue-plan` does not dispatch from, rule
`plan-part` queues as `unapproved` and rule `plan-approval` has already proposed for — so nothing is
scheduled while you talk without anything having to be parked to achieve it. Closing the window
changes nothing and needs no escape hatch, which is what the old `POST /api/plans/:id/discuss/end`
was.

### The link

`desktopDeepLink(folder, prompt)` (`web/src/cockpit/desktopLink.ts`) builds

```
claude://code/new?q=/lubbdubb%20discuss%20284&folder=<config.desktopFolder>
```

`q` is prefilled rather than sent, so the operator reads the command before it goes; the client caps
it at 14336 characters, which nothing here approaches. `folder` is `config.repoRoot`, shipped on the
state snapshot as `config.desktopFolder` — without it the session opens wherever that client was last,
which is a Claude that cannot read the plan it was sent to argue about.

**The host is `code`, not `claude.ai`.** The client routes the two differently, and only this one
lands on its Claude Code surface, which has the repository, the `/lubbdubb` skill and the harness's
MCP registration. A plain chat has none of the three. (`claude-cli://open` reaches the same engine and
spawns a _terminal_, which is not what a cockpit button should do to somebody.)

A deep link only fires on the machine the browser is on. That is the same limit the desktop
validation control has always had, and there is no reading of it the cockpit could act on — so the
command is in the `title` as well, for an operator who has to type it.

### What the session does

The `/lubbdubb` skill (`src/validation/desktopSkill.ts`, rewritten into the operator's Claude Code on
every boot) carries a `discuss <n>` arm beside its `<n>:<letter>` one. It says: read the plan, argue
with it against the code, amend it, then stop and send them back to the cockpit. It explicitly does
**not** do the work — a session that starts implementing has answered a question nobody asked.

Two tools on the desktop channel do the rest (→ [11](11-mcp-tools.md#the-desktop-channel)):

- **`plan_read(issue)`** — the verdict fields, `openQuestions` (the planner's own nomination of what to
  argue about, which is the agenda unless the operator brings one), the parts through
  `currentPlanSummary` so every slug is in front of the session, the acceptance criteria, the live
  validation checks and the revision count.
- **`plan_amend(issue, …plan document)`** — the same document as `plan_submit`, validated by
  `validatePlanDocument` and written by `ingestPlanDocument`. The schema is one export
  (`src/mcp/planDocumentSchema.ts`) shared by both tools rather than two literals.

`plan_amend` gets three things right, and each of them is silent when wrong:

1. **It refuses unless the plan is `awaiting_approval`** — the gate the old `/discuss` route made, kept
   next to the write. A released plan's parts schedule off a decision an operator already took;
   writing `awaiting_approval` back over it reopens a gate rule `plan-part` had cleared and stops the
   rest of the work. `PlanModal.tsx` offers Discuss only on `awaiting_approval`, so the control agrees
   with the tool rather than surprising it.
2. **It withdraws the superseded proposal**, and **writes the status first**. A pending proposal holds
   rule `plan-approval` off the plan (`planProposalHold`), so an amendment that left the card up would
   send the operator back to approve the _pre-discussion_ decomposition. The order matters exactly as
   it does in `/replan`: `refusePlan` settles a plan that is still `awaiting_approval` — retiring every
   unstarted part and sending it back to a planner — so the plan is moved to `planning` first, which
   makes the rejection a no-op that only closes the inbox item. Ingestion writes `awaiting_approval`
   back a moment later, and store writes are synchronous, so no pulse observes the gap.
3. **It says where to go next.** The reply carries the hand-back wording rather than a bare ok, the way
   `validation_report` states what it recorded: the plan is amended, nothing is scheduled, approve it
   in the cockpit — where "What changed" now draws the amendment against the version they were
   reading.

Validation happens before any of that, so a rejected document leaves the plan graph exactly as it was
and the retry is against an unchanged plan.

**If they decide the plan was right after all**, the session amends nothing and the plan is approvable
exactly as it was — there is no state to unwind, because none was written.

## What the prompts spend their words on

`issue-plan` used to spend roughly two thirds of its length on JSON shape and split mechanics. It does
not need to: `plan_submit` validates on the spot and hands back its own reason, so the schema block
can be terse and a rejection is cheaper than a paragraph explaining how to avoid one. What that buys
is room for the part that actually moves plan quality — a worked example of a diagnosis against a
restated ticket, what makes an `alternatives` worth reading, and the instruction to cite what was
read.

The same rebalance applies to `issue-replan`, which copied the schema block. Two things are said only
in the amendment prompt: that the whole narrative is **replaced rather than
merged** (an amendment that omits `alternatives` leaves the previous one standing, reading as though
the old reasoning still applies), and that the amendment is shown to the operator **as a diff** — so
the write-up should open with what changed the planner's mind, which is the one thing the diff cannot
show.

## Tests

`test/issuePlan.test.ts`, `test/planIngestion.test.ts`, `test/planPart.test.ts`,
`test/planApproval.test.ts`, `test/planReconcile.test.ts`, `test/planDiscussion.test.ts`,
`test/planNarrative.test.ts`, `test/stackedPrs.test.ts`, `test/closedPrs.test.ts`.
