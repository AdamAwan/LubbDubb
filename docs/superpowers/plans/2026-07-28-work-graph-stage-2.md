# Work graph stage 2 — the assessor, task by task

**Spec:** [`../specs/2026-07-28-work-graph-stage-2-assessor-design.md`](../specs/2026-07-28-work-graph-stage-2-assessor-design.md)
**Stage 1:** shipped in PR #150 (merge commit `d428397`)

Eight tasks, in order. Each ends with `npm run check` green — knip runs every rule at
`error`, so a task that adds an export must add its consumer (a test counts:
`includeEntryExports` holds test files to the same standard). Do not batch or reorder.

## Signatures verified against the tree

Written down because stage 1's plan invented three APIs and got four test-helper fields
wrong, and each one cost a subagent a wasted pass. Everything below was read out of the
source at plan time.

| Thing                           | Actual                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Store.recordIssueConclusion`   | `(input: {originRef, verdict, note, by, agentId?, taskId?}) => IssueConclusion` — upsert, preserves `createdAt` |
| `Store.getIssueConclusion`      | `(originRef: string) => IssueConclusion \| null`                                                                |
| `Store.clearIssueConclusion`    | `(originRef: string) => boolean`                                                                                |
| `Store.listIssueConclusions`    | `() => IssueConclusion[]`                                                                                       |
| `AgentManager.recordConclusion` | `(agentId, verdict, note) => {ok:true, conclusion} \| {ok:false, error}` — resolves origin from the credential  |
| `ConclusionAuthor`              | `'agent' \| 'operator'` (`src/types.ts:557`) — gains `'assessor'`                                               |
| `IssueConclusionVerdict`        | `'done' \| 'more_work'` — **unchanged**, `delivered` does not join it                                           |
| `conclusionOrigin`              | `(originRef: string \| null) => {ok:true, originRef} \| {ok:false, error}` (`src/issueConclusion.ts:132`)       |
| `IssuePickupStatusKind`         | 10-member union at `src/dispatcher/issuePickup.ts:180`, **not exported** — gains `'delivered'`                  |
| `IssuePickupContext`            | exported interface at `issuePickup.ts:201`                                                                      |
| `PlanningPolicy`                | `src/plans/planning.ts:11` — the shape `AssessmentPolicy` mirrors                                               |
| config default                  | `src/config.ts:365` — `planning: {enabled: false, …}` sits here                                                 |
| `dispatchVerdict`               | `(origin, now, recentDecisions, policy) => DispatchVerdict` (`dispatchCooldown.ts:43`)                          |
| `DEFAULT_COOLDOWN`              | `{maxAttempts: 3, cooldownMs: 15*60_000}`                                                                       |
| `Store.listWorldEventsSince`    | `(since: string, refs: string[]) => WorldEvent[]` (`store.ts:1171`)                                             |
| `rejectionSignalQuery`          | `(proposals) => {since, refs} \| null` — the shape `deliverySignalQuery` mirrors                                |
| `Store.listWorkSubtree`         | `(rootRef: string) => WorkNode[]`                                                                               |
| `WorkNodeKind`                  | includes `'assess'` already (`src/types.ts:296`) — reserved by stage 1, unwritten                               |
| `worldDiff` issue events        | `issue_opened`, `issue_closed`, `issue_linked` only — **no `workItemState` event**                              |
| `buildApp`                      | `buildApp(system)` — one arg, config off `system.config`                                                        |
| `connector.resolveRefUrl`       | synchronous, non-optional                                                                                       |

Repo facts that bit stage 1 and still apply: ESM with explicit `.js` extensions on every
relative import; `src/store/store.ts` is the only file touching SQLite; a fresh
`CREATE TABLE` needs no `Store.migrate()` entry but a column on an existing table does;
tests close with `system.store.close()`; route tests opt out of auth with
`auth: { enabled: false } as never`; the fake connector has no `pr_merged` event (a merge
is `pr_closed` with `merged: true`, which moves the row into `closedPullRequests` and
never expires it — `FakeWorldStore` is how a test ages it out).

---

## Task 1 — the table and the store methods

**Goal.** `issue_deliveries` exists and the store can read, write and clear it, with the
mutual exclusion against `issue_conclusions` enforced in the write.

**Files.** `src/types.ts`, `src/store/schema.ts`, `src/store/store.ts`,
`test/issueDelivery.test.ts` (new).

- `IssueDelivery` + `DeliveryAuthor = 'assessor' | 'operator'` in `src/types.ts`.
- Schema per the spec. Fresh table → **no `migrate()` entry**.
- `Store.recordDelivery(input: {originRef, summary, by, agentId?, taskId?})` — upsert on
  `origin_ref`, preserving `decided_at` across an overwrite the way
  `recordIssueConclusion` preserves `created_at`. **In the same transaction it deletes
  the issue's `issue_conclusions` row.**
- `Store.recordIssueConclusion` gains the mirror: it deletes the issue's
  `issue_deliveries` row. Both directions in the store, because it is the only file that
  touches SQLite and a caller that forgot one would leave the two contradicting.
- `Store.listDeliveries()`, `Store.getDelivery(originRef)`, `Store.clearDelivery(originRef) => boolean`.

**Test.** Upsert preserves `decidedAt`; a delivery write clears a standing conclusion;
a conclusion write clears a standing delivery; clear returns false for a missing row.

**Watch for.** `listDeliveries` is unbounded on purpose, exactly as `listProposals` is:
a verdict that aged out of a window would silently re-open pickup on delivered work.
Say so in the doc comment.

---

## Task 2 — the pure hold predicate

**Goal.** One function decides whether a standing delivery holds pickup.

**Files.** `src/delivery/delivery.ts` (new), `test/delivery.test.ts` (new).

- `deliveryHold(delivery: IssueDelivery | null, issue: Issue, ctx: DeliveryHoldContext) => string | null`.
  Null = free to pick up; a string is the operator-facing reason.
- Two arms, in this order:
  1. **Pickup-state observation.** `ctx.pickupStates` non-empty and
     `issue.workItemState` is one of them → cleared. The tracker move is the override.
  2. **World signal.** Any `WorldEvent` on `issue:<n>` with `createdAt > delivery.decidedAt`
     → cleared.
- `deliverySignalQuery(deliveries) => {since, refs} | null`, mirroring
  `rejectionSignalQuery`: bounded by time and item, null when nothing stands so a
  deployment with no verdicts does no read at all.
- The ref mapping (`issue:<n>` from an origin) is **not exported** — the match and the
  ask must not be able to disagree, which is the reason `proposalWorldRef` is private.

**Test.** Each arm alone; both absent → holds; a signal _older_ than the verdict does not
clear; `deliverySignalQuery` returns null for an empty list and the oldest `since` across
several.

**Watch for.** Arm 1 reads current _state_, not a transition — `worldDiff` emits nothing
for a `workItemState` change, and the spec argues at length why adding one would be
wrong. Do not add an `issue_state` event.

---

## Task 3 — wire the gate

**Goal.** A standing delivery stops rule 4, and the cockpit chip says so.

**Files.** `src/dispatcher/dispatcher.ts` (`DispatchContext`), `src/harness.ts`,
`src/dispatcher/ruleDispatcher.ts`, `src/dispatcher/issuePickup.ts`,
`src/server/app.ts` (snapshot), `test/delivery.test.ts`.

- `DispatchContext` gains `deliveries?: IssueDelivery[]` and `deliverySignals?: WorldEvent[]`.
- `harness.ts` wires both beside `conclusions`/`rejectionSignals`: read
  `store.listDeliveries()`, derive the query with `deliverySignalQuery`, and only then
  call `store.listWorldEventsSince`.
- Rule 4's `eligibleIssues` filter gains the `deliveryHold` check.
- `IssuePickupContext` gains `deliveries?`/`deliverySignals?`; `issuePickupStatus` gains
  the `'delivered'` status kind, checked **after** `has_pr` and `active` (a delivered
  issue that somehow has an open PR is honestly `has_pr` — the PR rules own it).
- `buildStateSnapshot` passes the same two through, so the chip predicts the rule.

**Test.** A standing delivery makes rule 4 dispatch nothing for that issue and
`issuePickupStatus` report `delivered`; clearing it (either arm) restores both.

**Watch for.** The gate is asked in exactly two places off the one predicate. It is
deliberately **not** asked in the executor — the spec says why (pickup is world-driven
only, unlike the prose-driven acts the jobs/proposals pairs guard).

---

## Task 4 — the rule

**Goal.** `issue-assess` dispatches an assessor, ahead of pickup and suppressing it.

**Files.** `src/plans/planning.ts` or a new `src/delivery/assessment.ts` for
`AssessmentPolicy`, `src/config.ts`, `src/dispatcher/rules.ts`,
`src/dispatcher/promptTemplates.ts`, `src/dispatcher/ruleDispatcher.ts`,
`src/system.ts`, `test/issueAssess.test.ts` (new).

- `AssessmentPolicy { enabled: boolean }`, default `{enabled: false}`, mirroring
  `PlanningPolicy`'s shape and its off-by-default stance.
- `DISPATCH_RULES` entry `issue-assess`, number `'3e'`, with the standing rationale.
- Prompt template `issue-assess` (+ `issue-assess-escalation`? **no** — the rule fails
  open with no escalation, so there is no escalation template. Do not add one).
  Placeholders: `{number} {title} {body} {branch}`.
- The rule, per the spec's condition list. Collect through the shared `candidates` list
  so the headroom cut and the Up-next queue see it — never an inline `raw.push`.
- **Prior-task condition from `ctx.tasks`**: any task whose `originRef` is `issue:N` or
  starts with `issue:N:`. Not from the graph. Not negotiable.
- Suppression: build the candidate issue-number set once, and have rule 4's loop skip
  those numbers.
- Fail-open: `dispatchVerdict` returning `escalate`/`hold` for `issue:N:assess` means
  the issue is **not** suppressed and pickup proceeds — no escalation action emitted.

**Test.** Fires with prior tasks and no open PR; does not fire for a fresh issue; does
not fire with the flag off; suppression (never both in one cycle); fail-open after the
attempt cap; the watch/ignore gate applies.

**Watch for.** `WorktreeManager.ensure` is reuse-first and ignores `base` when the branch
already exists, so the action must carry `base: config.defaultBranch` and the branch must
be `assess/issue/<n>` — `issue/<n>` would collide with the pickup branch and, worse, git
cannot create `issue/12/assess` beside `issue/12`.

---

## Task 5 — the `assess_issue` tool

**Goal.** The assessor can cast its verdict, and only the assessor can.

**Files.** `src/mcp/assessment.ts` (new), `src/mcp/names.ts`, `src/mcp/tools.ts`,
`src/agents/agentManager.ts`, `src/issueConclusion.ts`, `src/types.ts`,
`test/mcpChannel.test.ts` (extend — do not create a parallel file).

- `validateAssessment(args)` in `src/mcp/assessment.ts`, mirroring `validateConclusion`:
  verdict in `['delivered', 'more_work']`, summary required and not trimmed away.
- `assessmentOrigin(originRef)` — accepts `issue:<n>:assess` only, and refuses everything
  else with a message naming the right tool, the way `conclusionOrigin` does.
- `AgentManager.recordAssessment(agentId, verdict, summary)`, routed through the manager
  (not straight to the store) so the event repaints the cockpit now. `delivered` →
  `store.recordDelivery(…, by: 'assessor')`; `more_work` →
  `store.recordIssueConclusion(…, by: 'assessor')`. Mutual exclusion is already in the
  store from task 1 — do not re-implement it here.
- `ConclusionAuthor` gains `'assessor'`; `resolveIssueConclusion`'s consumers render it
  (rule 3b's reason string has a `by ===` chain that needs the arm).
- `MCP_TOOL_NAMES` gains `assess_issue`. `ALLOWED_MCP_TOOLS` is derived from it, so the
  grant follows automatically — but assert the three-way agreement, as
  `test/mcpChannel.test.ts` already does for the existing tools.
- `conclusionOrigin` gains the assessor refusal arm.

**Test.** An assessor origin may cast both verdicts; a pickup/part/planner/job origin is
refused with a message naming `assess_issue` or `conclude_work` as appropriate; the
verdicts land in the right tables and clear each other.

**Watch for.** Identity is structural — no issue argument on the tool. The origin comes
from the credential.

---

## Task 6 — the graph reaches the agent

**Goal.** `world_read('issue', …)` carries the work subtree, and the fold writes `assess`
nodes.

**Files.** `src/mcp/worldRead.ts`, `src/mcp/tools.ts`, `src/graph/workGraph.ts`,
`test/mcpChannel.test.ts`, `test/workGraph.test.ts`.

- The issue payload gains `work`: `store.listWorkSubtree(issueOrigin(n))`, alongside the
  plan graph it already carries. The store lookup belongs in the tool layer, not in the
  pure `worldRead.ts` reader — that file's doc comment already draws that line.
- Carry `provenance` through verbatim. The prompt (task 4) tells the assessor that an
  `inferred` merge is weaker evidence than an `observed` one; the payload has to let it
  tell them apart.
- `foldWorkGraph` gains an arm for `issue:\d+:assess` task origins → an `assess` node
  parented to `issue:<n>`, **never terminal** (a concern's reasoning, for a concern's
  reason).

**Test.** The subtree reaches the payload including an aged-out merged PR with
`provenance: 'observed'`; the `assess` node appears under its issue and is not terminal.

**Watch for.** This is `src/mcp/`, not `src/dispatcher/` — the stage-1 structural
assertion in `test/workGraph.test.ts` names the files under `src/` allowed to import
`graph/workGraph`. `worldRead` reaches the graph through **`Store.listWorkSubtree`**, not
by importing the fold, so that assertion is untouched. **Do not edit it.** If it fails,
fix the file it names.

---

## Task 7 — the cockpit

**Goal.** An operator can see a delivery verdict and set or clear it.

**Files.** `src/server/app.ts`, `web/src/types.ts`, `web/src/App.tsx`,
`test/cockpitAuth.test.ts` (it walks the route table — the new route is covered
automatically), `test/issueAssess.test.ts`.

- `POST /api/issues/:n/delivered` — `{delivered: boolean, summary?: string}`. True writes
  `by: 'operator'`; false calls `clearDelivery`.
- The snapshot ships the standing delivery per issue beside `pickup`.
- The chip renders the `delivered` status kind from `issuePickupStatus` — the existing
  `pickupChip` in `web/src/App.tsx`, not a new component.

**Watch for.** Under the guarded `/api` prefix, so nothing per-route is needed and
**`test/cockpitAuth.test.ts` must not be edited to accommodate it**. `typecheck:web` is a
separate pass from `typecheck`; a change spanning `src/` and `web/` must satisfy both.

---

## Task 8 — docs

**Goal.** The specs describe what shipped.

**Files.** `docs/spec/` (the dispatcher rules document and the persistence document —
find the ones that own rule numbering and the table list), `CLAUDE.md`.

- A "Where things live" bullet for `src/delivery/`, in the register of the existing ones:
  what it is, the two-arm expiry and why there is no timer, why `issue_deliveries` is not
  a third `IssueConclusionVerdict`, and the prior-task condition doing two jobs.
- Extend the stage-1 work-graph bullet to say the assessor is the first consumer and that
  it reads through `world_read`, not through a rule.
- Record the **stage-1 backfill gap** as a known limitation in `docs/spec/14-persistence.md`
  — the operator ruled to leave it, and it currently lives only in the PR #150 body, which
  is not where anyone will look for it.

---

## Then

`npm run check`, commit each task separately, push to
`claude/work-graph-stage-1-handoff-404xnm`, open the PR as ready for review.

Stage 3 ("nothing gets done without a recorded work item") is separately specced and is
**not** part of this.
