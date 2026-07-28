# 05 — Dispatch

The dispatcher answers one question per cycle: _given the world and the fleet, what should happen?_
Its output is a bounded, validated action plan — never direct effects.

```ts
interface Dispatcher {
  decide(ctx: DispatchContext): Promise<DispatchResult>;
}
```

`DispatchResult` is `{ actions, rejected, rationale, upcoming? }`.

## The action vocabulary

`src/dispatcher/actions.ts` defines the complete set as a zod discriminated union on `type`. This is
what makes an LLM decision-maker safe: it can only ever ask for one of these, and anything malformed
is rejected and audited rather than executed.

| Action                | Required payload                          | Optional payload                                                               |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| `dispatch_code_agent` | `branch`, `title`, `prompt`, `reason`     | `originRef`, `originTitle`, `originSummary`, `jobId`, `partId`, `base`, `rule` |
| `dispatch_desk_agent` | `title`, `prompt`, `reason`               | `originRef`, `originTitle`, `originSummary`, `jobId`, `rule`                   |
| `escalate_to_human`   | `escalationType`, `prompt`, `reason`      | `context`, `taskId`, `agentId`, `rule`                                         |
| `respond_to_agent`    | `agentId`, `response`, `reason`           | `originRefs`, `rule`                                                           |
| `reply_on_pr`         | `prNumber`, `draft`, `reason`             | `commentId`, `confidence` (0..1), `rule`                                       |
| `merge_pr`            | `prNumber`, `reason`                      | `method` (`merge`\|`squash`\|`rebase`, default `squash`), `confidence`, `rule` |
| `propose_plan`        | `planId`, `originRef`, `prompt`, `reason` | `rule`                                                                         |
| `set_work_item_state` | `number`, `state`, `reason`               | `rule`                                                                         |
| `no_op`               | `reason`                                  | `rule`                                                                         |

`reason` is mandatory on every action — it is what the audit log shows. `rule` defaults to `null`,
because the LLM dispatcher reasons freely and emits none.

`parseActions(raw)` validates an array, partitioning into `actions` and `rejected` (each rejected item
keeps its raw value and a joined zod error path/message). Absent `confidence` is treated as **0**:
"no confidence stated" means never auto-send.

## The rule book

`src/dispatcher/rules.ts` holds `DISPATCH_RULES` — the rule registry as data. Every action the
`RuleDispatcher` emits carries a `rule` id from it; `Store.recordDecision` lifts the id into the
`decisions.rule` column; and `/api/state` ships the whole registry so the cockpit's Decision log can
expand a row into the rule that fired and why that rule exists.

