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

| Module                | Tables                                                                      |
| --------------------- | --------------------------------------------------------------------------- |
| `tasks.ts`            | `tasks`                                                                     |
| `jobs.ts`             | `jobs`, `job_attachments`                                                   |
| `priority.ts`         | `priority_overrides`, `goal_priorities`                                     |
| `profileOverrides.ts` | `profile_overrides`                                                         |
| `findings.ts`         | `findings`                                                                  |
| `humanTasks.ts`       | `human_tasks`                                                               |
| `plans.ts`            | `plans`, `plan_parts`, `plan_revisions`                                     |
| `validation.ts`       | `validation_checks`, `validation_resources`                                 |
| `issueVerdicts.ts`    | `issue_conclusions`, `issue_deliveries`, `issue_shortfalls`, `issue_assays` |
| `scratch.ts`          | `scratch_entries`, `retrospectives`                                         |
| `agents.ts`           | `agents`, `usage_events`, `agent_flags`, `agent_files`                      |
| `transcripts.ts`      | `agent_transcripts`                                                         |
| `escalations.ts`      | `escalations`, `proposals`                                                  |
| `decisions.ts`        | `decisions`                                                                 |
| `world.ts`            | `world_events`, `world_baseline`, `connector_state`                         |
| `errors.ts`           | `error_events`                                                              |
| `graph.ts`            | `work_nodes`, `work_item_filings`, `work_item_ignores`                      |
| `bugFilings.ts`       | `issue_bug_filings`                                                         |
| `floor.ts`            | `floor_completions`                                                         |

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

