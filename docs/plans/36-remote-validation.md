# Build plan — 36 Remote validation

The staged order [36 — Remote validation](../spec/36-remote-validation.md) gets built in. It is
**dependency order only**: nothing here is an estimate, a schedule or a slice, and how many parts one
change carries is a separate decision taken when the work is planned.

**Deleted by the change that finishes the last part**, and the "not yet built" marker at the top of
the spec comes off in the same change that makes each section true — not later
([docs/README.md](../README.md)).

One constraint governs the order and is the reason the first part is first:

> **Every project-supplied command in this design is a live shell command against a real environment.
> No part of this may be testable only by running one. The fake comes first.**

`at`, `browser.runner`, `browser.listSelectors`, `browser.publishArtefacts`, `state.run`,
`ensureTenant`, `reseed` — a test that reaches any of them for real provisions a tenant, drives a
browser against somebody's acceptance environment, or queries a deployed store, **and passes while
doing it**. That is the `FakeUpstreamIssues` failure, and it is why no part below is acceptable
without its scripted fake in the same change.

---

## Part 1 — The seams and their scripted fakes

Three new seams beside the two that exist, each an interface with a command implementation and a
scripted fake, injected at `buildSystem`.

| Seam                                                  | Implementations                            | Covers                                        |
| ----------------------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| `RemoteRunner` — _src/remoteValidation/runner.ts_     | `CommandRemoteRunner` · `FakeRemoteRunner` | `runner`, `listSelectors`, `publishArtefacts` |
| `StateReader` — _src/remoteValidation/stateReader.ts_ | `CommandStateReader` · `FakeStateReader`   | `state.run`                                   |
| `TenantKeeper` — _src/remoteValidation/tenants.ts_    | `CommandTenantKeeper` · `FakeTenantKeeper` | `ensureTenant`, `reseed`                      |

`EnvironmentProber` and `EnvironmentObserver` are reused unchanged, with their existing fakes.

**Acceptance**

- Three new `buildSystem` opts keys — `remoteRunner`, `stateReader`, `tenants` — threaded through
  `src/system.ts`, the composition root, and defaulting to the command implementations.
- `CommandStateReader` parses through the **same** `src/environments/watchResult.ts` the observer
  uses: the id echo, the rows-never-counts refusal and the `presence` reading are one implementation,
  not two. A copied parser is a rejected change.
- Every command is spawned with the query and the parameters in the **spawn env only** — a test
  asserts the query never appears in the command string.
- `remoteValidation.runTimeoutMs` (default 30 minutes) kills a run; every other command keeps the
  30-second kill, and the kill answers nothing.
- A test with each fake injected drives every method and asserts **no process is spawned** — the fake
  records what it was asked for and the assertion is on that record.
- `test/remoteValidationSeams.test.ts` is the module; the fakes live beside the other scripted fakes
  and are exported for later parts.

---

## Part 2 — Configuration, and the refusals

The `validate` block on an environment, the one new top-level key, and the policy that refuses a block
that cannot mean what it says.

**Acceptance**

- `environments[].validate` parses: `permits`, `tenant` | `tenantEnv` | `ensureTenant`, `reseed`,
  `tenantFreshnessMs`, `browser: {runner, listSelectors, profile, publishArtefacts}`,
  `state: {run}`. `environments` stays `fileOnly` in `CONFIG_FIELDS`.
- New top-level key **`remoteValidation`** — `{runTimeoutMs}` — and it is **claimed by the `Features`
  group in `src/server/runningConfig.ts`**. An unclaimed key validates, applies, and is drawn nowhere;
  a test asserts `groupedTopLevelKeys()` holds it.
- `validateEnvironments` refuses, each with its own sentence: an empty `permits`; `check` permitted
  with no `browser`; `state` permitted with no `state.run`; a `browser` with a `runner` and no
  `listSelectors`; more than one of `tenant`/`tenantEnv`/`ensureTenant`; a `reseed` or
  `tenantFreshnessMs` with no tenant of any shape; an empty command anywhere in the block.
- **No secret is a config key.** `tenantEnv` names an env var; the value reaches the spawn env and
  never the prompt, the cockpit or a project layer. Asserted.
- A test builds its config with `loadConfig`, never `loadDeploymentConfig`, and points
  `projectConfigFile` or `repoRoot` at a temp directory.

---

## Part 3 — Persistence

One new store module and three columns on existing tables.

