# 14 — Persistence

**`src/store/` is the only directory that touches SQLite.** Everything else goes through the
`Store`. The schema is `src/store/schema.ts`.

## Shape

The rule above is about **SQLite access, not about one class** (issue #221). `store.ts` was a
2,543-line class with 117 methods over 29 tables, and every subsystem that needed one of them
depended on the surface of all of them. It is now a **composition root**: one domain module per
group of related tables, each a class taking nothing but a `StoreContext` (`{db, now}`), and a
thin `Store` that instantiates them and delegates. Every public method name and signature is
unchanged, so no call site anywhere knows.

| Module             | Tables                                                                      |
| ------------------ | --------------------------------------------------------------------------- |
| `tasks.ts`         | `tasks`                                                                     |
| `jobs.ts`          | `jobs`, `job_attachments`                                                   |
| `priority.ts`      | `priority_overrides`                                                        |
| `findings.ts`      | `findings`                                                                  |
| `humanTasks.ts`    | `human_tasks`                                                               |
| `plans.ts`         | `plans`, `plan_parts`                                                       |
| `issueVerdicts.ts` | `issue_conclusions`, `issue_deliveries`, `issue_shortfalls`, `issue_assays` |
| `scratch.ts`       | `scratch_entries`, `retrospectives`                                         |
| `agents.ts`        | `agents`, `usage_events`, `agent_flags`, `agent_files`                      |
| `transcripts.ts`   | `agent_transcripts`                                                         |
| `escalations.ts`   | `escalations`, `proposals`                                                  |
| `decisions.ts`     | `decisions`                                                                 |
| `world.ts`         | `world_events`, `world_baseline`, `connector_state`                         |
| `errors.ts`        | `error_events`                                                              |
| `graph.ts`         | `work_nodes`, `work_item_filings`, `work_item_ignores`                      |
| `bugFilings.ts`    | `issue_bug_filings`                                                         |
| `floor.ts`         | `floor_completions`                                                         |

Four properties, all asserted structurally in `test/storeModules.test.ts` rather than intended:

- **Only `src/store/` imports `better-sqlite3`.** The constraint the split was careful to preserve,
  and now the one that fails a test when broken. (Matched on the _import_ — two modules elsewhere
  mention the driver in prose to explain why a synchronous write makes a read-then-write race-free.)
- **A module is handed the database and nothing else.** `StoreContext` is `{db, now}` and no module
  imports a sibling. That is not a rule imposed on the split so much as a fact discovered by it:
  every method in the old class was `this.db.prepare(...)` plus `this.now()`, with no domain
  reaching another through class state, which is what made the move mechanical. A genuinely
  cross-domain read belongs _above_ the persistence layer, in the caller that already holds both.
- **Each table is named by exactly one module.** Two writers to one table is how the invariants
  between them come to disagree — which is why the four issue-verdict tables are deliberately one
  module and not four (see below).
- **The transcript buffer survives `close()`.** `TranscriptStore` is the one stateful module — it
  accumulates output in memory and writes on a ~16KB threshold — so `Store.close()` has to ask it
  to flush before the handle goes, and a test with a real file on disk is what notices if it stops.

One file under `src/store/` is deliberately **not** a domain module and is excluded from all three
assertions above: `verdicts.ts`, the issue-verdict exclusion matrix (#222). It is a dependency-free
declaration — no SQLite, no `Store` — naming the four verdict tables so a test can walk it, and
`issueVerdicts.ts` is the only thing that writes them. `context.ts`, `migrate.ts`, `schema.ts` and
`store.ts` itself are excluded for the same kind of reason: none of them owns a table.

**Membership is settled by which invariants must be readable together, not by table count.**
`issueVerdicts.ts` is the point of the exercise: the four verdict writers clear each other under
rules that used to live hundreds of lines apart, related only by prose cross-references. Those
rules are now declared as data and applied in one private method — see [Issue verdicts, and the
exclusion matrix](#issue-verdicts-and-the-exclusion-matrix) — and the four writers that share them
are one module rather than scattered through 2,500 lines.

## Database setup

`new Store(dbPath)`:

1. Creates the parent directory unless the path is `:memory:`.
2. Opens the database (better-sqlite3).
3. `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.
4. Executes `SCHEMA` (all statements are `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`,
   so it is idempotent).
5. Runs `ensureColumns` for every domain module's declared columns — **before any module is
   constructed**, let alone reads, since a module reading a migrated column on a database created
   by an older build reads `undefined`.
6. Constructs the domain modules over one shared `StoreContext`.

Writes are **synchronous**, which is what keeps the harness logic race-free. Lean on that.

The clock is injectable (`Clock`), so tests get deterministic timestamps.

## Migrations

`CREATE TABLE IF NOT EXISTS` never alters an existing table, so a column added to the schema is
invisible on databases created by an older build. `ensureColumns` (`src/store/migrate.ts`) closes that
gap with additive, idempotent `ALTER TABLE … ADD COLUMN`, guarded by a `PRAGMA table_info` check, safe
to run on every boot.

**The entries are declared by the module that owns the table**, as an exported `ColumnMigrations`
the composition root applies — so "did this table's new column get an entry?" is a question you can
answer without leaving the file you added the column's reader to. Current entries:

| Table         | Declared in     | Columns added                                                                                                  |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `tasks`       | `tasks.ts`      | `origin_title`, `origin_summary`, `dispatch_reason`                                                            |
| `agents`      | `agents.ts`     | `session_id`, `cost_usd`, `input_tokens`, `output_tokens`, `num_turns`, `note`, `noted_at`, `resumed_at`       |
| `decisions`   | `decisions.ts`  | `rule`, `admission`                                                                                            |
| `findings`    | `findings.ts`   | `ticket_ref`, `where_at`, `detail`                                                                             |
| `human_tasks` | `humanTasks.ts` | — (a fresh table; the entry is declared empty so the next column has somewhere obvious to go)                  |
| `plans`       | `plans.ts`      | `risks`, `out_of_scope`, `document`, `discussing`                                                              |
| `plan_parts`  | `plans.ts`      | `rationale`, `acceptance`, `expected_kind`, `outcome_kind`, `outcome_ref`, `outcome_summary`, `blocked_reason` |
| `jobs`        | `jobs.ts`       | `origin_ref`                                                                                                   |

`findings.where_at` is the one column whose name does not match its field: `where` is SQL, so the
column is `where_at` and `rowToFinding` maps it to `where`. Both new columns are nullable, and a row
from before them reads as `null` on each — the pre-split report stays whole in `summary`
([13](13-jobs-and-findings.md#the-three-text-fields)).

**Two migrations are not `ALTER`s.** `adoptFloorCompletions()` carries #203's `floor_completions`
into `issue_runs` and drops it (#234). A reshape rather than a column: `completed_at` was `NOT NULL`
and a run minted at pickup has no completion, so stretching the column to mean two things would leave
"minted" and "finished" indistinguishable on exactly the databases with history in them. It is guarded
on `issue_runs` being **empty**, not on the old table existing, so a second boot cannot overwrite
refreshed snapshots with the old shape's stale titles, and it runs in one transaction — carrying
`dismissed_at` is the load-bearing part, since a backfill that silently dropped the operator's
dismissals would put every cleared card back on the floor with the dispatcher acting on it again.

`absorbSinglePlanStatus()` is the other: no column changes, the values in one do —
`UPDATE plans SET status='active' WHERE status='single'`. `single` was a plan **shape** wearing a
lifecycle status, which made the two exclusive; the shape is now read off the live parts
([08](08-planning.md#shape-is-the-parts)). Unconditional and idempotent — a database with no such rows
updates none, and a second boot finds none left. Both run from `Store`'s constructor beside the
`ensureColumns` pass, before any module is constructed, let alone reads.

**A column added to an existing table needs an entry here.** A brand-new table does not — its
`CREATE TABLE` carries the full definition. `jobs`, `findings`, `plans`, `plan_parts`, `agent_flags`,
`agent_files`, `issue_conclusions`, `issue_deliveries`, `issue_shortfalls`, `issue_assays`, `scratch_entries`, `retrospectives`, `issue_runs`, `priority_overrides`, `work_nodes`,
`work_item_filings`, `work_item_ignores` and `issue_bug_filings` were all introduced as new tables and therefore needed no
migration entry **at the time** — but a table being new once is not a table staying exempt: `findings`
has since gained `ticket_ref` and then `where_at`/`detail`, and `plans`/`plan_parts` have since gained the fields above, which
is exactly the case this table exists for. `CREATE TABLE IF NOT EXISTS` never alters an existing table,
so a column added without an `ensureColumns` entry is invisible on every database from before that
column existed — "this table is fresh, so it needs no entry" is only ever true on the day the table is
introduced.

## Tables

| Table                | Holds                                                                                                                                                                                                                                                                                                                                                                         | Key constraints                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`              | Units of work materialised at dispatch.                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                         |
| `jobs`               | Operator-queued prompts awaiting a slot.                                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                         |
| `job_attachments`    | Images an operator attached to a blueprint (#249): what they are and where the file is. Bytes live on disk under `attachmentRoot`, never in the database.                                                                                                                                                                                                                     | `UNIQUE (target_ref, idx)`                                                                                                                |
| `priority_overrides` | Operator "Up next" re-ordering, keyed on candidate origin.                                                                                                                                                                                                                                                                                                                    | `origin` is `PRIMARY KEY`                                                                                                                 |
| `agents`             | One row per launched agent, including usage and the progress note.                                                                                                                                                                                                                                                                                                            | —                                                                                                                                         |
| `usage_events`       | Timestamped per-report cost **deltas** (not cumulative), so rolling windows are a `SUM`.                                                                                                                                                                                                                                                                                      | —                                                                                                                                         |
| `agent_flags`        | Artifacts surfaced to the cockpit.                                                                                                                                                                                                                                                                                                                                            | `UNIQUE (agent_id, ref)`                                                                                                                  |
| `agent_files`        | Every file an agent wrote; `promoted` marks the ones also surfaced as chips.                                                                                                                                                                                                                                                                                                  | `UNIQUE (agent_id, path)`                                                                                                                 |
| `findings`           | Things agents noticed outside their own task.                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                         |
| `human_tasks`        | Work only a person can do. `part_id` is the only way one holds work off the fleet; nothing in the dispatcher reads this table.                                                                                                                                                                                                                                                | —                                                                                                                                         |
| `issue_conclusions`  | Whether an issue is finished, per issue origin. One row, overwritten per declaration.                                                                                                                                                                                                                                                                                         | `origin_ref` is `PRIMARY KEY`                                                                                                             |
| `plans`              | One delivery plan per issue.                                                                                                                                                                                                                                                                                                                                                  | `origin_ref` is `UNIQUE`                                                                                                                  |
| `plan_parts`         | Parts of a multi-PR plan. `depends_on` is a JSON array of sibling slugs.                                                                                                                                                                                                                                                                                                      | `UNIQUE (plan_id, slug)`                                                                                                                  |
| `issue_deliveries`   | The harness's own park: an issue assessed as delivered. Gates pickup; expires on world signal.                                                                                                                                                                                                                                                                                | `origin_ref` is `PRIMARY KEY`                                                                                                             |
| `issue_shortfalls`   | The negative mirror: an issue worked whose goal is still not reached, with the cause that routes it. Gates **nothing**; lives until the arm it named is performed.                                                                                                                                                                                                            | `origin_ref` is `PRIMARY KEY`; `cause` is nullable                                                                                        |
| `issue_assays`       | Whether an issue's goal text can be worked from at all, judged before anything is dispatched. Gates the funnel; expires when the text changes or the world moves.                                                                                                                                                                                                             | `origin_ref` is `PRIMARY KEY`; `goal_ref` fingerprints the text judged                                                                    |
| `scratch_entries`    | The shared per-issue scratchpad: what the agents working one goal left for whoever works it next, and for the retrospective. **Append-only** — no update and no delete exists above the table.                                                                                                                                                                                | keyed on `pad_ref` (`issue:<n>`); ties on `created_at` break on `rowid`, which is insertion order                                         |
| `retrospectives`     | One write-up per goal, produced after delivery. Gates nothing; nothing in the dispatcher reads it beyond whether a row exists.                                                                                                                                                                                                                                                | `origin_ref` is `PRIMARY KEY`; upserted, so `created_at` dates the first write-up                                                         |
| `issue_runs`         | One run of the harness at a goal (#203, #234): minted the first pulse it has work under the issue, and living until the operator dismisses it. Carries the issue's title, body, labels, linked PR and workflow state as they last stood while live, because a retained run is **dispatched from** — it is unioned into the dispatcher's issue list, and a dismissal stops it. | `origin_ref` is `PRIMARY KEY`; upserted (`started_at` and `completed_at` frozen); `dismissed_at` is a one-way write that stamps `outcome` |
| `work_nodes`         | The durable work graph: every node the harness has observed, and what it descended from.                                                                                                                                                                                                                                                                                      | `ref` is `PRIMARY KEY`                                                                                                                    |
| `work_item_filings`  | A tracker item an operator had filed for work nothing external accounted for.                                                                                                                                                                                                                                                                                                 | `target_ref` is `PRIMARY KEY`                                                                                                             |
| `work_item_ignores`  | The other verdict on the same row: no tracker item is wanted. Undone by deleting the row.                                                                                                                                                                                                                                                                                     | `target_ref` is `PRIMARY KEY`                                                                                                             |
| `issue_bug_filings`  | A bug an operator raised against a story from the cockpit — they ran it and it does not do what they expect. Keyed on the **job**, not the story, so one story can carry several bugs: it can be wrong in more than one way, and each is its own bug. The operator's report is not a column; the desk job's prompt carries it verbatim.                                        | `job_id` is `PRIMARY KEY`; `origin_ref` indexed                                                                                           |
| `agent_transcripts`  | Chunked agent output.                                                                                                                                                                                                                                                                                                                                                         | `PRIMARY KEY (agent_id, seq)`                                                                                                             |
| `escalations`        | The human-in-the-loop inbox. `context` is JSON.                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                         |
| `decisions`          | The audit log. `action` is JSON; `rule` and `admission` are lifted off it at record time.                                                                                                                                                                                                                                                                                     | —                                                                                                                                         |
| `branch_reaps`       | Pull requests whose merged branch has already been deleted on both sides. Keyed on the PR, not the branch: a branch name is reusable, and a row keyed on the name would suppress the reap owed to the next branch wearing it.                                                                                                                                                 | `pr_number` is `PRIMARY KEY`                                                                                                              |
| `connector_state`    | The fake provider's editable world, so injected events survive restarts.                                                                                                                                                                                                                                                                                                      | —                                                                                                                                         |
| `world_events`       | Observed world transitions — the activity feed's backing store.                                                                                                                                                                                                                                                                                                               | —                                                                                                                                         |
| `world_baseline`     | The last snapshot the harness diffed against.                                                                                                                                                                                                                                                                                                                                 | Single row: `CHECK (id = 1)`                                                                                                              |
| `error_events`       | Recorded failures — the Errors panel's backing store.                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                         |

Indexes cover the hot lookups: `agent_flags(agent_id)`, `agent_files(agent_id)`, `agents(status)`,
`tasks(status)`, `jobs(status)`, `job_attachments(target_ref)`, `findings(status)`, `plans(origin_ref)`, `plan_parts(plan_id)`,
`decisions(cycle_id)`, `world_events(created_at)`, `usage_events(at)`, `error_events(created_at)`,
`work_nodes(parent_ref)`, `work_item_filings(job_id)`, `issue_bug_filings(origin_ref)`, `tasks(origin_ref)`. The last is the work graph's attempt list: a node's
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

#### Blueprint attachments

`addAttachments(targetRef, files)`, `listAttachments(targetRef)`, `getAttachment(id)`,
`listAllAttachments()`, `nextAttachmentIndex(targetRef)`, `rekeyAttachments(targetRef, moved)`,
`deleteAttachments(targetRef)`.

- **Keyed on `target_ref`, not on a job id.** What an attachment belongs to outlives the row it
  arrived with: a code blueprint becomes a desk _filing_ job and then a ticket, so the images have to
  follow the goal rather than the job. While the request is a blueprint the ref is `job:<id>`.
- **The bytes are on disk, not in the database.** The row records the sniffed mime, the size, the
  operator's filename as a display label and the absolute path. `AttachmentFiles`
  (`src/jobs/attachmentFiles.ts`) owns the files, one directory per target ref; the stem is the index
  and the extension is the **sniffed** format, so a client filename never reaches the filesystem.
- **Write order is files, then rows.** An interrupted write leaves bytes nothing points at rather than
  a row naming a path that does not resolve, and a path an agent cannot open is the failure that
  matters. A deletion is the mirror — rows first, then files.
- **The ref changes hands once, at `link_ticket`.** A code blueprint with a tracker configured is
  filed as a ticket rather than dispatched ([05](05-dispatcher.md), [16](16-http-api.md#launching-a-blueprint)),
  so its images arrive keyed `job:<id>` and would otherwise be visible to the one agent that files the
  ticket and writes no code. `AgentManager.linkTicket` re-keys them onto the `issue:<n>` the filing
  created: `AttachmentFiles.relocate` moves the files, then `rekeyAttachments` rewrites the rows.
  - **Files move first, rows second**, the write order above and for the same reason: the two halves
    cannot be made atomic, and a crash between them must leave rows naming paths that still resolve.
  - **The destination may already hold images** — an agent may link to the existing issue it decided
    its blueprint duplicates — so the move renumbers from `nextAttachmentIndex(toRef)` rather than
    keeping the stem. A fixed stem would silently overwrite another operator's screenshot, and
    `UNIQUE (target_ref, idx)` would refuse the row after the file was already gone.
  - **A failed move is recorded, not raised.** The link has already succeeded in the store, and
    refusing it over a rename would leave the operator looking at an incomplete filing. What is lost
    is the image's onward visibility, and [18](18-observability.md) carries the reason.
- **Nothing ages them out.** Attachments live as long as what they are attached to, so a plan written
  days later, and the retrospective after it, can still refer back to the screenshot the goal started
  as. The **only** deletion is a blueprint cancelled before it ran, which nothing downstream can want;
  a later retention sweep would be taking something this spec says is kept.

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

### Issue verdicts, and the exclusion matrix

Four tables record a verdict about an issue, keyed on the same `issue:<n>` origin:
`issue_conclusions`, `issue_deliveries`, `issue_shortfalls`, `issue_assays`. Some pairs may coexist
and some contradict each other, and **which is which is declared once**, in `src/store/verdicts.ts`:

```ts
VERDICT_EXCLUSIONS: Record<VerdictKind, readonly VerdictKind[]> = {
  conclusion: ['delivery'],
  delivery: ['conclusion', 'shortfall'],
  shortfall: ['delivery'],
  assay: [],
};
```

Writing a verdict clears every verdict its row names, for that origin, in one transaction. The
private `IssueVerdictStore.recordVerdict(kind, upsert, row)` is what applies it, and the four public writers —
`recordIssueConclusion`, `recordDelivery`, `recordShortfall`, `recordAssay` — keep their names,
signatures and row composition and call it instead of each hand-rolling a `DELETE`. The reasoning
per row lives on the declaration; the summary is that a delivery and a conclusion are two answers to
one question, a delivery and a shortfall are two polarities of one question, a shortfall spares the
conclusion (that is the working agent's own statement about its own run, and
`resolveIssueConclusion` ranks the two instead), and an assay answers a different question entirely.

Three properties are why the matrix is data rather than prose (#222):

- **`Record<VerdictKind, …>`**, so a fifth verdict table is a compile error until its row is stated.
  Auditing four writers for a 5×5 matrix by inspection is the thing that does not scale.
- **A deliberate "clears nothing" is an explicit empty entry.** As four inline `DELETE`s, `assay`
  clearing nothing and `shortfall` not clearing conclusions looked identical — an absent statement —
  and meant different things.
- **The declaration is dependency-free** (no SQLite, no `Store`), so `test/verdictMatrix.test.ts`
  walks it rather than re-typing it: a fixture map typed `Record<VerdictKind, Fixture>` asserts every
  cell in both polarities, and covers a fifth table on the day it is added rather than when somebody
  notices. It states only which rows may _exist_ together; which wins where two may coexist stays
  `resolveIssueConclusion`'s question.

`recordVerdict` deliberately does **not** compose the row. The four are not the same shape in the
ways that matter — a conclusion preserves `created_at` where the others preserve `decided_at`, a
shortfall normalises `part_slug` against `cause`, an assay keeps `comment_ref` only while `goal_ref`
is unchanged — so a version of it that owned the row would be a `switch (kind)`: the same four
half-rows, moved. The boundary is exactly what is uniform: an upsert keyed on `origin_ref`, plus a
set of sibling rows to delete, in one transaction.

### Plans

`upsertPlan`, `getPlan`, `getPlanByOrigin`, `listPlans`, `setPlanStatus`, `setPlanDiscussing(id,
discussing)`, `setPlanStatusComment`, `rollUpPlanStatus(planId)`, `upsertPlanParts(planId, parts)`
(merges on slug, **never deletes**), `listPlanParts(planId)`, `listAllPlanParts`, `updatePlanPart`,
`markPartDispatched(id, taskId, branch)`.

`plans.status` is `planning | awaiting_approval | active | complete | abandoned` — the plan's **life**,
and nothing else. Whether the issue is being delivered as one pull request or several is `planShape`'s
answer, read off the live `plan_parts` rows ([08](08-planning.md#shape-is-the-parts)); the retired
`single` status is carried into `active` by `absorbSinglePlanStatus` above. A status value is otherwise
a _value_, not a column, so adding one needs no migration: an existing row simply never holds the new
one. `awaiting_approval` is the approval gate itself — see [08](08-planning.md#the-approval-gate).

`upsertPlan` **preserves `risks`/`outOfScope`/`document` on absence** rather than clearing them, the
same discipline it already applies to `statusCommentRef`: a caller that writes a status without
re-stating the narrative must not erase it. `discussing` is deliberately **not** settable through
`upsertPlan` at all — it is its own one-way transition via `setPlanDiscussing`, so an ingestion can
end a discussion (see [08](08-planning.md#discussing-a-plan)) but never accidentally re-open one.

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

`recordDecision(input)` — **lifts `action.rule` and `action.admission` into the `rule` and `admission`
columns** at record time, so the audit log can answer "what proposed this" and "what became of it"
separately rather than losing the first to the second. `listDecisions(limit=200)`.

`admission` is nullable and is set only by the two admissions that emit an action of their own
(`branch-notify`, `cooldown-escalate`); the held reasons (`cooldown`, `capped`, `unapproved`,
`superseded`, `waiting`) hold a candidate that was never executed and so write no decision row at all.
Rows written before the column existed carry the _outcome_ in `rule` with `admission` NULL — the
proposer is unrecoverable, nothing rewrites them, and the cockpit renders the two shapes distinctly.
See [05](05-dispatcher.md#two-columns-on-the-decision-row).

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
