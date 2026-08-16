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

### 2. The one standing authority — `store.standingLandingForPr(prNumber)`

**The harness authorizes no outbound act on its own.** There was a confidence gate here once:
`autoSendVerdict` compared a dispatcher-reported number against a configured threshold and could send
a reply or land a merge with nobody asked. It is gone, along with the `autoSend` config block and the
`confidence` field on the two actions that carried it — the number was a hardcoded literal at one
emitter, so the "threshold" resolved between two constants and measured nothing.

What is left is a **stack landing**: the operator's own authorization over a chain, clicked once over
the pull request numbers it covers ([12](12-stacked-prs.md)). Asked only of a merge — a landing says
nothing about replies — and asked _after_ the hold, so a rejection they gave still governs, and
_before_ the escalation, so an authorized chain does not fill the inbox with the questions it exists
to answer.

**Nothing here can reject.** Only a human can, because a rejection is durable and a machine "no"
would mean the question is never put to anyone. Unauthorized means "not mine to authorize", which is
exactly what a pending proposal already says.

### 3. Either the standing authority or an ask

- **Covered by a landing** → `store.createProposal(…)`, then `decideProposal(id, 'accepted', note,
'stack_landing')`, then `runAuthorized(accepted, cycleId)`. No escalation: nothing is being asked of
  anyone. One appears only if the act then fails.
- **Everything else** → an escalation (`approve_change` for a merge, `review_reply` carrying the
  draft) plus a **pending** proposal hanging off it, audited `executed` — an escalation did happen.
  Accepting performs the act; rejecting records the reason and stops.

## Performing an authorized act

`ActionExecutor.runAuthorized(proposal, pulseCycleId?)` is the one place an accepted proposal becomes
its effect _and_ its audit row. `ProposalDesk.accept` calls it with no cycle id; `authorize` calls it
with the pulse's.

`readProposedAct(proposal)` re-reads the stored action into one of three `ProposedAct`s, re-checking
the fields the effect is about to be handed rather than trusting a round trip through JSON and SQLite:

