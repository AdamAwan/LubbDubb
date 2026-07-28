# 14 — Persistence

**`src/store/store.ts` is the only module that touches SQLite.** Everything else goes through the
`Store`. The schema is `src/store/schema.ts`.

## Database setup

`new Store(dbPath)`:

1. Creates the parent directory unless the path is `:memory:`.
2. Opens the database (better-sqlite3).
3. `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.
4. Executes `SCHEMA` (all statements are `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`,
   so it is idempotent).
5. Runs `migrate()`.

Writes are **synchronous**, which is what keeps the harness logic race-free. Lean on that.

The clock is injectable (`Clock`), so tests get deterministic timestamps.

## Migrations

`CREATE TABLE IF NOT EXISTS` never alters an existing table, so a column added to the schema is
invisible on databases created by an older build. `migrate()` closes that gap with additive, idempotent
`ALTER TABLE … ADD COLUMN`, guarded by a `PRAGMA table_info` check, safe to run on every boot.

Current entries:

| Table       | Columns added                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `tasks`     | `origin_title`, `origin_summary`, `dispatch_reason`                                                      |
| `agents`    | `session_id`, `cost_usd`, `input_tokens`, `output_tokens`, `num_turns`, `note`, `noted_at`, `resumed_at` |
| `decisions` | `rule`                                                                                                   |
| `findings`  | `ticket_ref`                                                                                             |

**A column added to an existing table needs an entry here.** A brand-new table does not — its
`CREATE TABLE` carries the full definition. `jobs`, `findings`, `plans`, `plan_parts`, `agent_flags`,
`agent_files`, `issue_conclusions`, `issue_deliveries`, `priority_overrides`, `work_nodes` and
`work_item_filings` were all introduced as new tables and therefore have no
migration entry — but `findings` has since gained `ticket_ref`, which is exactly the case the table
above exists for.

## Tables

| Table                | Holds                                                                                          | Key constraints               |
| -------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------- |
| `tasks`              | Units of work materialised at dispatch.                                                        | —                             |
| `jobs`               | Operator-queued prompts awaiting a slot.                                                       | —                             |
| `priority_overrides` | Operator "Up next" re-ordering, keyed on candidate origin.                                     | `origin` is `PRIMARY KEY`     |
| `agents`             | One row per launched agent, including usage and the progress note.                             | —                             |
| `usage_events`       | Timestamped per-report cost **deltas** (not cumulative), so rolling windows are a `SUM`.       | —                             |
| `agent_flags`        | Artifacts surfaced to the cockpit.                                                             | `UNIQUE (agent_id, ref)`      |
| `agent_files`        | Every file an agent wrote; `promoted` marks the ones also surfaced as chips.                   | `UNIQUE (agent_id, path)`     |
| `findings`           | Things agents noticed outside their own task.                                                  | —                             |
| `issue_conclusions`  | Whether an issue is finished, per issue origin. One row, overwritten per declaration.          | `origin_ref` is `PRIMARY KEY` |
| `plans`              | One delivery plan per issue.                                                                   | `origin_ref` is `UNIQUE`      |
| `plan_parts`         | Parts of a multi-PR plan. `depends_on` is a JSON array of sibling slugs.                       | `UNIQUE (plan_id, slug)`      |
| `issue_deliveries`   | The harness's own park: an issue assessed as delivered. Gates pickup; expires on world signal. | `origin_ref` is `PRIMARY KEY` |
| `work_nodes`         | The durable work graph: every node the harness has observed, and what it descended from.       | `ref` is `PRIMARY KEY`        |
| `work_item_filings`  | A tracker item an operator had filed for work nothing external accounted for.                  | `target_ref` is `PRIMARY KEY` |
| `agent_transcripts`  | Chunked agent output.                                                                          | `PRIMARY KEY (agent_id, seq)` |
| `escalations`        | The human-in-the-loop inbox. `context` is JSON.                                                | —                             |
| `decisions`          | The audit log. `action` is JSON; `rule` is lifted off it at record time.                       | —                             |
| `connector_state`    | The fake provider's editable world, so injected events survive restarts.                       | —                             |
| `connector_events`   | Injected events, for diagnostics.                                                              | —                             |
| `world_events`       | Observed world transitions — the activity feed's backing store.                                | —                             |
| `world_baseline`     | The last snapshot the harness diffed against.                                                  | Single row: `CHECK (id = 1)`  |
| `error_events`       | Recorded failures — the Errors panel's backing store.                                          | —                             |

Indexes cover the hot lookups: `agent_flags(agent_id)`, `agent_files(agent_id)`, `agents(status)`,
`tasks(status)`, `jobs(status)`, `findings(status)`, `plans(origin_ref)`, `plan_parts(plan_id)`,
`decisions(cycle_id)`, `world_events(created_at)`, `usage_events(at)`, `error_events(created_at)`,
`work_nodes(parent_ref)`, `work_item_filings(job_id)`, `tasks(origin_ref)`. The last is the work graph's attempt list: a node's
attempts are the `tasks` rows carrying its origin, so no separate attempts table exists — `tasks` only
lacked the index.

## The Store API

### Tasks

`createTask`, `updateTask` (status / agentId / branch only), `getTask`, `listTasks`,
`findActiveTaskByOrigin(originRef)`, `findActiveTaskByBranch(branch)`. "Active" is `queued`, `running`
or `waiting`.

The two `findActive*` predicates are the dispatch gates. They are mirrors of each other, and the branch
one exists because origin and branch are not 1:1 on the job path — see [09](09-execution.md) and
[13](13-jobs-and-findings.md).

### Jobs

`createJob`, `getJob`, `listJobs(limit=100)` (newest first), `listQueuedJobs()` (oldest first),
`markJobDispatched(id, taskId)`, `cancelJob(id)` (still-queued only).

### Priority overrides

`setPriorityOverrides(origins)` (replace-all: ranks the given origins `0..n-1` and clears any not
listed), `listPriorityOverrides()` (lowest rank first),
`reconcilePriorityOverrides(trackedOrigins, ttlMs)` (bumps `last_seen_at` for still-tracked origins,
then drops any untracked longer than `ttlMs`; `ttlMs <= 0` disables pruning). Called each pulse from
the harness with the origins still queued or staffed, so an override for work the harness has stopped
tracking is pruned rather than lingering forever (issue #128).

### Agents

`createAgent`, `updateAgent` (status / pid / waitingReason / endedAt), `getAgent`, `listAgents`,
`listAgentsByStatus(...statuses)`, `countLiveAgents()`, `recordAgentUsage(id, usage)`,
`recordAgentNote(id, note)`, `sumUsageCostSince(iso)`.

`countLiveAgents` is the liveness reading the cap arithmetic and file-overlap detection both use: it
counts `starting` / `running` / `waiting`. `crashed` is deliberately outside it — a row stamped by boot
detection has no process behind it, so counting it would let dead agents eat the concurrency cap.

`recordAgentUsage` writes the cumulative values onto the row **and** the cost delta into
`usage_events`.

### Transcripts

`appendTranscript(agentId, chunk)`, `flushTranscript(agentId)`, `getTranscript(agentId)`.

Output arrives as many tiny deltas, so chunks are buffered in memory and flushed as one `INSERT` per
~16 KB (`TRANSCRIPT_FLUSH_BYTES`), avoiding a database write plus a `MAX(seq)` select on every chunk.
Buffers are flushed on threshold, **on read**, and on `close()`, so read-your-writes stays intact.
`AgentManager` also flushes explicitly at every terminal transition and on kill, so a finished agent's
transcript is durable.

### Flags and files

`recordFlag(agentId, input)` and `recordFile(agentId, input)` — both upserts on their unique key, so a
repeat refreshes the row rather than duplicating. `getFlag`, `listFlags(agentId)`, `listAllFlags`,
`listFiles(agentId)`, `listAllFiles`.

### Findings

`recordFinding(agentId, taskId, originRef, input)` → `{finding, created}`; a verbatim repeat refreshes
without resetting status. `getFinding`, `listFindings(limit=100)`,
`resolveFinding(id, status, jobId?)`.

### Plans

`upsertPlan`, `getPlan`, `getPlanByOrigin`, `listPlans`, `setPlanStatus`, `setPlanStatusComment`,
`rollUpPlanStatus(planId)`, `upsertPlanParts(planId, parts)` (merges on slug, **never deletes**),
`listPlanParts(planId)`, `listAllPlanParts`, `updatePlanPart`,
`markPartDispatched(id, taskId, branch)`.

`plans.status` is `planning | single | awaiting_approval | active | complete | abandoned`. It is a
_value_, not a column, so a database from an older build needs no migration: an existing row simply
never holds the new one. `awaiting_approval` is the approval gate itself — see
[08](08-planning.md#the-approval-gate).

### Work graph

`recordWorkGraph(observations)`, `listWorkRoots()` (nodes with no parent, most recently seen first),
`listWorkSubtree(rootRef)` (one recursive CTE bounded to the requested root, `UNION` rather than
`UNION ALL` so the walk terminates whatever reaches the table), `listWorkNodes()` (every row, flat).

`listWorkNodes` exists for the unrecorded-work detector, whose verdict is per-node but whose evidence
beside it is what ran underneath — rebuilding the table from roots plus a subtree each is N+1 queries
for something one `SELECT` answers. Note what it is deliberately **not** wired into: the recorder still
builds its `existing` set the roots-then-subtrees way, so the backfill-reach limitation below stands
unchanged. Closing that is a separate decision, not a side effect of this method existing.

A node is keyed on the ref vocabulary that already exists — `issue:12`, `issue:12:plan`,
`issue:12:part:schema`, `pr:41`, `pr:41:ci`, `job:7` — so it joins to every gate, override and proposal
without a second naming scheme, and on the **origin** rather than the task: two CI attempts on one PR
are two `tasks` rows and one node. `parent_ref` follows work lineage (a PR's parent is the part that
produced it); stacking is a different relation and lives on `base_ref`, which keeps the table a tree.
`terminal` is stored rather than derived because terminality depends on kind as well as status — a
`merged` PR is terminal, a `closed` issue is terminal, a concern node never is — and deriving it at read
time would put that judgement in both the CTE and the panel, where the two can disagree. `provenance`
records how a terminal PR state was learned: `observed` (seen in `closedPullRequests`) or `inferred`
(it left the open set and the window never showed it).

`recordWorkGraph` is **upsert-only**: a node absent from this pulse's observations is left exactly as it
was. That is the whole feature — the world snapshot remembers a merge for `closedPrWindowMs` and then
forgets it, and the graph must not. `parent_ref` is **write-once once non-null**: work lineage does not
change, and an immutable edge makes a cycle impossible rather than merely guarded, which matters because
`listWorkSubtree` is recursive. The "once non-null" wrinkle is deliberate — a stray PR can be recorded
parentless and adopted when its issue link appears, but nothing is ever _re_-parented. Every other column
is recomputed from the observation and never toggled against its previous value, the `PlanReconciler`
discipline.

**There is no TTL and no pruning**, unlike `priority_overrides`, which is reconciled away each pulse
because an override for work nobody is doing is stale. Nothing about a work node goes stale: it is a
record of what happened, and its value is precisely that it is still there when every other surface has
forgotten. The only writer is the `WorkGraphRecorder` in the pulse — see [04](04-harness-cycle.md).

### Work-item filings

`createWorkItemFiling({targetRef, jobId})`, `listWorkItemFilings()`, `findWorkItemFilingByJobId(jobId)`,
`linkWorkItemFiling(jobId, ticketRef)`.

A filing records that an operator asked an agent to create a tracker item for work the harness did that
nothing external accounts for — an operator job that produced commits with no issue behind it. It matters
because **completion is read from the tracker and never computed**, so an item the tracker has never heard
of has no terminal state available to it at all.

Keyed on `target_ref`, so one node has at most one filing and a second click is refused by the primary key
rather than by a caller remembering to look first. `create` returns null in that case; `linkWorkItemFiling`
is guarded `WHERE job_id = ? AND status = 'filing'` and returns null when nothing changed, so an agent that
calls `link_ticket` twice links once — idempotence in the write, the `linkFindingTicket` and `decideProposal`
discipline. `listWorkItemFilings` is unbounded on purpose, as `listProposals` is: a linked filing is what
parents its node, and one that aged out of a window would have the fold quietly un-record filed work.

It is **not** a `findings` row. A finding is an agent's testimony, with `agent_id`/`task_id` `NOT NULL` and
attribution taken structurally from a credential; a harness-authored row has neither, so reusing the table
would mean forging the two columns that carry the guarantee. The filing _mechanism_ is reused in full — a
desk job, `trackerCoordinates`, an overridable prompt, `link_ticket` — and only the row differs.

The parent edge it produces is written by the **fold**, never from the route or the tool: the filing row is
intent, the relationship `plans` and `plan_parts` already have to the recorder, which stays the graph's only
writer. Setting it is legal because `parent_ref` is write-once _once non-null_, which is equally what stops
it ever being redone.

### Escalations

`createEscalation`, `answerEscalation(id, response)`, `dismissEscalation(id, context)`,
`getEscalation`, `listEscalations`, `listOpenEscalations`.

### Decisions

`recordDecision(input)` — **lifts `action.rule` into the `rule` column** at record time, so the audit
log can answer "which rule fired" first-class. `listDecisions(limit=200)`.

### World and errors

`recordWorldEvents(inputs)` (stamps id and timestamp), `listWorldEvents(limit=200)`,
`getWorldBaseline()`, `setWorldBaseline(world)`, `recordError(input)`, `listErrors(limit=100)`, `clearErrors()` (deletes the whole log, returns the row count).

### Connector state

`getConnectorState(key)`, `setConnectorState(key, value)`, `recordConnectorEvent(kind, payload)` — used
by the fake providers so an injected world survives a restart.

## Durability rules

- **Reads return plain domain objects.** Nothing leaks a database row shape or a prepared statement.
- **Transcripts are flushed before any read, at every terminal transition, on kill, and on close.**
- **`recordDecision` is called for every action outcome**, including skips and the cycle rationale.
- **Nothing is deleted on a status change.** Cancelled jobs, dismissed findings, retired parts and
  dismissed escalations all keep their rows; the status carries the meaning. "We looked at this" is
  information.
- **A work node is never deleted at all**, not even on a status change — nothing observes it away, and
  no pass prunes it.
- **The runtime cap and pause flag are not persisted.** They live in `RuntimeControl` and a restart
  reverts to config.

### Known limitation: the work graph's backfill reach

`WorkGraphRecorder.record` builds the `existing` set it folds against as
`listWorkRoots().flatMap(root => listWorkSubtree(root.ref))`, which reaches a node only if its
**whole ancestor chain** already has rows. On a backfill pass a plan or part belonging to an
already-closed issue never gets an `issue:<n>` node — providers list open issues only — so that
subtree is invisible to the fold.

The consequence is **conservative**: such a node stays stale at whatever it was last recorded as
(typically `open`) rather than being falsely marked merged, so nothing downstream is told something
untrue. Closing it means a fourth store method returning every row flat, where the work-graph design
deliberately enumerated three.

Ruled on and left as-is. It is recorded here rather than only in the pull request that introduced it,
because a pull request body is not where anyone looks for a limitation six months later.
