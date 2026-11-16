# CLAUDE.md — `src/validation/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Persistence

- **A validation check's `area` comes from a `suite` step and from nothing else, and a second home for it is a silent
  undo.** It was inherited from the `coverage` of a covered part, repaired from SQL at boot and held in a column; all
  three are gone, because a boot pass that recomputes it overwrites what the step named on _every_ boot — the join quietly unpicking
  the author, with nothing red. → [36](../../docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area)
- **`fleetCanStart` is three-valued and `null` must never fold into `false`.** Null is _this check has no steps_ —
  `fleetCandidate` and the operator's press still decide, which is every check written before test plans. False is a
  plan whose first step is a person's, which can never execute. Fold them and every prose check on the deployment stops
  being dispatchable, with a full "Up next" queue and nothing red. → [20](../../docs/spec/20-validation.md#who-carries-a-step)
- **A failed validation check must never be recorded as a shortfall.** A shortfall clears the goal's **delivery** row,
  and the delivery is what parks the goal: writing one un-parks it, settles the close-out obligation and declines the
  validation bench row — the reading deleting the rows it was reported into, with delivered work handed back to the
  fleet. Rule `validation-failed` is the consumer, on its own origin. →
  [20](../../docs/spec/20-validation.md#when-a-check-fails)

## Tenants

- **The harness never generates or infers a tenant identifier, anywhere.** Environments reap tenants
  matching a name pattern past a short age, so an invented name survives about an hour and its
  disappearance presents as mysterious mass failure. No tenant configured is a `blocked` row **naming
  the command or variable that would provide one** — and a `tenantEnv`'s _value_ goes into the spawn
  env and nowhere else: the lock, the cockpit and every prompt carry the **variable's own name**.
  → [36](../../docs/spec/36-remote-validation.md#tenants)

## Remote validation

- **A `RemoteValidationDesk` pass that stamps an arrival it did not assemble burns the guard that makes turning remote
  validation on next month safe.** `goal_arrivals.sheeted_at` null means _not considered yet_, and the freshness guard
  does a backfill's job — so the early return where no environment declares a `validate` block stamps **nothing**, and
  an arrival on an environment with no `validate` block is left unstamped. Stamp on the way past and the operator who
  turns it on gets a sheet, a spawned query and a bench row for every goal that ever arrived. →
  [36](../../docs/spec/36-remote-validation.md#the-desk)
- **Anything a sheet run owes its agent is counted at the press, or the run settles with it still owed.**
  `runnableSelectors`, `runnableScripts`, `runnableScreens` and `runnableDrives` are four halves of one question, and a
  check that carries only the newest of them names nothing the older ones count: the press ends the run on the spot, the
  check stays `unrun` for ever, and the sheet reads as a run that answered. A fifth thing a run can carry is a fifth
  entry there. → [36](../../docs/spec/36-remote-validation.md#a-screen-from-the-sheets-own-run)
- **Two dispatches must never share one browser profile directory.** A persistent profile is held by one browser at a
  time, so a remote validation run pointed at `localValidationProfileDir` refuses to start whenever a local validation
  is up — every row it was pressed for comes back `blocked`, which is a right answer to the wrong question, with nothing
  red. `remoteValidationProfileDir` is per environment. →
  [36](../../docs/spec/36-remote-validation.md#the-browser-the-run-drives)
- **A sheet reading is never a `WorldEvent` and never a `watch_readings` row.** Same trap as an arrival's, one subsystem
  over: `deliveryHold` expires a standing delivery verdict on any world event matching the goal's issue ref, so a
  reading written as one un-parks the goal it just reported on. →
  [36](../../docs/spec/36-remote-validation.md#what-a-finding-does-and-what-it-must-never-do)
