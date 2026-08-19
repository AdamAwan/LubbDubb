# 13 — Jobs, findings, lessons and human tasks

Four operator-facing queues, split by **who acts on them**. A **job** is work the operator asked for,
done by an agent. A **finding** is a claim an agent filed, which becomes work only when an operator
says so. A **lesson** is a claim of a different kind — what working a goal taught about working this
repository — and it reaches nothing until an operator promotes it. A **human task** is work only a
person can do, and the operator is the one who does it.

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

- **The whole transform is at route time; rule `manual-job` is untouched.** That is a clean recursion boundary:
  only an operator-injected code blueprint via this route becomes a ticket, and the **desk** filing job
  it becomes never does (a desk job is never itself a code blueprint). No new dispatcher wiring — the
  funnel already picks up watched issues.
- **A desk job, not a code one**, for `finding-ticket`'s reason: filing touches no repository, so a
  worktree and a branch would be pure cost. It renders the overridable `blueprint-ticket` template
  (`src/dispatcher/promptTemplates.ts`), whose pure fields come from `blueprintTicketFields(request,
tracker, watchLabel)` (`src/blueprintTicket.ts`) — the operator's prompt carried verbatim, the
  tracker coordinates, and the label instruction.
- **The ticket must be `-watch`-tagged, unlike a finding-filed one.** A finding's ticket lands in the
  backlog unwatched on purpose (it is deferred, not scheduled); a blueprint's ticket is the work the
  operator asked for, so the prompt instructs the agent to add the effective `${labelPrefix}-watch`
  label or the watch gate never picks it up. The empty case is decided in the pure fields, not the
  template: `labelPrefix: ''` turns the watch gate off (the harness acts on every open issue), so there
  is no label to add and the prompt says so.
- **A `WorkItemFiling` row keyed on the desk job is how `link_ticket` resolves the created issue back**
  (`agent → task → job:<id> origin → the filing`). A blueprint has no prior work node to file _for_,
  so `targetRef` is the desk job's own ref (`job:<id>`) — unique by construction, skipped by the
  unrecorded-work lens (which is code-kind only), and handled by the fold, which stands the issue node
  up and hangs the desk job under it. Reusing the filing table rather than a parallel record is safe
  because no reader misreads it: the row surfaces nowhere as "unrecorded work" and `link_ticket`'s
  existing `issue:`-ref guard is exactly right. See [11](11-mcp-tools.md).

**Fallbacks are today's behaviour.** A **desk** blueprint (a direct answer, a report) is dispatched as
asked. A code blueprint with **no tracker** (`fake`/unconfigured) has nowhere to file, so it too
dispatches directly — and the branch-collision 409 above applies only on this arm, since a filed
blueprint's branch is meaningless (the funnel works `issue/<n>` branches later).

