# 08 — The planning funnel

`src/plans/`. Off by default (`planning.enabled: false`), and off leaves the funnel out entirely:
every issue routes straight to `single`, rule 4 is un-narrowed, no planner is ever dispatched, and
behaviour is exactly what it is without plans. Only the `rule` dispatcher implements it.

On, every watched open issue passes a planning agent before any implementation work — a real change in
what the fleet spends its slots on, which is why it is opt-in where `mcp` is opt-out.

## The four arms

`resolvePlanRoute(input)` in `src/plans/planning.ts` is **the one place** an issue's arm is decided.
Pure over the plan row plus the plan origin's cooldown verdict. Both the dispatcher (rules 3c and 4)
and `issuePickupStatus` read it, so the cockpit's chip can never disagree with what fires.

| Verdict                                              | Meaning                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{route:'single', failedOpen}`                       | Fall through to normal pickup. `failedOpen` marks the ones that got there because planning gave up.                                                                  |
| `{route:'parts'}`                                    | Decomposed; the part scheduler owns it and pickup stays off.                                                                                                         |
| `{route:'awaiting_approval'}`                        | Decomposed, and the decomposition is a proposal a human has not answered. Pickup stays off exactly as for `parts`; rule 4a queues the parts without dispatching any. |
| `{route:'planning', planner:'dispatch'\|'cooldown'}` | A planner is owed, now or after the gap.                                                                                                                             |

Resolution order:

1. Planning disabled → `single`.
2. A plan row with status `single` → `single`.
3. A plan row with status `awaiting_approval` → `awaiting_approval`.
4. A plan row with any status other than `planning` (`active`, `complete`, `abandoned`) → `parts`.
5. Otherwise (no plan, or a plan back in `planning` — a replan in flight), the plan origin's cooldown
   verdict decides: `escalate`/`hold` → **fail open**; anything else → `planning`.

**Fail-open is load-bearing.** Narrowing pickup to `single` would turn any planner that crashes or
writes no plan into a permanently parked issue. Once the attempt cap is spent the issue falls open and
gets worked normally. Nothing escalates: the cap is the signal, and an issue that quietly keeps moving
beats one that quietly stops.

A **replan** fails back differently — to `parts`, not `single` — when `existingParts > 0`. An issue
that already has parts has a decomposition to fall back on, and `single` would point rule 4 at the flat
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
explicit replan — ingestion writes `single` or `active` — so the narrowed window cannot loosen the
throttle on a first-time planner.

## Rule 3c — the planner

Dispatches a **code** agent (it needs a worktree to read the repo) on `plan/issue/<n>`, origin
`issue:<n>:plan`, from the `issue-plan` template — or `issue-replan`, carrying `currentPlanSummary`,
when the plan row is back in `planning` — or `discuss-plan`, same origin and branch, when
`isPlanInDiscussion` says the plan is being discussed rather than merely replanned (below). Skipped
when an active task already holds the origin, which is what stops a discussion ever getting a second
planner. There is **no escalation arm**.

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
- `dependsOn` names **at most one** sibling. This is the static form of "a part may stack on at most
  one _open_ dependency": with two, both could be in review at once and there would be no single
  branch to base on. Enforced here rather than discovered at dispatch, where the plan is already
  persisted.
- A dependency must resolve to a declared slug and must not be the part itself.
- Dependency cycles are rejected (`findDependencyCycle`). A cycle would deadlock every part in it.

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

The verdict is persisted for **both** outcomes — a `single` plan is a first-class row. Without one the
planner would re-run on the same issue every cycle.

For an amendment:

1. `partsToRetire(existing, declaredSlugs)` — parts the new document drops are retired **only when
   nothing was started for them** (`partHasWork`: `dispatched`, `in_review` or `merged`). One with an
   agent, a branch or a PR is left exactly as it is. Retiring it would strand a PR the reconciler
   still folds reality onto, and a reviewer would have no idea the harness had written it off.
   Un-declaring in-flight work is a request to _stop_, which is a kill, not a plan edit.
2. `amendedPlanStatus(verdict, surviving, requireApproval)` — `parts` is `active`, or
   `awaiting_approval` when approval is required; `single` is honoured only while nothing survives
   with work, otherwise the plan stays `active`. A `single` verdict is never gated: it proposes
   nothing, and gating it would park an issue on a question with no decision in it.
3. `store.upsertPlan`, then retire, then `store.upsertPlanParts` (which merges on slug and never
   deletes).

An overridden `single` is reported rather than silently applied: `overriddenSingle` is returned, the
tool path tells the **agent** and records an operator-facing error, and the file path (which cannot
answer the agent) records the error alone.

## Plan parts

`src/plans/parts.ts` — all pure.

| Function                                                 | Answers                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bySlug(parts)`                                          | An index for the dependency walks.                                                                          |
| `dependencyOf(part, index)`                              | The single dependency, or null.                                                                             |
| `partDepth(part, index)`                                 | How deep in a stack. Bounded by the part count, so a surviving cycle cannot spin.                           |
| `dependencySatisfied(dep, pushed)`                       | `merged` unconditionally; `dispatched`/`in_review` only when the branch carries commits beyond the base.    |
| `partBase(part, index, n, defaultBranch)`                | The dependency's branch while it is in flight; the integration branch once it merged or when there is none. |
| `liveParts(parts)`                                       | Everything not `retired`. **Every** count, roll-up, prompt and rule reads this.                             |
| `planProgress(parts)`                                    | `{merged, total}` over live parts.                                                                          |
| `partHasWork(part)`                                      | `dispatched` \| `in_review` \| `merged`.                                                                    |
| `partsToRetire(existing, declared)`                      | Which parts an amendment retires.                                                                           |
| `amendedPlanStatus(verdict, surviving, requireApproval)` | The status an ingested or amended plan resolves to.                                                         |
| `currentPlanSummary(plan, parts)`                        | The current plan rendered for a replanning agent — slug, status, PR/branch, dependency, scope.              |
| `siblingContext(parts, current)`                         | `{done, remaining}` for the part prompt.                                                                    |
| `observePartPr(part, branch, openPrs, closedPrs)`        | The pure core of PR observation (below).                                                                    |