| Table                                  | Declared in        | Columns added                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`                                | `tasks.ts`         | `origin_title`, `origin_summary`, `dispatch_reason`, `rule`, `ci_checks`, `model` (the resolved `claude --model` value for the run, from the `agentModels` policy — null on every deployment that configures none), `effort`, `profile` (the name that pair came from), `profile_source` (`pin` \| `rule` \| `default` — which level of the precedence chain answered, stored rather than re-derived because config moves under a finished run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `agents`                               | `agents.ts`        | `session_id`, `cost_usd`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `num_turns`, `note`, `noted_at`, `resumed_at`, `resume_attempts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `decisions`                            | `decisions.ts`     | `rule`, `admission`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `findings`                             | `findings.ts`      | `ticket_ref`, `where_at`, `detail`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `human_tasks`                          | `humanTasks.ts`    | `kind` (`'ask'` default, so every row from before the close-out reads as one), `dismissed_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `issue_runs`                           | `floor.ts`         | `dismiss_note` — what an operator said when they ended a run whose validation was not clear. Null for every row from before it existed, which is right: nobody was asked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `validation_checks`                    | `validation.ts`    | `revision`, `amended_at`, `amend_note`, `actor`, `handback_note`, `claimed_by`, `claimed_at` — the band an amendment leaves on a check, and who is expected to run it. Declared empty when the table shipped on the argument that a table being new _once_ does not keep it exempt; the debt was collected one change later, and without these entries every older database would read `undefined` for all three and silently draw no band. `actor` and `handback_note` arrived one change later and fail more quietly still: a column whose absence reads as `human` is one whose absence is invisible, and the hand-over control would simply never take. `claimed_by` and `claimed_at` came with the desktop channel and are quieter again: absent, they read as "nothing is claimed" — true of every older database and true forever after, so the fleet keeps dispatching checks a person is in the middle of running. |
| `validation_resources`                 | `validation.ts`    | **None, declared empty.** Still a fresh `CREATE TABLE` with nothing added since. The entry exists so the next column added is noticed here rather than read back as `undefined`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `issue_deliveries`, `issue_shortfalls` | `issueVerdicts.ts` | `detail` on **both** (the assessor's account beside its headline)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `plans`                                | `plans.ts`         | `diagnosis`, `approach`, `risks`, `out_of_scope`, `alternatives`, `open_questions`, `verification`, `evidence`, `document`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `plan_parts`                           | `plans.ts`         | `touches`, `rationale`, `acceptance`, `acceptance_met`, `size`, `expected_kind`, `outcome_kind`, `outcome_ref`, `outcome_summary`, `blocked_reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `jobs`                                 | `jobs.ts`          | `origin_ref`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pets`                                 | `pets.ts`          | `dissolved_at`, `built_sha`, `built_clean`, `chain`, `opened_at` — the last of which needs a **backfill** as well as the column, below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### When a null means something

`ensureColumns` returns the columns it **actually added**, as `table.column`, and the composition
root gates a backfill on that list. One column so far needs it. `pets.opened_at` is null on every row
that predates it, and null there spells _still an egg_ — so the `ALTER TABLE` alone would turn every
existing vivarium back into a crate of anonymous shells, with nothing red and no way out but clicking
through the lot. `openPetsFromBeforeEggs` stamps them with their own `hatched_at`, and runs **only on
the boot the column arrives**: unconditionally on every boot, the same statement would open every egg
an operator had left sitting. Both directions are silent, which is why the mechanism is a report
rather than a convention. → [22](22-pets.md#the-egg)

A column whose absence is simply a weaker claim — `built_sha`, `chain`, `dismiss_note` — needs none
of this. The test is whether _null_ is a value the running code will act on.

`findings.where_at` is the one column whose name does not match its field: `where` is SQL, so the
column is `where_at` and `rowToFinding` maps it to `where`. Both new columns are nullable, and a row
from before them reads as `null` on each — the pre-split report stays whole in `summary`
([13](13-jobs-and-findings.md#the-three-text-fields)).

### Rebuilding a table whose key changed

`ALTER TABLE ADD COLUMN` cannot express a change of key, and SQLite has no `ALTER COLUMN`, so the only
honest answer is a **rebuild**: create the new shape, copy the rows across resolving the old key into
the new one, drop the old table, and put the new one in its place — all inside one transaction, so a
crash halfway leaves the old table exactly as it was rather than a half copy nothing knows is half.

`rebuildTables(db, rebuilds, createTables)` (`src/store/migrate.ts`) is that path, and it is shaped
like `ensureColumns` deliberately: the entries are a `TableRebuild[]` **declared by the module that
owns the table**, and the composition root applies them.

- **Detection is the old key column's presence.** A fresh database gets the new shape from `SCHEMA`
  and is never rebuilt; a rebuilt one no longer has the column, so a second boot is a no-op rather
  than a second copy.
- **The schema's own `CREATE` makes the new table.** The rebuild renames the old one out of the way
  first and then calls `createTables`, which is `db.exec(SCHEMA)`. A second copy of the DDL inside a
  migration would be free to drift from the one every fresh database gets, with nothing to catch it.
- **Every column is named in the copy.** `SELECT *` binds by position and would silently shift a row's
  columns along the day either shape gains a field.

Two declarations exist. `VALIDATION_REBUILDS` in `validation.ts` moves `validation_checks` and
`validation_resources` off `plan_id` and onto the goal's `origin_ref` — the old key resolved through
the plans table. A row whose plan is gone is dropped by the join rather than carried under a key made
up for it: it can no longer name a goal, and a check keyed on nothing is worse than one that is not
there. **`id` and `letter` come across untouched**, which is the whole risk in the rebuild — they are
the merge key and the handle a person types, and renumbering either would silently invalidate every
amendment that names a check and every reading already recorded against one. Asserted in
`test/validation.test.ts`, against a database built in the old shape.

`GRAPH_REBUILDS` in `graph.ts` drops `work_item_filings.job_id`. A work item's filing had a job
because a filing _was_ an agent doing something; since [#394](13-jobs-and-findings.md#filing-a-ticket)
the harness files one itself, so there is no job to name and nothing that resolves a filing from an
agent's credential. Dropping rather than nulling, because `NOT NULL` is not something `ALTER` can undo
and a column no writer fills would refuse every new filing on every database created before this
build. Nothing is re-derived in the copy: `target_ref` was already the primary key, so a filing an
operator made last month keeps its ticket.

**Three migrations are not `ALTER`s.** `adoptFloorCompletions()` carries #203's `floor_completions`
into `issue_runs` and drops it (#234). A reshape rather than a column: `completed_at` was `NOT NULL`
and a run minted at pickup has no completion, so stretching the column to mean two things would leave
"minted" and "finished" indistinguishable on exactly the databases with history in them. It is guarded
on `issue_runs` being **empty**, not on the old table existing, so a second boot cannot overwrite
refreshed snapshots with the old shape's stale titles, and it runs in one transaction — carrying
`dismissed_at` is the load-bearing part, since a backfill that silently dropped the operator's
dismissals would put every ended run back in front of the operator with the dispatcher acting on it
again.

`absorbSinglePlanStatus()` is the second: no column changes, the values in one do —
`UPDATE plans SET status='active' WHERE status='single'`. `single` was a plan **shape** wearing a
lifecycle status, which made the two exclusive. Unconditional and idempotent — a database with no such
rows updates none, and a second boot finds none left.

`backfillWholePlanParts()` is the third, and it **must run after** the one above, because it reads the
status that one writes. It gives every plan with **no part rows** the one part it always was, slug
`whole`. Those rows are the retired shape's other half: "one pull request" used to mean _zero parts_,
with rule `issue-pickup` working the issue on the flat `issue/<n>` branch. Nothing schedules them now
— pickup does not look at a planned issue and rule `plan-part` finds no part — so without this a live
goal parks itself, silently, on the deploy that ships it. The part carries `branch = issue/<n>` on an
`active` or `complete` plan, so the flat branch's open PR and running agent land on it through the
ordinary `part.branch ?? partBranch(…)` resolution; `null` otherwise, so nothing yet scheduled is cut
in the normal namespace. `abandoned` plans are skipped. Idempotent: a plan with any part row, retired
ones included, is left alone. → [08](08-planning.md#the-status-is-the-plans-life-and-only-that)

`backfillTaskDispatchKind()` is the third: it seeds `tasks.rule` and `tasks.ci_checks` on the runs
dispatched before those columns existed, so the by-task-type and by-check spend tables
([18](18-observability.md#by-task-type-and-by-check)) can speak about them. Two halves with very
different standing. The **rule** is structural — each of `pr:<n>:ci`, `pr:<n>:ci-gate`,
`pr:<n>:comments` and `pr:<n>:mergeable` is minted by exactly one rule, so reading it off the origin
is a fact about the dispatch vocabulary. The **checks** are parsed out of the `dispatch_reason`
sentence, and this is **the only place in the harness that parses one** — the read path never does,
because a reader that re-derives a format reports zero, silently, the first time the wording changes
(`ciStatusOf`'s rule, [18](18-observability.md)). Here that risk is bounded and visible: an
unrecognised sentence leaves the row null, the money lands in the panel's stated `unnamedCostUsd`
remainder, and nothing reads as free that was not. It only ever fills nulls, so it is idempotent and
cannot overwrite what the dispatcher recorded properly.

All three run from `Store`'s constructor beside the `ensureColumns` pass, before any module is
constructed, let alone reads. The rebuild pass runs before all of them — it is what applies `SCHEMA`
at all.

**A column added to an existing table needs an entry here.** A brand-new table does not — its
`CREATE TABLE` carries the full definition. `jobs`, `findings`, `plans`, `plan_parts`, `agent_flags`,
`agent_files`, `issue_conclusions`, `issue_deliveries`, `issue_shortfalls`, `issue_assays`, `scratch_entries`, `retrospectives`, `issue_runs`, `priority_overrides`, `goal_priorities`, `work_nodes`,
`work_item_filings`, `work_item_ignores`, `pr_watch_seeds`, `pr_work_item_links`, `profile_overrides`, `local_runs` and `issue_bug_filings` were all introduced as new tables and therefore needed no
migration entry **at the time** — but a table being new once is not a table staying exempt: `findings`
has since gained `ticket_ref` and then `where_at`/`detail`, and `plans`/`plan_parts` have since gained the fields above, which
is exactly the case this table exists for. `CREATE TABLE IF NOT EXISTS` never alters an existing table,
so a column added without an `ensureColumns` entry is invisible on every database from before that
column existed — "this table is fresh, so it needs no entry" is only ever true on the day the table is
introduced.

## Tables

| Table                  | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Key constraints                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`                | Units of work materialised at dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                            |
| `jobs`                 | Operator-queued prompts awaiting a slot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                            |
| `job_schedules`        | Recurring blueprints: the prompt an operator wants queued on a cron schedule, and how far through that recurrence the harness has got. Intent, not work — a firing writes an ordinary `jobs` row, so nothing downstream of the queue knows a clock queued it. `next_run_at` is the whole of the scheduling state, recomputed from the clock at each firing rather than from the slot that fired.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                            |
| `job_attachments`      | Images an operator attached to a blueprint (#249): what they are and where the file is. Bytes live on disk under `attachmentRoot`, never in the database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `UNIQUE (target_ref, idx)`                                                                                                                   |
| `priority_overrides`   | Operator "Up next" re-ordering, keyed on candidate origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `origin` is `PRIMARY KEY`                                                                                                                    |
| `profile_overrides`    | Which model profile the operator said one queued origin's work runs on — the narrowest, highest-precedence level of the pin chain, ahead of the plan's part profile and the goal's tag. Swept by the same `last_seen_at` reconcile `priority_overrides` gets, and off the same tracked-origin set: an override naming an origin nothing tracks any more prices no dispatch and is one nobody can see to take off. A separate table rather than a column beside the rank, because "do this sooner" and "do this cheaper" are independent statements about one row.                                                                                                                                                                                                                                                                                                                                                                                            | `origin` is `PRIMARY KEY`                                                                                                                    |
| `goal_priorities`      | Goals the operator marked a priority (`issue:<n>`), and when. Presence is the whole value: there is no rank, because the flag says which **goal** comes first and the pipeline already says what that goal needs first. **Never pruned**, unlike the row above it — an override arranges one pulse's queue and is meaningless once its origin stops being ranked, while this is a standing statement about a goal, and a flagged goal waiting on a human queues nothing at all. It is cleared by the operator and by nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                  | `origin` is `PRIMARY KEY`                                                                                                                    |
| `agents`               | One row per launched agent, including usage and the progress note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                            |
| `usage_events`         | Timestamped per-report cost **deltas** (not cumulative), so rolling windows are a `SUM`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                            |
| `agent_flags`          | Artifacts surfaced to the cockpit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `UNIQUE (agent_id, ref)`                                                                                                                     |
| `agent_files`          | Every file an agent wrote; `promoted` marks the ones also surfaced as chips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `UNIQUE (agent_id, path)`                                                                                                                    |
| `findings`             | Things agents noticed outside their own task.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                            |
| `lessons`              | What working a goal taught about **working this repository** (#355) — kept in the store rather than in the tree, because the three properties that make it safe are ones a markdown pad cannot hold: the gate (`status`), the provenance (`origin_ref` + `created_at`) and the prune (`retired`). Read by the cockpit and by `renderLessonBlock` — which puts the `promoted` rows, and only those, into every agent's system-prompt append (#355 phase 3). No dispatcher rule reads it at any status.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                            |
| `human_tasks`          | Work only a person can do. `part_id` is the only way one holds work off the fleet; nothing in the dispatcher reads this table. `kind` tells the harness's own close-out from everything a person or an agent asked for, and `dismissed_at` is the settled row an operator has cleared off the bench — presentation, never a fourth status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                            |
| `issue_conclusions`    | Whether an issue is finished, per issue origin. One row, overwritten per declaration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `origin_ref` is `PRIMARY KEY`                                                                                                                |
| `issue_instructions`   | What the operator has told the fleet to do on a goal, in their own words ("change the button to primary"). Append-only, several per goal, and settled together by the conclusion that answers them. Not a verdict: nothing gates on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `plans`                | One delivery plan per issue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `origin_ref` is `UNIQUE`                                                                                                                     |
| `plan_parts`           | Parts of a multi-PR plan. `depends_on`, `touches` and `acceptance_met` are JSON arrays.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `UNIQUE (plan_id, slug)`                                                                                                                     |
| `plan_revisions`       | Every plan a planner has submitted for one plan row, oldest first. `narrative` and `parts` are JSON. Append-only. Its `verdict` column is vestigial — written, never read — since every plan is a list of parts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `UNIQUE (plan_id, seq)`                                                                                                                      |
| `validation_checks`    | How anyone checks the _goal_ was met: one row per check on a **goal**, keyed on its `origin_ref` rather than on whichever plan of the work declared it. `id` is the author's merge key; `letter` is the handle a person types, assigned once and never reused; `uses` and `covers` are JSON arrays. The result is columns rather than a table — one current reading, `note_progress`'s argument. `check_do`/`check_expect` are named around DO being a SQLite keyword. `revision` is JSON: what an amendment replaced and the reading it withdrew, cleared by the next recorded reading. `actor` is the operator's hand-over to the fleet — written by one route and nothing else, and withdrawn by exactly what withdraws a result. `claimed_by`/`claimed_at` are a desktop session's hold on a check while it runs one: at most one live claim across every goal, released by the report, by the session's socket closing, or by expiry. → [20](20-validation.md) | `PRIMARY KEY (origin_ref, id)`                                                                                                               |
| `validation_resources` | What those checks need that is not in the repository — fixtures, reference material, access. Named, never pathed; the file lives under `validationRoot`. `human_task_id` remembers the ask filed for an unprovided one — so a replan does not file it twice, and so a replan that stops needing the resource can withdraw it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `PRIMARY KEY (origin_ref, name)`                                                                                                             |
| `issue_deliveries`     | The harness's own park: an issue assessed as delivered. Gates pickup; expires on world signal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `origin_ref` is `PRIMARY KEY`                                                                                                                |
| `issue_shortfalls`     | The negative mirror: an issue worked whose goal is still not reached, with the cause that routes it. Gates **nothing**; lives until the arm it named is performed. `detail` is the assessor's account; both verdict tables carry one, because an assessment lands in exactly one of them and a column on only the negative table would be silently dropped by every `delivered` verdict.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `origin_ref` is `PRIMARY KEY`; `cause` is nullable                                                                                           |
| `issue_assays`         | Whether an issue's goal text can be worked from at all, judged before anything is dispatched, and which model profile the assayer proposed for its work. Gates the funnel twice over: on a refused goal, which expires when the text changes or the world moves, and on a profile proposal nobody has answered, which expires only on the answer or the text changing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `origin_ref` is `PRIMARY KEY`; `goal_ref` fingerprints the text judged; `proposed_profile` + `profile_answered_at` are the goal-profile gate |
| `scratch_entries`      | The shared per-issue scratchpad: what the agents working one goal left for whoever works it next, and for the retrospective. **Append-only** — no update and no delete exists above the table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | keyed on `pad_ref` (`issue:<n>`); ties on `created_at` break on `rowid`, which is insertion order                                            |
| `retrospectives`       | One write-up per goal, produced after delivery. Gates nothing; nothing in the dispatcher reads it beyond whether a row exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `origin_ref` is `PRIMARY KEY`; upserted, so `created_at` dates the first write-up                                                            |
| `issue_runs`           | One run of the harness at a goal (#203, #234): minted the first pulse it has work under the issue, and living until the operator dismisses it. Carries the issue's title, body, labels, linked PR and workflow state as they last stood while live, because a retained run is **dispatched from** — it is unioned into the dispatcher's issue list, and a dismissal stops it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `origin_ref` is `PRIMARY KEY`; upserted (`started_at` and `completed_at` frozen); `dismissed_at` is a one-way write that stamps `outcome`    |
| `tracker_items`        | The ticket mirror (#329): every item the tracker's assignment filter has returned since the harness first swept, in the state it was last seen in. Never deleted — see [The ticket mirror](#the-ticket-mirror).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `number` is the key; no other index, since `number` **is** the default ordering.                                                             |
| `tracker_sweep`        | One row (`id = 1`): the mirror's frozen backfill anchor, the high-water mark the next changed-since read asks from, and `restated_at` — the one-shot mark that the history has been read with every row's native state on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `CHECK (id = 1)` — there is one sweep, not a log of them.                                                                                    |
| `upgrade_intent`       | One row (`id = 1`): a deliberate upgrade of the harness's own build — its state, the upstream sha accepted, and whether the drain is what paused dispatch. Persisted where `RuntimeControl` is not, because `applying` is read by the process _after_ the one that wrote it ([21](21-self-update.md#the-intent)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `CHECK (id = 1)` — there is one upgrade in progress, not a log of them.                                                                      |
| `work_nodes`           | The durable work graph: every node the harness has observed, and what it descended from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `ref` is `PRIMARY KEY`                                                                                                                       |
| `work_item_filings`    | A tracker item an operator had filed for work nothing external accounted for. `filing` is the **claim**, held for the moment between the click and the tracker answering — the harness files these itself, so a claim whose create failed is deleted rather than left standing. No `job_id`: nothing is dispatched for one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `target_ref` is `PRIMARY KEY`                                                                                                                |
| `work_item_ignores`    | The other verdict on the same row: no tracker item is wanted. Undone by deleting the row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `target_ref` is `PRIMARY KEY`                                                                                                                |
| `issue_bug_filings`    | A bug an operator raised against a story from the cockpit — they ran it and it does not do what they expect. Keyed on the **job**, not the story, so one story can carry several bugs: it can be wrong in more than one way, and each is its own bug. The operator's report is not a column; the desk job's prompt carries it verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `job_id` is `PRIMARY KEY`; `origin_ref` indexed                                                                                              |
| `agent_transcripts`    | Chunked agent output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `PRIMARY KEY (agent_id, seq)`                                                                                                                |
| `escalations`          | The human-in-the-loop inbox. `context` is JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                            |
| `decisions`            | The audit log. `action` is JSON; `rule` and `admission` are lifted off it at record time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                                                                                            |
| `branch_reaps`         | Pull requests whose merged branch has already been deleted on both sides. Keyed on the PR, not the branch: a branch name is reusable, and a row keyed on the name would suppress the reap owed to the next branch wearing it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `pr_number` is `PRIMARY KEY`                                                                                                                 |
| `local_runs`           | The machine's one dev environment, one row per run: which goal's code is in it, the checkout, the pid, and how it ended. The row **outlives the run**, because a start that failed is the case an operator hits and its reason has to be readable after the process is gone. At most one row is live, and `beginLocalRun` is what makes that true — it ends the last in the same transaction that writes the next, rather than trusting a caller to check first. → [23](23-local-runs.md#persistence) | `id` is `PRIMARY KEY`; `idx_local_runs_status` |
| `pr_watch_seeds`       | Pull requests the harness has already answered the watch question for — because it tagged one it opened, or because a person used the toggle. Keyed on the PR for `branch_reaps`' reason. Stored because the live labels cannot answer it: an un-watched pull request looks exactly like one never reached, and re-tagging it would undo the operator's own click every pulse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `pr_number` is `PRIMARY KEY`                                                                                                                 |
| `pr_work_item_links`   | Pull requests the harness has already linked to their work item, at `open_pr` time or on the pulse. Keyed on the PR for `branch_reaps`' reason — one work item legitimately carries several. Stored because neither the world nor any other row answers it: an operator may delete a link they judged wrong, and re-deriving would write it straight back every pulse; and `linkedPrNumber` folds a work item's relations to the _last_ pull request naming it, so on a plan whose parts each open one the earlier parts read as unlinked however many links exist.                                                                                                                                                                                                                                                                                                                                                                                                 | `pr_number` is `PRIMARY KEY`                                                                                                                 |
| `pr_review_waits`      | One watermark per pull request currently waiting on a reviewer: the instant it started. Stored because it is the one reading about a _span_ — the moment a pull request becomes reviewable is observable only as it happens, and no provider reports it afterwards. Written only when absent and deleted the moment the wait ends, so the table holds exactly what is outstanding; a plain upsert would read as "waiting five minutes" forever. Display only — nothing gates on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `pr_number` is `PRIMARY KEY`                                                                                                                 |
| `connector_state`      | The fake provider's editable world, so injected events survive restarts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                            |
| `world_events`         | Observed world transitions — the activity feed's backing store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                            |
| `world_baseline`       | The last snapshot the harness diffed against.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Single row: `CHECK (id = 1)`                                                                                                                 |
| `error_events`         | Recorded failures — the Errors panel's backing store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                            |

Indexes cover the hot lookups: `agent_flags(agent_id)`, `agent_files(agent_id)`, `agents(status)`,
`tasks(status)`, `jobs(status)`, `job_attachments(target_ref)`, `job_schedules(enabled, next_run_at)`, `findings(status)`, `plans(origin_ref)`, `plan_parts(plan_id)`, `validation_checks(origin_ref)`,
`decisions(cycle_id)`, `world_events(created_at)`, `usage_events(at)`, `error_events(created_at)`,
`work_nodes(parent_ref)`, `issue_bug_filings(origin_ref)`,
`issue_instructions(origin_ref)`, `tasks(origin_ref)`. The last is the work graph's attempt list: a node's
attempts are the `tasks` rows carrying its origin, so no separate attempts table exists — `tasks` only
lacked the index.

## The Store API

### Tasks

`createTask`, `updateTask` (status / agentId / branch only), `getTask`, `listTasks`,
`listOutstandingTasks`, `findActiveTaskByOrigin(originRef)`, `findActiveTaskByBranch(branch)`.
"Active" is `queued`, `running` or `waiting`.

**`listTasks` returns `TaskSummary`, not `Task`: every column except `prompt`.** It is the only
all-time reading of the table, and it names its columns rather than starring. A rendered agent prompt
is kilobytes; on a deployment with 1,248 tasks the prompts were 17.4 MB of the 20.2 MB `SELECT *`
returned, and better-sqlite3 is synchronous, so that read blocked the server — 322 ms against 33 ms
for the named columns — every time any of its thirteen callers ran, several times a pulse per open
cockpit. None of them reads a prompt: they read origins, branches, statuses and rules.

The prompt is a **single-row** read. `getTask`, `listOutstandingTasks` (bounded to the active set) and
`createTask`'s own return value are `Task`, and they are what the three readers of a prompt use — the
launch, the initial message, and crash recovery's requeue note. `Task extends TaskSummary` rather than
the two being declared side by side, so a column added to the table lands on both and nothing that
reads a summary field has to change.

**A column added to `tasks` must be added to `SUMMARY_COLUMNS` in `src/store/tasks.ts` as well as to
`ColumnMigrations`.** Omitting it is silent in the way this whole file is about: `rowToSummary` maps by
name, the field is optional on the domain type, so it simply reads back as absent everywhere the
snapshot is drawn. `test/snapshotShape.test.ts` compares a summary's keys against a whole row's, which
is what says so.

The two `findActive*` predicates are the dispatch gates. They are mirrors of each other, and the branch
one exists because origin and branch are not 1:1 on the job path — see [09](09-execution.md) and
[13](13-jobs-and-findings.md).

### Jobs

`createJob`, `getJob`, `listJobs(limit=100)` (newest first), `listQueuedJobs()` (oldest first),
`markJobDispatched(id, taskId)`, `cancelJob(id)` (still-queued only).

#### Blueprint attachments

`addAttachments(targetRef, files)`, `listAttachments(targetRef)`, `getAttachment(id)`,
`listAllAttachments()`, `deleteAttachments(targetRef)`.

- **Keyed on `target_ref`, not on a job id.** What an attachment belongs to is the _goal_, not the row
  the request arrived as: a code blueprint with a tracker configured becomes a ticket, so its images
  belong to `issue:<n>`, while one that dispatches directly belongs to `job:<id>`.
- **The bytes are on disk, not in the database.** The row records the sniffed mime, the size, the
  operator's filename as a display label and the absolute path. `AttachmentFiles`
  (`src/jobs/attachmentFiles.ts`) owns the files, one directory per target ref; the stem is the index
  and the extension is the **sniffed** format, so a client filename never reaches the filesystem.
- **Write order is files, then rows.** An interrupted write leaves bytes nothing points at rather than
  a row naming a path that does not resolve, and a path an agent cannot open is the failure that
  matters. A deletion is the mirror — rows first, then files.
- **The ref is decided before anything is written.** A code blueprint with a tracker configured is
  filed as a ticket rather than dispatched ([13](13-jobs-and-findings.md#filing-a-ticket)), and the
  **harness** files it — so the issue number is known on the request, and the images are written under
  `issue:<n>` from the start. They were previously keyed `job:<id>` and re-keyed by `link_ticket` when
  a desk agent reported the ticket back; that whole move is gone with the agent, and with it the
  window in which an image belonged to a row about to stop existing.
  - **A failed write is recorded, not raised.** The ticket exists and is what the operator asked for;
    refusing the request over a screenshot would cost them the filing. What is lost is the image's
    onward visibility, and [18](18-observability.md) carries the reason.
- **Nothing ages them out.** Attachments live as long as what they are attached to, so a plan written
  days later, and the retrospective after it, can still refer back to the screenshot the goal started
  as. The **only** deletion is a blueprint cancelled before it ran, which nothing downstream can want;
  a later retention sweep would be taking something this spec says is kept.

### Job schedules

`createJobSchedule(input)` (enabled on creation — an operator who wrote one means it to run),
`getJobSchedule(id)`, `listJobSchedules()` (oldest first, **all** of them),
`updateJobSchedule(id, patch)`, `recordJobScheduleRun(id, {firedAt, jobId, nextRunAt})`,
`deleteJobSchedule(id)`.

- **The store holds _when_, never _whether_.** No query here asks the clock: `next_run_at` is written
  by whoever computed it — the route on a create or an edit, the desk on a firing — and read back as
  a plain string. The one place that knows what a cron expression means is `src/schedules/cron.ts`,
  so this table cannot form a second opinion about it.
- **Disabled rows are listed too.** A paused schedule is a standing intention the operator can see
  and switch back on, and it is skipped by the pass reading `enabled` rather than by never being
  handed it — the same shape a dismissed finding stays in its list.
- **A firing is one write.** `recordJobScheduleRun` sets `last_fired_at`, `last_job_id` and
  `next_run_at` together, because they are one event: a row saying it fired but not what it produced
  is exactly the row the next pulse's in-flight check cannot use. It is also why
  `updateJobSchedule` cannot write those two — one writer, so an edit never half-records a run.

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

`listGoalFiles(goalRef)` is the one read that asks the files question of a **goal** rather than an
agent: `agent_files` joined out through `agents` to the task whose `origin_ref` says which goal it was
working, folded to one `GoalFile` (`path`, `originRef`, `createdAt`) per path and ordered newest write
first. It is what the prior-work briefing's file section renders
([09](09-execution.md#what-earlier-agents-worked-out-reaches-the-next-one)). Four things it settles:

- **The subtree is a prefix**, the `issue:<n>` root plus `issue:<n>:…` — the membership `padOriginFor`
  already resolves, asked as SQL rather than re-derived from a second taxonomy, so it cannot drift from
  the pad's. `issue:1` therefore does not reach `issue:12`.
- **Code tasks only**, `detectFileOverlaps`'s narrowing ([12](12-artifacts-and-files.md#file-overlap-detection))
  for its reason: a desk agent works in a scratch directory, so a retro's write-up is not a file the
  repository has, and listing it as one would be false rather than merely stale.
- **One row per path, dated and attributed by its last write.** A row is already deduped per
  (agent, path) with its stamp bumped on rewrite, so the newest row for a path is the one that dates it.
  Ties break on `rowid`, so one database renders one list.
- **No promotion flag and no tool on the returned row.** The reader renders neither, and a field carried
  but unrendered is one a later reader has to guess the meaning of.

`listGoalNeighbours(goalRef, paths)` asks the same table the other way round: which **other** goals have
been in any of `paths`, folded to one `GoalNeighbour` (`goalRef`, `retroSummary`, `sharedPaths`,
`lastWriteAt`) per goal. It is the briefing's neighbour section
([09](09-execution.md#what-earlier-agents-worked-out-reaches-the-next-one)). It inherits the code-tasks
narrowing and the prefix scoping above, and settles three more:

- **The retrospective is the join, not a filter after it.** `retrospectives.origin_ref` is always the
  `issue:<n>` root (`retroSubmitOrigin` resolves it), so joining `tasks` to it on `origin_ref` or
  `origin_ref || ':%'` yields the neighbour's goal ref, the "this goal is finished" gate and the summary
  being handed over in one pass — and the pattern carries no `LIKE` wildcards, so `issue:1` still does
  not reach `issue:12`.
- **A goal still being worked is excluded by that gate and by no other**, rather than by a second
  liveness predicate. One reading of "finished" in the codebase, not two.
- **Paths are folded in TypeScript, not with `group_concat`.** A path is arbitrary text, so any
  separator that joins one is a separator a path may itself contain. Rows come back ordered newest
  first, so the first row for a goal dates it and the fold's insertion order is the order the reader
  renders — no sort after the query, and none by overlap count, which would be a ranking.

### Findings

`recordFinding(agentId, taskId, originRef, input)` → `{finding, created}`; a verbatim repeat refreshes
without resetting status. `getFinding`, `listFindings(limit=100)`,
`resolveFinding(id, status, jobId?)`.

### Lessons

`proposeLesson(input)` → a `proposed` row; `getLesson`, `listLessons(limit=200)` (retired ones
included — the prune surface has to show what it pruned), `promoteLesson(id)`, `retireLesson(id)`.

Both transitions are **guarded in the write** rather than by a read-then-check, the discipline
`linkFindingTicket` uses: `promoteLesson` moves only a `proposed` row, `retireLesson` moves either
live status, and each returns null when there was nothing in a status it could leave. `retired` is
terminal — there is no un-retire. → [13](13-jobs-and-findings.md#lessons)

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

### Operator instructions on a goal

`addIssueInstruction({originRef, text})`, `listStandingInstructions(originRef)`,
`listAllStandingInstructions()`, `settleInstructions(originRef)`, `withdrawInstruction(id)` —
`src/store/instructions.ts`.

Not filed with the verdicts above, and the distinction is the whole shape. Every table there holds one
standing answer per issue, overwritten per declaration, read by a gate. An instruction is **input**:
several stand at once, they are appended to every dispatch on the goal
([09](09-execution.md#the-operators-own-instructions-reach-the-agent)), and nothing in the dispatcher
branches on them. Putting a growing list under the module whose discipline is one-row-per-issue would
have cost that discipline its meaning.

- **Append-only.** No update beside the insert, for the scratchpad's reason: a revised instruction
  would leave a record of what the operator ended up asking for rather than what the agent was actually
  handed, and the two differ exactly when something went wrong.
- **`settled_at` is the whole lifecycle**, and a settled row is kept rather than deleted so the trail of
  what was asked survives the asking. It is set by the agent's `conclude_work` (all of a goal's at once)
  or by the operator withdrawing one.
- **Ordered `created_at ASC, rowid ASC`**, `listScratchEntries`' tie-break for its reason: the id is a
  nanoid, so two rows written in the same millisecond would otherwise come back in a random order, and
  the list is read as a sequence.
- **One grouped read for the snapshot**, `listScratchPadSummaries`' rule: `/api/state` is polled, and a
  read per goal would scale the poll with the size of the backlog.

### Plans

`upsertPlan`, `getPlan`, `getPlanByOrigin`, `listPlans`, `setPlanStatus`, `setPlanStatusComment`, `rollUpPlanStatus(planId)`, `upsertPlanParts(planId, parts)`
(merges on slug, **never deletes**), `listPlanParts(planId)`, `listAllPlanParts`, `updatePlanPart`,
`markPartDispatched(id, taskId, branch)`.

### Validation

`ingestValidation(planId, {checks, resources, supersededReason, amendNote})` (merges on check id,
assigns letters, supersedes rather than deletes),
`amendValidation(planId, {checks, withdraw, resources, note})` — the same merge from one agent's
correction rather than from a document, and **it withdraws nothing by omission**: a document speaks
for the whole check set and may supersede by silence, an agent halfway through a part may not, or it
would only have to be terse to delete the validation plan it is failing. `listValidationChecks(planId)`, `listAllValidationChecks`,
`listValidationResources(planId)`, `listAllValidationResources`,
`getValidationCheck(planId, checkId)` — one live check, shared by every writer that has to decide
before it writes, so the hand-over route and the reporting tool cannot reach different conclusions
about what a check currently says.

`setValidationActor(planId, checkId, actor)` — the operator's hand-over to the fleet, and its undo.
`claimValidationCheck(planId, checkId, holder, staleBefore)` — the search, the decision and the write
in one synchronous method, so two sessions racing cannot both read "nothing is claimed".
`releaseValidationClaim(planId, checkId)` — its undo, idempotent.
`recordValidationHandback(planId, checkId, note)` — the fleet giving one back: `actor` to `human` and
the reason on the row, and **no reading**, because an agent that could not reach the environment
learned nothing about the goal.

`recordValidationResult(planId, checkId, {state, note, by, until})` — one method for all five
transitions, because a check has exactly one current reading and everything the last one left behind
is cleared in the write rather than by a caller who has to remember. Refuses a superseded check.
`linkValidationResourceTask(planId, name, humanTaskId)`. → [20](20-validation.md)

### Why a plan's verdicts are kept

`plans` is **overwritten** by every amendment — that is what makes a replan a replan, and what keeps
the plan id its parts hang off. It is also why `plan_revisions` has to exist separately: an operator
who discussed a plan for ten minutes was handed the amended decomposition whole, with nothing anywhere
saying which two parts moved.

A revision is written by `ingestPlanDocument` alone, and it records **what was proposed** rather than
what the store made of it — a part the amendment dropped but which `partsToRetire` spared is absent
from the revision and live on `plan_parts`. Both are true, and the pair is the reading the plan sheet
draws. → [08](08-planning.md#revisions)

`plan_revisions` needed no `ensureColumns` entry because it is a brand-new table and
`CREATE TABLE IF NOT EXISTS` is the whole migration. **That is true once**: a column added to it later
needs an entry like any other.

`plans.status` is `planning | awaiting_approval | active | complete | abandoned` — the plan's **life**,
and nothing else. It carries nothing about shape, and nothing else does either: every plan is a list of
parts ([08](08-planning.md#a-plan-is-a-list-of-parts)). The retired `single` status is carried into
`active` by `absorbSinglePlanStatus` above. A status value is otherwise
a _value_, not a column, so adding one needs no migration: an existing row simply never holds the new
one. `awaiting_approval` is the approval gate itself — see [08](08-planning.md#the-approval-gate).

`upsertPlan` **preserves `diagnosis`/`approach`/`risks`/`outOfScope`/`document` on absence** rather than clearing them, the
same discipline it already applies to `statusCommentRef`: a caller that writes a status without
re-stating the narrative must not erase it.

`plans.discussing` is a column **nothing reads**. It marked a plan parked for a conversation with a
fleet planner; discussing a plan is a deep link into the operator's own Claude Code now
([08](08-planning.md#discussing-a-plan)) and writes nothing, so the field went with it. The column
stays because dropping one is not an additive migration and `NOT NULL DEFAULT 0` costs an existing
database nothing.

### The ticket mirror

`tracker_items` is the record behind [the Tickets tab](17-cockpit.md#the-tickets-tab), and it is the
one table in the store that **never deletes**. An item the tracker stops returning — closed long ago,
untagged, reassigned away — keeps its last-seen row, because the question the tab answers is _what has
this fleet been asked to do_ and a history that forgets cannot answer it.

**Backfill one month, then keep everything.** Two rules that pull in opposite directions, so both are
stated:

- **The floor is anchored, not rolling.** `tracker_sweep.anchor_at` is stamped one month before the
  first sweep and frozen thereafter — an `INSERT OR IGNORE`, so a later change to the window cannot
  move an existing deployment's floor. A rolling month would drop the far end of the history every
  night, silently: the tab would simply have fewer old rows each morning, with nothing saying they had
  gone. It is also why widening the window later is safe and does nothing: the rows below the new
  floor are already kept.
- **Nothing is deleted, and the mark only moves forward.** `swept_to` is the newest `changed_at`
  **actually written**, taken with a `MAX` inside the same transaction as the rows — never the clock.
  A mark ahead of rows nobody wrote is the direction that loses data, since the next sweep asks from
  after them and they are missed forever; a mark behind merely costs one idempotent re-read.

**The floor is a floor, not a filter.** The provider is asked by _last changed_
([15](15-integrations.md)), so an item filed long before the anchor that somebody touched last week
arrives on an ordinary sweep and is then kept like any other row. The history is "everything since the
anchor, plus whatever older work is still alive" — worth knowing, because a reader expecting a clean
cut-off will one day find an older ticket in the list and think the floor is broken.

**The list read hands back the whole table**, ordered by `number` descending, which is arrival order
because a tracker id is auto-incremental. There is no `WHERE` on it and no `LIMIT` because neither
thing the list is filtered and ordered by is this table's to know: the watch bucket is a function of the operator's
label prefix and cost is `buildSpendGoals`' answer, and either as a stored column would be a stale
copy of a verdict that moves. The filtering, ordering and paging are one pure function over the rows
(`src/tickets/ticketList.ts`). What that costs is reading the mirror per request, affordable for a
stated reason rather than by luck: one line per row with no body, bounded by the tracker's assigned
backlog rather than by time, and the route is fetched on open rather than polled.

#### Folding a watch click onto the mirror

`patchTicketLabels({numbers, label, present})` folds one label onto the named mirrored rows — the
mirror's half of the same click `patchWorldLabels` handles for the baseline, and for the same reason
stated twice as strongly. The Tickets tab is the one surface with an explicit **Unwatch**, and it
draws both the toggle and its `watch` filter from `labels` here rather than from the world. Nothing
else writes this column between sweeps, and the sweep that would runs _last_ in a cycle — the same
cycle a watch route's `runCycle('manual')` coalesces away when another is in flight. So without the
fold the row an operator just un-watched goes on reporting `watched` while the tag is long gone from
the tracker: a control that cannot be moved, which is what issue #417 reported
([16](16-http-api.md#and-why-the-issue-route-also-patches-the-mirror)).

It is observed fact arriving early on the same terms: only ever called for a write the provider
confirmed, only for the items whose write landed, and overwritten by the next sweep's overlay of the
world's own labels. A `number` the mirror does not hold is **skipped** rather than inserted — this
table is a record of what the tracker handed us, and a row invented for a click would be a ticket
that was never swept. An empty label is a no-op: that is `labelPrefix: ''`, the gate off, where there
is no tag at all.

**The mirror is also the spend trend's closure source.** `listTicketsClosedSince(since)` is the one
narrowed read on this table: the rows in the `closed` state whose `changed_at` is at or after an
instant. It exists because the closure event the trend would otherwise use never fires on a real
deployment — `issue_closed` needs an `open → closed` transition seen in place, and both real issue
providers snapshot the tracker's _open_ set, so a closed item leaves the world without one ever being
evaluated ([18](18-observability.md#the-spend-trend)). This table is fed by `listTicketHistory`, which
asks by last-changed and returns closed items explicitly, so it is the only place a closure is durably
recorded at all. `changed_at` is a last-modified rather than a close date, so an item edited after it
closed drifts to a later week; there is no close-date column to prefer, and the read is documented as
taking that trade rather than hiding it.

It reads the mirror and nothing more. Which goal has spend against it stays `buildSpendGoals`'
question, for the reason no cost column lives here: a closed row and a goal's money are two records
that meet in the fold, never in the schema.

**Live and frozen.** Since #351 every cockpit surface reads this table, so it carries what the harness
makes of an item as well as what the tracker said: `tracking` is `live` while the item is in the
tracker's open set and `frozen` once it leaves. A frozen row keeps every field it was last seen with
and stops being enriched — it is never deleted, because deleting it would take the cost history and the
verdict with it, and the close-out sweep recognises its own obligation by finding the item again. Thaw
is one condition and not a judgement: the tracker returns it to the open set.

**"No longer in the open set" is read the two ways the providers disagree about** — gone from the list,
or still listed with a closed state. Azure keeps reporting a closed work item; GitHub's issues provider
fetches open issues only. Reading only the first leaves every Azure item live forever; reading only the
second never fires on GitHub. It is the same pair of readings the delivery close-out sweep takes
([13](13-jobs-and-findings.md)) — and, like that one, **the freeze is skipped entirely on an empty live
set**: a provider whose snapshot failed hands back its last good read, but one that is down on a first
boot hands back nothing, and freezing the whole board off that is the one way this can be wrong at
scale.

**The live overlay is passed in, not fetched.** `issue_type` and the parent columns come from the
snapshot the cycle has already built. The hierarchy alone costs two batched provider reads per pulse,
and paying for it a second time to fill a record would double it — while the two copies could still
disagree, which is worse than either.

**`work_item_state` is written by the history read, not only by that overlay** — and this is the one
field where taking it from the overlay alone was wrong. The overlay _is_ the open set by construction,
so an item that has left it kept whatever word it was last seen live with, and an item closed before
the harness ever saw it open carried none at all. On an Azure deployment that is most of the mirror:
the state list [the tab discovers](17-cockpit.md#three-axes-because-they-are-three-questions) had no
`Closed` in it, so the rows nothing had a state for were reachable by no state filter — the exact
silence discovering the list from the mirror exists to prevent. `TrackerItem.workItemState` therefore
carries the provider's own word on the history read too, and the upsert **`COALESCE`s rather than
assigns**: a provider with no native states (GitHub, the fake) hands back null on every sweep, and
assigning it would wipe what the overlay wrote, on every pulse, with nothing red.

**The mirror re-reads itself once, and `tracker_sweep.restated_at` is what makes it once.** A database
written before that field was read holds rows with no state, and no incremental sweep would ever fill
them — a changed-since read only returns what has changed. So the first sweep on a database whose
`restated_at` is null asks from the **anchor** instead of the mark, which re-upserts every row the
mirror holds (nothing older than the anchor is in it), and `recordSweep` stamps the column. A fresh
database is restated by its own first read, which already starts at the anchor, so only an upgraded
deployment pays for the re-read and only ever once. The column is on an existing table and therefore
has a `TICKET_COLUMNS` entry of its own — **its absence is what means "not restated"**, so a missing
migration here would not fail loudly, it would re-read the whole history on every pulse forever.

**`parent_known` is a column, not a nullable id.** An orphan and a link we could not read are both a
null id, and the provider is careful to keep them apart ([15](15-integrations.md)); a flag is what
carries that distinction into the table, and out to a surface that must not tell a reader an item
belongs to no feature when the truth is that nobody could tell. A sweep that could not resolve the link
leaves whatever an earlier one managed to read.

`tracker_items` gained all of these **after** its original `CREATE`, so each has a `TICKET_COLUMNS`
entry — a column without one is invisible on every database from before it existed, and invisible is
the whole failure. → [migrations](#migrations)

### Feature colours

`feature_colors` maps a feature's number to a **slot on a fixed twelve-hue ladder**, assigned
least-used-first the first time the feature is drawn and then never moved. Persisted because the whole
value of the colour is that the same feature is the same one tomorrow; a ladder rather than a random hue
because a random one has two failure modes nothing catches — one that disappears against the panel, and
two features that land close enough to read as one. A **slot** rather than a colour because the palette
belongs to the stylesheet, and a hex here would be a second opinion about it that no theme could reach.

Assignment happens on **read**, not on the sweep: a feature earns a colour by being drawn, and a slot
spent on a parent nobody ever sees would push the features a reader does see further round the ladder.
The table is a fresh `CREATE TABLE` and declares an empty column list anyway — a table being new _once_
does not keep it exempt.

Nothing under `src/dispatcher/` reads any of this. The dispatcher decides from the live issue list,
which is open items by construction, and a rule that could see a frozen row would eventually act on
one.

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
`linkWorkItemFiling(targetRef, ticketRef)`, `dropWorkItemFiling(targetRef)`.

A filing records that an operator asked for a tracker item for work the harness did that
nothing external accounts for — an operator job that produced commits with no issue behind it. It matters
because **completion is read from the tracker and never computed**, so an item the tracker has never heard
of has no terminal state available to it at all.

Keyed on `target_ref`, so one node has at most one filing and a second click is refused by the primary key
rather than by a caller remembering to look first. `create` returns null in that case — and it is the
**claim**, taken before anything reaches the tracker, which is what makes two clicks in one second safe now
that the harness files on the request. `linkWorkItemFiling` is guarded
`WHERE target_ref = ? AND status = 'filing'` and returns null when nothing changed — idempotence in the
write, the `linkFindingTicket` and `decideProposal` discipline. `dropWorkItemFiling` releases a claim whose
create failed, narrowed to `filing` so it can never take a row carrying a ref; a delete rather than a third
status, for the reason `work_item_ignores` is a delete. `listWorkItemFilings` is unbounded on purpose, as
`listProposals` is: a linked filing is what parents its node, and one that aged out of a window would have
the fold quietly un-record filed work.

It is **not** a `findings` row. A finding is an agent's testimony, with `agent_id`/`task_id` `NOT NULL` and
attribution taken structurally from a credential; a harness-authored row has neither, so reusing the table
would mean forging the two columns that carry the guarantee.

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
`getWorldBaseline()`, `setWorldBaseline(world)`, `patchWorldLabels(patch)`, `recordError(input)`, `listErrors(limit=100)`, `clearErrors()` (deletes the whole log, returns the row count).

`patchWorldLabels({issues?, pullRequests?, label, present})` folds one label onto the named items in
the stored baseline, for a route that has just had the provider accept the write and must not make
the cockpit wait a pulse to see it ([16](16-http-api.md#why-both-watch-routes-patch-the-baseline)).
It moves `labelsAddedByViewer` with `labels` where the item carries one, or the toggle would read
"Watching" on an issue pickup still treats as untagged; it skips an item the baseline does not carry,
rather than inventing a row no snapshot described; and it is overwritten by the next cycle's reading,
which is the point — the tracker stays the source of truth.

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
