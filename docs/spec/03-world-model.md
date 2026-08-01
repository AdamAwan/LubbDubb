# 03 — World model

The domain vocabulary lives in `src/types.ts`. The cockpit names the same types rather than keeping a
copy of them: `web/src/types.ts` re-exports the wire contract in `src/wire.ts`, which is declaration-only
and reaches the SPA through `import type`, so nothing survives erasure and the web bundle still imports
no server code. See [16 — HTTP API](16-http-api.md#the-wire-contract).

## `WorldSnapshot`

One instant of the outside world, produced by `Connector.getState()`:

```ts
interface WorldSnapshot {
  takenAt: string; // ISO
  pullRequests: PullRequest[]; // OPEN pull requests, and only those
  closedPullRequests?: PullRequest[]; // PRs that left the open set within closedPrWindowMs
  issues: Issue[];
}
```

`pullRequests` contains **open PRs only**. Every dispatcher rule and every PR predicate
(`openPrForIssue`, `basePrOf`, `inheritedCiFailure`, `isStackedPr`) takes that list and trusts it to
be open. Recently-closed PRs are carried in a separate field so that property holds by construction
rather than by remembering to filter a status in nine places. **Nothing in the dispatcher reads
`closedPullRequests`.**

`takenAt` is the clock the whole cycle is judged against: cooldown arithmetic uses it rather than
wall-clock at decision time, so a cycle is evaluated against when its world was observed.

## `PullRequest`

| Field                | Meaning                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `number`       | Provider id and PR number.                                                                                                                                                                                                                                      |
| `title`, `branch`    | Title and head branch.                                                                                                                                                                                                                                          |
| `baseBranch?`        | The branch this PR targets. Absent means the provider did not report one.                                                                                                                                                                                       |
| `ciStatus`           | `passing` \| `failing` \| `pending` \| `unknown`. The fold of `ciChecks`, and the field every gate reads.                                                                                                                                                       |
| `ciChecks?`          | `CiCheck[]` — the individual checks behind `ciStatus`, each `{name, status, blocking?, advisory?}` where status is `passing`/`failing`/`pending`. Absent means the provider reported no per-check detail, which per-check CI policy reads as "act generically". |
| `unresolvedComments` | `PrComment[]` — review comments waiting on the author, each with `handled`.                                                                                                                                                                                     |
| `approved?`          | Approval folded from reviews/votes.                                                                                                                                                                                                                             |
| `mergeable?`         | Tri-state: `true`, `false`, or absent for unknown.                                                                                                                                                                                                              |
| `mergeableState?`    | `dirty` \| `behind` \| `blocked` \| `clean` \| `unknown` — GitHub's `mergeable_state`, normalised.                                                                                                                                                              |
| `merged?`            | Already merged. Once true, no rule acts on it.                                                                                                                                                                                                                  |
| `state?`             | `open` \| `merged` \| `closed`. Set by providers that report closed PRs. Read it via `prState`, never directly.                                                                                                                                                 |
| `closedAt?`          | ISO instant the PR left the open set. Only set on a closed/merged PR.                                                                                                                                                                                           |
| `labels?`            | Drives the provider-agnostic exclusion gate. Absent means no labels.                                                                                                                                                                                            |
| `url?`               | The provider's canonical web URL, when it supplies one.                                                                                                                                                                                                         |

A `CiCheck` carries two optional flags, both absent-means-the-long-standing-behaviour so every
provider and persisted row that predates them reads unchanged:

- **`blocking`** — false when the provider says the check does not block completion (an Azure
  "Optional" branch policy). Display and briefing only; nothing gates on it. Whether a _check_ blocks
  and whether the _PR_ can merge are different questions, and the second is `ciStatus`'s alone.
- **`advisory`** — the check is reported for visibility and nothing else. `classifyCiFailures` never
  classifies it (no rule, not even `match: "*"`, can claim one) and `ciNeedsAttention` never counts
  it, so it can neither dispatch an agent nor escalate. It is how a policy that merely _restates_ a
  signal something else already owns at higher fidelity — the Azure comment policy against rule `pr-review-comment` —
  is made visible without outranking the rule that owns it.

`prState(pr)` (`src/prHealth.ts`) is the only correct way to read a PR's state. It returns `state`
when present and otherwise folds back onto `merged`. It **never invents `closed`** — a PR nobody told
us was closed is open or merged, never abandoned. Inferring abandonment from a disappearance is
exactly the bug the closed-PR list exists to fix.

## `Issue`

A tracker issue or work item — the thing that becomes a PR.

| Field                     | Meaning                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `number`, `title`, `body` | Identity and content.                                                                                                                      |
| `labels`                  | All labels/tags. Drives the watch/ignore gate and label-encoded priority.                                                                  |
| `labelsAddedByViewer?`    | The subset the authenticated viewer added. `undefined` when authorship is not tracked. Read only when `issuePickupRequireOwnLabel` is on.  |
| `state`                   | `open` \| `closed` — collapsed.                                                                                                            |
| `workItemState?`          | The provider's **native** workflow state (e.g. Azure `System.State`: "New"/"Ready"/"In Review"). `undefined` for GitHub and the fake.      |
| `linkedPrNumber`          | The last PR that cross-referenced this issue. **Sticky** — it stays set after that PR merges, so no gate may treat it as "has an open PR". |
| `url?`                    | Provider web URL.                                                                                                                          |

## The ref vocabulary

Refs are the strings that tie a piece of work to the world item it exists for. They are used as task
`originRef`s, as world-event refs, as `world_read`/`report_finding` arguments, and as keys in the
cockpit's link map.

| Ref shape                    | Names                                     | Branch the dispatcher uses |
| ---------------------------- | ----------------------------------------- | -------------------------- |
| `pr:<n>`                     | A pull request (world events, link map)   | —                          |
| `pr:<n>:ci`                  | A PR's failing-CI concern                 | the PR's own `branch`      |
| `pr:<n>:mergeable`           | A PR's base-update / conflict concern     | the PR's own `branch`      |
| `pr:<n>:comments`            | A PR's unhandled review threads, together | the PR's own `branch`      |
| `pr:<n>:comment:<commentId>` | One review thread (a signal, not a dispatch origin) | the PR's own `branch` |
| `issue:<n>`                  | An issue, and its plan row's `origin_ref` | `issue/<n>`                |
| `issue:<n>:plan`             | A planning agent for that issue           | `plan/issue/<n>`           |
| `issue:<n>:part:<slug>`      | One part of a decomposed issue            | `issue/<n>/<slug>`         |
| `job:<id>`                   | An operator-launched job                  | `job.branch` or `job/<id>` |

**Origin and branch are 1:1 for every world-driven rule.** That is why the origin de-duplication gate
already functions as a branch gate. Rule `manual-job` (`job:<id>`) is the one dispatch path where the property
does not hold by construction — the operator supplies a free-string branch — so it is enforced
explicitly there (see [09](09-execution.md)).

The `issue/<n>` vs `issue/<n>/<slug>` split is why planners live on `plan/issue/<n>`: git stores refs
as files, so `refs/heads/issue/12` and `refs/heads/issue/12/plan` cannot coexist.

## World events (the activity feed)

`diffWorlds(prev, next)` in `src/world/worldDiff.ts` is pure and infra-free: no ids, no clock. The
store stamps identity and timestamps when persisting the result.

Object identity is by domain `id`. Two standing rules:

- A newly appeared object emits a single `*_opened`/`*_added` and **not** its per-field transitions on
  top — "it's new" already says everything.
- A removed object emits nothing. A disappearance is not a progress signal.

| Kind           | Emitted when                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `pr_opened`    | A PR id appears in the open list.                                                              |
| `pr_ci`        | `ciStatus` changed.                                                                            |
| `pr_approved`  | `approved` went false→true.                                                                    |
| `pr_mergeable` | `mergeable` went false→true.                                                                   |
| `pr_merged`    | `merged` went false→true **while still open**, or the PR appears in the closed list as merged. |
| `pr_closed`    | The PR appears in the closed list, not merged.                                                 |
| `pr_comment`   | An unresolved comment id appears that was not there before.                                    |
| `issue_opened` | An issue id appears.                                                                           |
| `issue_closed` | `state` went open→closed.                                                                      |
| `issue_linked` | `linkedPrNumber` went null→set.                                                                |

Because the second rule (removals are silent) is absolute, `pr_merged` **cannot** be observed on the
open list against a real provider — GitHub (`state: 'open'`) and Azure (`status: 'active'`) both drop
a PR from the world the moment it merges. The merge therefore arrives as an _appearance_ in
`closedPullRequests`. A closed row is news the first cycle it appears there and never again (it
lingers for the whole retention window), and a merge already announced off the open list — which the
fake provider does, marking a PR merged in place before it closes — is not announced twice.

## The closed-PR window

`config.closedPrWindowMs` (default 6h, `0` disables) bounds how far back a provider looks for PRs that
have left the open set. `src/integrations/closedWindow.ts` holds the provider-agnostic half:

- `closedWindowStart(nowMs, windowMs)` — the ISO instant to look back to.
- `withinClosedWindow(closedAt, since)` — the honest client-side cut. Providers filter server-side
  where the API allows, but the coarse filters available (GitHub sorts by _updated_; Azure's time
  range is boundary-inclusive) let older rows through. A PR with no recorded close time is dropped:
  it cannot be placed in the window, and a wrong "closed just now" is worse than a missing row.

Cost is deliberately bounded: **one extra list request per snapshot per provider, with no per-PR
fan-out.** A closed row carries no CI, review or comment detail, because nothing acts on a dead PR.

Three things consume the list — the world diff (above), plan reconciliation (see
[08](08-planning.md)), and the cockpit's "Recently closed" section. Each degrades to the older
"absence means merged" reading when the window is disabled or the provider does not report closed PRs.

## Harness-internal types

- **`Task`** — `kind`, `title`, `prompt`, `branch`, `originRef`, plus `originTitle` /
  `originSummary` / `dispatchReason` captured at dispatch so the cockpit can explain a running agent
  without re-fetching. Status: `queued` \| `running` \| `waiting` \| `done` \| `interrupted` \|
  `failed`. Active means `queued`, `running` or `waiting`.
- **`Agent`** — `taskId`, `status`, `cwd`, `pid`, `waitingReason`, `sessionId`, timestamps, cumulative
  usage (`costUsd`/`inputTokens`/`outputTokens`/`numTurns`), and the progress `note` + `notedAt`.
  Status: `starting` \| `running` \| `waiting` \| `done` \| `killed` \| `interrupted` \| `failed`.
  Live means `starting`, `running` or `waiting`.
- **`Job`**, **`Finding`**, **`Plan`**, **`PlanPart`** — see [13](13-jobs-and-findings.md) and
  [08](08-planning.md).
- **`Escalation`** — `type` (`approve_change` \| `answer_question` \| `resolve_ambiguity` \|
  `review_reply`), `status` (`open` \| `answered` \| `dismissed`), `prompt`, `context`, optional
  `agentId`/`taskId`, `response`.
- **`Action`** / **`Decision`** — see [05](05-dispatcher.md).
- **`WorldEvent`**, **`ErrorLogEntry`** — see [18](18-observability.md).
- **`AgentFlag`**, **`AgentFile`** — see [12](12-artifacts-and-files.md).
