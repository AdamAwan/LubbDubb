# 04 — The harness cycle

`src/harness.ts` is the pulse. `src/heartbeat.ts` is the timer that drives it.

## The heartbeat

`Heartbeat` is deliberately dumb: it knows nothing about dispatch. `start()` sets a `setInterval` at
`heartbeatIntervalMs`; `stop()` clears it; `trigger()` fires one immediately. Node timers keep the
process alive, which is what an always-on server wants.

`fire()` holds a `running` flag and returns immediately if a cycle is already in flight, so cycles
never overlap.

## Coalescing

`Harness.runCycle` holds a second guard, `cycleInFlight`. A call that arrives while a cycle is running
returns a report with `cycleId: 'coalesced'` and a zeroed summary rather than queueing. Both guards
exist because a cycle can be started two ways: by the timer (through `Heartbeat`) and directly by a
route calling `harness.runCycle('manual')`.

A cycle's `source` is `'timer'`, `'manual'` or `'boot'`.

## Ordering

`runCycle` performs exactly this sequence. The order is load-bearing at three points, noted below.

1. **Emit `cycle:start`** with the new `cyc_*` id and the source.
2. **Snapshot the world** — `connector.getState()`.
3. **Record world changes** — diff against the previous snapshot, persist the events, emit
   `world:events`. See below.
4. **Reconcile plans** — `plans.reconcile(world)`. This runs **before** `decide`, so a part it moves
   to `ready` is dispatchable in the same cycle. Safe because every fold is idempotent.
5. **Read the fleet and the store** — tasks, agents, open escalations, queued jobs, plans, plan parts,
   and the most recent 200 decisions.
6. **Compute headroom** — `paused ? 0 : max(0, cap - countLiveAgents())`, reading `cap` and `paused`
   **by reference** from `RuntimeControl` (never a copy taken at wiring time).
7. **Split the PR world** — partition open PRs into the dispatch world and `excludedPrs` (below).
8. **`dispatcher.decide(ctx)`** with the full `DispatchContext`.
9. **Cache the Up next plan** — `plan.upcoming` becomes `harness.upcoming`, tagged with the cycle id
   and the world's `takenAt`. Null when the dispatcher returns no plan (the `claude` dispatcher
   returns none).
10. **Record the rationale** — a `no_op` decision with outcome `skipped` and detail
    `` `[${source}] ${plan.rationale}` ``, so even an idle cycle leaves an audit row.
11. **`executor.execute(cycleId, plan)`**.
12. **Emit `cycle:end`** with the report.

## Failure handling

The whole body is wrapped. A throw anywhere is recorded through `errors.record({ source: 'cycle' })`
with the message and stack, `cycle:end` is emitted with a `cycle failed: <message>` rationale and a
zeroed summary, and the next pulse tries again. Timer cycles run via `void fire('timer')`, so an
uncaught throw would otherwise vanish as an unhandled rejection. `cycleInFlight` is cleared in a
`finally`.

## The world baseline

`recordWorldChanges` keeps the harness's memory of the last world:

- The previous snapshot is `this.prevWorld`, falling back to `store.getWorldBaseline()` on the first
  cycle after a restart — so a restart neither blinds the diff nor floods the feed with "everything
  is new".
- With no baseline at all (a fresh store), **only** the baseline is written: no diff, no events.
- Otherwise `diffWorlds(prev, world)` runs, non-empty results are persisted via
  `store.recordWorldEvents`, and `world:events` is emitted for the cockpit's Activity feed.
- The baseline is then replaced with this cycle's world, both in memory and in the store.

The persisted baseline is also what the `world_read` MCP tool reads, so an agent sees exactly the
world the dispatch decision was made against.

## PR exclusion

A PR carrying `${labelPrefix}-ignore` is the operator's "leave this alone" signal.
`isPrExcluded(pr, label)` partitions the open list:

- `dispatchWorld.pullRequests` — the PRs rules may act on.
- `ctx.excludedPrs` — the hidden ones, passed alongside.

Excluded PRs are **hidden from dispatch but still open**, and that distinction matters: gates that
must not read "absent from the world" as "merged" — issue pickup (`openPrForIssue`), the work-item
state back-off, base-PR attribution for stacks — resolve against the combined list. Without it, an
ignored PR would read as merged and its issue would get a second agent onto the very same branch.

The world used for diffing and for the baseline is untouched, and the cockpit's state snapshot reads
the connector directly, so an excluded PR stays fully visible with its health verdict and its tag.

## `DispatchContext`

What the dispatcher gets to look at (`src/dispatcher/dispatcher.ts`):

| Field                 | Contents                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `world`               | The snapshot with excluded PRs removed.                                                      |
| `excludedPrs?`        | The removed ones, so "still open" stays knowable.                                            |
| `tasks`, `agents`     | The full fleet, from the store.                                                              |
| `openEscalations`     | Open escalations.                                                                            |
| `queuedJobs`          | Operator jobs awaiting a slot, oldest first.                                                 |
| `plans`, `planParts`  | The plan graph, already reconciled this cycle.                                               |
| `recentDecisions`     | The last 200 decisions — the cooldown and notify-dedup memory.                               |
| `steeringPriorities`  | Operator hints.                                                                              |
| `agentHeadroom`       | How many agents may still be started this cycle.                                             |

## `CycleReport`

Returned by `runCycle` and carried on `cycle:end`:

```ts
{ cycleId, source, rationale, summary: { cycleId, executed, deferred, rejected }, at }
```

## Events

`Harness` emits three typed events, consumed by `Hub` and fanned out to cockpit sockets:

- `cycle:start` — `{ cycleId, source }`
- `cycle:end` — the `CycleReport`
- `world:events` — `{ events }`, only when the diff produced any

## What triggers a cycle

- The heartbeat timer.
- `harness.runCycle('boot')` once at startup.
- `POST /api/pulse`.
- `POST /api/inject` (fake providers only), after applying the event.
- `POST /api/jobs`, `POST /api/findings/:id/promote`, `POST /api/plans/:id/replan`, and each of the
  watch/exclude label toggles — each kicks a cycle so the change takes effect immediately.