`dependencySatisfied` is why `dispatched` is not enough on its own: a dispatched part's branch exists
the moment its worktree does, and basing on an empty branch gains nothing.

`siblingContext` splits by whether the work exists yet, because the halves mean different things to
the agent: `done` is code it may find on its branch and must not redo, `remaining` is work explicitly
not its to do.

### Statuses

`pending` → `ready` → `dispatched` → `in_review` → `merged`, plus `blocked` and `retired`. Retiring is
a status transition, not a disappearance: the row stays so the graph remains readable after a replan,
and nothing schedules it again.

## Rule 4a — scheduling parts

For each plan with status `active` — or `awaiting_approval`, which dispatches nothing (below) —
whose issue is open and passes `issueWatchGateReason`:

- Parts are read from `ctx.plans`/`ctx.planParts` **directly, not from `eligibleIssues`**. That list
  gates on the issue having no open PR, and a part's PR is exactly what makes the parent look taken.
- Only the **watch/ignore tag** is applied, evaluated once on the parent. Not the workflow-state gate
  — rule 3b parks a decomposed item in the review state for the life of the plan.
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
`src/plans/planning.ts` agree). On, a `parts` verdict is a **proposal** before it is work (issue #109
phase 3). Off, an enabled funnel behaves byte-for-byte as it did before phase 3 existed: a
decomposition commits the moment the planner writes it, and no proposal row is written for anyone.

**The default changes nothing for a deployment that has not turned the funnel on**, because
`planning.enabled` is still `false` by default — this only decides what happens once an operator
enables it, which is the honest place for the safe default: the thing being defaulted is whether a
decomposition into N branches and N agents starts itself the moment a planner writes it.
`test/planPart.test.ts` carries both polarities of the default assertion — it once asserted the
default writes no proposal; it now asserts the default **does**, and that `requireApproval: false`
writes none — so the two default sites (`config.ts`, `DEFAULT_PLANNING`) cannot drift apart unnoticed.

**The gate is the plan's status.** Ingestion persists the verdict as `awaiting_approval` instead of
`active`; accepting moves it to `active`, and that is the whole effect, because `awaiting_approval`
is `active` with the gate closed. Rule 4a's question — "is this plan released" — is therefore the
status check it already had, and a superseded verdict structurally cannot release a new one, because
a replan resets the row.