| Act           | Effect                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `merge`       | `sink.mergePr({prNumber, method})`                                                                      |
| `reply_draft` | `sink.postPrReply({prNumber, commentId, body})`                                                         |
| `plan`        | `releasePlan(store, planId, originRef)` — publishes nothing; see [08](08-planning.md#the-approval-gate) |

`plan` is checked **before** the PR number, or an approved decomposition audits as "names no PR
number". A malformed payload is reported, never guessed at.

`authorityOf(proposal, pulseCycleId)` decides the whole decider → cycle id → wording chain at once,
because the three are a chain and not three facts:

| Decider         | Cycle id                                                                          | Reads as                                         |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| `human`         | `human:<proposal id>` — a decision made outside the pulse, like `agent-lifecycle` | `authorized by you`                              |
| `stack_landing` | the pulse's own cycle id                                                          | `authorized by you, landing the stack`           |
| `auto_send`     | the pulse's own cycle id                                                          | `authorized by auto-send` — historical rows only |

A standing landing accepts _inside_ a cycle, so its row stays grouped with the pulse that produced
the action and **cannot** carry the `human:` prefix the cockpit badges "you · accepted" off — that
prefix marks a click being applied at a route, and this one was clicked earlier, over the chain.

`auto_send` survives in the `decidedBy` union as a **historical** value only. Nothing writes it; a
database written before the gate was removed still holds rows carrying it, and a decider the cockpit
cannot name reads as a missing authority rather than an old one.

**The failure path is one path for both deciders.** A send that throws creates an `autoMergeFailed`
escalation and audits `rejected` (the act did not go out). The proposal stays `accepted` — it _was_ accepted — and once its settle window lapses the gate
re-proposes if the world still warrants it. That is the recovery; it needs no new state.

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

Every stage of a goal is a fresh agent with no memory of the last. The assayer read the ticket against
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
  body; a part's **`rationale` / `acceptance`**, stored and rendered nowhere at all; and the **prose
  behind each standing verdict** (assay, conclusion, delivery, shortfall). It therefore omits
  `plan.reason` (rendered by `currentPlanSummary` to a replanner and as `{plan}` to a part agent) and a
  part's status, branch and PR number (`currentPlanSummary`, `siblingContext`).
- **No world facts.** A pull request's state is live through `world_read`; pasted into a prompt it would
  be a stale second reading of something the agent can ask about properly.
- **Scoped by `padOriginFor`, not a fresh predicate** — already the harness's answer to "which goal is
  this agent working": the `issue:<n>` root plus its `:plan`, `:assay`, `:assess` and `:part:<slug>`
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
  recent 15 entries and the write-up at 4 000 characters, with the elision stated and `scratch_read`
  named, or a partial record reads as the whole one.

## The operator's own instructions reach the agent

The cockpit's **More work** control writes what the operator wants done on a goal, in their words —
_change the button to primary_, _the permission is wrong_, _the loading icon spins forever, fix it_.
It replaced a bare `more_work` toggle whose fixed note (`Set by the operator from the cockpit.`)
carried none of that, so the next agent re-read the same ticket that had already produced the thing
the operator was unhappy with. The rows are in
[14](14-persistence.md#operator-instructions-on-a-goal); the routes that write them are in
[16](16-http-api.md#post-apiissuesnumberinstruction).

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
  about the goal, and the agents that work it are dispatched for `:plan`, `:assay`, `:assess` and
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
  `trackerCoordinates`' arrangement exactly ([13](13-jobs-and-findings.md)). Null under the `fake`
  provider, where the note says there is nothing to update rather than naming a command that would
  fail.
- **An untouched goal appends nothing**, so its prompt is byte-identical to one composed before this
  existed.

## An operator's attachments reach the agent

A blueprint launched from the cockpit may carry images (issue #249) — a screenshot of the panel to
change, the broken screen, a before/after pair. They are written once under `attachmentRoot`
(`src/jobs/attachmentFiles.ts`) and recorded in `job_attachments`, keyed on the ref they belong to,
which while the request is a blueprint is `job:<id>` and afterwards is the `issue:<n>` the blueprint
was filed as. See [14](14-persistence.md#blueprint-attachments) for the rows and the re-key, and
[16](16-http-api.md#launching-a-blueprint) for how they arrive.

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
  a scratchpad, so the two cannot drift. It has to be: a filed blueprint's images are keyed `issue:<n>`
  while the agents that go on to work it are dispatched for `issue:<n>:assay`, `:plan`, `:part:<slug>`
  and `:retro`. An exact match would put the screenshot in front of the filing agent alone, the one
  agent that writes no code. An origin outside any issue subtree — a `job:<id>` blueprint that
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

The executor depends on the `Worktrees` **interface**, not the class: `ensure`/`remove` is the whole
of what it and the reap in `system.ts` ask for, and a seam wider than its consumer is a fake with
behaviour nobody checks. `WorktreeManager` is the real implementation, wired by default;
`FakeWorktreeManager` is the injected one (see [19](19-development.md)). This is git's **write** side
given the treatment its read side already had in `GitObserver` — the asymmetry was load-bearing,
because the write side is the half that mutates a repository.

`ensure(branch, base?)`:

1. An existing worktree for the branch is returned as-is.
2. A stale target directory is **reclaimed** (below).
3. An existing **local branch** gets a worktree added at it.
4. With no `base`, `git worktree add -b <branch> <dir>` forks from the repo root's HEAD.
5. With a `base`, it is resolved through `resolveCommit`; a base that resolves to nothing **throws**
   rather than quietly falling back to HEAD — silently picking an incidental base is the bug the
   parameter exists to fix. The executor's `catch` audits it as a rejected dispatch.

**Reuse comes first, and `base` is then ignored entirely.** `ensure(branch, base)` does not guarantee
the branch is based on `base`; it only decides where a branch that did not exist starts. You do not
move an in-flight agent's branch out from under it.

The directory name is the branch with every character outside `[a-zA-Z0-9._-]` replaced by `-`.
`remove(branch)` runs `git worktree remove --force` when a worktree exists.

### Reclaiming an orphaned directory

An interrupted or killed agent can leave its checkout **de-registered but present** — the
`.git/worktrees/<name>` admin entry gone, the folder still on disk. `findExisting` reads
`git worktree list --porcelain`, so it cannot see one; the deterministic path is then computed and
`git worktree add` refuses it with `fatal: '<dir>' already exists`. Because the path is
deterministic, every retry hits the same wall: the branch is wedged for good, the issue never gets
an agent, and the decision log shows nothing but repeated `rejected` dispatches. `git worktree
prune` does **not** clean it — prune is the mirror case, an admin entry whose directory vanished.

So before every `worktree add`, `ensure` prunes (cheap and idempotent, clearing that mirror-case
cruft) and then, if the target path exists on disk and is **not** in the porcelain list, removes it
(`git worktree remove --force` first, its failure ignored, in case git still half-tracks it).

- **Registered is untouchable.** The guard is the porcelain list, not the presence of a `.git` file:
  a directory git still knows about is some agent's live checkout, and yanking it mid-run is far
  worse than the collision. Two branches can sanitize onto one directory — when a live worktree
  stands there the `add` fails loudly, which is the honest answer.
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

### Removal

`src/system.ts` listens for `agents.on('reaped')` and removes the worktree only when:

- the agent's status is `done` (failed and killed agents keep theirs for debugging), **and**
- the task has a branch, **and**
- no other active task shares that branch.

Sequencing matters: `reaped` fires only once the process has _actually exited_, because a live process
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
  `git worktree add -b` a remote-tracking ref would set the new branch's _upstream_ to it, so a later
  bare `git push` would aim at the base.
- **`GitObserver`** (`gitObserver.ts`) — the read-only seam: `presence(branch)`,
  `divergence(branch, base)`, `hasCommitsBeyond(branch, base)`. Deliberately **fetch-free**; how often
  to refresh is the caller's decision. Its one consumer is plan reconciliation.
  `FakeGitObserver` is the test implementation.

New observer methods must stay read-only and fetch-free.
