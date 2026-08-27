# Build plan — the post-deploy watch

The implementation plan for [29 — The post-deploy watch](../spec/29-post-deploy-watch.md). The spec
describes the behaviour and argues it; this describes the order it gets built in and what each stage
is done when.

**This file is deleted by the change that finishes the last stage.** A build plan outlives its
usefulness the moment the code lands, and a stale one beside a spec is a second document describing
the application — the thing `docs/README.md` refuses for design documents, for the same reason. Until
then it is the working record: stages are ticked here, and the spec's own **Not built** markers come
off section by section as each becomes true.

## Order, and why this order

Four stages. Each is independently useful, ships on its own, and leaves the tree green — the fleet
can be pointed at any of them and stop.

| Stage | Ships                                         | Useful alone because                                                                                 |
| ----- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1 ✅  | The seam, signals, presence, the dry run      | "Did the new thing throw" is most of the value and needs no baseline                                 |
| 2 ✅  | The window, readings, verdicts, the goal page | The first stage a watch actually runs; stage 1 only ever dry-runs                                    |
| 3 ✅  | Measures and baselines                        | The optimisation case, which is the one that needs a before                                          |
| 4     | The bench row, bug filing, `holds`, extend    | Turns a reading into work; deliberately last, since it is the only arm that touches other subsystems |

Stage 2 is the one to resist splitting further. A watch that opens and never reads is a table nobody
can see, and a reading with no verdict is a number with no rule — the three together are the smallest
thing that is true.

## Stage 1 — the seam and the declaration ✅

**Done when** a planner can declare a signal, the harness dry-runs it against the environment on
submission, and the plan sheet draws the reading. Nothing opens, nothing repeats.

**Shipped.** Every bullet below landed, minus the one prompt addition noted under _What stage 1
decided_. The spec's **Not built** marker is narrowed to the sections stage 1 did not make true.

### Config and policy

- `src/environments/policy.ts` — `EnvironmentWatch` on `EnvironmentConfig`: `observe`, optional
  `schema`, `describe`, `forMs` (see below), `holds`. Extend `validateEnvironments` with the three refusals the
  spec names (empty `observe`, unknown `holds`, `describe` without `observe`).
- `src/config.ts` / `src/configFields.ts` — `watchIntervalMs`, default `1_800_000`. `environments`
  stays `fileOnly`; nothing new becomes operator-editable.
- `docs/spec/02-configuration.md` — the new keys, in the same change.

### The seam

- `src/environments/observer.ts` — `EnvironmentObserver` and `CommandEnvironmentObserver`, modelled
  line for line on `prober.ts`: shell, `repoRoot`, 30s kill, failure detail from the first stderr
  line.
  - Passes `LUBBDUBB_ENVIRONMENT`, `LUBBDUBB_WATCH_ID`, `LUBBDUBB_WATCH_QUERY`.
  - Appends the id projection to the query before handing it over, and **rejects a result that does
    not carry the id back**. This is the whole of the stale-wrapper guard and belongs here, not in a
    caller.
- `src/environments/fakeObserver.ts` — scripted fake, beside `fakeProber.ts`. Extending the seam
  means extending the fake in the same change.
- `src/environments/watchResult.ts` — the pure parse of a result into `{rows, value, verdict,
detail}` against the output contract. Pure, so the contract's edges (two rows for a measure, a
  non-numeric `value`, no echo) are unit tests and not integration ones.

### The declaration

- `src/validation/watchDocument.ts` — the zod schemas, exported for the same reason
  `ValidationCheckSchema` is: `watch_declare` must refuse exactly what a plan document refuses, and a
  second copy would drift on the day one of them learned a field.
- `src/plans/planDocument.ts` — `watch: WatchSchema.optional()`, sibling to `validation`. Optional,
  for the reason every post-v1 field is.
- `src/plans/planIngest.ts` — ingest the block, assign nothing positional (the slug is the merge key,
  as with checks).
- `src/store/watches.ts` + `src/store/store.ts` — `goal_watches` only, at this stage.

### The dry run

- `src/environments/watchDryRun.ts` — run each declared check once on submission and on amendment,
  store the reading, and hand a failure back to the author as a refusal.
- Wire through `src/system.ts`, which every component is threaded through.

### Prompts

- `src/plans/planning.ts` prompt additions — **appended** to the rendered prompt, never interpolated
  into it. An override that never learned a `{watch}` token would drop it silently, on exactly the
  deployments that customised most. No `docs/prompt-templates/` copy: the note is appended beside a
  rendered template rather than being one, exactly as `relatedWorkNote` is.
- The instruction that matters is the one aimed at the working agent: _if you added a log line or a
  metric for this, declare the watch that reads it._ Deferred to stage 3 with `watch_declare` — see
  below.

### Tests

