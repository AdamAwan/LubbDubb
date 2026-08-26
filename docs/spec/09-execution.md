# 09 — Action execution

`src/executor/actionExecutor.ts` turns a validated action plan into real effects, applying the guard
rails. Every decision — executed, deferred, rejected or skipped — is written to the audit log with its
reason, so "why did (or didn't) this happen" is always answerable.

## Outcomes

| Outcome    | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `executed` | The effect happened.                                                 |
| `deferred` | Deliberately not now; the same action will be re-planned next cycle. |
| `rejected` | Malformed, or the effect failed.                                     |
| `skipped`  | Not needed — the work is already being done, or the target is gone.  |

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
skipped: _this work is already being done._

### 2. Branch gate — `deferred` (code dispatches only)

`store.findActiveTaskByBranch(action.branch)`. If a live task holds the branch, the dispatch is
deferred with the holding task's id and origin in the detail.

For every world-driven rule origin and branch are 1:1, so the origin check above already **is** a
branch check and this one is a no-op for them — `test/jobQueue.test.ts` asserts exactly that against a
broad world, so a later rule that broke the 1:1 property fails a test rather than quietly sharing a
checkout. One path reaches here with a branch the origin does not determine: **rule `manual-job`**, whose
`job.branch` is a free string the operator supplies. `WorktreeManager.ensure` is reuse-first, so
letting it through would put two live claude processes in one worktree directory — the same files on disk, with no merge anywhere to reconcile
them.

**Deferred, not skipped, deliberately.** `skipped` is the origin gate's word and means "this work is
already being done"; that is not what happened. A job is distinct work that merely names a busy
branch. Every active task ends, so the collision is transient and the honest reading is "not yet": the
job stays `queued` (nothing calls `markJobDispatched`) and the gate re-tests next cycle, for one audit
row per cycle. An operator who does not want to wait cancels it.

The same predicate is asked earlier, at queue time, by `POST /api/jobs`, which **409s** a colliding
branch. Two call sites, one predicate — that is what keeps them from disagreeing. They differ only in
_when_, which is why the earlier one refuses (nothing has been promised yet) and the later one defers
(a queued job the operator is entitled to have retried).

### 3. Pause gate — `deferred`

`runtime.paused` → `Deferred: dispatch is paused; will retry when resumed.` Read by reference, so a
runtime change takes effect immediately.

### 4. Cap gate — `deferred`

`liveCount >= runtime.cap` → `Deferred: concurrency cap N reached; will retry next cycle.` The harness
also advertises zero headroom while paused, so this is belt and braces.

### 5. Spawn

`recordDispatchTask(action)`, then `workingDirectory(task, action)`, then `agents.spawn(task, cwd)`. On
success:

- `liveCount` increments.
- `if (action.jobId) store.markJobDispatched(jobId, task.id)`.
- `if (action.partId) store.markPartDispatched(partId, task.id, branch)`.

Both marks happen **only after the agent actually spawns**, so a dispatch the cap or pause gate held
leaves the job `queued` and the part `ready` for a later cycle.

