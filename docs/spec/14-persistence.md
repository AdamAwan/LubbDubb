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

| Table       | Columns added                                                                    |
| ----------- | -------------------------------------------------------------------------------- |
| `tasks`     | `origin_title`, `origin_summary`, `dispatch_reason`                              |
| `agents`    | `session_id`, `cost_usd`, `input_tokens`, `output_tokens`, `num_turns`, `note`, `noted_at` |
| `decisions` | `rule`                                                                           |

**A column added to an existing table needs an entry here.** A brand-new table does not — its
`CREATE TABLE` carries the full definition. `jobs`, `findings`, `plans`, `plan_parts`, `agent_flags`,
`agent_files` and `priority_overrides` were all introduced as new tables and therefore have no
migration entry.

## Tables

| Table               | Holds                                                                                  | Key constraints                          |
| ------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| `tasks`             | Units of work materialised at dispatch.                                                | —                                        |
| `jobs`              | Operator-queued prompts awaiting a slot.                                               | —                                        |
| `priority_overrides`| Operator "Up next" re-ordering, keyed on candidate origin.                             | `origin` is `PRIMARY KEY`                |
| `agents`            | One row per launched agent, including usage and the progress note.                     | —                                        |
| `usage_events`      | Timestamped per-report cost **deltas** (not cumulative), so rolling windows are a `SUM`. | —                                       |
| `agent_flags`       | Artifacts surfaced to the cockpit.                                                     | `UNIQUE (agent_id, ref)`                 |
| `agent_files`       | Every file an agent wrote; `promoted` marks the ones also surfaced as chips.            | `UNIQUE (agent_id, path)`                |
| `findings`          | Things agents noticed outside their own task.                                          | —                                        |
| `plans`             | One delivery plan per issue.                                                           | `origin_ref` is `UNIQUE`                 |
| `plan_parts`        | Parts of a multi-PR plan. `depends_on` is a JSON array of sibling slugs.                | `UNIQUE (plan_id, slug)`                 |
| `agent_transcripts` | Chunked agent output.                                                                  | `PRIMARY KEY (agent_id, seq)`            |
| `escalations`       | The human-in-the-loop inbox. `context` is JSON.                                        | —                                        |
| `decisions`         | The audit log. `action` is JSON; `rule` is lifted off it at record time.                | —                                        |
| `connector_state`   | The fake provider's editable world, so injected events survive restarts.                | —                                        |
| `connector_events`  | Injected events, for diagnostics.                                                      | —                                        |
| `world_events`      | Observed world transitions — the activity feed's backing store.                        | —                                        |
| `world_baseline`    | The last snapshot the harness diffed against.                                          | Single row: `CHECK (id = 1)`             |
| `error_events`      | Recorded failures — the Errors panel's backing store.                                  | —                                        |

Indexes cover the hot lookups: `agent_flags(agent_id)`, `agent_files(agent_id)`, `agents(status)`,
`tasks(status)`, `jobs(status)`, `findings(status)`, `plans(origin_ref)`, `plan_parts(plan_id)`,
`decisions(cycle_id)`, `world_events(created_at)`, `usage_events(at)`, `error_events(created_at)`.

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
*value*, not a column, so a database from an older build needs no migration: an existing row simply
never holds the new one. `awaiting_approval` is the approval gate itself — see
[08](08-planning.md#the-approval-gate).

### Escalations

`createEscalation`, `answerEscalation(id, response)`, `dismissEscalation(id, context)`,
`getEscalation`, `listEscalations`, `listOpenEscalations`.

### Decisions

`recordDecision(input)` — **lifts `action.rule` into the `rule` column** at record time, so the audit
log can answer "which rule fired" first-class. `listDecisions(limit=200)`.

### World and errors

`recordWorldEvents(inputs)` (stamps id and timestamp), `listWorldEvents(limit=200)`,
`getWorldBaseline()`, `setWorldBaseline(world)`, `recordError(input)`, `listErrors(limit=100)`.

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
- **The runtime cap and pause flag are not persisted.** They live in `RuntimeControl` and a restart
  reverts to config.