**New module — _src/store/remoteValidation.ts_**, taking a `StoreContext`, delegated to from
`src/store/store.ts` under the same method names, and the only place these tables are touched:

| Table                    | Key                           | Written                                                          |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------- |
| `remote_sheets`          | `(goal_ref, environment)`     | `OR IGNORE`                                                      |
| `remote_sheet_rows`      | `(sheet, row_id)`             | `OR REPLACE`; `selected`, `blocked_reason` in place              |
| `remote_runs`            | run id                        | conditional insert, unique on `(environment, tenant)` while live |
| `remote_readings`        | `(run, row_id)`               | append-only                                                      |
| `remote_state_queries`   | `(goal_ref, query_id)`        | `OR REPLACE`, merge key is the slug                              |
| `remote_query_approvals` | `(query_digest, environment)` | `OR REPLACE`                                                     |
| `remote_tenants`         | `(environment, tenant)`       | `OR REPLACE`                                                     |

**Columns on existing tables**, each an additive `ALTER TABLE` guarded by `PRAGMA table_info` and
declared in the owning module's `ColumnMigrations`:

| Column                     | Module                      | Null means                                        | Backfill |
| -------------------------- | --------------------------- | ------------------------------------------------- | -------- |
| `validation_checks.area`   | `src/store/validation.ts`   | no area declared — true of every older row        | none     |
| `plan_parts.coverage`      | `src/store/plans.ts`        | not a test part — true of every older row         | none     |
| `goal_arrivals.sheeted_at` | `src/store/environments.ts` | not considered yet — the freshness guard reads it | none     |

**Acceptance**

- All seven new tables declare a `ColumnMigrations` block, **empty or not**. A table being new once
  does not keep it exempt.
- The three existing-table columns have real `ColumnMigrations` entries. A test opens a database
  written **without** them, boots, and asserts each column is present and readable — without the entry
  every check is unautomatable and every sheet all-manual, on exactly the deployments with a history,
  and nothing is red.
- **No backfill is written**, and the reason for each is in the spec rather than in a comment. A test
  asserts an upgraded database assembles **no** sheet for an arrival that predates the column.
- `remote_runs` rows are kept after they end; a test asserts an abandoned run's reason is readable
  afterwards.
- `beginRemoteRun` does its mutual exclusion **inside the transaction**, `beginLocalRun`'s shape. A
  test presses twice concurrently on one `(environment, tenant)` and gets one run.
- No `runOnce` id is introduced; if one is, it is never edited in place afterwards.

---

## Part 4 — `state` queries, and their three writers

The query kind the watch does not have, on the watch's own arrangement.

**Acceptance**

- `StateSchema` (_src/validation/stateDocument.ts_) parses an optional `state` block on the plan
  document beside `validation` and `watch`, and refuses **exactly** what a watch check is refused —
  through the shared `aggregatingTail`, not a second copy: an aggregating query is refused at
  ingestion, a query with no `presence` is refused, and both transports refuse the same documents.
- **`state_declare`** — _src/mcp/tools/stateDeclare.ts_ — added to `MCP_TOOL_NAMES` and `buildTools`,
  classified `point-of-use`, merging on the slug, adding and amending and **withdrawing nothing**.
- Its origin fence is the **wide** kind, `validation_amend`'s: the whole-issue agent, a part agent and
  the assessor may call it; **the planner is refused by name** and pointed at the document block. The
  origin comes off the credential, so an agent working goal A cannot declare on goal B.
- Operator writer: `PUT`/`DELETE /api/issues/:number/state-queries/:queryId`, `watch/checks/:checkId`'s
  shape — including `authored: 'operator'`, which a replan does not touch.
- The instruction naming the tool is **appended** to the two prompts that dispatch work as a rendered
  string, `watchDeclareNote`'s arrangement — never interpolated, and never imported into
  `src/dispatcher/`.
- A test asserts a declared query is never written to any file: the store is the only writer, and
  nothing puts one in a worktree.

---

## Part 5 — The dry run, and approval per environment

**Acceptance**

- Declaring or editing a query runs the dry run **in the same call** and stores the reading beside the
  query: the query text, what it returned, and the `presence` reading.
- Accepting writes `remote_query_approvals` on **`(query digest, environment)`**. A test asserts a
  query accepted against one environment is **still unapproved** on another — the leak the key exists
  to stop.
