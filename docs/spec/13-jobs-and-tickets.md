# 13 — Jobs, tickets and human tasks

Three operator-facing queues, split by **who acts on them**. A **job** is work the operator asked
for, done by an agent — queued by hand, or by a **schedule** on a clock. A **filed ticket** is work
handed to the tracker so it waits its turn there with everything else. A **human task** is work only
a person can do, and the operator is the one who does it.

**Two of what used to be here have gone.** A **finding** was a claim an agent filed and an operator
ruled on; a **lesson** was a claim of a different kind — what working a goal taught about working
this repository. Both were the same shape of thing said twice, and both are `knowledge_facts` rows
now: raised through one intake, matched by one matcher, ruled on through one set of reaches, and
drawn on one page. What they used to do about an operator's click — become a job, become a ticket —
is [an exit](27-knowledge.md#sending-a-claim-on), and it is the same machinery this document
describes below. → [27](27-knowledge.md#what-the-three-stores-became)

## Jobs

A job is an ad-hoc prompt queued from the cockpit. Unlike a `Task` — created the instant an agent
spawns — a job persists **ahead of** dispatch, so it can sit in a queue when the fleet is at capacity.

```ts
interface Job {
  id;
  title;
  prompt;
  kind: 'code' | 'desk';
  branch: string | null; // code jobs; null => derived job/<id> at dispatch
  status: 'queued' | 'dispatched' | 'cancelled';
  originRef: string | null; // the work this job stands in for; null for an ordinary job
  taskId: string | null; // set once dispatched
  createdAt;
  updatedAt;
}
```

### Queueing — `POST /api/jobs`

Body `{prompt, title?, kind?, branch?}`. `prompt` is required and non-empty; `kind` defaults to
`'code'` and must be `code` or `desk`. When no title is given, one is derived from the prompt's first
non-empty line, capped at 80 characters with an ellipsis.

For a **code** job naming a branch, `Store.findActiveTaskByBranch` is asked up front and a collision
**409s** with the holding task's id and origin. The executor's identical check remains the real gate —
a branch can go busy between queueing and dispatch, so this one cannot be the only one — but a 409 now
is worth far more to the operator than a deferral they would have to read out of the decision log hours
later. The two cannot drift apart because they ask the same predicate; they differ only in _when_,
which is why this one rejects (nothing has been promised yet) and the executor's defers (a queued job
the operator is entitled to have retried).

Desk jobs skip the check entirely: rule `manual-job` ignores a desk job's branch.

The route creates the job, broadcasts `world:changed`, and kicks a cycle so a job dispatches
immediately when there is headroom.

### Blueprints become tickets — `POST /api/jobs`, the code arm

A code job injected from the cockpit is a **blueprint**, and it enters the workflow through the same
door as a ticket rather than being dispatched straight onto a branch (issue #198). When a tracker is
configured (`trackerCoordinates(config) !== null`), the route does not queue a code job on the raw
prompt; it files a **watched ticket** so the work flows through the whole planning funnel — the goal
assay, the planning agent, the plan's parts — exactly like a picked-up issue. The workflow's two entry
points ("start with a prompt", "start with a ticket") are drawn converging on _find-or-create a ticket,
then the funnel_; this is the prompt arm wired to that convergence.

- **The harness files it, on the request.** No job is queued and no agent is dispatched for it
  ([filing a ticket](#filing-a-ticket)). This arm is the one that made the case: the ticket must carry
  the effective `${labelPrefix}-watch` label or the watch gate never picks it up, and an agent that
  forgot it left the item created, the filing shown complete in the cockpit, and **nothing ever
  dispatched** — no error, nothing red. A `labels` array the harness passes cannot be forgotten. The
  empty case is a `[]` rather than a sentence: `labelPrefix: ''` turns the watch gate off (the harness
  acts on every open issue), so there is nothing to tag and nothing is written.
- **The body was never being delegated.** It is the operator's own request, verbatim — the only
  judgement a desk agent added was a title, and the request's first line is that. The wording stays
  overridable through the `blueprint-ticket-body` template, whose pure fields come from
  `blueprintTicketFields(request)` (`src/blueprintTicket.ts`); `body.title` on the launch still wins
  over the derived one.
- **The whole transform is at route time; rule `manual-job` is untouched.** That is a clean recursion
  boundary: only an operator-injected code blueprint via this route becomes a ticket, and there is no
  second job for the transform to reach again.
- **No filing row.** One existed only so `link_ticket` could resolve the created issue back from the
  filing agent's credential, and there is no filing agent. The route answers `{ok, ticketRef}`, and the
  issue stands up in the graph from the world on the next pulse like any other.
- **Attachments are written under the ticket** (`issue:<n>`), not under a job and then moved. The
  harness knows the number before any byte is written, so an image is the goal's from the moment it
  lands — every agent the funnel dispatches for the issue is handed it
  ([12](12-artifacts-and-files.md)). A create that succeeds and an attachment write that fails is
  recorded, not raised: the ticket is what the operator asked for, and losing a screenshot's onward
  visibility is the smaller failure.

**Fallbacks are today's behaviour.** A **desk** blueprint (a direct answer, a report) is dispatched as
asked. A code blueprint with **no tracker** (`fake`/unconfigured) has nowhere to file, so it too
dispatches directly — and the branch-collision 409 above applies only on this arm, since a filed
blueprint's branch is meaningless (the funnel works `issue/<n>` branches later).

Tests: `test/blueprintTicket.test.ts`, `test/attachmentsSurviveTicket.test.ts`.

### Dispatch — rule `manual-job`

`DispatchContext.queuedJobs` is wired from `store.listQueuedJobs()` (oldest first). The dispatcher
pushes them onto the **front** of the candidate list, **before any world-driven rule**, so the headroom
cut dispatches them first: a manual request takes the next free slot. A job below the cut shows as
`waiting` in the Up next queue and is retried next cycle.

- The origin is `job:<id>`; a job whose origin already has an active task is skipped.
- The branch is `job.branch ?? "job/<id>"` for code jobs, `null` for desk.
- **No cooldown throttle applies** — a job is a one-shot request, not a persistent signal.
- The emitted action carries `jobId`, and the executor calls `Store.markJobDispatched(jobId, task.id)`
  **only after** the agent actually spawns, so a job the cap or pause gate held stays `queued`.
- A dispatch that **throws** — a worktree `ensure` that fails, a session that will not start — also
  leaves the job `queued`, and the executor settles the task row it had already written so the job's
  own `job:<id>` origin is claimable again next cycle. Without that settlement a job is retried
  forever against a claim only it holds, and the harness reports "nothing actionable" while its queue
  stands still; see
  [09 — A failed dispatch settles its task row](09-execution.md#a-failed-dispatch-settles-its-task-row).

### Standing in for another origin

`Job.originRef` is the work a job **redoes**, and only a crash recovery's requeue sets it (see
[10](10-agent-runtimes.md#crash-recovery)): the retired task's origin, `issue:41:retro` or `pr:42:ci`.
It is not the job's own origin, which stays `job:<id>` — that is what the dispatch is keyed on, what
`markJobDispatched` matches, and what the work graph folds the job's PR onto.

It exists because the gates that stop two agents landing on one piece of work read **origins**. A
requeued retro's task says `job:<id>`, so without this field the rule that dispatched the original
sees nothing in flight and dispatches a second agent onto the same goal — which is what happened to
issue #249, where two retro agents ran at once and both would have called `retro_submit`.

A job **stands in** for its origin while it is `queued`, or while the task it became is still active
(`dispatched` is terminal for a job, so the task is the only thing that says whether the work is
still going on). That predicate is stated once, in `src/store/jobs.ts`, and asked by both readers:

- `DispatchContext.standingJobs` (`store.listStandingJobs()`) is folded into the dispatcher's
  `activeOrigins`, so no rule even produces a candidate for work a requeue is redoing.
- `store.findStandingJobByOrigin` is the executor's half of the same gate, which closes the window a
  requeue filed **after** the snapshot the dispatcher decided on opens.

The origin is claimable again the moment the requeued job's task ends — the requeue holds the work,
it does not retire it.

#### Why a requeue never stands in for a _queued_ job

The gate is transitive, and that is what makes it dangerous in one specific shape. A job's dispatch
task carries origin `job:<N>`, so a requeue of that task files a job whose `originRef` is `job:<N>` —
and if job N is **itself still queued**, job N+1 now stands in for it and `manual-job` skips N for as
long as N+1 sits in the queue. Repeat the failure and the queue grows a chain
(`Requeued: Requeued: Requeued: …`) in which only the newest link can ever be tried, and no older one
can run or expire. Observed on one branch for two days.

The gate is right and is not weakened. The chain is prevented one step upstream, in
`RecoveryDesk.decide`: a job leaves the queue only through `markJobDispatched`, which runs after the
spawn succeeds, so a predecessor still `queued` means **no agent ever ran and the queue already holds
the request**. There is nothing to redo. The verdict files nothing and hands that job back as the
requeue — see [10](10-agent-runtimes.md#the-three-verdicts). A `dispatched` predecessor still gets a
real new job, and locks nothing: no rule dispatches a dispatched job, and the requeue is reached under
its own `job:<N+1>` origin, which nothing stands in for.

A chain already written to a database predates the collapse and stays locked until its newest link is
cancelled.

### The branch invariant

Rule `manual-job` is the **one** dispatch path where origin and branch are not 1:1, so it is the one that needs
the property enforced rather than merely observed. `job.branch` is a free string the operator supplies
while the origin `job:<id>` is unique by construction, so `activeOrigins` and `findActiveTaskByOrigin`
— which gate the branch for free everywhere else — are both blind to it. `WorktreeManager.ensure` being
reuse-first makes the failure silent rather than loud: two live agents land in **one worktree
directory**, editing the same files with no merge anywhere to reconcile them.

Closed with one predicate, `Store.findActiveTaskByBranch`, asked in two places: the route (409) and the
executor (deferral). It is a **no-op for every world-driven rule** — that is the point, and
`test/jobQueue.test.ts` asserts it: a broad world, then two assertions, that the gate never fired and
that no two live tasks share a branch. A later rule that broke the 1:1 property fails a test instead of
quietly sharing a checkout.

### Cancellation — `POST /api/jobs/:id/cancel`

`Store.cancelJob` drops a still-`queued` job. A job already dispatched **cannot** be cancelled here —
it is a live agent, so kill it instead. The route 409s when the job is absent or no longer queued.

`jobs` was a fresh `CREATE TABLE`, but `origin_ref` post-dates it, so it has a `JOB_COLUMNS` entry
([14](14-persistence.md#migrations)). Tests: `test/jobQueue.test.ts`.

## Schedules

A **schedule** is a job the operator wants queued on a clock rather than by hand: "sweep the
dependencies every Monday at 09:00", "review the open pull requests every night". It is the same
prompt, the same composer, the same queue — with a `when` attached.

```ts
interface JobSchedule {
  id;
  title; // what each firing's job is called; derived from the prompt when omitted
  prompt; // what each firing's job says, verbatim
  kind: 'code' | 'desk';
  cron: string; // five fields, read in the harness process's local timezone
  enabled: boolean;
  nextRunAt: string | null; // null while disabled, and for an expression that never matches again
  lastFiredAt: string | null;
  lastJobId: string | null; // the job the last firing created
  createdAt;
  updatedAt;
}
```

### It queues, and that is all it does

**A firing writes an ordinary `jobs` row.** Rule `manual-job` drains it exactly as it drains one the
operator launched from the composer: under the same cap, the same pause flag, the same Up next queue
and the same branch invariant. So a schedule adds a way for work to **arrive** and no way for it to
be **run** — every gate that stands between a queued job and an agent is untouched, and none of them
knows or cares that a clock queued this one.

That is the whole containment argument, and it is why there is no config key, no per-schedule
concurrency limit and no "scheduled" flag anywhere downstream. A recurrence that could dispatch
around the cap would be the capability escalation the claim store is careful not to be
([27](27-knowledge.md#what-nothing-does)); one that queues is just an operator who is asleep.

### The expression

Five fields — `minute hour day-of-month month day-of-week` — each a star, a number, an `a-b` range, a
`/n` step on either, or a comma-separated list of those. `src/schedules/cron.ts` parses and steps
them, and it is the only thing in the harness that knows what an expression means.

- **Written rather than depended on.** The syntax is fixed by forty years of crontab and is a hundred
  lines to implement; a dependency would be a supply-chain surface and a version to carry for
  something no upstream is going to change.
- **Names (`MON`), `@daily` aliases and a seconds field are refused**, not half-supported. An
  expression that parses to something other than what its author reads is worse than one that will
  not parse at all, so every refusal is one sentence naming the field and what that field accepts —
  handed back verbatim by the route and printed under the input by the cockpit.
- **Fields are read in the harness process's local timezone.** That is what an operator means by
  "weekdays at 09:00": the machine the fleet runs on is the one they are sitting at. The two days a
  year it differs from any other clock behave the way their own crontab does, because the search
  steps a real `Date` rather than doing arithmetic on epoch milliseconds.
- **Vixie's day rule holds**: with _both_ day fields restricted the match is their union, so
  `0 9 1 * 1` means "the 1st, and every Monday". It is the one part of the syntax that surprises
  everybody, and the surprise is silent, so it is stated in the parser, the spec and a test.
- **An expression matching no future minute** (`0 0 30 2 *`) resolves to a null `nextRunAt` rather
  than being re-asked every pulse forever.

### Firing — the `ScheduleDesk`, once a pulse

`schedules.run()` sits with the other bookkeeping passes in `Harness.runCycle`
([04](04-harness-cycle.md#ordering)), a few lines **above** the `listQueuedJobs` the dispatcher
decides from — so a firing is dispatched on the pulse it fires rather than waiting for the next one.
Every decision is in the pure `schedulePass` (`src/schedules/schedule.ts`); the desk is the store
round trip around it, the shape `DeliveryCloseOutDesk` already has.

Three properties, all of them about a harness that was **not running** when a slot came round — which
is the normal case for a laptop, not an edge case:

- **A missed window fires once, not once per slot.** `nextRunAt` is recomputed from **now**, never
  from the slot that fired. A nightly schedule on a machine that was off for a week queues one job
  when it comes back; firing seven agents for the seven mornings nobody was there is a bill, not a
  catch-up.
- **A schedule never has two of its own jobs in flight.** If the job the last firing created is still
  queued, or the task it became is still active, the schedule is **rolled forward** to its next slot
  without firing. Rolled forward rather than deferred, so a 3am job does not arrive at 11am because
  last night's overran — the cadence the operator asked for is the one they get. The predicate is
  `listStandingJobs`' reasoning asked of one job: `dispatched` is terminal for a job, so the task it
  became is the only thing that says whether the work is still going on.
- **At most one firing per schedule per pulse**, which falls out of taking the next slot after `now`
  rather than draining every slot before it.

A failing schedule fails only itself: each firing is recorded through `errors.record` and the loop
carries on, because the alternative is one bad row taking the pulse that would have fixed it.

**The granularity is the pulse, not the minute.** `heartbeatIntervalMs` defaults to five minutes, so a
`0 9 * * *` schedule fires at the first pulse at or after 09:00 — never before it, and by default up
to five minutes after. A recurrence is a "some time this morning" instrument, and an operator who
needs the minute lowers the heartbeat. A **paused fleet** is the same shape from the other side: the
firing still queues, headroom is zero so nothing spawns, and the in-flight rule then holds every later
slot behind it — so a week of pause is one job waiting, not two thousand.

### What a firing does _not_ carry

- **No branch.** Each firing takes the derived `job/<id>` of its own job, so two firings can never
  share a worktree — the failure `WorktreeManager.ensure` makes silent. A fixed branch on a
  recurrence is that collision waiting for the first job that runs long.
- **Nothing interpolated into the prompt** — not the schedule's name, not the time, not "this is a
  scheduled run". An operator's prompt is theirs, and a harness sentence prepended to it is a
  sentence they did not write being read by an agent they cannot see. What connects the two is
  recorded instead: the schedule keeps `lastJobId`, and the job's own `job:<id>` origin is what
  everything downstream is keyed on.
- **No ticket, unlike a code blueprint from `POST /api/jobs`.** That route's convergence
  ([above](#blueprints-become-tickets--post-apijobs-the-code-arm)) is for a one-off intention
  entering the funnel. A recurrence is a standing one, and filing a fresh ticket every Monday would
  fill the tracker with copies of one sentence for the assay and the planner to judge identically
  each time. A firing is dispatched as the job it is.

### The four routes

`POST /api/schedules` writes one, `POST /api/schedules/:id` edits it (every field optional, so the
pause toggle and a reworded prompt are one call), `POST /api/schedules/:id/run` fires it now, and
`DELETE /api/schedules/:id` ends it. See [16](16-http-api.md#schedules).

Two decisions worth keeping:

- **The next slot is recomputed from now whenever the recurrence itself changed**, and cleared when
  it is paused. A schedule moved from 09:00 to 21:00 that kept yesterday's `nextRunAt` would fire at
  the old time once more, which is the edit visibly not taking; and a resume that fired instantly off
  a slot long past is not what a toggle means.
- **"Run now" ignores both gates the pulse applies on the operator's behalf** — a paused schedule
  still runs, and a previous firing still in flight does not hold it — because those exist to stop
  agents stacking up unattended, which a click is not. It deliberately does **not** move `nextRunAt`:
  running early is not a change of cadence.

### Deleted, not tombstoned

Unlike a rejected claim or a settled human task, a schedule is **deleted**. Those carry somebody's
judgement about a piece of work and a row that vanished would take the note with it; this carries an
intention that has ended, and there is no verdict to lose. Its history survives anyway — every job it
ever queued is still in `jobs`, with the agents and decisions that came of them.

`job_schedules` was a fresh `CREATE TABLE`, and `src/store/schedules.ts` declares an empty
`JOB_SCHEDULE_COLUMNS` anyway, for `human_tasks`' reason: a table being new **once** does not keep it
exempt. → [14](14-persistence.md#migrations)

Tests: `test/jobSchedules.test.ts`.

## Filing a ticket

Four cockpit clicks file a tracker item: a deferred **claim**
([27](27-knowledge.md#sending-a-claim-on)), unrecorded **work**, a **blueprint**, and a **bug** an
operator raised. All four go through `ActionSink.createIssue` ([15](15-integrations.md)), and none of
them asks a model to run a `gh` / `az` command any more (issue #394).

- **What the harness must supply is the one thing nothing else can infer: which tracker.**
  `trackerCoordinates(config)` (pure, `src/mcp/findings.ts`) names it from the same config block the
  **`issues` provider** is built from — so a ticket lands where the harness reads issues from and
  nowhere else. It returns null for `fake`, or for a provider selected without its config; every one
  of the four routes then 409s, and the snapshot ships `config.canFileTickets: false` so the cockpit
  hides the buttons rather than offering a click that cannot work. One predicate, five surfaces.
- **The type, the labels, the assignee and any relation are decided by the harness.** `ticketAssignee`
  (`src/ticketAssignment.ts`) reads `userId` ([02](02-configuration.md#userid)); `filingType` /
  `bugFilingType` (`src/ticketTypes.ts`) read `issueFilingTypes` and `issueBugType`
  ([02](02-configuration.md#what-type-a-filed-item-is)). Each of those was a sentence in a prompt, and
  a sentence is only as reliable as a model's memory of it: a blueprint's ticket without its watch
  label is never dispatched for, an Azure bug without its relation cannot be traced back to its story,
  and a create with no `--type` is refused outright, taking the ticket with it. `ticketFiler`
  (`src/tickets/filing.ts`) resolves all four per call, so all four arms file identically.
- **The wording stays operator-overridable**, because how a ticket reads _is_ house style. Two arms
  render a ticket **body** from the template book — `work-item-ticket-body`, `blueprint-ticket-body` —
  and two keep an agent to write one. Nothing about the change moves that judgement into the harness.
- **Two arms keep a desk agent, and two do not.** Where the whole body is already harness- or
  operator-composed text (unrecorded work, a blueprint), a desk agent was spending a slot on one API
  call. Where the body is a judgement — verifying a claim against the repository, writing up a symptom
  an operator observed — the agent stays, narrowed to composing the title and body and handing both to
  `link_ticket` ([11](11-mcp-tools.md)).

**A claim's arm is the one whose writing is most of the value**, which is why it kept its agent.
The body is one agent's report, and turning that into something a stranger can act on — verifying
what of it holds against the repository, and saying which parts are confirmed and which are the
raising agent's word — is judgement, not mechanism. `finding-ticket` is an ordinary overridable entry
in the template book, so how tickets are worded is changed by dropping a file in `promptTemplatesDir`
rather than by patching a route. It still carries `{kind}` and `{kindHelp}` as placeholders, filled
with what is true of every claim now, because a placeholder cannot be withdrawn the way a value can:
`renderTemplate` leaves an unfilled `{token}` in the prompt verbatim, so an override written against
the older book would ship a literal `{kind}` to the agent.

**It is asynchronous, and that is why the exit is two states rather than one.** The click queues a
desk job; the ticket exists only once the agent has written it and called `link_ticket`. An open
`ticket` graduation is the honest reading in between, and the claim stays exactly where it was until
the item exists — collapsing them would take it out of every prompt for a ticket that does not exist
yet, and leave nothing to show for an agent that died before creating one. `link_ticket` closes it
from the credential (`agent → task → its job:<id> origin → the graduation that job was created for`),
so the tool takes no argument naming what it is filing, and idempotence lives in the write.

- **A surviving agent is handed its dedupe candidates**, rather than told to go and search. The
  harness mirrors the tracker ([14](14-persistence.md#the-ticket-mirror)), so the adjacent items are
  computable: `dedupeCandidates` ranks the mirror by title-token overlap and `renderCandidates`
  **appends** the shortlist after the rendered prompt — never a `{candidates}` placeholder, which
  every override predating it would drop in silence. Closed items are candidates too; the mirror is the
  only place the harness can see one at all.

Tests: `test/ticketFiling.test.ts`.

### The other filing kind — a bug the operator raised

`POST /api/issues/:number/bug` ([16](16-http-api.md#post-apiissuesnumberbug)) is the same machinery
with a different author. A claim is an agent's testimony and a work-item filing is the harness
accounting for its own work; this one is the **operator's** — they ran the thing and it does not do
what they expect, which is the one fact about a goal no agent on it can derive, since none of them ran
it. Everything the claim arm establishes holds: the same tracker gate, a desk job, an overridable
template (`raise-bug`), two statuses, and `link_ticket` closing the loop from the credential by
carrying the title and body the agent wrote.

Four things differ, each for a reason worth keeping:

- **It needs two writes to be correct, and that is why it does not file itself.** A bug that is not
  linked back to its story is a bug nobody can trace. On Azure that is a `related` relation — `related`
  and not parent/child, which is legal whatever process template the project runs, where a parent link
  from a User Story to a Bug is refused outright by some of them. On GitHub it is a `#<story>`
  cross-reference in the body, which GitHub draws on both issues. Both are `relatedTo` on
  `createIssue` ([15](15-integrations.md)) and neither is a sentence an agent could drop. The type is
  `issueBugType` rather than the head of `issueFilingTypes`: what a process calls its bug type is
  exactly what varies (the Basic process calls it "Issue"), and matching on the word would file a
  story as a bug on the one project it is wrong for.
- **The row is keyed on the job, not on a target** (`issue_bug_filings`, [14](14-persistence.md)), so
  a story can carry several bugs. A story can be wrong in more than one way and each is its own bug;
  refusing the second would be a rule nobody asked for, and it is why this is a table of its own
  rather than a fourth use of `work_item_filings`.
- **The operator's report is required and rides only in the prompt.** It is not stored a second time:
  the job's prompt carries it verbatim and is durable, and two records of one sentence are free to
  drift.
- **It decides nothing about the story it came from.** No verdict is written, no state moves. The bug
  carries the work, which is also the only arrangement in which the fleet is handed the operator's
  own words as the goal.

Tests: `test/raiseBug.test.ts`.

## Human tasks

Every unit of work the harness spawned was dispatched to an agent. Work only a **person** can do —
flipping a setting in a console nobody gave the fleet an account for, plugging in hardware, looking
at a rendered screen and saying whether it is right, signing off that a goal is actually met — had no
representation at all. An agent that hit one could only escalate, which is a different shape.

```ts
interface HumanTask {
  id;
  title; // the ask, one line — validation refuses a newline
  detail: string | null; // what to do and how to know it is done, markdown
  originRef: string | null; // the work it belongs to: "issue:12", "issue:12:part:schema", "pr:42"
  partId: string | null; // the plan part this task *is*, when a planner declared a step for a person
  kind: 'ask' | 'close_out' | 'burn' | 'validate' | 'supply'; // who it is for the harness — see below
  agentId: string | null; // the requesting agent, from the credential; null when nobody individual asked
  taskId: string | null;
  status: 'open' | 'done' | 'declined';
  resolution: string | null; // the operator's note — required on `declined`
  createdAt;
  updatedAt;
  resolvedAt: string | null;
  dismissedAt: string | null; // when the operator cleared the settled row off the bench
}
```

`human_tasks` was a fresh `CREATE TABLE`, and `src/store/humanTasks.ts` declared an empty
`HUMAN_TASK_COLUMNS` anyway: a table being new **once** does not keep it exempt. `kind` and
`dismissed_at` are the columns that collected on it — `kind` with a `'ask'` default, so every row
written before the close-out existed reads as what it is, and `dismissed_at` nullable with none,
because null is already true of every row from before there was a way to dismiss one.
→ [14](14-persistence.md#migrations)

### It is not an escalation, and the difference is not a nuance

Both put something in front of a human, and that is the whole of what they share. They were kept
apart because every other property differs, and because a mechanism that answered to both would have
to be honest about neither.

|                             | Escalation                                       | Human task                            |
| --------------------------- | ------------------------------------------------ | ------------------------------------- |
| What it is                  | a question                                       | a unit of work                        |
| Who is blocked              | one running agent, holding a slot and a worktree | nobody, unless a plan part names it   |
| How it settles              | typing an answer into the parked session         | doing the thing, then marking it done |
| Outlives its agent          | no — it dies with the session                    | yes, and a restart                    |
| Can other work depend on it | no                                               | yes, through a plan part              |
| Costs, while open           | a fleet slot and a checkout                      | nothing                               |

An agent that needs an **answer** to carry on escalates: it parks, and one reply unparks it. An agent
that needs a person to **do something** — which may take until Tuesday — requests a human task and
gets on with, or concludes, whatever it can. Holding a slot and a worktree open for a day waiting on
a console change is the cost that makes the two worth telling apart at all.

It is also why a human task is **not** drawn in the "Needs you" inbox. Filing the two together would
put a thing that costs ten seconds beside a thing that costs an afternoon, under one heading that
could only be honest about one of them. → [17](17-cockpit.md)

### How it blocks work: through a plan part, and only there

The one thing a human task can hold off the fleet is a plan part it backs, and no new scheduling
machinery was added for it. A planner declares `expectedKind: 'human'` on a part
([08](08-planning.md#a-step-for-a-person)); ingestion backs that part with a `human_tasks` row keyed
on `part_id`; and from there the existing graph does the work:

- Rule `plan-part` produces **no candidate** for a human part — `partIsHuman` filters it out before
  anything else looks at it. → [05](05-dispatcher.md#the-rules-in-evaluation-order)
- A human part has no branch, so `dependencySatisfied` is false for anything that named it until it is
  `partSettled`. **Dependents stay `pending` with no new code at all.**
- Marking it **done** settles the part `concluded` with `outcomeKind: 'human'`, so `partSettled` is
  true and readiness releases the dependents on the next pulse.
- **Declining** it leaves the part `blocked` rather than concluded — see below.

**An ask is only ever as long-lived as the part it is keyed on.** Whatever retires the part — an
amendment that dropped the step, or a refusal that sent the whole plan back
([08](08-planning.md#the-approval-gate)) — declines the row with it, through the one
path both reach. A retirement that left the row open would put a step no plan schedules on the bench
with nothing able to settle it, and it would be indistinguishable there from an ask the operator still
owes.

**A standalone human task blocks nothing.** It is a visible obligation, not a gate. That line is what
keeps the capability an agent gains to "ask a person" rather than "stop the fleet": the blocking half
only ever arrives through a plan, and a plan is already gated by an operator's approval.

### Declining is a settlement, not a failure

`declined` carries a required note, and the note is the point: a planner shown only "declined" has no
reason to decide differently to the way it just decided.

**The backing part is deliberately not concluded.** Concluding it would make `partSettled` answer
true, and every dependent waiting on the thing that was refused would be released to an agent — a
plan completing on work nobody did. So the part stops where it is, `PlanReconciler` writes it
`blocked` with its own account of why, its dependents stay `pending`, and the two ways out are the
ones already on the panel: **Replan**, or **abandon the decomposition**. No escalation is filed for
the decline itself — the operator is the one who declined, and the buttons are in front of them.

An amendment that drops a human part settles its open task `declined` too, with "an amended plan no
longer includes this step". Declining rather than deleting for the reason a rejected claim stays
on the page: the alternative is an open obligation pointing at a part no plan schedules, which
nothing will ever settle.

### The step after the launch: the close-out

The harness delivers a goal; it does not close the item in the tracker. That is settled and stays
settled — a close is _admin work anyone can do at any moment_, and promoting it to the harness's own
verdict is what issue #234 exists to stop ([17](17-cockpit.md)). What was missing is the other half:
nothing recorded that the close was still **owed**. The Signal post said "Update the ticket" and the
run carried on regardless, which is a reminder rather than an obligation — nothing holds it, nothing
settles it, and nothing says on Thursday that it never happened.

`DeliveryCloseOutDesk` runs once a pulse ([04](04-harness-cycle.md)) and files a `close_out` task for
every goal with a standing delivery whose tracker item is still open. It is **standalone** — no
`part_id` — so it blocks nothing, and the rule above holds: only a plan-declared part ever holds work
off the fleet.

**Two things hold the filing back, and neither holds the settling.**

The first is the goal's own validation. The close is not asked for while the goal's `validate` row is
still open, because the bench asks for one thing at a time: filed together, the two rows say "run
these checks" and "close this ticket" in the same breath, and the second is an invitation to skip the
first. It is read off the **bench** rather than off the verdict — a `flagged` verdict would hold the
close for good on a goal with one failing check, and the operator's way of saying "I am done with
this" is the row, marked done or declined. That is also why `ValidationReadyDesk` runs above this desk
in the pulse. → [24](24-environments.md#the-bench-asks-for-one-thing-at-a-time)

The second is an environment gate, where one is configured: with `arrival.opens` naming `close_out`,
the row waits until the goal's work has actually reached somewhere a person can look at it. Nothing
gates it on a deployment that configured no environment, which is the default.
→ [24](24-environments.md#what-an-arrival-means)

Both hold the **file** arm only, and only for a row that does not exist yet. Everything that settles a
row still runs, so a ticket closed by hand while a goal is held still discharges an obligation filed
before the hold began — and a hold that arrives after the row does never un-files it.

**An owed row is filed on every pulse, not only the first.** Idempotence here is `recordHumanTask`'s
dedup, which folds the repeat onto the row it already keyed and rewrites `detail`; it is not the pass
going quiet once a row exists. Only a **settled** row is skipped, because an answer is the last thing
said about a row. `ValidationReadyDesk` works the same way and for the same reason — a pass that files
once has frozen its detail at the instant it filed, which is the one thing the detail below must not
be.

**Why this one may settle itself.** Every other human task is settled by a person clicking Done,
because the harness cannot observe a console switch being flipped. This one names an item the harness
already refetches every pulse, so leaving it to a click would ask the operator to tell the harness
something it can see. That asymmetry is the whole of what `kind` discriminates — and it is a column
rather than a title match, because recognising its own row by the sentence it wrote is parsing prose
the harness composed.

**It carries the goal's validation flag.** When the goal's validation plan is not clear, the task's
detail states the counts and lists what is outstanding with its reasons — refreshed every pulse, since
`recordHumanTask` updates the detail on a repeat, so it says what is outstanding _now_ rather than
when the row was filed. That is the moment worth putting it: a chip on a screen is something an
operator may not be looking at, and this row is put in front of them at the point they are about to
close the ticket. Marking it done then costs a note. It blocks nothing.
→ [20](20-validation.md)

**"Closed" is read as "no longer in the open set", two ways**, because the providers disagree about
what a closed issue looks like. Azure DevOps keeps reporting the work item with a closed state;
GitHub's issues provider fetches open issues only, so a closed one stops appearing. Reading only the
first leaves every GitHub task open forever; reading only the second never fires on Azure. Both mean
the same thing about _this_ obligation — nothing is left for a person to close — and the resolution
note says which was observed rather than claiming who closed it. The gone-arm is skipped entirely on
an **empty** issue list: a provider whose snapshot failed returns its last good read, but one that is
down on a first boot returns nothing at all, and settling every standing obligation off that is the
one way this can be wrong at scale.

The same reading is what stops it filing noise. A GitHub issue a merged `Closes #12` took with it is
never in the open set, so nothing is ever owed for it.

**Clearing the delivery retracts it.** An operator who deleted the row put the goal back into
production, and an open obligation to close its ticket then points at work that is not finished. The
task is settled `declined` with that as its note — declined rather than deleted, the settlement an
amended plan already uses on the human part it dropped.

The retraction reads the **standing rows**, not the deliveries, which makes it the one arm with work
to do when nothing is delivered at all — a harness working one goal at a time is in that state every
time it clears one. A short-circuit on an empty delivery list therefore has to read the bench too, or
the retraction happens only while some unrelated goal is still parked.

Tests: `test/deliveryCloseOut.test.ts`.

### The other step after the launch: the validation

A delivered goal usually owes a person two things, and until this existed only one of them was
written down. The other is the validation plan: an ordered set of checks a planner declared weeks
earlier, which become runnable at exactly one moment — the delivery — and which announced that moment
to nobody. The goal sheet drew a chip and the close-out obligation carried a line, and both are
surfaces an operator reaches _after_ deciding to go and look. That is a reminder rather than an
obligation, the close-out's own shortfall one step back: nothing held it, nothing settled it, and
nothing said on Thursday that nobody ever ran them.

`ValidationReadyDesk` runs once a pulse ([04](04-harness-cycle.md)) and files a `validate` task for
every goal with a standing delivery whose checks include one a **person** still has to run. Standalone
— no `part_id` — so it blocks nothing, which is also what validation itself promises
([20](20-validation.md)): a row on a list starts nothing and holds nothing.

**What counts as a person's.** Everything outstanding except a check an operator handed to the fleet
and which has not come back: rule `validate-check` is about to dispatch that one, and a bench row
asking a person for it is a row that answers itself. A **failed** check counts, because somebody has
to do something about it, and a **deferred** one counts, because letting deferral take a check off
the bench would make it the quiet exit the verdict already refuses to let it be. A hand-back puts the
check straight back on, with the agent's own sentence about what stopped it.

**Why this one may settle itself.** The close-out's asymmetry, argument for argument: the harness
cannot watch a console switch being flipped, but the check rows are ones it reads every pulse and the
operator records through its own cockpit. Leaving it to a click would ask them to say the same thing
twice, and the second telling is the one that gets forgotten. It settles `done` the moment nothing is
left for a person — every check passed, waived, or handed to the fleet — and the note says which of
those it was.

**The detail is refreshed on every pulse**, which is the one place this differs in shape from the
close-out: the row is re-filed while it is still owed, and `recordHumanTask` folds the repeat onto it,
so it lists what is outstanding _now_ rather than on the day it was filed. A **settled** row is left
entirely alone — re-filing would rewrite the detail underneath an operator's own verdict, and nothing
here reopens one.

**Clearing the delivery retracts it**, the close-out's rule and for its reason: the goal went back
into production, so there is nothing delivered to validate and the checks will be asked for again
against whatever is delivered next. Settled `declined`, with that as the note. And for the close-out's
other reason too: it is the arm that runs when nothing is delivered, so the sweep's own short-circuit
must read the standing rows before it takes it.

Tests: `test/validationReady.test.ts`.

### The six arms that file one

- **`request_human_task`**, the MCP tool: `{title, detail?}` and nothing that names work. Identity is
  structural, as for every write tool. It queues nothing and blocks nothing, and the response says so
  outright — an agent that believed filing this arranged something would sit waiting for it.
  → [11](11-mcp-tools.md#request_human_task)
- **The close-out sweep**, the harness's own: `kind: 'close_out'`, a null `agentId` because nobody
  individual asked, and one of the two arms that file without anyone typing anything. See above.
- **The validate sweep**, the harness's third: `kind: 'validate'`, a null `agentId` for the close-out
  sweep's reason, and settled by the check rows rather than by a click. See above.
- **The burn watch**, the harness's other: `kind: 'burn'`, and the one arm whose `agentId` is not the
  agent that _asked_ but the agent the row is _about_ — a live run spending far past what its kind of
  work costs. It settles itself when that run ends, for the close-out's reason. It holds nothing and
  stops nothing; what it buys is that somebody looks. → [18](18-observability.md#the-burn-watch)
- **The runway watch**, the harness's newest: `kind: 'supply'`, a null `agentId` and a **null
  `originRef`** — it is the one row that is about the fleet rather than about a piece of work, so an
  origin here would file it onto whichever goal happened to be last in the world. Exactly one is ever
  open: a change of state settles the standing row and files the new wording, which is also what
  gives the notification chain one banner per transition rather than one per pulse. It holds nothing
  and stops nothing. → [25](25-supply.md#what-it-files)
- **`POST /api/human-tasks`**, the operator's own: the same row with no agent behind it, which is
  exactly what a null `agentId` means. There is no `requestedBy` column, so nothing can disagree with
  the ids beside it. Both arms validate through the same pure `validateHumanTask`
  (`src/mcp/humanTasks.ts`) — a one-line title is a property of the panel row, not of who typed it.

A **repeat** (same agent, same origin, same title, same kind) refreshes the row without resetting status,
`recordFinding`'s rule and for its reason. Better instructions overwrite thinner ones; a declined
task asked for again stays declined.

### Settling — `POST /api/human-tasks/:id/done` and `/decline`

Both are compare-and-set against `open` in the write, the discipline `decideProposal` and
`link_ticket` already use: a second click settles nothing and cannot overwrite the first verdict with
the second. A `done` on a task backing a part settles the task **first** and the part second — a
failed part write then leaves a settled task an operator can see, where the other order would leave a
concluded part nothing accounts for.

Settled tasks stay in the list rather than being deleted, for the reason a rejected claim does: a
row that vanished on being settled would take the operator's own note with it, and on a decline that
note is the whole account of why the work below it stopped.

### Getting it off the bench — `POST /api/human-tasks/:id/dismiss`

A settled row is a record, and a record you cannot put down is a permanent fixture. The close-out
sweep files _and settles_ its own rows without anyone touching them, so on a repo delivering steadily
the bench fills from underneath with the account of work nobody did — and until this existed there
was nothing an operator could do about it.

**It is not a third verdict, and `dismissed_at` is not a fourth `HumanTaskStatus`.** What a person is
owed and whether they have finished reading about it are two questions, and one column cannot answer
both: the reconciler asking whether a part was declined must not have to learn a value that says
nothing about the part. So the dismissal takes no note, concludes no part, runs no cycle and leaves
the status and the resolution exactly where they were.

**Only a settled row can be dismissed** — 409 otherwise — and that guard is what keeps it from
becoming a quiet way to make an obligation go away. An open task has two answers and hiding it is
neither. Compare-and-set on both halves (`status<>'open' AND dismissed_at IS NULL`), so a second
click dismisses nothing.

**The row is updated, never deleted**, and here that is load-bearing rather than sentimental: the
close-out sweep recognises its own row by finding it again, so a delete has it file the same
obligation on the next pulse and the button reads as one that does nothing. The snapshot keeps
shipping the row — the goal floor's close-out station reads it, including a decline no reading of the
tracker can see — and it is the **bench** that stops drawing it. → [17](17-cockpit.md)

Tests: `test/humanTasks.test.ts`, and the sweep's side in `test/deliveryCloseOut.test.ts`.
