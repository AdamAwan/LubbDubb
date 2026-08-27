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

| Stage | Ships                                            | Useful alone because                                                      |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| 1     | The seam, signals, presence, the dry run         | "Did the new thing throw" is most of the value and needs no baseline      |
| 2     | The window, readings, verdicts, the goal page    | The first stage a watch actually runs; stage 1 only ever dry-runs         |
| 3     | Measures and baselines                           | The optimisation case, which is the one that needs a before               |
| 4     | The bench row, bug filing, `holds`, extend        | Turns a reading into work; deliberately last, since it is the only arm that touches other subsystems |

Stage 2 is the one to resist splitting further. A watch that opens and never reads is a table nobody
can see, and a reading with no verdict is a number with no rule — the three together are the smallest
thing that is true.

## Stage 1 — the seam and the declaration

**Done when** a planner can declare a signal, the harness dry-runs it against the environment on
submission, and the plan sheet draws the reading. Nothing opens, nothing repeats.

### Config and policy

- `src/environments/policy.ts` — `EnvironmentWatch` on `EnvironmentConfig`: `observe`, optional
  `schema`, `describe`, `for`, `holds`. Extend `validateEnvironments` with the three refusals the
  spec names (empty `observe`, unknown `holds`, `describe` without `observe`).
- `src/config.ts` / `src/configFields.ts` — `watchIntervalMs`, default `1_800_000`. `environments`
  stays `fileOnly`; nothing new becomes operator-editable.
- `docs/spec/02-configuration.md` — the new keys, in the same change.

### The seam

- _src/environments/observer.ts_ — `EnvironmentObserver` and `CommandEnvironmentObserver`, modelled
  line for line on `prober.ts`: shell, `repoRoot`, 30s kill, failure detail from the first stderr
  line.
  - Passes `LUBBDUBB_ENVIRONMENT`, `LUBBDUBB_WATCH_ID`, `LUBBDUBB_WATCH_QUERY`.
  - Appends the id projection to the query before handing it over, and **rejects a result that does
    not carry the id back**. This is the whole of the stale-wrapper guard and belongs here, not in a
    caller.
- _src/environments/fakeObserver.ts_ — scripted fake, beside `fakeProber.ts`. Extending the seam
  means extending the fake in the same change.
- _src/environments/watchResult.ts_ — the pure parse of a result into `{rows, value, verdict,
  detail}` against the output contract. Pure, so the contract's edges (two rows for a measure, a
  non-numeric `value`, no echo) are unit tests and not integration ones.

### The declaration

- _src/validation/watchDocument.ts_ — the zod schemas, exported for the same reason
  `ValidationCheckSchema` is: `watch_declare` must refuse exactly what a plan document refuses, and a
  second copy would drift on the day one of them learned a field.
- `src/plans/planDocument.ts` — `watch: WatchSchema.optional()`, sibling to `validation`. Optional,
  for the reason every post-v1 field is.
- `src/plans/planIngest.ts` — ingest the block, assign nothing positional (the slug is the merge key,
  as with checks).
- _src/store/watches.ts_ + `src/store/store.ts` — `goal_watches` only, at this stage.

### The dry run

- _src/environments/watchDryRun.ts_ — run each declared check once on submission and on amendment,
  store the reading, and hand a failure back to the author as a refusal.
- Wire through `src/system.ts`, which every component is threaded through.

### Prompts

- `src/plans/planning.ts` prompt additions and `docs/prompt-templates/` copies — **appended** to the
  rendered prompt, never interpolated into it. An override that never learned a `{watch}` token would
  drop it silently, on exactly the deployments that customised most.
- The instruction that matters is the one aimed at the working agent: _if you added a log line or a
  metric for this, declare the watch that reads it._

### Tests

_test/watchDocument.test.ts_, _test/watchResult.test.ts_, _test/watchDryRun.test.ts_. The dry-run
test injects `FakeEnvironmentObserver`; nothing touches a network.

## Stage 2 — the window, the readings, the card

**Done when** an arrival opens a watch, it reads on `watchIntervalMs`, it settles at `for`, and the
goal page draws every check with its verdict.

- _src/store/watches.ts_ — `watch_windows`, `watch_readings`. `settled_at` null means still watching;
  note it in `docs/spec/14-persistence.md` under the nulls that mean something.
- _src/environments/watchDesk.ts_ — a fifth pass on `EnvironmentDesk`, **below** the arrival pass,
  since a window opens on an arrival the pass above records. Cap per pulse, oldest window first.
- _src/environments/watchWindow.ts_ — pure: which arrivals open a window (two-probe-interval
  freshness, stamped either way), which checks are due, which windows settle.
- _src/environments/watchVerdict.ts_ — pure fold to the three verdicts. `unknown` never folds to
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

_test/watchWindow.test.ts_, _test/watchVerdict.test.ts_, _test/watchDesk.test.ts_ at the
`buildSystem` seam with `dbPath: ':memory:'`.

## Stage 3 — measures and baselines

**Done when** a measure declared `noWorseThan: "baseline"` captures its reading at declaration and
the card draws expected / before / now.

- Extend the schemas with `measures`, `expect`, `unit`; refuse a measure with neither threshold nor
  baseline at ingestion.
- Baseline capture rides the stage-1 dry run — it is the same call, stored rather than discarded.
- _src/mcp/tools/watchDeclare.ts_ + `MCP_TOOL_NAMES` + the `mcp__lubbdubb__*` grants. Three things
  must agree, and `test/mcpChannel.test.ts` asserts all three against each other.
- The pending-amendment state on the plan sheet: an agent's declaration is not live until accepted.

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

1. **Where the pending-amendment state lives** (stage 3) — a column on `goal_watches`, or the
   existing plan-amendment path. The second is less to build and couples the watch to a replan; the
   first duplicates a workflow that already exists.
2. **Whether `extend` re-opens a settled window or opens a second one** (stage 4). A second window is
   truer to "a watch is a record of a period" and makes the card longer.
3. **Retention for `watch_readings`** — pruned with the window is stated in the spec, but a watch on a
   busy environment at 30-minute intervals for a week is ~336 rows per check, and nothing prunes the
   window itself today.