`test/watchResult.test.ts` and `test/watchDryRun.test.ts` (the document schema is exercised from the latter rather than in a third file — its refusals are three assertions, not a suite). The dry-run
test injects `FakeEnvironmentObserver`; nothing touches a network.

### What stage 1 decided

The plan left these open; each was settled in the building and is recorded here so the next stage
does not re-litigate it.

- **`for` is spelled `forMs`, on the environment's `watch`.** The harness's other durations carry the
  suffix, and an unsuffixed one is the unit ambiguity the convention exists to remove. Validated but
  unread — stage 2 is its first reader. The plan document's own per-goal `for` is stage 2's, since
  stage 1 opens no window to size.
- **The dry run is put to one environment — the first declaring an `observe`.** It answers "does this
  query parse and resolve", which is a property of the query; asking every environment would spawn a
  process per environment per check on every submission to learn it several times. Where the answer
  legitimately differs per environment is what `presence` is for, at watch time.
- **The id echo is checked per row, and an empty result carries none.** Not a hole: zero rows is the
  answer a signal is not trusted on alone, and the `presence` read — which is not permitted to come
  back empty — is where a stale wrapper is caught.
- **The projection is a pipeline segment** (`| extend lubbdubbWatchId = "<id>"`). It is the one place
  the harness has an opinion about a query language, and it is escapable: an operator can echo
  `LUBBDUBB_WATCH_ID` from the wrapper instead. Interpolating the id is safe where interpolating the
  query is not — the id is a kebab-case slug the schema enforces.
- **The output contract is a JSON array of row objects on stdout.**
- **A check an amendment stopped declaring is deleted**, not superseded: at this stage the row carries
  only its declaration and the dry run of it, both replaced. → open question 4.
- **The working agent's prompt instruction was not added.** It names `watch_declare`, which is stage 3;
  an instruction pointing at a tool that does not exist is worse than none. The planner's guidance did
  land, appended (`watchNote`, `src/plans/planning.ts`) and threaded to the rule as a rendered string
  so `src/dispatcher/` still imports nothing from `src/environments/`.
- **`measures` is refused by the schema** rather than accepted and ignored, though `watchResult.ts`
  already parses a measure's row — the shape it refuses is the shape a stale wrapper produces.
- **The lens boundary is asserted** in `test/watchDryRun.test.ts`; the spec claimed a structural
  assertion covered `src/environments/` and none existed.

## Stage 2 — the window, the readings, the card ✅

**Done when** an arrival opens a watch, it reads on `watchIntervalMs`, it settles at `for`, and the
goal page draws every check with its verdict.

**Shipped.** Every bullet below landed. The spec's **Not built** marker is narrowed to what stages 3
and 4 still own.

- `src/store/watches.ts` — `watch_windows`, `watch_readings`. `settled_at` null means still watching;
  noted in `docs/spec/14-persistence.md` under the nulls that mean something.
- `src/store/environments.ts` — `ENVIRONMENT_COLUMNS`, the module's **first** `ColumnMigrations`
  entry, for `goal_arrivals.watched_at`; registered in `src/store/store.ts`.
- `src/environments/watchDesk.ts` — a fifth pass on `EnvironmentDesk`, **below** the arrival pass,
  since a window opens on an arrival the pass above records. Cap per pulse, oldest window first.
- `src/environments/watchWindow.ts` — pure: which arrivals open a window (two-probe-interval
  freshness, stamped either way), which windows are due a reading, which settle.
- `src/environments/watchVerdict.ts` — pure fold to the three verdicts. `unknown` never folds to
  `clean`; no roll-up to a single word.
- `src/wire.ts` → `web/src/types.ts`, `src/server/stateSnapshot.ts` — `GoalWatchView` beside
  `GoalReachView`. A wire type **is** a domain type or extends it, never a re-declaration.
- `web/src/console/GoalPage.tsx` + `web/src/console/console.css` — the watch block inside the
  environment row. Every colour a `--cn-*` token; a literal is a colour no theme can reach.
- `web/src/view/goalPage.ts` — fold the reading into the track strip's Environments stage, off the
  card rather than computed again.

### The two traps to write tests for first

- **The freshness guard.** Without it the first pulse after this ships opens a window on every goal
  that ever arrived. Test: an arrival three intervals old opens nothing and is stamped.
- **`unknown` on the glass.** Test the presence-zero case end to end, because it is the one that
  reads as success.

### Tests

`test/watchWindow.test.ts`, `test/watchVerdict.test.ts`, `test/watchDesk.test.ts` at the
`buildSystem` seam with `dbPath: ':memory:'`.

### What stage 2 decided