- Editing a query clears the approval **everywhere**; a re-declaration word for word does not.
- An unapproved query is **`blocked`, never run and never `failed`**, and the row says what it waits
  for. Asserted for `state`, and for a live watch check whose digest has not been accepted against
  that environment.
- `presence` is approved on the same terms as the query it belongs to.

---

## Part 6 — Sheet assembly, and the desk

`RemoteValidationDesk` (_src/remoteValidation/desk.ts_), run from the pulse.

**Acceptance**

- **Position asserted**: below `EnvironmentDesk`'s arrival pass, above `ValidationReadyDesk`, which
  stays above `DeliveryCloseOutDesk`. The assertion is the invariant; a reordering elsewhere must fail
  a test rather than be silent.
- A sheet is assembled per `(goal, environment)` on an arrival, `OR IGNORE` — **a second arrival
  re-runs the sheet that exists**, and a sheet never expires. Asserted in both directions.
- Rows are assembled from the goal's live validation checks, its live watch checks, and its `state`
  queries. A row of a kind the environment does not `permit` is `blocked`.
- **Freshness guard**: a sheet is assembled only for an arrival confirmed within two probe intervals,
  and **every arrival is stamped `sheeted_at` either way**. An arrival on a deployment where no
  environment declares a `validate` block is left **unstamped** — asserted, because stamping it burns
  the guard that makes turning the feature on next month safe.
- **Cap of five sheets per pulse**, oldest arrival first, deferring rather than dropping.
- The desk is the one owner of every sheet write. A pass that throws goes through `errors.record` and
  never fails the cycle; **no swallowed `catch`**.
- Nothing under `src/dispatcher/` imports _src/remoteValidation/_ or `src/environments/` — asserted
  structurally with the existing lens assertions.

---

## Part 7 — The deterministic rows, and the pre-flight

**Acceptance**

- On assembly, every **approved** `state`, `signal` and `measure` row runs and its reading lands on the
  sheet. Nothing browser-shaped runs.
- The pre-flight asks `listSelectors` and compares the offering against what the `check` rows' `area`
  names. Mismatches are on the sheet **before** any press.
- The **matched** count for the later consistency check comes from the pre-flight listing, not from
  the post-run report.
- A `state` row on a machine that cannot reach the store is `blocked` while every other row on the
  same sheet still reports — **`blocked` per row, never per run**. Asserted.
- An observation that fails, times out, or answers without the id echo is `blocked`, never a reading.
- **No reading is written into `watch_readings`, and none is a `WorldEvent`** — asserted against the
  world's own list.

---

## Part 8 — Tenants

**Acceptance**

- The three shapes resolve: a literal `tenant`, a `tenantEnv` read from the environment, and an
  `ensureTenant` command that is **operator-invoked and never run per arrival**.
- **The harness generates or infers no tenant identifier anywhere** — asserted by a test that
  configures no tenant and gets `blocked` rows naming the missing configuration, never an invented
  name.
- A missing tenant produces a legible `blocked` naming the command that would provide one.
- `reseed` stamps `remote_tenants`; the tenant's age against `tenantFreshnessMs` is on the sheet.
- **Staleness is a qualifier on the reading and never a fourth outcome** — asserted on the outcome
  vocabulary, which stays `passed` | `failed` | `blocked`.

---

## Part 9 — The press, the pin and run uniqueness

**Acceptance**

- `POST /api/issues/:number/remote-validation/:environment/run` — 409 while a run is live for that
  `(environment, tenant)`, naming it; 400 with nothing selected; **runs a cycle**, and is the only
  route here that does.
- The pin asks `GitObserver.contains(landings, [deployedSha])` where `deployedSha` comes from `at`
  **now**. Three arms asserted: reached → the run opens; not reached → abandoned with a reason;
  `unknown` → abandoned with a reason, **never folded into either**.
- An environment that has moved **forward** still runs; a rollback abandons. Asserted as a pair.
- An abandoned press writes no readings at all.
- `.../cancel` settles an open run `abandoned`; `.../rows/:rowId` selects and deselects;
  `.../reseed` invokes the command and stamps.
- Every handler is wrapped in `checked(schemas, handler)`; a refusal is a **returned value and a 400**,
  never a throw. The routes live in _src/server/routes/remoteValidation.ts_ with a `ROUTE_MODULES`
  entry — `app.ts` stays wiring only.
