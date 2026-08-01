# 13 — Jobs and findings

Two operator-facing queues. A **job** is work the operator asked for. A **finding** is a claim an agent
filed, which becomes work only when an operator says so.

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

The `claude` dispatcher gets the same queue in its prompt, with instructions to dispatch it first with
`jobId` set and `originRef` `job:<id>`.

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

`jobs` is a fresh `CREATE TABLE`, so it needs no `migrate()` entry. Tests: `test/jobQueue.test.ts`.

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
  summary;
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

### Validation

`validateFinding(args)` (`src/mcp/findings.ts`), pure:

- `kind` must be one of the three; the error lists all three with their help text.
- `summary` is required and at most 2000 characters — long enough for a paragraph, short enough to read
  in a list.
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

A **verbatim repeat** (same agent, kind, ref, summary) refreshes the row **without resetting status**,
so dismissing one means something.

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