- **`forMs` stays on the environment, and there is no per-goal `for`.** Stage 2 is its first reader,
  and the plan document's own per-goal `for` was considered and left out: what the length of a window
  is really about is the release cadence and traffic pattern of a deployment, which the operator knows
  and a planner drafting a document does not. A second place to answer the same question, answered
  worse by the party with less information, is not an improvement. Default 48 hours, in
  `watchWindow.ts`. The window is sized from the **arrival**, not from the pulse that noticed it, so a
  probe pass that ran long does not extend a watch by its own delay.
- **`watchIntervalMs` is read per window, off that window's own newest reading**, rather than against
  a shared clock — so a window opened mid-interval is read on its own schedule and a backlog that
  defers past the cap keeps its place.
- **The per-pulse cap is 20 windows**, deliberately smaller than `MAX_LANDINGS_PER_PULSE`: what it
  bounds is a process spawn per open check against the operator's telemetry, not an argument list.
  Deferring, oldest window first.
- **Three things open a window**, and each is a different kind of no: the environment declares an
  `observe`, the goal declares at least one check, and the arrival is fresh. A goal that declares its
  first check *after* it arrived is not watched there — the declaration is what the operator approved,
  and approving it after the deploy is approving it for the next one.
- **The stamp is spent only where the feature is on.** An arrival on a deployment where no environment
  declares a `watch` is left unstamped; stamping it would burn the one guard that makes turning the
  feature on next month safe.
- **The pass order inside the desk is open → settle → read.** Settling before the readings is what
  stops a window that ran out between two pulses collecting one more reading past its own end.
- **The whole window is read at once**, not check by check on separate clocks: one `last read` per
  window is the reading an operator is shown, and staggered per-check clocks would make the card a
  set of answers taken at different times.
- **Open question 3 — retention for `watch_readings` — is settled as: nothing prunes a window.** A
  settled window's readings are the evidence behind a verdict that is now permanent, and the spec's
  "pruned with its window" was a rule with nothing to trigger it. What bounds the table is `for` over
  `watchIntervalMs` — 96 rows per check per environment on the defaults — so it grows with the
  fleet's work rather than with time. Stated in the spec under *Closing* and *Persistence*.
- **Open question 4 — whether a dropped check stays droppable — is settled as: it is deleted, and it
  takes its readings with it**, in the same transaction as the row. Superseding was the alternative
  and is the wrong shape here: it would keep a check nobody declares in the plan sheet, the goal page
  and the desk's own read loop, each needing its own retired-row filter, to preserve evidence for a
  question that is no longer being asked. Deleting *both* is what makes the delete safe — the hazard
  the question names is a verdict standing with nothing behind it, and pruning the readings with the
  check leaves neither. `WatchStore.ingestGoalWatch` does both, and `test/watchDesk.test.ts` holds it.

## Stage 3 — measures and baselines ✅

**Done when** a measure declared `noWorseThan: "baseline"` captures its reading at declaration and
the card draws expected / before / now.

**Shipped.** Every bullet below landed. The spec's **Not built** marker is narrowed to what stage 4
still owns — the bench row, the bug, `holds`, `extend`, and the Needs-you rail that carries them.

- `src/validation/watchDocument.ts` — `measures`, `expect` (`under` / `over` / `noWorseThan`), `unit`;
  a measure with neither threshold nor baseline refused at ingestion. `watchSignalInputs` became
  `watchCheckInputs`, one function over both kinds, because the store holds one table.
- `src/store/watches.ts` — `WATCH_COLUMNS`, the module's **first** `ColumnMigrations` entries, on two
  tables that were new one change earlier; registered in `src/store/store.ts`.
- `src/environments/watchDryRun.ts` — the baseline, stored rather than discarded. The same call.
- `src/environments/watchVerdict.ts` — the measure arm, beside the signal's rather than over it.
- `src/mcp/tools/watchDeclare.ts` + `MCP_TOOL_NAMES` + `TOOL_NAMING`, with the grants derived from
  the names as they already were; `test/mcpChannel.test.ts` holds all three against each other.
- `src/plans/planning.ts` — `watchDeclareNote`, appended by `plan-part` and `issue-pickup`, threaded
  as a rendered string so `src/dispatcher/` still imports nothing from `src/environments/`.
- `src/server/routes/watches.ts` — the operator's ruling, plus the dry run an acceptance runs.
- `web/src/components/WatchDigest.tsx`, `web/src/console/GoalPage.tsx` — the pending change with
  accept and decline, and a measure's expected / before / now.

### What stage 3 decided

- **Open question 1 — where the pending-amendment state lives — is settled as: two columns on
  `goal_watches`** (`live`, and `proposal` holding the declaration as JSON), not the existing
  plan-amendment path. The second was less to build and is the wrong shape: a replan is the transport
  that speaks for the *whole* block, so routing one agent's single-check declaration through it would
  put the goal's plan back into `awaiting_approval` — holding the goal's own work, at conclude time,
  to carry a sentence about telemetry. The duplication the question worried about turned out to be
  small, because the ruling is one route and one store method rather than a workflow: nothing here
  has a verdict history, a proposal row or an inbox item.