| Step                      | What happens                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict lands             | `amendedPlanStatus(…, requireApproval)` → `awaiting_approval`. Parts are written normally: the gate holds scheduling, not the record of the verdict.                                                                                               |
| Rule 3d (`plan-approval`) | Emits `propose_plan` for an `awaiting_approval` plan whose issue is open and watched, unless `planProposalHold` finds a pending one. Read off `ctx.plans`, not `eligibleIssues` — a replan of a live plan is re-approved while its parts have PRs. |
| The executor              | Creates an `approve_change` escalation plus a `plan` proposal with ref `issue:<n>:plan`, and re-asks the same hold (every path that reaches the executor is covered, not just the one that checks first).                                          |
| Accept                    | `ProposalDesk.accept` → `ActionExecutor.runAuthorized` → `releasePlan`: the plan becomes `active`, audited under `human:<proposal id>` as `authorized by you`.                                                                                     |
| Reject                    | `ProposalDesk.reject` → `refusePlan`.                                                                                                                                                                                                              |
| Replan                    | `POST /api/plans/:id/replan` withdraws a pending proposal (below).                                                                                                                                                                                 |

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
on, a plan is the only thing that schedules work for a decomposed issue (rule 3b parks the work item in
the review state for the life of the plan, and `resolvePlanRoute` fails a spent replan back to `parts`).
So `refusePlan` (`src/plans/planApproval.ts`) retires every part `partHasWork` says nothing was started
for, then takes `amendedPlanStatus('single', survivors)`:

- **`single`** — nothing was in flight, so the issue falls back to being worked as one PR by rule 4.
- **`active`** — parts are in flight, which means a _replan_ is being refused: the work already
  running carries on and the amendment's new parts are the ones retired. Collapsing here is impossible
  anyway, since git cannot create the flat `issue/<n>` branch beside the existing part refs.

An operator who wants a _different_ split presses Replan instead, which is on the same panel.

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
branch worth stacking on, else `pending`. Readiness is computed against a **working copy** with this
pulse's observations already applied, so a dependency that merged this cycle unblocks its dependent in
the same cycle.

Retired parts are skipped entirely — there is no reality to fold on, and nothing should quietly bring
them back.

### The ref-collision guard

`refs/heads/issue/12` and `refs/heads/issue/12/<slug>` cannot coexist. An issue worked as `single`
first and then replanned to `parts` has exactly that branch, and every part branch would fail to
create with a git error nobody can act on. The reconciler checks `git presence(issue/<n>)`; if the
flat branch exists locally or remotely, every uncut part is parked `blocked` and **one** clear error is
recorded naming the branch to delete or rename.

### The status comment

Each plan owns exactly **one** living comment on its issue, via
`IssueCommentCapable.upsertIssueComment` and `plans.status_comment_ref`, edited in place. It is written
when there is news: the plan appearing (no comment yet), a part moving, or the plan rolling up. Because
it is one comment rather than a stream, it is mechanical bookkeeping rather than authored prose, which
is why it is **not** auto-send gated. A failure to write it is recorded and the pulse continues —
progress reporting never takes the pulse down with it.

`Store.rollUpPlanStatus` moves a plan to `complete` when every live part is `merged`.

## Replan

`POST /api/plans/:id/replan` flips the plan row to `planning`, clears `discussing` if it was set,
withdraws any pending plan proposal, and kicks a cycle. That is all it does.