Tests: `test/blueprintTicket.test.ts`.

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
around the cap would be the capability escalation `findings` is careful not to be
([above](#it-queues-nothing)); one that queues is just an operator who is asleep.

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

Unlike a dismissed finding or a settled human task, a schedule is **deleted**. Those carry somebody's
judgement about a piece of work and a row that vanished would take the note with it; this carries an
intention that has ended, and there is no verdict to lose. Its history survives anyway — every job it
ever queued is still in `jobs`, with the agents and decisions that came of them.

`job_schedules` was a fresh `CREATE TABLE`, and `src/store/schedules.ts` declares an empty
`JOB_SCHEDULE_COLUMNS` anyway, for `human_tasks`' reason: a table being new **once** does not keep it
exempt. → [14](14-persistence.md#migrations)

Tests: `test/jobSchedules.test.ts`.

## Findings

An agent that discovers something **outside its own task** had nowhere to put it. "This issue
duplicates #41", "the real fix is in a package I don't own", "there's an unrelated bug in the module I
touched" all ended up in a PR comment, hoping a human read it: nothing landed in the store, nothing
surfaced in the cockpit, and nothing could act on it later.

The `docs` kind closes the same gap from the other side (#397). A fact about **the repository** that
its own documentation does not state is learned _inside_ the task rather than beside it, and its only
destination was prose in a retrospective read once by a person — the fate #355 opened by objecting to.
It rides these rails rather than a surface of its own because the shape is identical: a provenanced
claim an operator promotes or dismisses. Two gates for one problem is how two gates come to disagree
about what "an operator decided" means.

```ts
interface Finding {
  id;
  agentId;
  taskId;
  originRef; // from the credential, never from an argument
  kind: 'duplicate' | 'blocked' | 'out_of_scope' | 'docs';
  ref: string | null; // the world item it is about
  summary; // the claim, one line — validation refuses a newline
  where: string | null; // what locates it: file and line, package, service
  detail: string | null; // the evidence, markdown
  status: 'open' | 'promoted' | 'dismissed' | 'filing' | 'filed';
  jobId: string | null; // the job it became — working it, or filing it
  ticketRef: string | null; // the ticket it was filed as ("issue:314")
  createdAt;
  updatedAt;
}
```

### The four kinds

Four, taken from four concrete gaps rather than invented as a taxonomy. What earns each a slot is
that it implies a **different operator action** — that is the axis worth splitting on:

| Kind           | Means                                                                                             | The operator…                                         |
| -------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `duplicate`    | This work item is the same work as another one.                                                   | closes or links one of them.                          |
| `blocked`      | The fix needs a change outside what the agent can touch — another repo, a package it doesn't own. | unblocks it or parks it.                              |
| `out_of_scope` | Something real, not the agent's task — an unrelated bug, a gap nobody has filed.                  | decides whether it becomes a job.                     |
| `docs`         | Something true of this repository that its own documentation does not say.                        | promotes it, and an agent opens a docs PR against it. |

There is still deliberately **no catch-all**: a bucket implying no action is where findings rot, and
the summary is free text already. `docs` clears the bar rather than widening it — "an agent writes the
documentation change and opens a pull request" is a genuinely different action from the other three,
and the row already carries what a docs claim needs: `summary` is the fact, `where` is the document
that should say it, `detail` is the evidence, and attribution is structural.

**The tension worth stating rather than hiding.** The first three are things noticed _outside_ the
agent's own task; a repo fact is learned _inside_ it, at the cost of learning it, which is exactly why
it is worth writing down. So `report_finding`'s description no longer says "NOT your task" as though
it covered every kind — it names both directions, and the `docs` bullet says to file the fact the
moment it is learned rather than saving it for a write-up that may summarise it away.

### The three text fields

`summary` was once the only one, and its description asked for what it is, where, and why it matters,
plus the evidence — four things in one string. What arrived was one undifferentiated block, with the
claim, the identifier and the stack trace at the same weight, which is a wall to read and no faster to
skim than the PR comment it replaced. The structure was never in the text, so no renderer could put it
there; only naming the parts can.

| field     | required | holds                                                       |
| --------- | -------- | ----------------------------------------------------------- |
| `summary` | yes      | the claim, one line, ≤160 characters                        |
| `where`   | no       | what locates it — file and line, package, service, endpoint |
| `detail`  | no       | the evidence — error, repro, reasoning — as markdown        |

Everything past `summary` is **optional on purpose**. A required field an agent has nothing for comes
back as "N/A", and a list of those is worse than a blob. `where` is free text rather than a closed
vocabulary because "where" means a different thing per kind, and a schema for it would be guessed at.

### Validation

`validateFinding(args)` (`src/mcp/findings.ts`), pure:

- `kind` must be one of the three; the error lists all three with their help text.
- `summary` is required, at most 160 characters, and **must not contain a newline**. That refusal is
  the load-bearing part of the split: the only cheap moment to fix a blob is the agent's own turn, and
  a rejection there costs one tool call, where an unreadable card costs an operator every time they
  open it. Both refusals name the field the text belongs in — an error that only said "too long" would
  get the same paragraph back, shortened.
- `where` is optional, at most 200 characters. `detail` is optional, at most 2000 — the cap that used
  to be on `summary`, which is where a paragraph now legitimately goes.
- `ref` is optional. `parseFindingRef` accepts the closed `pr:` / `issue:` vocabulary,
  suffix-tolerant so an origin ref passes back verbatim. A **bare number is refused** — unlike
  `world_read` there is no `kind` argument to disambiguate issue #41 from PR #41, and a duplicate
  report must not guess. Anything else is refused with "omit ref and describe it in the summary": an
  open-ended ref field becomes an unqueryable junk drawer.

Note what is **not** validated because it does not exist: no agent, task, issue or author argument.
Identity is structural.

### Recording

`AgentManager.recordFinding` routes it — not straight to the store — for the same reason a flag does:
the cockpit should hear the moment it is filed, not on the next pulse, and the `finding` event is what
carries it. The `Hub` broadcasts `agent:finding` plus a `dirty`.

Unlike `escalate`, it does **not** require a live session: a finding is a durable note, and one filed on
an agent's last breath is still true.

### Finding the finding that already exists

A report does not become a row until the store has looked for the claim it makes. Two lookups, in
this order:

1. **The standing claim** — any finding with the same `kind` and `ref` whose summary reduces to the
   same claim, and whose status is **not `dismissed`**, oldest first. The comparison is on a
   normalised key: lower-cased, with markdown emphasis, backticks, quotes and punctuation dropped and
   whitespace collapsed. Two keys match when they are equal, or when one wholly contains the other on
   word boundaries and the shorter is at least 24 characters — a restatement that appends its own
   qualifier is the same claim, while a short key would be a substring of far too much, and a wrong
   merge is worse than a duplicate because it hides one agent's report inside another's.
2. **The author's own repeat** — same agent, kind, ref and summary, whatever its status. At this
   point that can only be a row someone dismissed, since a live one would have matched above.

Dismissed rows are out of the first lookup on purpose: a dismissed finding is a claim an operator has
already answered, and folding a fresh report into it would file it straight into the bin. They stay
in the second because an agent repeating its _own_ dismissed claim should still land back on that
row — dismissing one has to mean something, and it means nothing if the next turn refiles it.

The first lookup is what the exact key alone could never see. Two agents on two tasks land in the
same file and see the same unrelated bug, and neither the agent id nor the character-for-character
summary matches; before it existed, that pair arrived in the cockpit as two cards saying one thing.

On a match the row is refreshed rather than inserted, and `updated_at` moves. The status is **not**
reset. Evidence follows authorship: the **author** of the matched row may overwrite its `where` and
`detail` — the summary is the claim and those are its supporting text, so a repeat carrying better
evidence replaces the thinner version rather than being filed beside it — while **another agent** may
only backfill fields the row has none for. It does not get to rewrite words on a card that carries
someone else's name.

The tool tells the agent which happened: a merged report comes back saying the claim was already on
the operator's list, so an agent does not read a returned id as proof it filed something new and does
not say it again, louder.

**Rows filed before the split are not migrated.** They hold a whole report in `summary` and null in
both new columns. No content migration guesses at where the seams were; the card clamps the headline
instead, so an old row reads as a slightly tall card rather than a lie about its own structure.

### It queues nothing

**Nothing in the dispatcher reads `findings`.** A queued job is dispatched by rule `manual-job` ahead of every
world-driven rule, so an agent that could queue jobs could put agents on the fleet — one agent's hunch
would spend another agent's slot, budget and worktree with nothing in between saying yes. That is a
capability escalation, not a convenience, and it is exactly the shape the proposal seam exists to
gate.

So a finding is a **claim, not work**. The tool's description _and_ its response say so outright, so an
agent does not report a bug and then assume its fix is scheduled. Filing is the same rule: it is an
operator's click that dispatches the filing agent, and `report_finding` cannot file its own ticket.

### Promotion — `POST /api/findings/:id/promote`

The only path from a finding to an agent, and it starts with an operator's click.

- 404 when the finding is absent; 409 when it is not `open`.
- `findingJobRequest(finding)` derives the default title and prompt. The title is
  `[<kind>] <ref> <first line>` capped at 80 characters. The prompt carries the finding's
  **provenance** — which agent saw it, on what origin, what the kind means — because the promoted
  agent's first question is always "says who, and were they looking at this or at something else?",
  and that is the one thing a PR comment could never be trusted to keep attached. It ends by telling
  the agent to verify the claim before acting on it, and to say so and stop if it does not hold rather
  than inventing work to justify the dispatch.
- **`where` and `detail` reach the promoted and filing agents through the existing `{summary}` value,
  not through placeholders of their own.** `findingReport` recomposes the three fields into one block,
  which both `findingJobRequest` and `findingTicketFields` pass as `summary`. A new `{token}` would be
  silently dropped by every operator override that never learned about it — precisely the deployments
  that customised most — and there is no fallback to get wrong here. → [05](05-dispatcher.md#prompt-templates)
- The operator may override `title`, `prompt` and `kind` in the request body.
- The job is created **first**, then the finding is resolved to `promoted` with the job id — so a
  failed create leaves the finding open.
- A cycle is kicked.

#### Promoting a `docs` claim

The one arm that does not take the derived prompt. A `docs` finding ends in a **pull request against
the worked repository**, and how a documentation change should be worded and where in a tree it
belongs is exactly the house style an override exists for — so it renders `docs-change` from the
template book, the way filing renders `finding-ticket`. `findingDocsFields(finding)` (pure,
`src/mcp/findings.ts`) supplies its `{ref}`, `{summary}` and `{originRef}`; the report's `where` and
`detail` ride in on `{summary}` like everywhere else, so an override that predates them still renders
them.

- **A `code` job, not a `desk` one.** It writes files in a tree and pushes a branch to open the pull
  request from, and a desk job would cut neither. The body's `kind` defaults to `code`, which is why
  nothing here forces it — the cockpit sends no body at all, so every promotion from the panel is a
  code job, and the override stays available for the operator who wants otherwise, the same as for
  every kind.
- The title is `Document: <first line>`, capped at 80 characters. It is the **job's** title, not the
  document's: what the docs end up saying is the judgement being delegated, and this only has to be
  recognisable in Up next.
- **The prompt ends in a pull request, and nothing else finishes it.** Never a direct push, never a
  commit to the integration branch, never a documentation change the harness makes to a repository it
  merely operates. If the pull request is not opened, nothing has happened — which is correct: a
  lesson lives in SQLite because it is _ours_, and a repo fact is _theirs_.
- It also tells the agent to **check the claim against the code first** and to say so and stop if it
  does not hold. A document is the wrong place to record a plausible mistake, because everyone after
  reads it as settled; stopping costs one dispatch and saves a false line nothing would go red about.
  And to change documentation only — a defect turned up while checking is a separate `report_finding`,
  not a fix smuggled into a docs PR.

Tests: `test/docsFindings.test.ts`.

### Filing — `POST /api/findings/:id/file`

The **defer** arm, beside promotion's "work it now". Promotion puts an agent on the problem; filing
puts an agent on the **tracker**, so the problem waits its turn in the backlog with everything else.
It is the one thing promotion could not express: a queued job either runs or is cancelled, and neither
of those is "deal with this later".

- **An agent files it, not a provider seam.** The _wording_ of a ticket is the part an operator has
  opinions about, and a prompt is where those opinions already live — `finding-ticket` is an ordinary
  overridable entry in the template book (`src/dispatcher/promptTemplates.ts`), so how tickets are
  worded, labelled or typed is changed by dropping a file in `promptTemplatesDir`, not by patching a
  route. Agents create issues with `gh` / `az` in their own shell already; adding an
  `IssueCreateCapable` seam would have moved that judgement into the harness, where it cannot be
  overridden. The template book is therefore no longer only the rule dispatcher's — `loadPromptTemplates`
  is hoisted in `system.ts` and exposed as `System.prompts`, so this renders the same under either
  dispatcher.
- **What the harness must supply is the one thing an agent cannot infer: which tracker.**
  `trackerCoordinates(config)` (pure, `src/mcp/findings.ts`) renders coordinates from the same config
  block the **`issues` provider** is built from — so a ticket lands where the harness reads issues
  from and nowhere else. It returns null for `fake`, or for a provider selected without its config;
  the route then 409s and the snapshot ships `config.canFileTickets: false` so the cockpit hides the
  button rather than offering a click that cannot work. One predicate, both surfaces.
- **And the one other thing an agent cannot infer: who it is for.** `userId`
  ([02](02-configuration.md#userid)) rides in on the same
  string — the create command gains `--assignee` / `--assigned-to`, and a paragraph says the flag is
  not optional, covers only the item the agent creates, and must not cost the ticket if the tracker
  refuses the identity. In the coordinates rather than a placeholder of its own, so an operator's
  prompt override that predates the key still assigns; unset, the coordinates are unchanged and the
  item is filed unassigned. One pure function (`ticketAssignment`, `src/ticketAssignment.ts`), so all
  four filing arms assign identically.
- **And what type of item it is.** `issueFilingTypes` ([02](02-configuration.md#what-type-a-filed-item-is))
  is the closed set the agent chooses from, defaulting to `["User Story", "Bug"]`. The three arms here
  hardcoded `--type Task` until they did not: a Task is how a story is broken down once somebody is
  working it, so one filed from the cockpit had nothing above it to roll up to and reached no backlog.
  _Which_ of the configured types a report is stays the agent's judgement, like the wording; the harness
  supplies the menu, names the decomposition type it must not reach for, and says an imperfect fit
  rounds to the nearest entry rather than to a type the project would refuse. In the coordinates rather
  than a `{type}` placeholder, on the same override argument as the assignee (`ticketTypeGuidance`,
  `src/ticketTypes.ts`). Azure only — a GitHub issue has no type. The **raised bug** arm files `Bug` on
  its own coordinates and consults none of this.
- **A desk job, not a code one.** Filing touches no repository, so cutting a worktree and a branch
  would be pure cost. The consequence is that a desk agent runs in a scratch directory with no git
  remote for `gh` to read the repo off — which is precisely why the coordinates are explicit.
- **Two statuses, because filing is asynchronous.** The click queues a job; the ticket exists only
  once an agent has created it. `filing` is the honest reading in between, and `filed` is the one that
  carries `ticketRef`. Collapsing them would have the card claim a ticket that does not exist yet, and
  leave nothing to show for a filing agent that died before making one — which is why the cockpit
  draws a `filing` finding among the open ones rather than in the resolved tail.
- **`link_ticket` closes it** — see [11](11-mcp-tools.md). The finding is resolved from the agent's
  credential (`agent → task → its `job:<id>` origin → the finding that job was created for`), so the
  tool takes only a ref, and idempotence lives in the write (`WHERE status='filing'`).
- `job_id` is reused for the filing job: a finding is terminal either way, so only ever one job hangs
  off it. `ticket_ref` is a **column on an existing table**, so it needs a `migrate()` entry — see
  [14](14-persistence.md).

Tests: `test/findingTickets.test.ts`.

### The third filing kind — a bug the operator raised

`POST /api/issues/:number/bug` ([16](16-http-api.md#post-apiissuesnumberbug)) is the same machinery
with a different author. A finding is an agent's testimony and a work-item filing is the harness
accounting for its own work; this one is the **operator's** — they ran the thing and it does not do
what they expect, which is the one fact about a goal no agent on it can derive, since none of them ran
it. Everything the two arms above establish holds: explicit tracker coordinates, a desk job, an
overridable template (`raise-bug`), two statuses, and `link_ticket` closing the loop from the
credential.

Three things differ, each for a reason worth keeping:

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

### Dismissal — `POST /api/findings/:id/dismiss`

The finding stays in the list, muted, rather than being deleted: "we looked at this" is information.
409 when absent or already resolved.

Tests: the `report_finding` block in `test/mcpChannel.test.ts`.

## Lessons

A finding is a defect the fleet noticed. A **lesson** is what working the goal taught about _working
this repository_ — "the suite wants a built web bundle first", "this subsystem's tests sit at an odd
seam", "a ticket that names only a symptom is under-specified for a planner every time". Before
this, that knowledge had exactly one destination: a retrospective a person read once. The next goal
started from zero and the fleet relearned the same thing at full price (#355). The retrospective now
proposes them directly, which is where most lessons come from.

```ts
interface Lesson {
  id;
  text; // the lesson, markdown
  originRef: string | null; // the goal it was learned on ("issue:41"), or null
  status: 'proposed' | 'promoted' | 'retired';
  createdAt;
  updatedAt;
}
```

### Why it is a claim, and not a pad

The obvious version of this feature — an append-only note surface every agent reads — is the thing
`docs/README.md` argues against most strongly about `CLAUDE.md`. A surface loaded into every agent's
context has length as a recurring fleet-wide cost and accuracy as a _correctness_ concern: a stale
line there is a false instruction handed to every agent before it reads any code, and it fails
silently. Nothing goes red, no test can see it, and in a year the block is forty stale assertions
making every agent quietly worse.

So a lesson is a **claim**, in exactly the shape a finding already has, and the four properties that
make the claim safe are the reason the store is allowed to exist at all:

| Property        | What holds it                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **Gated**       | `proposed` until a human promotes it. There is no way to write a promoted lesson directly.          |
| **Provenanced** | `originRef` and `createdAt` on every row — what taught it, and when, which is what dates the claim. |
| **Prunable**    | `retired`, from either live status, with a cockpit surface to prune from → [17](17-cockpit.md).     |
| **Bounded**     | 2,000 characters. Not a storage bound: a wall of text is the row nobody reads before promoting it.  |

### Where a lesson does _not_ go

The question that decides it is: does this describe **the repository**, or **working the
repository**?

| The lesson is…                                                      | Destination                                              | Why                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| A fact about the code — a seam, an invariant, a second registration | `report_finding` kind `docs` → promotion → **a docs PR** | It is the repo's knowledge and belongs where the repo keeps it |
| A fact about working the goal                                       | The lesson store, promoted                               | Ours, not theirs; no business in someone else's tree           |
| A one-off defect noticed in passing                                 | `report_finding` kind `out_of_scope` → promotion → job   | Already built above; needs nothing                             |
| Something true only of this goal                                    | The goal's scratchpad                                    | Already built; dies with the goal, correctly                   |

Row one was prose until #397: the `issue-retro` template said "say so in the document; do not file it
as a lesson", and the document is read once, by a person. Three of the four answers were rails and the
fourth was not, which made the most durable thing an agent learns the one thing with nowhere to put it.
It is a rail now, and it stays out of the lesson store on the same argument the store rests on: a claim
about _working_ the repository is a lesson, and a claim about the repository is theirs.

The discriminator is stated in **three** places for the reason it was already stated in two:
`issue-retro`'s template is operator-overridable, `retro_submit`'s tool description always arrives,
and `report_finding`'s description is what an agent that never gets to a retrospective reads — which
matters most here, because a repo fact is learned mid-run and filing it then beats waiting for a
retrospective that may summarise it away.

### The three states, and the two that are one-way

`proposed` → `promoted` is the gate. `proposed` or `promoted` → `retired` is the prune. There is no
un-retire: retiring must always be available because it is the safety valve, while promoting is the
risk, so it starts from a proposal every time. A lesson retired in error is written again, which
re-dates it — and a claim worth bringing back is worth reading first.

Both transitions are guarded **in the write** (`WHERE id=? AND status=…`), the discipline
`linkFindingTicket` and `decideProposal` use, so two racing clicks cannot both find a promotable row.

### The two writers

A lesson is proposed from one of two places, and both land `proposed`. There is no arm that writes a
promoted lesson.

| Writer               | Reaches the store through                  | Provenance                                      |
| -------------------- | ------------------------------------------ | ----------------------------------------------- |
| The operator, typing | `POST /api/lessons`                        | Whatever `originRef` they give, or null         |
| The retrospective    | `retro_submit`'s `lessons` field (phase 2) | The issue it wrote up — `issue:<n>`, never null |

Both go through `validateLessonText` in `src/lessons.ts`, which is where the 2,000-character bound
lives. It is there rather than in either writer because a bound written twice is a bound that
drifts, and it drifts in the direction that matters: whichever writer is looser decides what an
operator ends up being asked to read.

`proposeLesson` **dedupes against the live rows on the same goal** — `recordFinding`'s shape, for its
reason. `retro_submit` upserts its document on `origin_ref`, so a retrospective filed twice revises
one write-up; without the dedupe it would leave two of every lesson behind it. Scoped to `proposed`
and `promoted` only, so a retired lesson can be written again — which is the re-proposal "no
un-retire" rests on, and it re-dates the claim.

### The routes

| Route                           | Does                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| `POST /api/lessons`             | Writes one down. Lands `proposed`; 400 on empty or over-long text. |
| `POST /api/lessons/:id/promote` | The gate. 404 unknown, 409 already ruled on.                       |
| `POST /api/lessons/:id/retire`  | The prune. 404 unknown, 409 already retired.                       |

There is no list route: the lessons ride on `/api/state` with everything else the cockpit polls,
which is what `findings` does and for the same reason — the panel draws them beside refs the
snapshot's own link map resolves. All three broadcast `dirty` rather than `world:changed` and run no
cycle: nothing in the world moved.

### What a retrospective may file

The `lessons` field on `retro_submit` is optional, and a run that taught nothing general is the
ordinary case. What it may not be is unbounded: the scarce resource is not storage but the reader's
attention, since every lesson is worth nothing until a person has vouched for it, and fifteen
plausible claims are read less carefully than two. So at most five land, and the prompt asks for the
one or two a reader would thank the agent for.

Two rules decide what happens to the rest, and they differ from the document's on purpose:

| Not filed because…    | What happens        | Why                                                                                                                                              |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Over the length bound | **Dropped whole**   | Half a write-up is a shorter write-up; half a lesson is a _different claim_, still promotable — and the safeguard is a person reading the claim. |
| Over the count cap    | **Dropped whole**   | Same reason, one level up: the cap exists to protect the reading, so trimming to fit would defeat it.                                            |
| Anything at all       | **Never a refusal** | The write-up must not sink after the work of assembling it — `MAX_RETRO_DOCUMENT`'s rule, applied to the field beside it.                        |

Every drop is counted back to the agent as `lessonsDropped`. A lesson that did not land is one an
operator will never be asked about, and an agent that believes it filed eight has no other way to
find out — which is the silence this whole feature is built to avoid, in miniature.

The **discriminator** — repository, or _working_ the repository? — is stated in two places, and that
duplication is deliberate. `issue-retro`'s template is operator-overridable, so a deployment running
an override written before phase 2 would otherwise dispatch an agent that never hears the store
exists: the customised deployments losing the feature silently. `retro_submit`'s tool description
always arrives.

### What a promoted lesson reaches, and what it does not

**No dispatcher rule reads a lesson, and no dispatch prompt renders one.** A promoted lesson reaches
agents through exactly one channel: the fleet's system-prompt append, rendered by `src/lessonBlock.ts`
and threaded in by `src/system.ts` → [10](10-agent-runtimes.md#the-lesson-block). Filing a proposal is
all the tool channel got; promotion is still a click in the cockpit and stays one.

`test/lessons.test.ts` asserts that structurally: `src/dispatcher/` and `src/executor/` never touch
the store in any direction, and `src/mcp/` and `src/agents/` reach `proposeLesson` and nothing else —
never `listLessons` or `getLesson`. Which is why phase 3's seam is a **rendered string** passed
through `ClaudeArgsOptions` rather than a store handed to `agentProtocol.ts`: the launch path stays
unable to read a lesson, and `src/system.ts` — already the composition root — is the only module on
it that knows lessons exist. A change that needs that assertion relaxed has the seam wrong.

That structural test used to ban the _word_, across four directories. It matches the store's methods
instead as of phase 2, because a prompt that tells an agent the channel exists is the dispatcher
describing a tool rather than a rule consulting the table — and the thing that would actually break
the invariant is a call.

### What the block is, and what bounds it

Four properties, and each is one of the four the table above rests on, carried through to the render:

| Holds                                         | How                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only vouched-for claims render                | `renderLessonBlock` filters to `promoted` itself rather than trusting its caller. The gate has no bypass on this path either.                                                                                                               |
| A reader can date what it is told             | Each lesson renders with the goal it was learned on and the date it was written, under a header saying the repository in front of the agent is the authority. Claims with provenance, not instructions — so a stale one can be discounted.  |
| The cost is bounded                           | `lessonBlockChars` (default 6,000), on **characters**, since a lesson runs from a line to 2,000 of them. `0` renders nothing. → [02](02-configuration.md#agent-launch)                                                                      |
| The drop is visible to the person who can act | Over the cap, whole lessons are dropped **oldest-vouched first** — never a truncated claim. The **operator** sees which, per row, in the Lessons panel; the **agent** is told nothing about the cap, the drop, or that the list is partial. |

With no promoted lessons, nothing is appended at all — not a header, not a newline — and the launch
arguments are byte-identical to a build without the feature. A retired lesson stops appearing at the
agent's **next** launch, not mid-run: the block is re-appended on every launch, `--resume` included,
so an agent already running keeps the block it started with.

What the lesson store deliberately does **not** hold: a fact about the _code_. That is a `docs`
finding (#397, split out of #355 phase 4) — it becomes a proposed documentation change against the
worked repository rather than a store row, and it reaches no agent's context at all. The cap and the
visible drop above bound this block; that route touches none of it.

Tests: `test/lessons.test.ts`, and the lessons block in `test/retrospective.test.ts`.

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
  kind: 'ask' | 'close_out' | 'burn' | 'validate'; // who it is for the harness — see below
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

**A standalone human task blocks nothing.** It is a visible obligation, not a gate. That line is what
keeps the capability an agent gains to "ask a person" rather than "stop the fleet": the blocking half
only ever arrives through a plan, and a plan is already gated by `planning.requireApproval`, on by
default.

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
longer includes this step". Declining rather than deleting for the reason a dismissed finding stays
in the list: the alternative is an open obligation pointing at a part no plan schedules, which
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
against whatever is delivered next. Settled `declined`, with that as the note.

Tests: `test/validationReady.test.ts`.

### The five arms that file one

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

Settled tasks stay in the list rather than being deleted, for the reason a dismissed finding does: a
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