| Id                         | №    | Name                     | Fires when                                                                                                                                                |
| -------------------------- | ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual-job`               | 0    | Operator-launched job    | A queued job exists. Drained ahead of every world-driven rule.                                                                                            |
| `pr-ci-failing`            | 1    | Failing CI               | An open PR has failing CI that is not inherited from its base, at least one failing check is actionable under `ci.checks`, and no agent is on its branch. |
| `pr-ci-blocked`            | 1b   | CI blocked elsewhere     | Same, but every failing check is configured non-actionable and at least one asks to escalate. Asked once; no agent is dispatched.                         |
| `pr-base-update`           | 2    | Base out of date         | A PR is `behind` its base or conflicts with it.                                                                                                           |
| `pr-review-comment`        | 2b   | Unhandled review comment | A PR carries an unhandled review comment.                                                                                                                 |
| `branch-notify`            | 1–2b | One agent per branch     | A fresh PR signal lands on a branch whose agent is already **running**.                                                                                   |
| `pr-merge-ready`           | 3    | Merge-ready PR           | A non-stacked PR is green, approved, mergeable, and has no unhandled comments.                                                                            |
| `work-item-in-review`      | 3b   | Back off to review state | A work item in a pickup state has an open PR (or is decomposed).                                                                                          |
| `work-item-back-to-pickup` | 3b   | Return from review state | A still-open work item parked in the review state has no open PR and an explicit `more_work` conclusion.                                                  |
| `issue-plan`               | 3c   | Issue needs a plan       | With planning on, a watched open issue has no plan yet — or an operator asked for a replan.                                                               |
| `plan-approval`            | 3d   | Plan needs your approval | With `planning.requireApproval` on, a decomposition is `awaiting_approval` and no verdict is pending.                                                     |
| `issue-assess`             | 3e   | Issue may be finished    | With assessment on, a watched open issue has had work, has nothing in flight and no open PR.                                                              |
| `plan-part`                | 4a   | Plan part ready          | A part of an active plan is `ready` and unstaffed.                                                                                                        |
| `issue-pickup`             | 4    | Open issue without a PR  | An eligible open issue has no **open** PR and no agent on it, and its plan says `single`.                                                                 |
| `cooldown-escalate`        | 1–4  | Attempt cap reached      | An origin spent its dispatch attempts without clearing.                                                                                                   |
| `story-groom`              | 5    | Story grooming           | A ready story lacks a description or acceptance criteria.                                                                                                 |
| `story-waf`                | 6    | Missing WAF pillars      | A ready story has no WAF pillars.                                                                                                                         |
| `story-pickup`             | 7    | Idle capacity pickup     | Headroom remains and a groomed ready story is the highest priority.                                                                                       |
| `idle`                     | 8    | Nothing actionable       | No rule matched — recorded as a `no_op`, so idleness stays auditable.                                                                                     |

## Rank-then-slice

Agent-dispatch rules do **not** dispatch inline. Each collects a `Candidate`
(`{origin, rule, title, kind, branch, reason, action, held?}`) onto one ordered list. Only after every
rule has run does a single walk apply the headroom cut:

- A candidate whose origin already has an active task is skipped entirely (it is staffed, so it is
  not "up next").
- A candidate with `held` set — `'cooldown'` or `'capped'` — is queued with that status and **never
  dispatched, whatever the headroom**.
- Otherwise, while headroom remains: the action is emitted, the origin is added to `activeOrigins`,
  headroom decrements, and the item is queued as `dispatching`.
- With headroom exhausted, the remainder queue as `waiting`.

The whole ranked list — above and below the cut — is returned as `DispatchResult.upcoming`
(`QueueItem[]`). This is what makes the cut visible instead of making below-cut work vanish.

**Any new dispatch rule must route through the candidate list.** An inline `raw.push` of a
`dispatch_*` action bypasses both the headroom cut and the queue.

### Candidate order

Candidates are appended in this order, and the order _is_ the priority:

1. **Queued jobs** (rule 0), oldest first — a manual request takes the next free slot.
2. **PR concerns** (rules 1/2/2b), ranked **cross-PR** by concern class (CI > base-update > review
   comment) then by PR number. World order is arbitrary and must not decide who wins scarce headroom.
   Only the single most urgent concern per PR becomes a candidate.
3. **Planners** (rule 3c) — a planner unblocks work, so it wins a slot before the work it unblocks.
4. **Assessors** (rule 3e) — an assessment decides whether an issue needs work at all, so it is
   asked before the work is scheduled. An assessed issue is **suppressed** from rule 4 that cycle;
   see below.
5. **Plan parts** (rule 4a), ranked by dependency depth, then issue number, then part sequence, so
   the bottom of a stack is cut before the branch its dependents will base on is needed.
6. **Issue pickups** (rule 4), ordered by label-encoded priority then issue number.
7. **Story grooming and WAF** (rules 5/6).
8. **Story pickup** (rule 7) — ranked last, so at zero headroom it queues as `waiting` rather than
   silently vanishing.

Non-dispatch actions (`merge_pr`, `propose_plan`, `set_work_item_state`, `escalate_to_human`,
`respond_to_agent`) are
pushed directly, because they claim no headroom.

### Operator re-ordering (issue #128)

The operator can change what the harness picks up first by re-ordering the cockpit's Up next panel.
Because the queue is a per-pulse projection, what persists is not the array but a **priority
override keyed on the candidate's origin** — the same stable identity every rule and gate already
uses. Overrides live in the `priority_overrides` store table and reach the dispatcher as
`DispatchContext.priorityOverrides`.

The pure `rankByPriorityOverride` (`src/dispatcher/priorityOverride.ts`) re-sorts the collected
candidates **once, immediately before the headroom cut**, into three tiers:

1. **Rule-0 jobs stay first**, in their own order — a manual job is distinct work, not a
   re-prioritisation of existing work, so an override never moves one.
2. **Overridden origins next**, by ascending rank (`0` = "do this next"). This is what jumps a
   world-driven item ahead of the natural cross-rule ranking above.
3. **Everything else** keeps its natural (already-ranked) order, so an item the harness surfaces
   later slots in behind the arranged prefix until the operator re-arranges.

It **only re-orders**. It never clears a `held` verdict: a cooldown, cap, pause, ignore tag or
unapproved plan holds an item wherever the override places it, because the cut walk reads `held`
independently of position. Overriding a hold _into_ dispatch is a different feature, out of scope.

An override is written by `POST /api/upnext/order` (replace-all) and pruned once its origin stops
being tracked — see [16](16-http-api.md) and [14](14-persistence.md).

## `QueueItem`

```ts
{ origin, rule, title, kind, branch, status: 'dispatching' | 'waiting' | 'cooldown' | 'capped', reason }
```

`Harness` caches the last plan as `harness.upcoming` (`{cycleId, at, items}`), and
`buildStateSnapshot` ships it as `upcoming`. It is a **per-pulse projection recomputed from the world
every cycle**, not a persisted FIFO.

## The re-dispatch cooldown

`src/dispatcher/dispatchCooldown.ts`. The dispatcher's origin de-dup only sees _currently active_
tasks, so an agent that finishes without clearing its concern would leave the origin dispatchable and
be re-spawned every heartbeat. `dispatchVerdict(origin, now, recentDecisions, policy)` supplies the
missing memory, purely from the audit log:

| Verdict    | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `dispatch` | Free to (re-)dispatch.                                            |
| `cooldown` | Attempted too recently; queued as held, retried after the gap.    |
| `escalate` | The attempt cap is spent and no human has been looped in yet.     |
| `hold`     | Cap spent and already escalated — do nothing, do not re-escalate. |

`DEFAULT_COOLDOWN` is `{ maxAttempts: 3, cooldownMs: 900000 }` (15 minutes). Only **executed**
dispatches count as attempts: a deferred one (paused, or no headroom) never ran. "Now" is the world
snapshot's `takenAt`. An `escalate` verdict emits `escalate_to_human` tagged `cooldown-escalate`,
which claims no headroom.

## One agent per branch

For a PR whose branch already has an active task, `resolveBranchAgent` returns:

- **`running`** — the branch's agent is live. Every fresh, not-yet-notified concern is collapsed into a
  single `respond_to_agent` note listing them, tagged `branch-notify`, carrying the concern origins in
  `originRefs`.
- **`busy`** (queued / starting / **waiting**) — every note is held. Injecting into a waiting agent
  would call `agents.respond`, which flips `waiting → running` and would derail a pending human
  escalation. The signals persist, so a later cycle delivers them once the agent is running.
- **`free`** — a dispatch candidate.

Notify de-duplication reads `recentDecisions`: `notifiedOriginsByAgent` collects `agentId::origin`
pairs from **executed** `respond_to_agent` decisions, so a persistent signal is not re-notified every
cycle. It is best-effort over the recent window — a note that ages out simply gets sent again.

## Rule 3b — work-item state

Opt-in: it fires only when the operator set **both** `issueInReviewState` and a non-empty
`issuePickupStates`, and only for items carrying a native `workItemState` (Azure work items; GitHub
issues have none, so it is a no-op for them). It never fires on a closed item.

- Item in a pickup state **and** (an open PR exists for it, or its plan is decomposed) → move it to
  `issueInReviewState`.
- Item in `issueInReviewState` with no open PR **and an explicit `more_work` conclusion** → move it
  back to the **first** entry of `issuePickupStates`. There is no separate config for the return
  state: the first pickup state is the operator's own "start here".

Both directions are idempotent — after either move the item no longer matches.

The inverse arm's gate is the conclusion, **not** the absence of a PR, and that is load-bearing.
`openPrForIssue` reads only the open list, so "this PR merged" and "there was never a PR" are one
observation; releasing on absence therefore bounced a merged ticket back to "Ready" and had rule 4
put a fresh agent on work already sitting on the default branch. `done` and `undeclared` both leave
the item where it is — see [the conclusion verdict](06-issue-pickup.md#concluding-an-issue) for why
silence stops the harness rather than releasing it.

A decomposed item needs no special case here: an in-flight plan resolves to `more_work` through the
roll-up and a `complete` one to `done`, which is exactly what the old explicit `decomposed` check
gave it — the item stays in the review state for the whole life of its plan rather than bouncing back
to "Ready" in every gap between parts.

## Rule 3e — the assessor

`assessment.enabled` (**off by default**) puts an assessing agent in front of re-pickup. It exists
because rule 3b's park is a **tracker state**, so it only protects providers that have one: on
GitHub there is no review state, `openPrForIssue` reads only the open list, and the moment a
delivering PR merges the issue is again "open, watched, no open PR" — rule 4's entire precondition.
A fresh agent is then put on work already sitting on the default branch, bounded only by the attempt
cap. `delivered` is the same park, generalised off the tracker onto a row the harness owns.

The rule dispatches a **code** agent — it needs a worktree to read what was delivered — on branch
`assess/issue/<n>`, origin `issue:<n>:assess`, based on `defaultBranch` (merged work is _on_ it, so
it is the only checkout in which the question can be answered). The branch namespace is not
cosmetic, for `plan/issue/<n>`'s reason: git stores refs as files, so `refs/heads/issue/12` and
`refs/heads/issue/12/assess` cannot coexist.

It fires for issue N when all of:

- N is open and passes `issueWatchGateReason`. Deliberately **not** driven off `eligibleIssues`, for
  rule 4a's reason — that list applies the workflow-state gate, and the Azure case this must cover
  is precisely an item rule 3b parked in the review state.
- No `delivered` verdict stands, no open PR, and no plan still scheduling something
  (`planning`/`active`/`awaiting_approval`).
- Nothing live on `issue:N` or any `issue:N:*` origin.
- **At least one task has ever existed** on `issue:N` or a descendant origin (`hasPriorWork`).
- `dispatchVerdict('issue:N:assess')` says dispatch.

The prior-work condition does two jobs. It stops the assessor being noise — without it a brand-new
issue satisfies every other precondition trivially, since nothing is in flight because nothing ever
started. It is also the **discriminator that lets assess and pickup coexist** on an issue both would
otherwise claim: no prior tasks means the work has not started, so rule 4 picks it up; prior tasks
with nothing in flight means it may be finished, so the assessor asks. An issue the assessor claims
this cycle is **suppressed** from rule 4, or two agents land on it — one judging, one redoing.

It is answered from `ctx.tasks`, **never from the work graph**. `issue:<n>` and `issue:<n>:*` is
exactly the subtree's origin vocabulary, which is why it reads like a graph query; it is the same
question asked of the source the dispatcher already holds. Nothing in `src/dispatcher/` reads the
graph — see [`14-persistence.md`](14-persistence.md).

**It fails open**, exactly as the planner does: a spent attempt cap returns the issue to ordinary
pickup with **no escalation**, because narrowing rule 4 without that turns any assessor crash into a
permanently parked issue. A cooling assessor suppresses pickup for that cycle only and stays visible
in the queue as `cooldown`.

The agent casts its verdict with the `assess_issue` tool ([`11-mcp-tools.md`](11-mcp-tools.md)):
`delivered` writes the park, `more_work` writes the `issue_conclusions` row rule 3b's inverse arm
already reads. See [`06-issue-pickup.md`](06-issue-pickup.md) for what the park holds and what ends
it.

## Rule 3 — the merge gate

A PR is merge-ready when **all** of:

- it is not stacked (`isStackedPr(pr, defaultBranch)` is false),
- `ciStatus === 'passing'`,
- `approved === true`,
- `mergeable === true`,
- `mergeableState` is none of `behind`, `blocked`, `dirty`,
- every entry of `unresolvedComments` is `handled`.

It emits `merge_pr` with `method: 'squash'` and `confidence: 0.9`. The executor then authorizes it —
merging or putting it to a human — see [09](09-execution.md#authorizing-an-outbound-act).

**Unless a verdict on `pr:<n>:merge` is standing.** `proposalHold(kind, ref, ctx.proposals,
{rejectionSignals: ctx.rejectionSignals})` suppresses the rule while the merge is unanswered or has
been rejected, so one question is asked once. A rejection stops standing at the first world event on
that PR since it was given (`DispatchContext.rejectionSignals`, wired in `harness.ts`), at which point
this rule fires again — and the merge-readiness list above still has to pass, which is what keeps the
expiry from re-asking on a PR that has merely been commented on.

## The rationale

`buildRationale` produces `"Rule dispatcher: nothing actionable."` for a lone `no_op`, otherwise
`"Rule dispatcher chose N action(s): <types>"`. It is persisted as its own decision row each cycle.

## The `claude` dispatcher

`src/dispatcher/claudeDispatcher.ts` drives a Claude Code session over the same `PtySession`
abstraction as agents:

- The prompt states the headroom, the allowed action types, the requirement that every action carries
  a `reason`, the `confidence` contract for `reply_on_pr`, the operator's `steeringPriorities`, the
  issue-pickup policy rendered as guidance, and the full state as JSON.
- The model is asked to bracket a JSON object between `@@LUBBDUBB_PLAN_START@@` and
  `@@LUBBDUBB_PLAN_END@@`. The session is finished on seeing the end sentinel, on `done`/`failed`/
  `exit`, or on a 120-second timeout.
- The extracted block is parsed and run through the **same** `parseActions`. No parseable block, or
  invalid JSON, yields zero actions and an explanatory rationale — never a partial effect.

It returns **no `upcoming`**, so the cockpit's Up next panel is empty under this dispatcher. It also
does not implement the planning funnel or prompt templates; it is steered via `steeringPriorities`
instead.

## Prompt templates

`src/dispatcher/promptTemplates.ts` holds every agent- and escalation-facing prompt the rule
dispatcher emits, each under a stable `PromptId`, each with a built-in default, a declared placeholder
list, and a doc string.

Ids: `issue-plan`, `issue-replan`, `plan-part`, `plan-approval`, `plan-part-escalation`, `issue-pickup`,
`issue-pickup-escalation`, `pr-ci-fix`, `pr-base-update-behind`, `pr-base-update-conflict`,
`pr-review-comment`, `pr-concern-escalation`, `story-groom`, `story-waf`, `story-pickup`.

Overrides: drop `<id>.md` into `promptTemplatesDir` (default `.lubbdubb/prompts`). They are read
**once at boot**. `loadPromptTemplates` fails fast — at boot, not as a silently broken prompt — when a
file names no known id, references a placeholder the id does not declare, or is empty once its doc
header is stripped. A single leading `<!-- ... -->` block is stripped before the prompt reaches the
agent; a comment inside the body is left alone. `renderTemplate` substitutes `{name}` tokens and
leaves an unmatched token untouched.

`docs/prompt-templates/` holds ready-to-copy samples of the current defaults, one file per id.