Clearing `discussing` is not optional when a replan is requested mid-conversation: the flag is what
picks the template rule 3c renders from `planning`, so leaving it set would render `discuss-plan` on
the next dispatch instead of the `issue-replan` this call actually asked for — the two routes would
disagree about what plain `planning` means. `PlanPanel.tsx` and the factory skin's `TechTree.tsx` keep
Replan visible during a discussion for exactly this reason (the modal hides it, they don't); the route
must be safe to call in that state, not merely reachable.

The withdrawal is not optional under `requireApproval`: a pending verdict holds rule 3d off the plan,
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
mechanism rule 3c already dispatches a planner from. `discussing` (new `plans` column) only picks the
prompt.

`POST /api/plans/:id/discuss`:

1. 404 when the plan is unknown.
2. **409 unless `plan.status === 'awaiting_approval'`.** Every framing of Discuss — the design, this
   section, the `discuss-plan` prompt itself ("before approving it") — only ever contemplates talking
   through a decomposition that is still a pending question. Without the guard, discussing a `single`
   plan and then ending the discussion writes `awaiting_approval` over zero parts: rule 3d proposes it,
   an operator approves an empty decomposition, `resolvePlanRoute` now returns `parts` instead of
   `single`, and the issue is parked with no ready part, no agent and no chip explaining why. Discussing
   an already-`active` plan is the milder version of the same mistake — it reopens the gate rule 4a
   already cleared and stops scheduling the remaining parts, which is exactly the harm `/discuss/end`'s
   own 409 (below) exists to prevent on the way back out. `PlanModal.tsx` hides the Discuss button
   outside `awaiting_approval` so the UI cannot offer what the route refuses.
3. `store.setPlanStatus(id, 'planning')` — exactly what `/replan` does.
4. `store.setPlanDiscussing(id, true)`.
5. Withdraw any pending plan proposal (`ProposalDesk.reject`, "superseded by a discussion"). Safe for
   the reason the replan withdrawal is safe: the status write lands first, so `refusePlan` finds the
   plan no longer `awaiting_approval` and no-ops — the withdrawal only closes the inbox item. And
   **necessary**: a pending proposal holds rule 3d (`planProposalHold`), so the amended decomposition
   would never be put to anyone, and the stale card, if accepted, would release a plan its reader never
   saw.
6. Broadcast, run a cycle.

Returns `{ ok: true, plan }`.

Rule 3c renders the `discuss-plan` template instead of `issue-replan` when `discussing` is set — same
origin (`issue:<n>:plan`), same branch (`plan/issue/<n>`), same cooldown window, same attempt cap, same
fail-open. `discuss-plan` is an ordinary overridable entry in the template book and tells the agent:
this is a conversation, not a fresh decomposition; here is the current plan and its part states; use
`escalate` to ask and answer; call `plan_submit` with the amended document once the operator is
satisfied; then finish.

**Nothing is scheduled while you talk**, and each property is an existing gate rather than a new one:

- rule 4a schedules parts only for `active` / `awaiting_approval` plans — `planning` schedules none;
- rule 3c cannot dispatch a second planner while the discussion agent holds `issue:<n>:plan`
  (`findActiveTaskByOrigin`);
- rule 3d proposes only for `awaiting_approval`, so no fresh approval card appears mid-conversation.

**The conversation needs no new transport.** The agent parks with `escalate`; replies go through
`POST /api/agents/:id/respond`, which works on any live agent and drives another turn on the default
stream runtime; the transcript comes from `GET /api/agents/:id/transcript`. The plan modal's discussion
pane is those two calls plus a link to the real drawer for tool calls.

**Three endings:**

- **It amends.** `plan_submit` → `ingestPlanDocument` clears `discussing` as part of ingestion (not
  `upsertPlan` — folding the clear into ingestion is what stops an amendment silently re-opening a
  discussion it did not ask to close) and lands `awaiting_approval`, so the next pulse's rule 3d puts a
  **fresh** proposal up. The stale card was withdrawn at step 4 above, so nothing holds it.
- **You end it.** `POST /api/plans/:id/discuss/end` — 404 when the plan is unknown, **409 when
  `plan.discussing` is false** (the same compare-and-set discipline `releasePlan`/`refusePlan` apply to
  `awaiting_approval`: an unguarded restore would force _any_ plan back to `awaiting_approval` on a
  stale or duplicate call, reopening the approval gate on a plan whose parts are already dispatched).
  Otherwise it sets the plan back to `awaiting_approval`, clears `discussing`, broadcasts and runs a
  cycle — restoring the status is not an afterthought: clearing the flag alone would leave the plan in
  `planning`, which is exactly what rule 3c dispatches a fresh planner from. It **does** end the
  discussion agent — the live task on `planOrigin(planIssueNumber(plan.originRef))`, completed through
  the same `AgentManager.complete` the cockpit's own agent-complete button uses, the clean `done`
  terminal that reclaims the worktree rather than `kill`'s abandonment. Left alive, the planner holds a
  fleet slot and a worktree with nothing to talk to — the modal's discussion pane is gated on
  `plan.discussing`, so the reply box is already gone — and a late `plan_submit` from that stale agent
  would revert this very approval back to `awaiting_approval` through ingestion's unconditional
  `requireApproval` re-check. A missing agent (already gone) or a completion that fails is a no-op, not
  a route failure: the plan restore is the important half and must land regardless. Returns
  `{ ok: true, plan }`.
- **It dies.** The plan stays `planning` with `discussing` set, so rule 3c re-dispatches, bounded by the
  existing `dispatchVerdict` attempt cap on `issue:<n>:plan`; a spent cap fails the plan back to `parts`
  exactly as a spent replan does. Deliberately the same failure envelope as replan, not a new one.

**The cost, stated:** a discussion holds a fleet slot and a worktree for as long as you take to reply.
Nothing reclaims it on a timer, and adding one would end a conversation mid-thought.

## Tests

`test/issuePlan.test.ts`, `test/planIngestion.test.ts`, `test/planPart.test.ts`,
`test/planApproval.test.ts`, `test/planReconcile.test.ts`, `test/planDiscussion.test.ts`,
`test/stackedPrs.test.ts`, `test/closedPrs.test.ts`.
