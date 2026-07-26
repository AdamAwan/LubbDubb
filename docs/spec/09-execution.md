# 09 — Action execution

`src/executor/actionExecutor.ts` turns a validated action plan into real effects, applying the guard
rails. Every decision — executed, deferred, rejected or skipped — is written to the audit log with its
reason, so "why did (or didn't) this happen" is always answerable.

## Outcomes

| Outcome    | Meaning                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------- |
| `executed` | The effect happened.                                                                        |
| `deferred` | Deliberately not now; the same action will be re-planned next cycle.                        |
| `rejected` | Malformed, or the effect failed.                                                            |
| `skipped`  | Not needed — the work is already being done, or the target is gone.                         |

`ExecutionSummary` counts `executed`, `deferred` and `rejected` (skips are recorded but not counted).

## Order of processing

1. **Rejected items first.** Everything `parseActions` refused is audited as `rejected` with the zod
   error and the raw JSON, and never run.
2. `liveCount` is read once from `store.countLiveAgents()` and incremented locally as agents spawn, so
   the cap holds within a single cycle's plan.
3. Each validated action is handled by type.

## The dispatch gates

For `dispatch_code_agent` and `dispatch_desk_agent`, in this exact order:

### 1. Origin gate — `skipped`

`store.findActiveTaskByOrigin(originRef)`. If an active task already holds the origin, the action is
skipped: *this work is already being done.*

### 2. Branch gate — `deferred` (code dispatches only)

`store.findActiveTaskByBranch(action.branch)`. If a live task holds the branch, the dispatch is
deferred with the holding task's id and origin in the detail.

For every world-driven rule origin and branch are 1:1, so the origin check above already **is** a
branch check and this one is a no-op for them — `test/jobQueue.test.ts` asserts exactly that against a
broad world, so a later rule that broke the 1:1 property fails a test rather than quietly sharing a
checkout. Two paths can reach here with a branch the origin does not determine: **rule 0**, whose
`job.branch` is a free string the operator supplies, and the **LLM dispatcher**, which names branches
in prose. `WorktreeManager.ensure` is reuse-first, so letting either through would put two live claude
processes in one worktree directory — the same files on disk, with no merge anywhere to reconcile
them.

**Deferred, not skipped, deliberately.** `skipped` is the origin gate's word and means "this work is
already being done"; that is not what happened. A job is distinct work that merely names a busy
branch. Every active task ends, so the collision is transient and the honest reading is "not yet": the
job stays `queued` (nothing calls `markJobDispatched`) and the gate re-tests next cycle, for one audit
row per cycle. An operator who does not want to wait cancels it.

The same predicate is asked earlier, at queue time, by `POST /api/jobs`, which **409s** a colliding
branch. Two call sites, one predicate — that is what keeps them from disagreeing. They differ only in
*when*, which is why the earlier one refuses (nothing has been promised yet) and the later one defers
(a queued job the operator is entitled to have retried).

### 3. Pause gate — `deferred`

`runtime.paused` → `Deferred: dispatch is paused; will retry when resumed.` Read by reference, so a
runtime change takes effect immediately.

### 4. Cap gate — `deferred`

`liveCount >= runtime.cap` → `Deferred: concurrency cap N reached; will retry next cycle.` The harness
also advertises zero headroom while paused, so this is belt and braces.

### 5. Spawn

`materializeTask(action)` then `agents.spawn(task, cwd)`. On success:

- `liveCount` increments.
- `if (action.jobId) store.markJobDispatched(jobId, task.id)`.
- `if (action.partId) store.markPartDispatched(partId, task.id, branch)`.

Both marks happen **only after the agent actually spawns**, so a dispatch the cap or pause gate held
leaves the job `queued` and the part `ready` for a later cycle.

A throw from either step is caught and audited as `rejected: Failed to start agent: <message>`.

## Task materialisation

- **Code** — `store.createTask({kind:'code', …, branch})`, then
  `worktrees.ensure(action.branch, action.base ?? defaultBranch)`. A stacked plan part names the branch
  it forks from; everything else takes the configured integration branch.
- **Desk** — `store.createTask({kind:'desk', branch:null})`, then `mkdirSync(resolve(deskRoot, task.id))`.

The task carries `originTitle`, `originSummary` and `dispatchReason` from the action, so the cockpit
can explain a running agent without re-fetching from the provider.

## Auto-send

Side-effectful actions that publish to the outside world run through one gate,
`autoSendBlockedBy(gate, actionType, confidence)`, which returns a human-readable reason or `null`:

1. `!gate.enabled` → `auto-send disabled`
2. `!gate.allowedActions.includes(actionType)` → `<type> not in allowed auto-send actions`
3. `confidence < gate.confidenceThreshold` → `confidence X < Y threshold`

Defaults are `{enabled: false, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr']}`, so **out
of the box nothing side-effectful leaves without an explicit human action.** Absent `confidence` is 0.

