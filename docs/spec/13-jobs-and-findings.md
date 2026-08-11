# 13 — Jobs, findings and human tasks

Three operator-facing queues, split by **who acts on them**. A **job** is work the operator asked
for, done by an agent. A **finding** is a claim an agent filed, which becomes work only when an
operator says so. A **human task** is work only a person can do, and the operator is the one who does
it.

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

## Findings

An agent that discovers something **outside its own task** had nowhere to put it. "This issue
duplicates #41", "the real fix is in a package I don't own", "there's an unrelated bug in the module I
touched" all ended up in a PR comment, hoping a human read it: nothing landed in the store, nothing
surfaced in the cockpit, and nothing could act on it later.

```ts
interface Finding {
  id;
  agentId;
  taskId;
  originRef; // from the credential, never from an argument
  kind: 'duplicate' | 'blocked' | 'out_of_scope';
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

### The three kinds

Three, taken from three concrete gaps rather than invented as a taxonomy. What earns each a slot is
that it implies a **different operator action** — that is the axis worth splitting on:

| Kind           | Means                                                                                             | The operator…                     |
| -------------- | ------------------------------------------------------------------------------------------------- | --------------------------------- |
| `duplicate`    | This work item is the same work as another one.                                                   | closes or links one of them.      |
| `blocked`      | The fix needs a change outside what the agent can touch — another repo, a package it doesn't own. | unblocks it or parks it.          |
| `out_of_scope` | Something real, not the agent's task — an unrelated bug, a gap nobody has filed.                  | decides whether it becomes a job. |

There is deliberately **no catch-all fourth**: a bucket implying no action is where findings rot, and
the summary is free text already.

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

A **repeat** (same agent, kind, ref, summary) refreshes the row **without resetting status**, so
dismissing one means something. The summary is the whole key because it is the claim; `where` and
`detail` are that claim's supporting text, so a repeat carrying better evidence **overwrites** them
rather than being filed again beside the thinner one.

**Rows filed before the split are not migrated.** They hold a whole report in `summary` and null in
both new columns. No content migration guesses at where the seams were; the card clamps the headline
instead, so an old row reads as a slightly tall card rather than a lie about its own structure.

### It queues nothing

**Nothing in the dispatcher reads `findings`.** A queued job is dispatched by rule `manual-job` ahead of every
world-driven rule, so an agent that could queue jobs could put agents on the fleet — one agent's hunch
would spend another agent's slot, budget and worktree with nothing in between saying yes. That is a
capability escalation, not a convenience, and it is exactly the shape the auto-send seam exists to
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

### Dismissal — `POST /api/findings/:id/dismiss`

The finding stays in the list, muted, rather than being deleted: "we looked at this" is information.
409 when absent or already resolved.

Tests: the `report_finding` block in `test/mcpChannel.test.ts`.

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
  agentId: string | null; // the requesting agent, from the credential; null when nobody individual asked
  taskId: string | null;
  status: 'open' | 'done' | 'declined';
  resolution: string | null; // the operator's note — required on `declined`
  createdAt;
  updatedAt;
  resolvedAt: string | null;
}
```

`human_tasks` is a fresh `CREATE TABLE`, and `src/store/humanTasks.ts` declares an empty
`HUMAN_TASK_COLUMNS` anyway: a table being new **once** does not keep it exempt, and the next column
added has somewhere obvious to be declared rather than being invisible on every older database.
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

### The two arms that file one

- **`request_human_task`**, the MCP tool: `{title, detail?}` and nothing that names work. Identity is
  structural, as for every write tool. It queues nothing and blocks nothing, and the response says so
  outright — an agent that believed filing this arranged something would sit waiting for it.
  → [11](11-mcp-tools.md#request_human_task)
- **`POST /api/human-tasks`**, the operator's own: the same row with no agent behind it, which is
  exactly what a null `agentId` means. There is no `requestedBy` column, so nothing can disagree with
  the ids beside it. Both arms validate through the same pure `validateHumanTask`
  (`src/mcp/humanTasks.ts`) — a one-line title is a property of the panel row, not of who typed it.

A **repeat** (same agent, same origin, same title) refreshes the row without resetting status,
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

Tests: `test/humanTasks.test.ts`.