A throw from any of the three steps is caught and audited as
`rejected: Failed to start agent: <message>`, and the task row the dispatch already wrote is settled —
see [A failed dispatch settles its task row](#a-failed-dispatch-settles-its-task-row).

### A failed dispatch settles its task row

A dispatch that throws after `recordDispatchTask` leaves a task row behind, and that row is **not**
inert: `queued` is deliberately an active status (`src/tasks.ts`), because the row is written before
the worktree and the agent exist and has to hold the claim across that window. Left alone it is a
permanent claim on

- its **origin** — `findActiveTaskByOrigin` and the dispatcher's `activeOrigins`,
- its **branch** — `findActiveTaskByBranch`,
- and, when the dispatch came from a job, **whatever that job stands in for**. The claim on
  `job:<id>` is what stops rule `manual-job` re-dispatching it, so the job never leaves `queued` — and
  a queued job with an `originRef` stands in for that origin (`STANDING_SQL`, `src/store/jobs.ts`),
  which wedges a second piece of work behind the first. The same holds down the other arm of that
  query: a `dispatched` job whose task is active keeps standing for its origin.

So `ActionExecutor.abandonUnstarted(task)` settles it as **`interrupted`** — the word a recovery
`remove` verdict already writes for work that was claimed and never done — which is terminal to all
three gates. Only when the row is still active: `AgentManager.spawn` settles its own task as `failed`
when the session fails to start, which is a more specific reading of the same failure and is not
overwritten.

Nothing else is unwound, because nothing else was done: `markJobDispatched` and `markPartDispatched`
run only after the spawn, so the job is still `queued` and the part still `ready`, and the next cycle
re-dispatches the same work. One transient `worktrees.ensure` failure therefore costs a cycle rather
than wedging a chain of work shut for the life of the database (`test/dispatchFailure.test.ts`).

### A refusal that keeps repeating

One rejection costs a cycle and nothing else, which is exactly right and is why the executor writes a
`decisions` row and no more. **A refusal that repeats every pulse is a different thing**, and it used to
reach nobody: no error is recorded, no escalation is raised, the task row it made was
settled `interrupted` on the way out, and the two surfaces that carry `decisions` neither raise nor
sort by it. What a fleet stuck that way presents as is a fleet with nothing to do — nothing paused,
nothing red, an "Up next" queue that keeps refilling, and no symptom but work not happening.

So the cockpit derives a **`dispatch` row on the queue rail** ([17](17-cockpit.md#the-queue-rail--needs-you))
from the decision log it is already shipped: a dispatch whose origin has been `rejected` on **three
separate pulses running** raises an ask naming the origin, the refusal in the words the thrower wrote,
and how long it has been going on.

Three things about that shape are load-bearing:

- **It keys on the outcome, never on the message.** Both refusals the worktree pool raises — a branch
  checked out where the pool cannot lease it, and a pool with [nothing left to give](#exhaustion) —
  are `rejected` dispatches with different sentences, and so is whatever the next one turns out to be.
  A surface matching the sentence would cover only the failures that have already happened.
- **`deferred` is not a refusal.** The [branch](#2-branch-gate--deferred-code-dispatches-only),
  [pause](#3-pause-gate--deferred) and [cap](#4-cap-gate--deferred) gates defer by design and clear
  themselves on a later pulse. Counting those would raise an alarm every time the fleet ran at its
  cap, which is the fleet working.
- **The run must be unbroken at the head of that origin's history**, rather than a count over the
  window the snapshot ships. That is what makes the row clear itself the instant one dispatch for the
  origin gets through; a count would go on drawing "stuck" until the old rows aged out, some minutes
  after the operator had fixed it.

**The refusal itself does not change, and must not.** `checkedOutElsewhere` and the exhaustion message
are correct to reject, correct to say what they say, and correct to let the next cycle try again — the
whole of what was missing was somewhere for that to be read. It is deliberately **not** routed through
`errors.record` either: the error log is a list an operator clears
([18](18-observability.md#the-error-log)), and a per-pulse recording of a standing condition is a
hundred rows an hour of one fact, in the one place shape means "something threw once".

## Task materialisation

The row and the directory are separate steps, so the executor holds the created task when the
directory step throws and can settle it:

- **Code** — `store.createTask({kind:'code', …, branch})`, then
  `worktrees.ensure(action.branch, action.base ?? defaultBranch)`. A stacked plan part names the branch
  it forks from; everything else takes the configured integration branch.
- **Desk** — `store.createTask({kind:'desk', branch:null})`, then `mkdirSync(resolve(deskRoot, task.id))`.

The task carries `originTitle`, `originSummary` and `dispatchReason` from the action, so the cockpit
can explain a running agent without re-fetching from the provider. Its **prompt** is the action's plus
anything an operator said when they refused an act for the same origin — see
[A rejection's reason reaches the next agent](#a-rejections-reason-reaches-the-next-agent) — plus what
the earlier agents on the same goal worked out, see
[What earlier agents worked out reaches the next one](#what-earlier-agents-worked-out-reaches-the-next-one),
plus the images the operator attached to it, see
[An operator's attachments reach the agent](#an-operators-attachments-reach-the-agent).

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

| Standing verdict | Held for                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`        | Until answered. Asking again is the duplicate that filled the inbox.                                                                                                                                       |
| `rejected`       | Until something happens to the world item (below).                                                                                                                                                         |
| `accepted`       | `SETTLE_WINDOW_MS` (15 min, deliberately `DEFAULT_COOLDOWN` — the same statement), then it stops, so a _failed_ act is re-proposed while a successful one is not re-proposed before the world reflects it. |

Rule `pr-merge-ready` suppresses itself off the same predicate, so on the default path the question is asked once —
but it is repeated here because it must hold for _every_ path that reaches the executor, the LLM
dispatcher's prose-composed `reply_on_pr` included. Two call sites, one predicate.

### 2. The two standing authorities

**The harness authorizes no outbound act on its own judgement.** Every authority here is the
operator's; there are two of them, and they are two because they are different promises.

| Authority                                        | Reaches                      | The operator said                                                            |
| ------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------- |
| **Stack landing** — `store.standingLandingForPr` | the merges of named rungs    | _these pull request numbers_, clicked once over the chain                    |
| **`sendPrRepliesWithoutApproval`** — the config  | every reply the fleet drafts | _this class of act_, in advance — **and by default**, until they turn it off |

A **stack landing** is the operator's authorization over a chain, clicked once over the pull request
numbers it covers ([12](12-stacked-prs.md)). Its scope _is_ those numbers: it is asked only of a
merge, and a landing says nothing about replies.

**`sendPrRepliesWithoutApproval`** is the operator authorizing a class of act ahead of any particular
one: while it is on, a drafted reply is sent rather than put to them. It is the wider promise of the
two — nothing about it names a pull request — which is why it is scoped to **replies only** and why
its config entry says plainly what it does: prose an agent wrote, onto a thread the operator does not
control, signed as the harness.

**It is on by default, because that is already what happened.** Until `reply_to_review` existed an
agent had no way to answer a reviewer but to post to the thread from its own shell with the operator's
credential — unsigned, unrecorded, attributed to them, and with nobody asked
([11](11-mcp-tools.md#reply_to_review)). The reply was going out either way. What the default preserves
is that; what the tool changes is **who sends it**: signed, recorded, held by a standing rejection,
and carrying a proposal row that names the authority.

Read the other way round, `false` is the setting that changes something, and it is the stricter one —
it buys a click on every reply. Defaulting _there_ would have been the silent change: a deployment
that edited nothing would take the build and find its replies stopping and its inbox filling with
drafts nobody had asked to review. An operator who wants that sets one key, and every draft waits in
the inbox again — the arm below, unchanged, and still the only thing a merge or a plan can take. A merge is not in it (the landing is the better-scoped answer, and it
is per pull request), and neither is a plan: a plan is always put to a human, permanently, because
the undo for a plan that started itself is a replan — `planning.requireApproval` is a `RETIRED_KEY`
for exactly that reason ([08](08-planning.md#the-approval-gate)).

Both are asked _after_ the hold, so a rejection the operator gave still governs — "you do not need to
ask me" is not "ignore what I said no to" — and _before_ the escalation, so an authorized act does not
fill the inbox with the questions the authority exists to answer.

**This is not the confidence gate coming back.** `autoSendVerdict` compared a dispatcher-reported
number against a configured threshold, and the number was a hardcoded literal at its one emitter, so
the threshold resolved between two constants and measured nothing — it is gone, with the `autoSend`
block and the `confidence` field on the two actions that carried it, and the key name stays refused at
boot ([02](02-configuration.md#retired-keys)). What is here instead is a boolean an operator sets.
There is no number, no score and no gate: the harness never forms an opinion about whether an act is
good enough to send, it only reads back an authorization somebody gave it. A threshold, a confidence
field, or any numeric gate reintroduced here would be the removed feature, whatever it were called.

**Nothing here can reject.** Only a human can, because a rejection is durable and a machine "no"
would mean the question is never put to anyone. That holds for the config key as much as the landing:
it is an accept-only authority. Unauthorized means "not mine to authorize", which is exactly what a
pending proposal already says.

### 3. Either the standing authority or an ask

- **Covered by a standing authority** → `store.createProposal(…)`, then
  `decideProposal(id, 'accepted', note, 'stack_landing' | 'auto_send')`, then
  `runAuthorized(accepted, cycleId)`. No escalation: nothing is being asked of anyone. One appears only
  if the act then fails. The proposal row is written **either way** — it is the audit trail, and a send
  with no row is an outbound act with no record of what authorized it — and its `note` names _which_
  authority: the landing and when it was clicked, or the config key by name. Six weeks later that note
  is the only thing that can tell a reply the operator clicked from one their config sent.
- **Everything else** → an escalation (`approve_change` for a merge, `review_reply` carrying the
  draft) plus a **pending** proposal hanging off it, audited `executed` — an escalation did happen.
  Accepting performs the act; rejecting records the reason and stops.

### Where a `reply_on_pr` comes from

Two things raise one, and neither of them sends anything:

- **A dispatch rule**, on the pulse, through `execute`.
- **An agent**, through the `reply_to_review` MCP tool ([11](11-mcp-tools.md#reply_to_review)), which
  calls `ActionExecutor.proposeReply` and returns. The pull request comes from the caller's origin,
  never from an argument.

The tool takes this route rather than the sink because everything above is what makes a reply the
_harness's_: the hold that stops one thread being asked about twice, the rejection the operator
already gave and the re-ask that names it, their authority, the sign-off `CompositeConnector.signed`
applies on the way out, and the escalation if the send fails. An agent that posts to the thread itself
— with the tracker's CLI and the operator's credential, which a deployment's `agentAllowedTools`
commonly makes possible — gets none of it, and the reply is unsigned, unrecorded by the harness, and
attributed to the operator rather than to the fleet. Nothing about that is red, which is why the
prompt appendix says not to as well as the tool description
([05](05-dispatcher.md#prompt-templates)).

## Performing an authorized act

`ActionExecutor.runAuthorized(proposal, pulseCycleId?)` is the one place an accepted proposal becomes
its effect _and_ its audit row. `ProposalDesk.accept` calls it with no cycle id; `authorize` calls it
with the pulse's.

`readProposedAct(proposal)` re-reads the stored action into one of three `ProposedAct`s, re-checking
the fields the effect is about to be handed rather than trusting a round trip through JSON and SQLite:

| Act           | Effect                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `merge`       | `sink.mergePr({prNumber, method})`                                                                      |
| `reply_draft` | `sink.postPrReply({prNumber, commentId, body})`, then `sink.resolvePrThread(…)` when the act says to |
| `plan`        | `releasePlan(store, planId, originRef)` — publishes nothing; see [08](08-planning.md#the-approval-gate) |

`plan` is checked **before** the PR number, or an approved decomposition audits as "names no PR
number". A malformed payload is reported, never guessed at.

### Resolving the thread the reply answers

A `reply_on_pr` carries `resolve`, and it comes from the agent that wrote the reply
(`reply_to_review`'s `resolved`, [11](11-mcp-tools.md#reply_to_review)). Where it is set and the act
names a thread, `runAuthorized` resolves that thread through `ActionSink.resolvePrThread` immediately
after the reply lands, and says which happened as a clause on the reply's **own** audit line: one act
was authorized, and this is the rest of it. Absence — on a row written before the flag existed, or on
a reply the agent left open — is "leave the thread as the reviewer left it".

It rides on the reply act rather than being an act of its own because the reply is what the
resolution claims to justify: the operator approving the answer approves closing the thread the
answer is about, which is one question rather than two. A thread resolved with no reply in it is a
thread a reviewer has to reconstruct from the diff.

**A failed resolve is swallowed, and that is load-bearing.** A throw would land in `runAuthorized`'s
catch, which reads every failure as "the send failed" — so a reply already posted and visible in the
thread would be escalated for the operator to send by hand, and re-proposed once its settle window
lapsed. The reviewer would read the same answer twice because the harness could not close a thread.
An unresolved thread is the safe direction instead: it is recorded through `errors`, said in the
decision line, and rule `pr-review-comment` dispatches for the thread again, which is visible and
cheap. A provider that cannot resolve at all (`canResolvePrThread()` false) is a shape rather than a
fault and is likewise stated in the line.

**This is the only way a thread gets resolved.** An agent has no credential of its own to click with,
and the prompt tells it not to reach for the operator's — so before the flag existed, routing replies
through the harness meant threads the fleet genuinely dealt with stayed open in front of the
reviewer, and the fleet came back to them.

`authorityOf(proposal, pulseCycleId)` decides the whole decider → cycle id → wording chain at once,
because the three are a chain and not three facts:

| Decider         | Cycle id                                                                          | Reads as                               |
| --------------- | --------------------------------------------------------------------------------- | -------------------------------------- |
| `human`         | `human:<proposal id>` — a decision made outside the pulse, like `agent-lifecycle` | `authorized by you`                    |
| `stack_landing` | the pulse's own cycle id                                                          | `authorized by you, landing the stack` |
| `auto_send`     | the pulse's own cycle id, or the agent's call                                     | `authorized by auto-send`              |

A standing landing accepts _inside_ a cycle, so its row stays grouped with the pulse that produced
the action and **cannot** carry the `human:` prefix the cockpit badges "you · accepted" off — that
prefix marks a click being applied at a route, and this one was clicked earlier, over the chain.

`auto_send` is what `sendPrRepliesWithoutApproval` writes, and it is also what the removed confidence
gate wrote — so a database from before that removal holds rows carrying it with no config key behind
them. Both read as "authorized by auto-send", which is what both were; what distinguishes them is the
proposal's own note, which the key names itself in and the old gate did not.

A reply the key authorizes at an agent's call has no pulse to belong to, so its cycle id is
`agent-reply:<agent id>` — the same shape as a human accept's `human:<proposal id>`, and deliberately
neither the pulse's nor the `human:` prefix the cockpit badges "you · accepted" off. It was neither.

**The failure path is one path for every decider.** A send that throws creates an escalation and
audits `rejected` (the act did not go out) — including one the config key authorized, which is one of
the reasons `reply_to_review` must not call the sink itself.

A merge's failure carries `autoMergeFailed` on its escalation context. The proposal stays
`accepted` — it _was_ accepted — and once its settle window lapses the gate re-proposes if the world
still warrants it. That is the recovery; it needs no new state.

## A rejection expires on signal

A "no" used to be durable forever. That is the safe direction and not the right one: the world moves
and the verdict doesn't, so a merge refused because the PR needed one more commit stays refused after
the commit lands, and the only way to make the harness act is to do it by hand — the inert-approval
failure mirrored.

A rejection therefore stands until the **world item it concerns** changes, and then stops standing.

- **What counts.** Any `WorldEvent` on the item, `createdAt` strictly after `decidedAt`. A proposal
  names an _act_ (`pr:42:merge`) and an event names an _object_ (`pr:42`), so `proposalWorldRef` maps
  one to the other — in one place, used both to match events and to ask for them, because two matchers
  over two views is the bug class this repo has fixed twice. Any transition rather than a per-kind
  list: the rules that would re-propose re-evaluate on exactly these events, so a filter here would be
  a second opinion about which changes matter, sitting nowhere near the rule it second-guesses.
- **No timer arm.** A time-only expiry re-asks a question the world has not changed its answer to,
  which is "not this second" under a longer name. If both existed signal would dominate anyway, so a
  timer could only ever delay an expiry the signal already granted. The asymmetry with the `accepted`
  window is intended: an accepted act waits on the world to _reflect_ something done (a duration), a
  rejected one waits on it to _become_ something else (an event).
- **It cannot flood.** Expiring only un-holds the rule; the rule's own preconditions still decide, and
  the fresh pending proposal holds the ref again. So the act is re-proposed **once**, not once per
  pulse — and the most common signal on a refused PR, a new review comment, un-holds rule `pr-merge-ready` and then
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

Expiry governs re-_asking_, not the verdict: the row stays `rejected`, and the operator's reason keeps
being delivered (below).

## A rejection's reason reaches the next agent

`rejectionGuidance(originRef, proposals)` is the second half of "a rejection is usable signal". The
reason was already captured, rendered into a hold string and written to the audit line — and read by
no agent at all, so refusing a draft with _"too defensive — just fix the lint"_ left the next agent on
`pr:<n>:comment:<id>` starting from the prompt that produced the draft you refused.

`recordDispatchTask` appends it to the dispatch prompt when the standing verdict for the action's
**exact** origin ref is a rejection carrying a note.

- **In the executor, not the dispatcher.** Every dispatch passes here whatever composed it, so the
  note reaches an agent whether the act was proposed by a rule or authorized outside the pulse.
- **Appended, not filled in.** Prompt templates are operator-overridable and the loader only rejects
  _unknown_ placeholders, so an override that omitted a new `{rejection}` token would silently drop a
  human's words — on exactly the deployments that customised the prompt most. Appending has no
  fallback to get wrong.
- **Exact ref, not the world item.** A rejected `reply_draft`'s ref _is_ rule `pr-review-comment`'s dispatch origin, so
  this is a lookup. Widening it to the PR would put a refusal to _merge_ in front of an agent fixing
  CI, as guidance it can neither act on nor tell apart from its own task — so a rejected merge reaches
  no agent, because no agent's job is to hear about it.
- **Attributed, and quoted.** The note is free text a human typed, passed through verbatim and framed
  as _their_ words about what was refused, never as the harness's own instruction, because an agent
  will act on it. An **empty note appends nothing**: the prompt is byte-identical to one with no
  rejection behind it.

## What earlier agents worked out reaches the next one

Every stage of a goal is a fresh agent with no memory of the last. The appraiser read the ticket against
the repository, the planner read the repository and argued for a shape, a part agent hit a constraint
and wrote it on the pad — and the agent dispatched after them started from a template holding a title,
a body and a branch name, paying again for what the one before it learned. The knowledge was not
missing; it was in the store, and nothing handed it over. The scratchpad's own doc says it is written
"for whoever works this goal next", and its only reader was the retrospective — the one agent on a goal
that does none of the work.

`recordDispatchTask` appends `priorWorkBriefing(...)` (`src/briefing/priorWork.ts`, pure) to the dispatch
prompt.

- **Only what no prompt already renders.** The rule that stops it becoming a second account of things
  the harness already says. It carries the **pad**; the planner's **`document` / `risks` /
  `outOfScope`**, which reach the plan sheet and no agent — and on a one-part plan are the entire
  product of a code agent that read the whole repository, while rule `issue-pickup`'s prompt is the issue title and
  body; a part's **`rationale` / `acceptance`**, stored and rendered nowhere at all; the **prose
  behind each standing verdict** (appraisal, conclusion, delivery, shortfall); **the paths the goal has
  been edited in**; and **the retrospectives of the goals that have been in those same paths**. It
  therefore omits
  `plan.reason` (rendered by `currentPlanSummary` to a replanner and as `{plan}` to a part agent) and a
  part's status, branch and PR number (`currentPlanSummary`, `siblingContext`).
- **No world facts.** A pull request's state is live through `world_read`; pasted into a prompt it would
  be a stale second reading of something the agent can ask about properly.
- **Files this goal has been edited in** (issue #354) is the one section that is stored _fields_ rather
  than stored prose, and it sits last — the sections above it are the argument, this is the index. One
  line per path, most recent write first, attributed to the origin that wrote it, from
  `Store.listGoalFiles` ([14](14-persistence.md#flags-and-files)). Three things about it, each answering
  a rule it sits against:
  - **It is still a join, never a judgement.** A path is `agent_files.path` quoted back and the order is
    a stored timestamp. Ranking, relevance scoring or "the files you probably want" would be the second
    opinion about somebody else's decision that this module and `retroDossier` both refuse.
  - **It is not a world fact.** A pull request's state is a fact about the world _now_, which
    `world_read` answers better than a paste; this is a fact about the goal's **own history**, like the
    pad, and no live tool answers it. A path written on a sibling's branch may not exist on this
    dispatch's branch, and a rename leaves the record pointing at nothing — which is testimony going
    stale, covered by the heading's own framing rather than by a softer sentence of the section's.
  - **Promoted paths are in it and unmarked**, and it **stays on for a part dispatch**: `forPart`
    suppresses the parts section alone, because `siblingContext` renders what a sibling was _for_ and
    nowhere renders where it has been.
- **Other goals that have been in these same files** (issue #354, phase 2) is that join asked once more
  with a goal on the far side of it, and it sits last of all — under the index it is derived from. One
  line per neighbour: the paths in common, then its retrospective summary quoted whole, from
  `Store.listGoalNeighbours` ([14](14-persistence.md#flags-and-files)). It answers the same two rules
  the same way, and settles three things of its own:
  - **"Closed" is spelled `has a retrospective`, and that is the world-fact rule rather than a
    shortcut.** Whether an issue is closed is a fact about the world _now_; a retrospective is a row
    this database owns, written by rule `issue-retro` only once a goal is done. So it is the harness's
    own stored answer to the same question, and it is the thing being handed over besides — the gate
    and the payload are one join. A goal still being worked is therefore absent with no second liveness
    predicate: `detectFileOverlaps` owns "is this happening now"
    ([12](12-artifacts-and-files.md#file-overlap-detection)), and a briefing with an opinion on that
    would be the drift both modules exist to avoid.
  - **It is not sorted by overlap.** Neighbours come back by the recency of their last write, a stored
    timestamp, and the number of shared paths is _stated_ rather than allowed to rank — "most
    overlapping" is a relevance score, which is the judgement the section above refuses in the same
    words.
  - **The summary is quoted, not pointed at**, because no tool an agent has reaches another goal's
    write-up — `scratch_read` is scoped to the caller's own pad. The sentence is therefore the whole
    delivery, and the document stays where it is. The section **stays on for a part dispatch** for a
    stronger version of the file list's reason: it is about goals no sibling was ever part of, so there
    is no surface it could duplicate.
- **The neighbour query is seeded from two places**, `neighbourSeedPaths`: the paths this goal has been
  edited in, and the paths its plan cites as `evidence`. The second exists because the first is empty on
  exactly the dispatch the lookup is worth most on — a goal's file rows appear only once an agent has
  written under it, while a plan's evidence is written before any part is dispatched. They mean
  different things and neither is widened into the other; what keeps that honest is that the section
  names the paths a neighbour **shares** and never claims this goal edited them.
- **Scoped by `padOriginFor`, not a fresh predicate** — already the harness's answer to "which goal is
  this agent working": the `issue:<n>` root plus its `:plan`, `:appraisal`, `:assess` and `:part:<slug>`
  arms. Everything else (a PR concern, a job, a filing) is handed nothing, which is the rejection note's
  widening rule at the level of a whole goal. The **retro origin is excluded** though `padOriginFor`
  accepts it: `retroBriefing` already hands it the pad and the whole dossier, both bounded on their own
  terms ([05](05-dispatcher.md#what-it-is-bounded-by)).
- **A part agent gets no parts section**, because `plan-part` renders every sibling through
  `siblingContext`; and the conclusion is omitted when the outstanding-work note already carries it, so
  one fact is never rendered twice in one prompt.
- **Appended, not filled in**, for the rejection note's reason, and **it derives nothing** — every line
  is a stored field quoted back, `retroDossier`'s rule.
- **Bounded, and it names what it dropped.** Appended text lands after the cached prefix, so a briefing
  is fresh input tokens on every dispatch. An untouched goal renders the empty string, so a first
  agent's prompt is byte-identical to one composed before this existed; the pad is capped at the most
  recent 15 entries, the file list at the most recent 25 paths, the neighbour list at 4 goals of 4 named
  paths each and the write-up at 4 000 characters, with the elision stated and `scratch_read` named, or
  a partial record reads as the whole one. The file cap is tight because it is the section that scales
  with the **size** of the work rather than with what anyone chose to write down; the neighbour cap is
  tighter still, because each of its lines carries a whole summary and is a pointer to work done
  somewhere else.

## The operator's own instructions reach the agent

The cockpit's **More work** control writes what the operator wants done on a goal, in their words —
_change the button to primary_, _the permission is wrong_, _the loading icon spins forever, fix it_.
It replaced a bare `more_work` toggle whose fixed note (`Set by the operator from the cockpit.`)
carried none of that, so the next agent re-read the same ticket that had already produced the thing
the operator was unhappy with. The rows are in
[14](14-persistence.md#operator-instructions-on-a-goal); the routes that write them are in
[16](16-http-api.md#post-apiissuesnumberinstruction).

**Writing one also restarts the goal**, and that half belongs to the route rather than to this note.
An operator presses **More work** on a goal that looks finished, which is precisely a goal the funnel
has parked — a standing delivery, or a plan that has rolled up `complete` — so for as long as the
route only wrote rows, the words reached the cockpit and no agent. The route therefore writes the
`more_work` conclusion whatever verdict is standing (which retracts a delivery) and sends a settled
plan back to a planner. What that costs and why it is the honest reading is argued where the route is
specified, in [16](16-http-api.md#post-apiissuesnumberinstruction).

`recordDispatchTask` appends `operatorInstructionsNote(...)` (`src/goalInstructions.ts`, pure) to the
dispatch prompt whenever the goal carries an instruction nobody has concluded yet.

- **First among the appended blocks.** It is the only one of them that changes _what the work is_ —
  the rejection note, the outstanding-work note, the briefing and the attachments all describe work
  already asked for.
- **They accumulate, and they stand until an agent concludes the goal.** Two things wanted before
  anyone worked it are two things; a conclusion is one overwritten row, so the note could not have
  lived there. `conclude_work` settles every instruction standing on the goal, whichever verdict it
  casts — the agent's note is the answer to them, and it reaches the next agent through
  `outstandingWorkNote` ([11](11-mcp-tools.md#conclude_work)). **Not settled at dispatch**: an agent
  that died before doing anything would take the operator's words with it, silently.
- **Scoped by `padOriginFor`**, the attachments' rule for the attachments' reason — an instruction is
  about the goal, and the agents that work it are dispatched for `:plan`, `:appraisal`, `:assess` and
  `:part:<slug>`. An exact match would put _change the button to primary_ in front of nobody at all on
  a decomposed goal. The retro origin is deliberately **not** excluded the way the briefing excludes
  it: a retrospective that did not know what was asked for mid-run would write up a different run from
  the one that happened.
- **Appended, not filled in**, for the rejection note's reason, and **quoted and attributed** — but
  framed as _instructions_ where the outstanding-work note is framed as a report. That inversion is the
  point: this is the operator, it postdates the ticket, and where it disagrees with the ticket, the plan
  or an earlier agent's note, it wins.
- **The agent updates the ticket, and the harness does not.** An instruction that changes what the goal
  asks for has to reach the record every later agent, every assessor and every human reads — and the
  agent is the only party that can tell "this changes the goal" from "this says how to do work the goal
  already asks for". So `ticketAmendCommands(config, number)` supplies the one thing an agent cannot
  infer (which tracker, read-then-write, both halves) and the judgement stays the agent's. That is
  `trackerCoordinates`' arrangement exactly ([13](13-jobs-and-tickets.md)). Null under the `fake`
  provider, where the note says there is nothing to update rather than naming a command that would
  fail.
- **An untouched goal appends nothing**, so its prompt is byte-identical to one composed before this
  existed.

## What the fleet knows about this goal reaches the agent

`recordDispatchTask` appends `renderScopedKnowledgeNote(...)` (`src/knowledge/block.ts`, pure) — the
knowledge base's claims whose **scope matches this dispatch**: the `goal:` claims for the goal it is
for, and the `check:` claims for the checks it answers → [27](27-knowledge.md#delivery-two-prompts-not-one).

- **Here rather than in the system prompt**, and that split is the whole of delivery. The injected
  claims are identical for every agent, so they are a cached prefix paid once
  ([10](10-agent-runtimes.md#the-knowledge-block)); these vary per dispatch by construction and would
  destroy that prefix. What varies goes in the task prompt, always.
- **Whatever the block is already carrying is not here.** Since #27 phase 4 an injected claim rides
  the system prompt whatever its scope — a check that flakes flakes for the agent about to run it, not
  only for the one dispatched to fix it — so what this appends is the `lookup` claims in scope, plus
  the goal's own, which never ride the block. One predicate decides both, `ridesSystemPrompt`, read
  here inverted: two lists that merely agreed today would send one sentence twice or drop it entirely,
  and neither is visible from either renderer alone.
- **In the executor rather than in a rule**, the attachments' placement for the attachments' reason —
  every dispatch passes through `recordDispatchTask` whatever composed it — and for one more: **no
  rule, desk or gate reads a fact**, asserted structurally over `src/dispatcher/` by
  `test/knowledge.test.ts`. Nothing is dispatched, held or ranked because of a claim.
- **The scope is the goal, not the concern.** `dispatchFactScopes` collapses `pr:412:ci` to
  `goal:pr:412` through `corroborationGoal` — the same collapse a corroboration is counted under, so
  the scope a fact is written under and the scope a dispatch is read under cannot drift. `pr:412:ci`
  and `pr:412:comments` are two origins of one goal.
- **A check name is matched exactly**, `priorRemedies`' choice and the same fragility for the same
  reason: a prefix match would put another job's history in front of an agent under a name it would
  read as its own. When a job is renamed the claim silently stops being delivered, which the cockpit's
  Knowledge page says out loud where a check scope is drawn.
- **Appended, never interpolated.** Prompt templates are operator-overridable and `loadPromptTemplates`
  rejects only _unknown_ placeholders, so a `{knowledge}` token would be dropped in silence by every
  override written before this existed — on exactly the deployments that customised most.
- **`lookup` means _not injected everywhere_, not _never injected_.** A `check:format:check` claim
  costs nothing on a dispatch about anything else and is in front of the agent that needs it without
  anyone asking. What the store will not deliver at all is a `proposal` — one agent's claim nothing has
  agreed with — a `committed` one, which is in the repository now, and a lapsed expiring one.
- **Bounded, and it says what it dropped**, `priorRemedies`' rule: an agent that reads a partial record
  as a whole one concludes something from the absence of an entry that was merely trimmed.
- **A goal nothing has been written about appends nothing**, so its prompt is byte-identical to one
  composed before this existed.

## An operator's attachments reach the agent

A brief launched from the cockpit may carry images (issue #249) — a screenshot of the panel to
change, the broken screen, a before/after pair. They are written once under `attachmentRoot`
(`src/jobs/attachmentFiles.ts`) and recorded in `job_attachments`, keyed on the ref they belong to —
`job:<id>` for a brief that dispatches, and the `issue:<n>` it was filed as for one that becomes a
ticket. See [14](14-persistence.md#brief-attachments) for the rows, and
[16](16-http-api.md#launching-a-brief) for how they arrive.

`recordDispatchTask` appends `attachmentsNote(...)` (`src/jobs/attachments.ts`, pure) to the dispatch
prompt: one line per image giving its **absolute path**, the mime **sniffed from its bytes**, and the
operator's own filename as a label.

- **Appended, not filled in**, for the rejection note's reason.
- **One canonical file, not a copy per dispatch.** A copy into each agent's cwd would risk the
  screenshot being committed onto a branch and would duplicate it once per agent on a goal. The single
  file is readable instead through a `permissions.additionalDirectories` grant on every launch, see
  [10](10-agent-runtimes.md#reading-outside-the-worktree).
- **Scoped to the goal, not to the exact origin.** The lookup is `padOriginFor(originRef) ?? originRef`
  — the harness's own spelling of "which goal is this origin inside", already used to decide who shares
  a scratchpad, so the two cannot drift. It has to be: a filed brief's images are keyed `issue:<n>`
  while the agents that go on to work it are dispatched for `issue:<n>:appraisal`, `:plan`, `:part:<slug>`
  and `:retro`. An exact match would put the screenshot in front of the filing agent alone, the one
  agent that writes no code. An origin outside any issue subtree — a `job:<id>` brief that
  dispatched directly, because no tracker is configured — falls back to itself, which is an exact match.
  - Within a goal the append is **unconditional**: a part agent working something the screenshot has
    nothing to do with is still shown it. That is the trade the prior-work briefing already makes, and
    the alternative is guessing which part an image is "about", which the harness has no basis for.
- **The label is quoted as the operator's**, never as an instruction — a filename is not a directive,
  and it is never used to build a path.

## `update_pr_branch` — the base merge without an agent

The `behind` arm of rule `pr-base-update` ([05](05-dispatcher.md#pr-base-update--two-arms)), performed
here rather than dispatched. `sink.updatePrBranch({prNumber, base})` asks the provider to merge the
base branch in on its own machines: no worktree, no model, no cold read of the repository, for a merge
the provider itself reported as clean.

Not authorized and not proposed, which is deliberate on both counts. It is mechanical in
`set_work_item_state`'s sense, and beyond that it is a write to a branch the harness owns that the
agent path took without asking anyone — a cheap path that asked a human what the expensive one never
did would be a new gate wearing an optimisation's clothes.

It re-checks the **branch gate** first, for the reason the dispatch path re-checks it: every path
reaching the executor must be covered, not only the one that checked first. An agent holding the
branch has a worktree cut from a commit this merge would move out from under it. That is a
`deferred` — the collision is transient — and deliberately not a `skipped`, which is the word the next
pulse reads as "the cheap path is unavailable here".

Then three outcomes, and the difference between the last two is the whole reason the sink answers
rather than throwing:

| Result      | Decision   | Error log | Meaning                                                                 |
| ----------- | ---------- | --------- | ----------------------------------------------------------------------- |
| `ok: true`  | `executed` | —         | The base is merged in; the next snapshot stops reporting the PR behind. |
| `ok: false` | `skipped`  | —         | This provider has no such operation (Azure DevOps). A configuration.    |
| _throws_    | `rejected` | recorded  | The provider has it and would not do it.                                |

Either unperformed row is the dispatcher's memory on the next pulse: it reads them back out of
`recentDecisions` and builds the concern as the code agent it always was, so the PR is never left
sitting behind its base. The error entry is `source: 'provider'` and carries what happens next in its
detail, because a failure the harness recovers from on its own must still be visible as a failure
([18](18-observability.md)).

## `requeue_ci_check` — the expired build without an agent

The expired arm of rule `pr-ci-gate` ([05](05-dispatcher.md#pr-ci-gate-a-check-that-waits-rather-than-fails)),
performed here rather than dispatched (issue #395). `sink.requeueCiCheck({prNumber, check, requeueRef})`
asks the provider to run the policy's build again: no worktree, no model, no cold read of the
repository, for a gate whose cause the provider itself reported and whose resolution the harness
already knew.

Not authorized and not proposed, for `update_pr_branch`'s reasons exactly. What it does **not** carry
is that act's branch gate, and that is not an omission: a requeue writes to a policy evaluation, not
to the branch, so nothing an agent's worktree was cut from moves and there is no collision to defer
for. The rule reaches this act only for a free branch anyway — a staffed one gets the note.

The action names every expired check on the gate, so the executor loops and one decision row covers
the lot:

| Result                 | Decision   | Error log | Meaning                                                                            |
| ---------------------- | ---------- | --------- | ---------------------------------------------------------------------------------- |
| every check `ok: true` | `executed` | —         | A run is queued; the next snapshot reports the checks pending rather than expired. |
| any check `ok: false`  | `skipped`  | —         | The provider has no such operation, or has it and declined. A configuration.       |
| _throws_               | `rejected` | recorded  | The call itself failed.                                                            |

A throw is whole-act even where earlier checks in the list were queued — the ones that took stop being
expired and drop out of the gate by themselves, so the agent the next pulse dispatches is left with
exactly the ones that did not. Either unperformed row is the dispatcher's memory on the next pulse,
which builds the concern as the code agent it always was.

**A 200 is not a requeue**, and that is the one thing this act knows that the base update does not.
Azure answers with the evaluation record whether or not it restarted anything, so a record that comes
back still `isExpired` is one it declined — a token without **Build (execute)**, a definition it
cannot queue. The Azure integration reads that off the answer and returns `ok: false`, which is what
sends the gate back to an agent rather than leaving it waiting on a build nobody started
([15](15-integrations.md#the-azure-provider)).

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

`src/worktree/worktreeManager.ts`. Worktrees are a **bounded pool of directories leased to
branches** — created lazily, only when a code task needs one, and switched rather than recreated.
Desk tasks never call this.

The key used to be the branch: one directory per branch, deleted when the work ended. So a branch
that came back — a CI failure to chase, a review comment to answer, a part picked up again — **landed
in a tree with no dependencies installed** and paid to install them before it could run one check. In
this repo that is `npm ci` over native builds: minutes of wall clock and several tool turns per
dispatch, for setup that had been sitting on disk an hour earlier. A slot left standing on its branch
keeps everything git ignores, which is where a project's build state lives — so **warm dependencies
are a consequence of a branch finding its own tree again, not something the harness manages**.
Nothing here knows what a package manager is, there is no install command and no config key naming
one; if the harness ever needs to know the project's toolchain, this has gone wrong.

**Reuse is scoped to the branch, and nothing crosses.** A slot handed to a _different_ branch is
**wiped** back to what a fresh checkout would hold ([below](#handing-a-slot-over)). The first cut of
the pool carried the previous occupant's ignored files across — that is what made a hand-over cheap —
and it is the bug this replaced: a `dist/`, a generated file, a dependency tree resolved from another
branch's lockfile, all reading to an agent as its own branch's output, with nothing anywhere marking
them stale. The cost is the cold install on a branch's **first** dispatch. That is the trade the pool
now makes: a tree is only warm for the work that warmed it, and the work that comes back to a branch
is exactly the work that pays for a cold one twice.

The executor depends on the `Worktrees` **interface**, not the class:
`ensure`/`ensureReadOnly`/`remove`/`deleteBranch` is the whole of what it and the reap in `system.ts`
ask for, and a seam wider than its consumer is a fake with behaviour nobody checks. `WorktreeManager` is the real implementation, wired by default;
`FakeWorktreeManager` is the injected one, and it **models the pool too** (see
[19](19-development.md)) — a fake still keyed on the branch would hand every branch its own path and
keep every test green while the real manager leased slots. This is git's **write** side given the
treatment its read side already had in `GitObserver` — the asymmetry was load-bearing, because the
write side is the half that mutates a repository.

`ensure(branch, base?)` — and `ensureReadOnly(key, of)`, which takes the same path with one extra arm
([below](#the-read-only-checkout)):

1. `git worktree prune`, so a slot whose directory vanished stops counting against the bound.
2. A **pool slot** already checked out on the branch — or, read-only, a slot this key still holds — is
   returned as-is, and re-leased: untouched, with everything in it. This is the only arm that reuses
   anything. **Scoped to slots under `worktreeRoot`**, the way the survey is: `git worktree list`
   answers for the repository's own main worktree too, and an operator standing on `issue/12` in their
   own clone to read what an agent did is the obvious way to be standing there. Handed that as a slot,
   the next dispatch onto the branch runs an agent in the operator's working copy — committing into
   it, switching under them, and released by a `remove` that deletes nothing, so nothing puts it back.
   It is not a slot, so the bound, the eviction, the salvage, the reclaim and the exhaustion refusal
   are all blind to it as well. **The repo's own main worktree is never a slot**, at either end: this
   arm will not take it and [`deleteBranch`](#release) will not detach it. A branch checked out
   outside the pool **throws by name** rather than falling through the ladder — git will not check one
   branch out twice, so `git worktree add` would refuse the slot anyway with a `fatal:` naming a path
   and no reason; the refusal says which directory is in the way, and the whole fix is the operator
   switching their own checkout off the branch.
3. Read-only only: a free slot that is already a read-only checkout of the **same ref**. Handing it
   over costs nothing and burns nothing, so it beats both a spare and a fresh slot.
4. Otherwise a **spare** slot: free, and on an unmarked detached HEAD or a branch whose ref is gone,
   so it holds nothing anybody can come back for. Wiped and switched (below).
5. Otherwise the pool **grows**, while it is below its bound: a stale target directory is
   **reclaimed**, then `git worktree add` puts a new slot straight on the branch (or, read-only,
   `--detach` at the commit). Slot directories are `slot-<n>`, the lowest unused index.
6. Otherwise the first **evictable** slot: free, but still carrying a branch or another ref's
   read-only tree. Wiped and switched.
7. Otherwise the uncommitted work stranding the free slots is moved onto a **salvage ref** and the
   ladder is walked once more — see [reclaiming a stranded slot](#reclaiming-a-stranded-slot).
8. With none of those, it **throws** — see [exhaustion](#exhaustion).

**Minting comes ahead of eviction**, and the order is load-bearing rather than a preference. A slot
handed to another branch is wiped either way, so taking one that still carries a live branch burns
that branch's tree and buys nothing a fresh slot would not have given — and that tree is exactly what
a CI fix or a review comment on the branch comes back to. The consequence is that a quiet deployment
grows to its full pool size over time instead of churning one directory: disk is still bounded by the
pool, and what the extra slots hold is the warm state of the last few branches worked.

A branch that does not exist yet starts at a commit: `base` resolved through `resolveCommit`, or the
repo root's HEAD when there is no `base`. The start point is named **explicitly** even in the HEAD
case, because a pooled slot's own HEAD is the previous occupant's and forking implicitly off it would
silently mis-base every branch cut into a reused slot. A base that resolves to nothing **throws**
rather than quietly falling back to HEAD — silently picking an incidental base is the bug the
parameter exists to fix. It is resolved before the slot is touched, so that failure leaves the slot
exactly as it was rather than cleaned and half-prepared. The executor's `catch` audits it as a
rejected dispatch.

**Reuse comes first, and `base` is then ignored entirely.** `ensure(branch, base)` does not guarantee
the branch is based on `base`; it only decides where a branch that did not exist starts. You do not
move an in-flight agent's branch out from under it. Two tasks on one branch therefore share a
checkout rather than fighting over it, exactly as they did before there was a pool.

### The lease

**A directory per branch was the only thing stopping two agents sharing a checkout**, and it provided
that implicitly: one branch, one path. Pooling breaks the coupling, so the lease is explicit and
checked on every hand-out. Getting it wrong puts two agents in one directory on different branches,
which is worse than anything `fileOverlap` reports — `sameWorktree` at least assumes they agree on
the branch.

A slot is **held** while either is true, and the two arms cover windows the other cannot:

- **This run leased it**, and `remove` has not released it. A task is settled the moment its agent
  reports done, but the agent's _process_ is still sitting in that directory until `reaped` fires,
  and cleaning and switching a tree out from under an exiting process is the damage that shows up as
  an `EBUSY` two days later. `system.ts` releases on `reaped`, the honest end of "something is still
  in there". This is also the arm `deleteBranch` has to ask about and the reap's own guard cannot see
  — see [Release](#release).
- **The branch it is checked out on still has outstanding work** — `Store.findActiveTaskByBranch`,
  the same predicate the executor's [branch gate](#2-branch-gate--deferred-code-dispatches-only)
  asks. This is the half that survives a restart, where the in-memory leases are empty by
  construction: crash recovery may **restore** an orphan back into its existing directory, and
  without this the very next dispatch would clean and switch that tree under it. The mirror case is
  the release a boot needs — a `requeue` or `remove` verdict settles the task, and the slot is free
  that instant, with nothing in the manager having had to remember anything.

A slot carrying **uncommitted tracked changes** is also never handed to another branch, and that is a
correctness rule rather than tidiness: `git switch` _carries_ uncommitted edits across when they do
not conflict, so a failed agent's half-finished work would land on an unrelated branch and be
committed there by an agent with no idea where it came from. It is also what keeps a failed or killed
agent's tree readable, which is what deleting the directory used to provide. What it is _not_ is
permanent: a slot stranded that way is reclaimed rather than refused forever once the pool has nothing
else left to give ([below](#reclaiming-a-stranded-slot)).

### The read-only checkout

Three dispatches need a repository and no branch: the goal appraisal ([06](06-issue-pickup.md)), the
assessment and a handed-over validation check ([20](20-validation.md)). Each is told in its prompt not
to commit or push anything, and each is cut from the default branch for the reason it says out loud —
the state it is asked about is _on_ it.

Each used to mint a branch anyway, and **nothing ever reaped it**: `reapableBranches` deletes the
branch of a **merged** pull request and refuses everything else, deliberately, so a ref that never
gets a pull request is never merged and never deleted. One `appraisal/issue/<n>` per appraisal, one
`assess/issue/<n>` per assessment and one `validate/issue/<n>/<checkId>` per check, accumulating for
the life of the deployment, with nothing anywhere reading as wrong (#396).

So a read-only dispatch mints nothing. `ensureReadOnly(key, of)` leases a slot and checks it out
**detached** at the commit `of` resolves to (through `resolveCommit`, so `origin/<ref>` wins over the
local ref as everywhere else). The lease key is the name the rule would have used as a branch — it is
what the task row carries, what the [branch gate](#2-branch-gate--deferred-code-dispatches-only)
reads, and what `remove` is called with when the agent is reaped — and it never becomes a ref.

- **The lease is untouched, which is the point.** Several read-only agents pinned to one directory is
  precisely the case the lease was written to refuse, and "none of them writes" is a property of a
  _prompt_, not of the runtime. So a read-only checkout takes a whole slot, leased under its key,
  exactly as a branch does. There is no sharing and no exemption.
- **It survives a restart too.** A detached slot has no ref for `pool.held` to be asked about, so the
  slot carries a **mark** — the key it holds and the ref it is a checkout of — in `<worktreeRoot>/.read-only/<slot>`.
  `holder` reads the key off it and asks `pool.held` the same question it asks about a branch. Without
  it a restored appraiser's tree would read as a spare and be cleaned and switched under the agent
  sitting in it. The mark is beside the slots rather than inside one (where `clean -ffdx` would take
  it, in front of the agent) or in git's admin directory (which is git's, not the harness's); losing
  one degrades to a full wipe, the way losing a lease does.
- **One ref, one warm tree.** Two read-only checkouts of the same ref are the same tree to whoever
  gets it, so a hand-over between them keeps the ignored files and takes only the last agent's
  scratch (`git clean -ffd`, not `-ffdx`) — and a free one is _preferred_ over minting a slot. That is
  what stops a queue of appraisals and checks paying for a cold install each, which the pool could never
  give work that warms nothing of its own. The mark is the whole of the evidence: it is written only by
  a read-only hand-over and cleared by every other, so a tree the harness cannot vouch for is wiped.
- **Reuse follows the ref, not the tree.** A key coming back to its own slot after the default branch
  has moved is re-pointed at the new commit. An assessor judging "was this delivered" against
  yesterday's tip answers the wrong question — where a branch's slot going stale is just its own
  commits arriving.
- **Not a separate pool.** A read-only dispatch is an agent like any other and is bounded by
  `maxConcurrentAgents` before it ever reaches a slot; a second pool would double the disk and need a
  second number nobody can size. What it costs is one slot while it runs, and `maxConcurrentAgents`
  is the knob for that, as it is for every other slot.
- Rules never arrange this themselves: they compose the dispatch through `readOnlyDispatch`
  (`src/dispatcher/rules/readOnlyDispatch.ts`), the executor reads `action.readOnly` at the single
  `ensure` call site, and `readOnly` defaults to false — so a dispatch that writes code cannot lose
  its branch by omission. Tests: `test/readOnlyCheckout.test.ts`.

### The checkout a local run uses

`ensurePreview(ref)` — one fixed directory under `localRunRoot`, detached at whatever `ref` resolves
to, for the machine's one dev environment ([23](23-local-runs.md#the-checkout)).

On `WorktreeManager` because this class is the only thing that hands out a directory, and **not a pool
slot** for three reasons that each matter. It is outside `worktreeRoot`, because `slots()` counts every
registered worktree under that root whatever the directory is called — so a preview checkout in there
would count toward the bound and be handed to an agent. Its ignored files survive a change of ref,
because the pool's `git clean -ffdx` is right for an agent's branch and wrong for a checkout whose
whole purpose is to be ready: it would make every swap between goals pay a cold dependency install. And
it takes no lease, because the lease exists to keep two agents out of one directory and there is
exactly one local run — the store row is what makes that true.

The sequence is existence check, `checkout --detach`, `reset --hard <commit>`, `clean -fd`, and each
step is there because a shorter one was wrong. Comparing `git worktree list` paths to decide whether the
checkout exists breaks where a short-name TEMP resolves to a different string for the same directory:
the comparison says "not registered", `worktree add` says "already exists", and the run fails on a tree
that was sitting there ready. `switch` before the tree is clean refuses outright when the last run left
a tracked file edited. And `reset --hard` on a checkout somehow standing on a branch would rewind _that
branch_ — the damage `git switch -C` is unreachable for. An unresolvable ref throws before anything is
touched, `ensure`'s rule.

### Handing a slot over

This runs **only for a branch the slot is not already on** — `ensure`'s reuse arm has taken every
other case — so everything standing in the directory belongs to some other branch. In this order, and
the order is load-bearing:

1. **`git clean -ffdx`** — everything untracked, ignored files included. `-x` is what takes the
   previous occupant's dependency tree and build output, and the second `-f` is for a nested
   repository inside them (a git-sourced dependency), which a single `-f` skips — leaving exactly the
   half-deleted dependency tree this is trying not to hand anyone. Nothing is excluded by name: an
   ignore list of paths to keep is the repo-specific configuration the harness refuses to grow. The
   one hand-over that keeps them is read-only to read-only on the same ref
   ([above](#the-read-only-checkout)), where the output answers the same source and `-ffd` takes only
   the last agent's scratch.
2. **`git switch <branch>`** when the ref exists, `git switch -c <branch> <commit>` when it does not,
   `git switch --detach <commit>` for a read-only checkout. The wipe must precede it because
   `git switch` refuses when an untracked file would be overwritten. The mark is cleared ahead of
   both, so a failure in between leaves a slot claiming nothing rather than claiming to be a checkout
   it is not.

**`git switch -C` and `git checkout -B` are unreachable, deliberately.** They _reset_ an existing
branch to the start point, so on a slot being handed to a branch that already has commits — a
re-dispatch, a retry, a part picked up again — they discard that work silently, with nothing red
anywhere. Existence is checked first and the create form is only ever reached for a branch that does
not exist.

A failure at either step is a **rejected dispatch naming the branch and the slot**, never a silent
fall back to a fresh directory — which would put two agents in one tree.

### Exhaustion

Pool size is the **live** agent cap plus a slack of two, and there is no setting for it: the fleet has
one size knob, `maxConcurrentAgents` ([02](02-configuration.md#repository)). Disk is bounded by it,
which it never was: twenty concurrent agents meant twenty full checkouts and no ceiling at all.

The pool used to take its own `worktreePoolSize`, which could only ever be wrong in one of two ways.
Below the cap it silently became the fleet's real limit — the failure the next paragraph describes,
arrived at deliberately. Above it, it was disk nothing could lease: a slot is only ever handed to an
agent, and the cap decides how many of those there are. The slack absorbs the gap between the two
(a slot is held from `ensure` until the agent's process is reaped, and for as long as salvaging a
dirty tree takes), and a pool that needed more than the slack would be a fleet leaking slots — a bug
to fix rather than a number to raise.

**The bound is read on every acquire, not once at boot, and it must stay that way.** The bound and
the cap are two limits over one fleet and **the lower one wins**, so a bound frozen at boot silently
becomes the fleet's real cap the moment an operator raises the other one through `POST /api/control`:
every dispatch above the old number is refused for want of a directory, audited `rejected`, and
retried on the next cycle forever. What that presents as is a full "Up next" queue, one running
agent, a cap of five, nothing paused and nothing red — which is what it did, for over an hour, before
this was written. So the pool's `size` is a **live view of `RuntimeControl.cap`**, the same
by-reference read the harness's headroom does. A deployment that cannot hold that many checkouts
lowers the cap, which is the same statement made where the fleet can act on it: fewer agents rather
than the same agents queueing for a directory that is never coming.

**Growing the ceiling mints nothing.** A slot is created only when a dispatch needs one and the pool
is below its bound, so raising the cap costs no disk until the fleet actually runs that wide — which
matters when one checkout of the repository is measured in tens of gigabytes. Lowering the cap does
not delete anything either: the slots already standing keep their warm trees, and the pool simply
stops growing.

With every slot unavailable and nothing left to reclaim, `ensure` **throws** and the executor audits
a rejected dispatch, which settles the task and leaves the next cycle to try again — and, if it goes
on doing that, [says so on the rail](#a-refusal-that-keeps-repeating). Rejecting is
preferable to blocking — waiting on a directory would hold the pulse. The refusal names each slot and
why it is unavailable, what the reclaim did or could not do, the two knobs, and the directories under
`worktreeRoot` that are not registered worktrees at all, because a rejection that names none of that
is a dead end in the decision log.

### Slot names and migration

Slot directories are `slot-0`, `slot-1`, … under `worktreeRoot`. There is no migration: a directory
left by a pre-pool deployment (named after a branch) is a registered worktree under the same root, so
it counts toward the bound and is leased like any other slot.

### Reclaiming a stranded slot

A slot carrying uncommitted tracked changes is refused by the survey — correctly, since a hand-over
would carry those edits onto an unrelated branch ([above](#the-lease)) — and until this existed
**nothing ever took them off it**. So the refusal was terminal: every failed or killed agent cost the
deployment one directory for the life of the process, and the pool silted up monotonically until the
fleet stopped. It is not an edge case either. On a repository whose build rewrites a **tracked**
generated file, _every_ slot an agent builds in is stranded the moment its lease ends; that is the
steady state, not the exception.

So `ensure`'s dead end reclaims instead of refusing. For each free-but-stranded slot:
`git stash push --include-untracked`, the resulting commit copied to
`refs/lubbdubb/salvage/<slot>/<sha>`, and the entry taken back off the stash stack. The slot is then
clean, so the retry reaches it as a spare or an evictable one and the dispatch proceeds.

- **Nothing is ever classified, and nothing is discarded.** Telling a build's dirtied generated file
  apart from an agent's half-finished feature is a judgement about a repository the harness does not
  have and must not grow, and being wrong destroys the only copy of somebody's work — silently, which
  is the genre this whole document exists to keep out. So everything uncommitted is kept and the
  operator decides. `--include-untracked` covers the new file an agent had not committed yet;
  **ignored** files are deliberately not stashed, since a dependency tree does not belong in a git
  object and the slot's next occupant already has rules for it.
- **A detached HEAD needs no special case, which is why a stash and not a commit.** A stash commit's
  parent is whatever HEAD is, named or not — and two of the stranded slots in the incident were
  detached, with no branch to commit onto. Committing onto the branch would have been wrong where
  there _was_ one, too: the agent's abandoned half-work would land in its pull request.
- **A ref of the pool's own, not the stash stack.** `refs/lubbdubb/salvage/…` is outside `refs/heads`,
  so it is not a branch to anything that reads branches — not `git branch`, not a push, not the reap's
  `reapableBranches` — and it moves for nobody. The stack is the operator's: its entries shift under
  whoever reads them next, and a stray `git stash pop` in the main checkout would drop an agent's
  800-file diff into their working tree. The name is content-addressed, so salvaging one slot twice
  cannot overwrite the first. `git for-each-ref refs/lubbdubb/salvage` lists them and
  `git stash apply <ref>` puts one back.
- **It runs at the dead end and nowhere else.** A sweep on the harness pulse would shell out
  `git status` across every checkout in the pool every ten seconds to answer a question that matters a
  few times a day, and on tens of gigabytes each that is not acceptable. A pass on release or at boot
  would pay the same cost off-schedule and salvage trees nobody was waiting for — where a slot left
  standing on its branch, dirt and all, is exactly what a re-dispatch onto that branch comes back to.
  At the dead end the `git status` per slot has **already been run by the survey**, so the reclaim
  costs nothing until the alternative is a rejected dispatch.
- **The lease is never reached past.** Only slots the survey marked free _and_ stranded are touched —
  the same arm that has already established no lease and no mark holds them. A held slot is not
  reclaimable however dirty it is, which is the property that keeps two agents out of one directory.
- **It is visible.** Each reclaim is recorded to the error log naming the slot and the ref its work
  went to, since a reclaim that ran invisibly would be the same silent-failure genre as the bug. So is
  a stash git refused — that slot simply stays blocked and the dispatch is rejected as before, and the
  refusal repeats the reason. A slot needing this after every dispatch is a repository with tracked
  files a build rewrites; the log says so, because untracking them is the actual fix.

### Reclaiming an orphaned directory

An interrupted or killed agent can leave its checkout **de-registered but present** — the
`.git/worktrees/<name>` admin entry gone, the folder still on disk. The porcelain list cannot see
one, so the slot is not in the pool; the next slot path is then computed and `git worktree add`
refuses it with `fatal: '<dir>' already exists`. Because slot paths are deterministic, every retry
hits the same wall: the pool is one smaller for good, and the decision log shows nothing but
repeated `rejected` dispatches. `git worktree prune` does **not** clean it — prune is the mirror
case, an admin entry whose directory vanished, and it runs ahead of the slot scan on every `ensure`
for exactly that half.

So before minting a slot, `ensure` checks whether the target path exists on disk and is **not** in
the porcelain list, and removes it if so (`git worktree remove --force` first, its failure ignored,
in case git still half-tracks it).

- **Registered is untouchable.** The guard is the porcelain list, not the presence of a `.git` file:
  a directory git still knows about is some agent's live checkout, and yanking it mid-run is far
  worse than the collision. A registered worktree standing on the path was already surveyed as a
  slot, so it is unreachable here at all — and the `add` failing loudly is the honest answer if it
  ever were.
- Reclaiming **discards** whatever the dead orphan still held. With no admin entry there is no
  branch or commit behind those files and no workflow that could recover them; they are unreachable
  either way.
- Porcelain paths are forward-slashed even on Windows, so they are `resolve`d before comparison —
  an unresolved path would never compare equal to the resolved target.

**A lock is transient; `force` is not the flag for it.** `rmSync`'s `force` suppresses "it isn't
there" — the opposite failure. A directory another **live process** holds open still throws `EBUSY`,
and on Windows merely being a running process's cwd is enough. So the removal retries (5 × 200ms,
Node's own retry set being exactly the transient errors: `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`,
`EPERM`), which is sized to tell a file still closing apart from a process that is going to be there
all day — not to outwait the second, since a dispatch that hung on for a minute would be worse than
failing.

What it throws when the retries run out **names the cause, not the errno**.
`EBUSY: resource busy or locked, rmdir '<dir>'` is a true statement of the syscall and a dead end as a
report: it reads the same whether a scanner had the folder open for a moment or a shell an agent left
behind two days ago is sitting in it, and the operator's next move — go find that process and stop it
— is in neither reading. The retries have already ruled the transient case out by then, so the message
says the directory is held open by another process, that it is usually one an earlier agent started
and left running, and that every dispatch onto the branch will fail here until it is stopped. The
executor's `catch` puts that text in the decision log as a rejected dispatch.

This is the residue of [10](10-agent-runtimes.md#reaping-the-process-subtree): stopping an agent now
takes its whole subtree down, so the common case no longer arises — but an agent that exits by itself
leaves descendants nothing can walk to, and `reclaim` is where that shows up. Tests:
`test/worktreeManager.test.ts` (Windows-only for the lock itself — POSIX permits removing a live
process's cwd, so there is nothing there to reproduce).

**Only the path being minted, and only automatically there.** The same operator's `worktreeRoot` held
eighteen directories against five registered worktrees: thirteen dead full checkouts, tens of
gigabytes, invisible to `slots()` and to the bound because git no longer knows about them, and beyond
`git worktree prune`, which is for the mirror case. They are **not** deleted automatically, and that
is a decision rather than an omission — `worktreeRoot` is an operator setting, an unguarded recursive
delete under a mistyped one is unrecoverable, and none of those directories costs the pool a slot or
blocks a dispatch. They cost disk, which is a thing to be told about rather than acted on. So the
[exhaustion](#exhaustion) refusal counts and names them (five, then a count), says that prune has
already run so nothing in the harness will ever reach them again, and leaves removing them to the
operator. The one exception is the path a new slot is about to be minted on, above, where a leftover
is not a disk cost but a wedged slot.

### Release

`remove(name)` releases the lease and **deletes nothing**. That is the whole change: the slot stays on
its branch (or at its commit, for a read-only checkout) with everything git ignores in it, and a
failed or killed agent's tree stays readable until the slot is reissued. A read-only checkout needs no
other ending: there is no ref for a reap to collect, which is the whole of why it exists.

`deleteBranch(branch)` — the local half of the reap after a pull request merges — releases the lease
and deletes the ref. `git branch -D` refuses a branch that is checked out anywhere, and the directory
is no longer the branch's to delete, so the slot holding it is **detached** (`git switch --detach`)
and left standing for the next occupant.

**It asks the lease first, and refuses a held slot rather than damaging it.** This is the one
`Worktrees` method that mutates a slot without handing one out, which is how it escaped
[the lease](#the-lease)'s "never reached past". Its caller's guard — `reapableBranches` skipping a
branch with an active task — is the **durable** half of the lease and only that half, so it evaporates
the moment a task settles, while the agent's process is still in the directory until `reaped` fires;
the window is widest for a killed agent, where `kill` settles the task synchronously and the process
death is asynchronous. Detaching in that window hands a live process's tree to the next dispatch,
which wipes it `git clean -ffdx` — and on Windows is the `EBUSY`-forever wedge. So both arms are
asked, and a held slot makes this **throw**: `BranchReapDesk` catches, records and continues **without**
writing the `branch_reaps` row, so the reap is retried next pulse and the remote branch is not deleted
either. One pulse held is the same trade the active-task guard already makes. The repo's own main worktree is exempt: detaching an
operator's checkout to reap a branch would be a rude surprise, and `-D` failing loudly is the honest
answer there. `-D` and not `-d` for the reason it always was — `merge_pr` squashes, so `-d`'s "is
this merged" test says no for every branch this is called on.

`src/system.ts` listens for `agents.on('reaped')` and releases the slot when:

- the task has a branch, **and**
- no other active task shares that branch.

**Every agent status, not just `done`.** Nothing else releases a lease, so skipping the failed and
killed ones would shrink the pool by one per failure with nothing at all to say so — where under the
old manager the same condition merely left a directory on disk.

Sequencing still matters: `reaped` fires only once the process has _actually exited_, because that
process is still sitting in the directory the next occupant will clean and switch. A release failure
is recorded to the error log.

One release does not hang off an agent at all: a dispatch that got past `ensure` and threw at the
spawn holds a lease no `reaped` event will ever release, so `abandonUnstarted` gives the slot back
along with the task row it settles.

## Git

`src/git/` is the whole git-shell-out corner.

- **`runGit(repoRoot, args)`** — the one place `cwd: repoRoot` lives.
- **`fetchRemote(repoRoot)`** — `git fetch --prune origin`. `--prune` so a deleted remote branch stops
  reading as present.
- **`resolveCommit(repoRoot, ref)`** — resolves to a **SHA**, trying `refs/remotes/origin/<ref>`, then
  `refs/heads/<ref>`, then `<ref>^{commit}`. **`origin/` wins over the local ref**: the harness's clone
  never checks the integration branch out, so its `refs/heads/main` is frozen at clone time while the
  remote-tracking ref moves. It returns a SHA rather than a ref name on purpose — handing
  `git worktree add -b` a remote-tracking ref would set the new branch's _upstream_ to it, so a later
  bare `git push` would aim at the base.
- **`GitObserver`** (`gitObserver.ts`) — the read-only seam: `presence(branch)`,
  `divergence(branch, base)`, `hasCommitsBeyond(branch, base)`. Deliberately **fetch-free**; how often
  to refresh is the caller's decision. Its one consumer is plan reconciliation.
  `FakeGitObserver` is the test implementation.

New observer methods must stay read-only and fetch-free.