- **A proposal-only row is `live=0` with its declaration in the ordinary columns**, so accepting is a
  flag rather than a second write of the same text — and `listGoalWatches` is **live-only**, which is
  the guard rather than a filter: every reader that puts a query to an environment goes through it,
  and the plan sheet reaches the pending rows through `listProposedGoalWatches`.
- **A replan's drop sweep skips proposal-only rows.** They were never part of the document, so a
  planner neither adopts nor discards them — a decision taken off an operator without their seeing it
  is what the approval exists to prevent. A pending amendment *to* a check the document re-declares
  goes with the re-declaration, because it amended text that no longer stands.
- **`noWorseThan: "baseline"` is read lower-is-better**, and a measure whose good news is a bigger
  number declares an `over`. One rule rather than a per-measure direction field, which would be a
  second thing to get wrong about a comparison the thresholds already express.
- **A measure declares no `presence`**, and the fold reads that null rather than inferring it from
  the kind. Presence exists because zero rows is indistinguishable from a healthy release; a measure
  that answers no row is already `unknown` under the output contract.
- **The reading's `value` is taken off the observation, not out of the fold.** The fold's job is the
  ruling; a number that only existed inside it could not be drawn beside the before, which is the
  half the card is worth looking at for. `watchCheckVerdict`'s return shape is unchanged, so a
  signal's verdict did not move.
- **An absolute threshold needs no baseline.** A threshold-only measure is never held `unknown` for
  want of a before it never declared — that is the right shape for new behaviour, which has none.
- **`watch_declare` withdraws nothing.** It adds and amends, merge-only, on `validation_amend`'s
  terms: an agent holding one part's diff knows about one check and nothing about the others, and a
  withdrawal from it would need a pending-delete state to be honest about. A check that should go is
  the operator's to delete or a planner's to stop declaring.
- **Accepting runs the dry run in the same call**, which is what takes a measure's baseline. Skipping
  it would leave the one declaration nobody reviewed as the one nobody proved resolves. Declining
  asks nothing — putting a declined query to an environment would be the approval running the query
  it exists to gate.
- **The plan sheet's anchor rail was left alone.** The watch section sits under Validation on the one
  scroll the sheet already is; a seventh jump target is stage 4's to add if the Needs-you rail wants
  a way in.

## Stage 4 — what a finding does

**Done when** a settled-regressed watch files one bench row, and the operator can raise a bug from
the reading.

- `src/delivery/closeOut.ts` — carry the watch state in the close-out's detail. Reporting, not
  gating.
- The `human_tasks` arm, through the existing filing path — one row per window, never one per
  reading, and it wears the `DESK_SETTLED` marker like its siblings.
- `POST /api/issues/:number/watch/:environment/extend` — a new route in the module that owns the
  group, `checked(schemas, handler)`, never reading the request itself.
- The bug-filing control, reusing `src/bugFiling.ts`: the reading rides as the operator's own report,
  and the relation is a field on `IssueCreateInput` and not a sentence in a prompt.
- `holds: ["close_out"]`, off by default.

## What must not drift while this is built

Each of these is silent if it goes wrong, which is why they are listed rather than left to review.

- **No import of `src/environments/` from `src/dispatcher/`.** The existing structural assertions
  cover the directory; do not add an exemption.
- **No `WorldEvent` for a reading.** It would expire the goal's delivery hold and re-dispatch
  finished work. Own table, own wire list, merged at the feed's door.
- **No model in the reading loop.** If a stage seems to want one, the expectation was
  under-declared — fix the declaration, not the verdict.
- **The id echo is verified, always.** It is the only thing standing between a stale wrapper script
  and a confidently wrong answer.
- **Two typecheckers.** Stage 2 spans `src/` and `web/`; `typecheck` and `typecheck:web` are separate
  passes.
- **knip runs every rule at `error`.** A helper exported before its caller exists turns `check` red;
  drop the `export` rather than the code.

## Open questions

Worth settling before the stage that hits them, not during.

1. ~~**Where the pending-amendment state lives**~~ — **answered in stage 3**: two columns on
   `goal_watches`, not the plan-amendment path, which would hold a goal's own work to carry one
   query. See *What stage 3 decided*.
2. **Whether `extend` re-opens a settled window or opens a second one** (stage 4). A second window is
   truer to "a watch is a record of a period" and makes the card longer.
3. ~~**Retention for `watch_readings`**~~ — **answered in stage 2**: nothing prunes a window, and the
   bound is `for` over `watchIntervalMs` rather than a retention rule. See *What stage 2 decided*.
4. ~~**Whether a dropped check stays droppable**~~ — **answered in stage 2**: it is deleted, and its
   readings are deleted with it in the same transaction. See *What stage 2 decided*.