### `reply_on_pr`

- **Clear to send** → `sink.postPrReply({prNumber, commentId, body: draft})`, audited with the
  confidence, the threshold and any returned `ref`. A **failure never drops the reply**: it falls back
  to creating a `review_reply` escalation carrying the draft and `autoSendFailed: true`, and the
  decision is still `executed` (an escalation did happen).
- **Blocked** → a `review_reply` escalation with the draft, audited with the blocking reason.

### `merge_pr`

Identical shape. Clear to send → `sink.mergePr({prNumber, method})`; a failure escalates
`approve_change` with `autoMergeFailed: true`. Blocked → an `approve_change` escalation asking the
human to approve the merge with the stated method.

### `set_work_item_state` — not gated

Mechanical bookkeeping (move a work item to "In Review" once its PR is open), not a publish-to-the-
world action, so it runs directly. It is idempotent, so a repeat before the next snapshot reflects the
change is harmless. A failure is audited as `rejected`.

The plan status comment (`upsertIssueComment`) is likewise not gated, for the same reason, and is
called by the plan reconciler rather than the executor.

## Other actions

- **`escalate_to_human`** — creates the escalation via `EscalationInbox.create`; always `executed`.
- **`propose_plan`** — the one proposal with no outbound act. It creates an `approve_change`
  escalation plus a `plan` proposal (ref `issue:<n>:plan`), or is `skipped` when
  `planProposalHold` finds a pending verdict for that plan. Accepting it runs through the same
  `ActionExecutor.runAuthorized` an accepted merge does — `readProposedAct` yields a `plan` act,
  checked before the PR number so an approved decomposition cannot audit as "names no PR number" —
  and releases the plan row rather than calling the sink. See [08](08-planning.md#the-approval-gate).
- **`respond_to_agent`** — `agents.respond(agentId, response)`. `executed` when the agent is live,
  `skipped` (`Agent <id> not live; nothing typed.`) when it is not.
- **`no_op`** — recorded as `executed` with its reason, so idleness is auditable.

## Worktrees

`src/worktree/worktreeManager.ts`. Worktrees are created lazily — only when a code task needs one —
keyed by branch and **reused** if one already exists. Two tasks on the same branch therefore share a
checkout rather than fighting over it. Desk tasks never call this.

`ensure(branch, base?)`:

1. An existing worktree for the branch is returned as-is.
2. An existing **local branch** gets a worktree added at it.
3. With no `base`, `git worktree add -b <branch> <dir>` forks from the repo root's HEAD.
4. With a `base`, it is resolved through `resolveCommit`; a base that resolves to nothing **throws**
   rather than quietly falling back to HEAD — silently picking an incidental base is the bug the
   parameter exists to fix. The executor's `catch` audits it as a rejected dispatch.

**Reuse comes first, and `base` is then ignored entirely.** `ensure(branch, base)` does not guarantee
the branch is based on `base`; it only decides where a branch that did not exist starts. You do not
move an in-flight agent's branch out from under it.

The directory name is the branch with every character outside `[a-zA-Z0-9._-]` replaced by `-`.
`remove(branch)` runs `git worktree remove --force` when a worktree exists.

### Removal

`src/system.ts` listens for `agents.on('reaped')` and removes the worktree only when:

- the agent's status is `done` (failed and killed agents keep theirs for debugging), **and**
- the task has a branch, **and**
- no other active task shares that branch.

Sequencing matters: `reaped` fires only once the process has *actually exited*, because a live process
pins the worktree cwd. A removal failure is recorded to the error log.

## Git

`src/git/` is the whole git-shell-out corner.

- **`runGit(repoRoot, args)`** — the one place `cwd: repoRoot` lives.
- **`fetchRemote(repoRoot)`** — `git fetch --prune origin`. `--prune` so a deleted remote branch stops
  reading as present.
- **`resolveCommit(repoRoot, ref)`** — resolves to a **SHA**, trying `refs/remotes/origin/<ref>`, then
  `refs/heads/<ref>`, then `<ref>^{commit}`. **`origin/` wins over the local ref**: the harness's clone
  never checks the integration branch out, so its `refs/heads/main` is frozen at clone time while the
  remote-tracking ref moves. It returns a SHA rather than a ref name on purpose — handing
  `git worktree add -b` a remote-tracking ref would set the new branch's *upstream* to it, so a later
  bare `git push` would aim at the base.
- **`GitObserver`** (`gitObserver.ts`) — the read-only seam: `presence(branch)`,
  `divergence(branch, base)`, `hasCommitsBeyond(branch, base)`. Deliberately **fetch-free**; how often
  to refresh is the caller's decision. Its one consumer is plan reconciliation.
  `FakeGitObserver` is the test implementation.

New observer methods must stay read-only and fetch-free.
