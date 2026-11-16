# CLAUDE.md — `src/environments/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Environments

- **A reach verdict is three-valued, and a new reader must not fold `unknown` into `absent`.** An expired credential, a
  missing binary and a commit that genuinely has not shipped all fail the same way, and only the last is about
  deployment. `GitObserver.contains` answers `boolean | null`, and a probe that could not say makes **every** landing of
  that environment `unknown`. → [24](../../docs/spec/24-environments.md#the-three-verdicts)
- **A stacked pull request's squash commit is not a landing, and recording it as one holds the goal's gates for ever.**
  Part 2's PR based on part 1's branch squashes onto that _topic_ branch — a branch that is then deleted and is an
  ancestor of nothing — so no environment can ever hold it. Counted in `total`, the goal reads `partial` in every
  environment for good; `newArrivals` only ever reads `reached`, so no arrival is written and every gate the arrival
  opens stays shut, with nothing red. `unrecordedLandings` cuts on `baseBranch`, `unattributedMerges` on the node's
  `baseRef`, and `EnvironmentDesk` reconciles what neither can see against the clone into
  `goal_landings.on_integration`. The stacked pull request is instead recorded on its _carrier's_ commit
  (`carriedLandings`). → [24](../../docs/spec/24-environments.md#what-counts-as-a-landing)
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
- **An arrival must never be written as a `WorldEvent`.** `deliveryHold` expires a standing delivery
  verdict on **any** world event matching the goal's issue ref, so an arrival written as one un-parks
  the goal it just announced and hands delivered work back to the fleet. Arrivals have their own
  table and wire list; the cockpit merges them at the feed's door.
  → [24](../../docs/spec/24-environments.md#in-the-cockpit)
- **An arrival is announced only if its reading is fresh, and stamped either way.** Drop either and
  the deployment that takes the build comments on every ticket that ever shipped.
  → [24](../../docs/spec/24-environments.md#announcing-an-arrival)
- **A landing is recorded by sweeping for unattributed merges, never on the merge itself.** The
  merge SHA has a `closedPrWindowMs` shelf life, so a hook on the transition loses the landing to any
  restart that straddles it. The desk runs **immediately below `graph.record`**, because attribution
  walks the graph's `parentRef` chain. → [24](../../docs/spec/24-environments.md#recording-a-landing)
