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