- **Waiving is not a route here**: a test asserts the sheet's retire path is
  `POST /api/issues/:number/validation/:checkId/waive`, reason required, and that it counts as clear at
  close-out while a **deferred** check does not.

---

## Part 10 — The dispatch, the origin, the prompt and the report tool

**Acceptance**

- Rule **`remote-validation`** — an entry in `RULES` (`src/dispatcher/rules.ts`) and a module
  _src/dispatcher/rules/remoteValidation.ts_ registered in `STAGES`
  (`src/dispatcher/ruleDispatcher.ts`). It routes through the **candidate list**: an inline `raw.push`
  of a `dispatch_*` action bypasses the headroom cut and the Up next queue, and a test asserts a
  capped run queues as `waiting` rather than vanishing.
- **`DISPATCH_PIPELINE` position: immediately below `validate-check`, above `validation-failed`** —
  asserted by index, both neighbours named.
- Origin **`issue:<n>:validate-remote:<runId>`**, lease `validate-remote/issue/<n>/<runId>`, a
  read-only checkout **pinned to the deployed commit** and no ref minted.
- **`src/issueOrigins.ts`**: `'validate-remote:'` added to `EVIDENCE_SUFFIX_PREFIXES`. A test asserts
  `issueOriginRole` answers `evidence` and **not `unrecognised`** — unrecognised stops the origin
  expanding under a goal's priority flag and files its spend under "other", and neither is red.
- New `PromptId` **`remote-validation`** in `src/dispatcher/promptTemplates.ts`, with a copy under
  _docs/prompt-templates/remote-validation.md_. Everything the agent must read is **appended**, never
  interpolated; a test asserts an operator override that never learned the new material still receives
  it.
- **`remote_validation_report`** — _src/mcp/tools/remoteValidationReport.ts_, in `MCP_TOOL_NAMES` and
  `buildTools`, classified `point-of-use` and named **only** in the `remote-validation` prompt's tool
  section.
- **It has no field an agent could state an outcome in** — asserted on the advertised schema, which is
  derived rather than written. It takes `reportPath`, `artefacts`, or a `handback` reason.
- **Narrow origin fence**: `remoteValidationOriginParts` parses `:validate-remote:` alone; every other
  caller is refused **by name**, and the `validation-failed` agent is refused **structurally**, by the
  parse. Asserted, including that the run's own agent is refused `validation_report`.
- Neither new tool name reaches the desktop channel (`DESKTOP_TOOL_NAMES`), and once shipped neither
  name is ever deleted — a withdrawn one goes to `RETIRED_TOOL_NAMES`.

---

## Part 11 — Folding the report into readings

The part where the runner contract becomes true rather than aspirational.

**Acceptance**

- **The report is the only source of row outcomes and the exit code is never read** — asserted with a
  fake that exits non-zero on a report full of passes, and zero on a report full of failures.
- Zero matched → `blocked`. Fewer executed than matched → `blocked`. Skipped-by-failed-dependency →
  `blocked`, not `failed`. A retried pass → `passed`, with the retry recorded.
- **The environment-moved asymmetry**: `at` is read at the start and the end of the run; on a change,
  a failed row is `blocked` and a passed row is still `passed`, and both record the commits they
  straddled. **Asserted in both directions.**
- Each browser row records wall-clock, matched, executed, retries and the artefact URL from
  `publishArtefacts`.
- A `handback` writes no readings and leaves every row as it was.
- Readings are attributed to `started_sha`/`ended_sha` and **superseded rather than deleted** by a
  later run.

---

## Part 12 — What a reading writes, and what it must never write

**Acceptance**

- `resultBy` gains **`spec`**. No migration: the column exists and only gains a value it may hold, and
  `rowToCheck` narrows an unrecognised value to attributed-to-nobody.
- A run writes on a check row **only** where the current reading is `unrun` or was itself a `spec`
  reading. A reading taken by an operator, an agent or a desktop session is **not** overwritten — the
  sheet still carries the row and says whose reading it is not replacing. Asserted in both directions.
- A `blocked` row writes nothing on the check at all.
- A `failed` row flows into rule `validation-failed` unchanged, each reading keeping its own attempt
  budget.
- **A failed row is never recorded as a shortfall**, and the sheet writes **no issue verdict at all** —
  asserted: the goal stays delivered and parked, the close-out obligation stays open, and the validate
  bench row is not declined. Any verdict a later change wants goes through
  `IssueVerdictStore.recordVerdict` and `VERDICT_EXCLUSIONS`, never a hand-rolled `DELETE`.

