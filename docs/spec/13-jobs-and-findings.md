# 13 — Jobs and findings

Two operator-facing queues. A **job** is work the operator asked for. A **finding** is a claim an agent
filed, which becomes work only when an operator says so.

## Jobs

A job is an ad-hoc prompt queued from the cockpit. Unlike a `Task` — created the instant an agent
spawns — a job persists **ahead of** dispatch, so it can sit in a queue when the fleet is at capacity.

```ts
interface Job {
  id; title; prompt;
  kind: 'code' | 'desk';
  branch: string | null;              // code jobs; null => derived job/<id> at dispatch
  status: 'queued' | 'dispatched' | 'cancelled';
  taskId: string | null;              // set once dispatched
  createdAt; updatedAt;
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
later. The two cannot drift apart because they ask the same predicate; they differ only in *when*,
which is why this one rejects (nothing has been promised yet) and the executor's defers (a queued job
the operator is entitled to have retried).

Desk jobs skip the check entirely: rule 0 ignores a desk job's branch.

The route creates the job, broadcasts `world:changed`, and kicks a cycle so a job dispatches
immediately when there is headroom.

### Dispatch — rule 0

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

Rule 0 is the **one** dispatch path where origin and branch are not 1:1, so it is the one that needs
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
  agentId; taskId; originRef;         // from the credential, never from an argument
  kind: 'duplicate' | 'blocked' | 'out_of_scope';
  ref: string | null;                 // the world item it is about
  summary;
  status: 'open' | 'promoted' | 'dismissed';
  jobId: string | null;               // the job it became, if promoted
  createdAt; updatedAt;
}
```

### The three kinds

Three, taken from three concrete gaps rather than invented as a taxonomy. What earns each a slot is
that it implies a **different operator action** — that is the axis worth splitting on:

| Kind           | Means                                                                                | The operator…                     |
| -------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| `duplicate`    | This work item is the same work as another one.                                       | closes or links one of them.      |
| `blocked`      | The fix needs a change outside what the agent can touch — another repo, a package it doesn't own. | unblocks it or parks it. |
| `out_of_scope` | Something real, not the agent's task — an unrelated bug, a gap nobody has filed.      | decides whether it becomes a job. |

There is deliberately **no catch-all fourth**: a bucket implying no action is where findings rot, and
the summary is free text already.

### Validation

`validateFinding(args)` (`src/mcp/findings.ts`), pure:

- `kind` must be one of the three; the error lists all three with their help text.
- `summary` is required and at most 2000 characters — long enough for a paragraph, short enough to read
  in a list.
- `ref` is optional. `parseFindingRef` accepts the closed `pr:` / `issue:` / `story:` vocabulary,
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

**Nothing in the dispatcher reads `findings`.** A queued job is dispatched by rule 0 ahead of every
world-driven rule, so an agent that could queue jobs could put agents on the fleet — one agent's hunch
would spend another agent's slot, budget and worktree with nothing in between saying yes. That is a
capability escalation, not a convenience, and it is exactly the shape the auto-send seam exists to
gate.

So a finding is a **claim, not work**. The tool's description *and* its response say so outright, so an
agent does not report a bug and then assume its fix is scheduled.

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

### Dismissal — `POST /api/findings/:id/dismiss`

The finding stays in the list, muted, rather than being deleted: "we looked at this" is information.
409 when absent or already resolved.

Tests: the `report_finding` block in `test/mcpChannel.test.ts`.
