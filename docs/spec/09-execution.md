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
can explain a running agent without re-fetching from the provider. Its **prompt** is the action's plus
anything an operator said when they refused an act for the same origin — see
[A rejection's reason reaches the next agent](#a-rejections-reason-reaches-the-next-agent).

## Authorizing an outbound act

`reply_on_pr` and `merge_pr` — the two acts the harness can publish — both go through
`ActionExecutor.authorize`, the one place an outbound act is authorized. They differ only in `kind`,
`ref` and escalation payload; there is not a path per act, and there is not a path per authority.

Both authorities settle the same record. A human clicking approve and a cleared confidence gate are
the same verdict reached two ways, so the gate does not call the sink itself: it **writes a proposal
and immediately settles it** through the same one-way `Store.decideProposal` a click uses, then
performs it through the same `runAuthorized`. What this buys is the audit log answering "who
authorized this outbound act" one way for both.

In order:

### 1. The hold — `skipped`

`proposalHold(kind, ref, proposals, {rejectionSignals})` (`src/proposals/proposals.ts`). A standing
verdict governs **before** the gate is asked, so it applies regardless of which decider would answer
next. Refs are `pr:<n>:merge` and `pr:<n>:comment:<id>` (or `pr:<n>:reply` when untargeted), so one
PR can be the subject of a merge and a reply at once without the two holding each other.

| Standing verdict | Held for |
| ---------------- | -------- |
| `pending` | Until answered. Asking again is the duplicate that filled the inbox. |
| `rejected` | Until something happens to the world item (below). |
| `accepted` | `SETTLE_WINDOW_MS` (15 min, deliberately `DEFAULT_COOLDOWN` — the same statement), then it stops, so a *failed* act is re-proposed while a successful one is not re-proposed before the world reflects it. |

Rule 3 suppresses itself off the same predicate, so on the default path the question is asked once —
but it is repeated here because it must hold for *every* path that reaches the executor, the LLM
dispatcher's prose-composed `reply_on_pr` included. Two call sites, one predicate.

### 2. The gate — `autoSendVerdict(gate, actionType, confidence)`

Returns `{authorized: true, note}` — the note becoming the decider's reason on the proposal row,
quoted verbatim by the audit line — or `{authorized: false, blockedBy}`, the reason the escalation
quotes:

1. `!gate.enabled` → `auto-send disabled`
2. `!gate.allowedActions.includes(actionType)` → `<type> not in allowed auto-send actions`
3. `confidence < gate.confidenceThreshold` → `confidence X < Y threshold`

Defaults are `{enabled: false, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr']}`, so **out
of the box nothing side-effectful leaves without an explicit human action.** Absent `confidence` is 0.

**It never returns a rejection.** Only a human can reject, because a rejection is durable and a
machine "no" would mean the question is never put to anyone. Blocked means "not mine to authorize",
which is exactly what a pending proposal already says.

### 3. Either a decider or an ask

- **Authorized** → `store.createProposal(…)`, then `decideProposal(id, 'accepted', verdict.note,
  'auto_send')`, then `runAuthorized(accepted, cycleId)`. No escalation: nothing is being asked of
  anyone. One appears only if the act then fails.
- **Blocked** → an escalation (`approve_change` for a merge, `review_reply` carrying the draft) plus a
  **pending** proposal hanging off it, audited `executed` with the blocking reason — an escalation did
  happen. Accepting performs the act; rejecting records the reason and stops.

## Performing an authorized act

`ActionExecutor.runAuthorized(proposal, pulseCycleId?)` is the one place an accepted proposal becomes
its effect *and* its audit row. `ProposalDesk.accept` calls it with no cycle id; `authorize` calls it
with the pulse's.

`readProposedAct(proposal)` re-reads the stored action into one of three `ProposedAct`s, re-checking
the fields the effect is about to be handed rather than trusting a round trip through JSON and SQLite:

| Act | Effect |
| --- | ------ |
| `merge` | `sink.mergePr({prNumber, method})` |
| `reply_draft` | `sink.postPrReply({prNumber, commentId, body})` |
| `plan` | `releasePlan(store, planId, originRef)` — publishes nothing; see [08](08-planning.md#the-approval-gate) |

`plan` is checked **before** the PR number, or an approved decomposition audits as "names no PR
number". A malformed payload is reported, never guessed at.

`authorityOf(proposal, pulseCycleId)` decides the whole decider → cycle id → wording chain at once,
because the three are a chain and not three facts:

| Decider | Cycle id | Reads as |
| ------- | -------- | -------- |
| `human` | `human:<proposal id>` — a decision made outside the pulse, like `agent-lifecycle` | `authorized by you` |
| `auto_send` | the pulse's own cycle id | `authorized by auto-send (confidence 0.90 ≥ 0.85 threshold)` |

Auto-send accepts *inside* a cycle, so its row stays grouped with the pulse that produced the action
and **cannot** carry the `human:` prefix the cockpit badges "you · accepted" off. An auto-sent row is
deliberately left unbadged — that is the harness acting on its own — with the authority in the detail.

**The failure path is one path for both deciders.** A send that throws creates the same
`autoSendFailed` / `autoMergeFailed` escalation as before and audits `rejected` (the act did not go
out). The proposal stays `accepted` — it *was* accepted — and once its settle window lapses the gate
re-proposes if the world still warrants it. That is the recovery; it needs no new state.

## A rejection expires on signal

A "no" used to be durable forever. That is the safe direction and not the right one: the world moves
and the verdict doesn't, so a merge refused because the PR needed one more commit stays refused after
the commit lands, and the only way to make the harness act is to do it by hand — the inert-approval
failure mirrored.

A rejection therefore stands until the **world item it concerns** changes, and then stops standing.

- **What counts.** Any `WorldEvent` on the item, `createdAt` strictly after `decidedAt`. A proposal
  names an *act* (`pr:42:merge`) and an event names an *object* (`pr:42`), so `proposalWorldRef` maps
  one to the other — in one place, used both to match events and to ask for them, because two matchers
  over two views is the bug class this repo has fixed twice. Any transition rather than a per-kind
  list: the rules that would re-propose re-evaluate on exactly these events, so a filter here would be
  a second opinion about which changes matter, sitting nowhere near the rule it second-guesses.
- **No timer arm.** A time-only expiry re-asks a question the world has not changed its answer to,
  which is "not this second" under a longer name. If both existed signal would dominate anyway, so a
  timer could only ever delay an expiry the signal already granted. The asymmetry with the `accepted`
  window is intended: an accepted act waits on the world to *reflect* something done (a duration), a
  rejected one waits on it to *become* something else (an event).
- **It cannot flood.** Expiring only un-holds the rule; the rule's own preconditions still decide, and
  the fresh pending proposal holds the ref again. So the act is re-proposed **once**, not once per
  pulse — and the most common signal on a refused PR, a new review comment, un-holds rule 3 and then
  fails its first merge-readiness test.
- **The re-ask says why it is being asked twice.** `reaskContext` prefixes the escalation with the
  refusal, its note and the transition that ended it; without it a second ask reads as the harness
  having forgotten the first.
- **Reading the signals.** `rejectionSignalQuery(proposals)` derives `{since, refs}` from the standing
  rejections and `Store.listWorldEventsSince(since, refs)` reads them — bounded by time and item, not
  by row count, so a rejection older than a window is a case that cannot arise. Nothing standing, no
  query, no read. The harness wires it into `DispatchContext.rejectionSignals` and the executor asks
  the same question off the same predicate, so the two cannot disagree about a hold.
- **`planProposalHold` does not inherit it**, and could not: it holds on `pending` only, so there is no
  rejected hold for a signal to end. See [08](08-planning.md#the-approval-gate).

Expiry governs re-*asking*, not the verdict: the row stays `rejected`, and the operator's reason keeps
being delivered (below).

## A rejection's reason reaches the next agent

`rejectionGuidance(originRef, proposals)` is the second half of "a rejection is usable signal". The
reason was already captured, rendered into a hold string and written to the audit line — and read by
no agent at all, so refusing a draft with *"too defensive — just fix the lint"* left the next agent on
`pr:<n>:comment:<id>` starting from the prompt that produced the draft you refused.

`materializeTask` appends it to the dispatch prompt when the standing verdict for the action's
**exact** origin ref is a rejection carrying a note.

- **In the executor, not the dispatcher.** Every dispatch passes here whatever composed it — and that
  is not a technicality: a `reply_draft` is only ever proposed off the LLM dispatcher's `reply_on_pr`,
  so the path where a rejected reply exists is precisely the one a rule-dispatcher-side hook misses.
- **Appended, not filled in.** Prompt templates are operator-overridable and the loader only rejects
  *unknown* placeholders, so an override that omitted a new `{rejection}` token would silently drop a
  human's words — on exactly the deployments that customised the prompt most. Appending has no
  fallback to get wrong.
- **Exact ref, not the world item.** A rejected `reply_draft`'s ref *is* rule 2b's dispatch origin, so
  this is a lookup. Widening it to the PR would put a refusal to *merge* in front of an agent fixing
  CI, as guidance it can neither act on nor tell apart from its own task — so a rejected merge reaches
  no agent, because no agent's job is to hear about it.
- **Attributed, and quoted.** The note is free text a human typed, passed through verbatim and framed
  as *their* words about what was refused, never as the harness's own instruction, because an agent
  will act on it. An **empty note appends nothing**: the prompt is byte-identical to one with no
  rejection behind it.

## `set_work_item_state` — not authorized, just done

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