---

## Part 13 — Saying so on the bench

**Acceptance**

- The existing `validate` human task is the gate's obligation; **no second bench kind is added**. Its
  detail, refreshed every pulse by `ValidationReadyDesk`, carries what the sheet says: readings in
  hand, selector mismatches, tenant age, and what is waiting on an approval.
- The row is filed where a press is outstanding, because a press is a person's act.
- `DeliveryCloseOutDesk` stays below it — the bench asks for one thing at a time, asserted.
- Nothing here holds a dispatch, a merge, a conclusion or a close.

---

## Part 14 — The cockpit

**Acceptance**

- Wire types `RemoteSheetView`, `RemoteSheetRowView`, `RemoteReadingView` in `src/wire.ts`, shipped on
  `CockpitState.remoteSheets` and re-exported by `web/src/types.ts`. Each **is** a domain type from
  `src/types.ts` or `extends` one — never a re-declaration, never widened — and `src/wire.ts` stays the
  only server module `web/src/` names.
- A `remoteValidation` card in `GOAL_SECTIONS`, between `localValidation` and `signals`, drawing one
  block per environment with a sheet: tenant and age, deployed commit, every row with its outcome and
  reason, artefact links, matched/executed/retries/wall-clock, selector mismatches, and the gate's four
  controls.
- The Environments card's row gains one folded line, **folded on the server** off the same rows.
- **Which environment's sheet is a field on `Place`** (`web/src/cockpit/place.ts`), never a `useState`
  in `useCockpit` — asserted on the back button and reload.
- Every reference is `<Ref to={ref}/>`, and never inside a button.
- **No colour is a literal**: every tone is a `--cn-*` property on both `:root` blocks and registered
  in `web/src/cockpit/tokens.ts`, asserted by `test/cockpitTheme.test.ts`.
- `blocked` and `unknown` say **why in words**, never in a clean reading's vocabulary.
- Both typecheckers pass — `typecheck` and `typecheck:web` are separate passes.

---

## Part 15 — The test part in the plan

Independent of parts 4–14 in everything but the `plan_parts.coverage` column from part 3; ordered last
because nothing else needs it and because it is the part an operator feels.

**Acceptance**

- A plan part parses an optional **`coverage`** naming the area it adds or amends coverage for. It is
  an ordinary `code` part in every other respect: it merges, it has per-part `acceptance`, and
  `partSettled` answers for it unchanged.
- **A declared test part holds the goal exactly as any other part does** — asserted: the goal is not
  delivered while it is unbuilt, and there is no soft hold.
- The planner is told the bar, appended to `issue-plan` and `issue-replan` as a rendered string
  **only where some environment declares a `validate.browser` block**. Asserted in both directions: a
  deployment with no browser block never sees the note and can declare no test part.
- The note states the allow-list rule — **the critical path is an allow-list, never a deny-list** — and
  that a spec copied from a neighbour must not inherit its critical tag.
- **A replan declares a new part to amend a merged one** and never retracts it. Asserted.
- An operator can strike a declared test part at plan approval through the existing gate; nothing new
  is added for it.

---

## Part 16 — Closing the documentation out

**Acceptance**

- The "not yet built" marker comes off each section of
  [36 — Remote validation](../spec/36-remote-validation.md) **in the change that makes it true**, and
  every italic path that now exists is backticked — `test/docsReferences.test.ts` asserts the
  backticked half.
- The edits this feature forces on [20](../spec/20-validation.md),
  [24](../spec/24-environments.md), [29](../spec/29-post-deploy-watch.md) and
  [32](../spec/32-local-validation.md) are already in the tree from this change and are corrected
  where a part landed differently from what was written.
- `docs/README.md` indexes 36, and the "no build plan open" line is accurate again.
- The **sharp edges that fail silently** are added to `CLAUDE.md` as the code that makes them true
  lands, and not before — a stale line there is a false instruction handed to every agent on every
  dispatch. The candidates, each with its spec link: the fake-first rule for the seven project
  commands; `blocked` per row rather than per run; the report being the only source of outcomes; the
  environment-moved asymmetry; the desk's position in the pulse; a reading never being a `WorldEvent`
  or a `watch_readings` row; and a run never overwriting a person's reading.
- **This file is deleted by that change.**
