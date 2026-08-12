# 18 — Observability

Four durable records answer four different questions, plus one live tail and one debug channel.

| Record        | Answers                               | Table                             | Panel        |
| ------------- | ------------------------------------- | --------------------------------- | ------------ |
| Decision log  | What did the harness decide, and why? | `decisions`                       | Decision log |
| Activity feed | What did the _world_ do?              | `world_events`                    | Activity     |
| Error log     | What failed?                          | `error_events`                    | Errors       |
| Usage         | What did it cost?                     | `usage_events` + the `agents` row | Usage chip   |

Cost is asked two ways off that one record: **when** it was spent (the rolling account windows) and
**what it was spent on** (per goal). The second is derived rather than stored — see
[Per-goal spend](#per-goal-spend).

## The error log

**`src/errorLog.ts` is the one error-recording path.** Anything that catches a failure calls
`errors.record(...)`, which:

1. persists the entry to `error_events`, so it survives a reload;
2. mirrors it to stderr, so headless runs still see it;
3. emits `logged`, which the `Hub` fans out over WebSocket as `error:logged` plus a `dirty`.

`ErrorRecorder` is the narrow `{record}` seam handed to consumers, so they stay decoupled from the
emitter and tests can pass a plain capture object.

The log is the one record an operator can **clear** (`POST /api/errors/clear`, the cockpit's
Faults head): it is a list read and cleared rather than a record anything decides on — nothing in the
harness reads `error_events` back — so the only thing a clear can lose is a row nobody had read. The
other three tables have no such button, because every one of them is read back by something. Clearing
stops nothing: the next failure records as usual.

The event is named **`logged`, not `error`**: an unlistened `error` event throws on an EventEmitter,
and recording a failure must never throw.

### Who records what

| `source`   | Recorded by                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle`    | The harness's cycle `catch` (message + stack); plan-reconciliation fetch and status-comment failures; the plan ref-collision guard.                                                                                                             |
| `provider` | Provider snapshot `catch`es, via the optional `errors` in `IntegrationContext`; Azure transient-retry notices.                                                                                                                                  |
| `agent`    | Spawn failures; terminal `failed` agents (with the exit code and an output tail); worktree removal failures; PTY sentinel-drift warnings; invalid or unreadable `plan.json`; an overridden `single` verdict; MCP channel/config/frame failures. |
| `server`   | The Fastify `setErrorHandler` (method, URL, message, stack).                                                                                                                                                                                    |
| `boot`     | Each agent found orphaned at boot (a crash, not a clean shutdown); a failed restore.                                                                                                                                                            |

**Do not add new swallowed `catch`es — route them here.** Tests silence the stderr mirror with
`buildSystem(config, { errorMirror: () => {} })`.

### The stderr mirror sanitises, and only the mirror does

The mirror writes **one line per entry**, so a newline in a value could end that line early and forge
a second `[lubbdubb:error]` one — and both halves of the header arrive from outside the harness: an
agent id off a request path, a provider name and exception text off the world.

- **The header is flattened** (`oneLine`), which costs nothing, since a `message` is a sentence by
  contract.
- **`detail` is indented, not flattened.** It is deliberately multi-line — that is what it exists for
  — so it keeps its shape while a forged header line is made visibly a continuation.

The **stored** entry keeps its exact text. The store is structured rows rather than a line-oriented
stream, and the cockpit renders the value as DOM text, where a newline forges nothing. Sanitising on
the way in would corrupt the record to protect a transport that is not the record.

## The decision log

Every action outcome is written by `Store.recordDecision`, which **lifts `action.rule` into the `rule`
column** so the audit log can answer "which rule fired" first-class rather than only "what did it say".

| Outcome    | Written when                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `executed` | The effect happened (including a no-op, and an escalation raised because auto-send was blocked). |
| `deferred` | Held by the branch gate, the pause gate or the cap gate.                                         |
| `rejected` | Malformed action, or the effect failed.                                                          |
| `skipped`  | The origin already has an active task, the target agent is not live, or the cycle rationale row. |

Each cycle also records its dispatcher rationale as a `no_op`/`skipped` row detailed
`` `[${source}] ${rationale}` ``, so an idle cycle is as explainable as a busy one.

`DISPATCH_RULES` ships in the state snapshot, so the cockpit expands a decision's rule id into the
rule's name, number and standing rationale — the reason the rule exists, independent of any one firing.

The log is also **read back as memory**: `DispatchContext.recentDecisions` (the last 200 rows) is what
the re-dispatch cooldown counts attempts from, and what the branch-notify de-duplication reads.
Only **executed** dispatches count as attempts, because a deferred one never ran.

`EscalationInbox.dismissEscalationsForAgent` also writes decision rows, under the synthetic cycle id
`agent-lifecycle`, recording why an orphaned escalation was auto-dismissed.

## The activity feed

`world_events` is the world's counterpart to the decision log: what changed out there, rather than what
the harness chose. Rows are produced by the pure `diffWorlds` and stamped by the store. See
[03](03-world-model.md) for the full event vocabulary and the two rules that shape it (a new object
emits only its appearance; a removal emits nothing).

The very first cycle over a fresh store records **only** the baseline — no diff, no "everything is
new" flood.

## Usage accounting

Two mode-specific sources that must not be conflated.

- **Stream mode** — each `result` event's cumulative `total_cost_usd` / `usage` / `num_turns` is
  recorded by `Store.recordAgentUsage`: the cumulative values onto the `agents` row (cache tokens
  folded into input), and the cost **delta** as a timestamped `usage_events` row.
- **PTY mode** — reports no per-turn usage. It instead captures the account rate limits from the
  status-line payload (`StatusFileRateLimits`), which is the one programmatic surface for the Pro/Max
  5h and weekly windows.

`buildUsage` in the snapshot therefore ships both: `windows.fiveHourCostUsd` and
`windows.sevenDayCostUsd` are plain `SUM`s over `usage_events` (available in every mode, because they
are self-computed), and `rateLimits` is the freshest status-line reading or `null`. The cockpit chip
prefers the real limits and falls back to cost.

## Per-goal spend

`rollUpIssueSpend` (`src/issueSpend.ts`) answers what a **ticket** cost — the unit an operator
budgets in, and the one thing the tracker names. It is pure, computed each snapshot from three lists
`buildStateSnapshot` already holds (`agents`, `tasks`, and the work graph), and ships as
`Issue.spend` on every enriched issue — live issues and retained runs alike, through the same
`enrichIssue` path.

**Derived, never stored.** No table, no migration, no reconciliation: cost is already durable on the
`agents` row, the origin is durable on the `tasks` row, and the lineage between them is durable in
`work_nodes`. A `issue_costs` table would be a fourth copy of a number the other three already
determine, and the one thing it could add — drift.

An agent knows only the origin it was dispatched against, and that is rarely the issue. Two ways an
origin reaches a goal, and everything else is the remainder:

- **By name** — the whole `issue:<n>` subtree. Deliberately the whole subtree rather than the roles
  `issueOriginRole` classifies: a planner that cost $4 and routed the goal to `single` spent that
  money on the goal, whatever it did or did not build. Deliberation is spend.
- **By lineage** — everything else, by walking `parentRef` up the durable work graph. `pr:41`'s
  parent is the part or issue that produced it; a job's is the issue that adopted it. Sub-refs
  (`pr:41:ci`, `pr:41:comments`, `pr:41:mergeable`) are reduced to `pr:41` first, since only the bare
  PR is ever a node. The graph is read rather than the world because it **never forgets**: a goal's
  total must not fall when its pull requests age out of `closedPrWindowMs`.

**The remainder is shipped, not swallowed.** Spend reaching no goal — an operator's job the graph
never linked, an agent dispatched against no origin — lands in `usage.unattributedCostUsd` rather
than being dropped. That is what makes the per-goal figures readable as a _partition_ of fleet spend:
a new origin shape that lands nowhere shows up as a growing remainder instead of as goals that
quietly under-report. Nothing in the harness reads any of this; it is an operator reading, like the
error log.

**Null is not zero.** PTY mode reports no usage at all ([above](#usage-accounting)), so an agent that
measured nothing contributes no row and no agent count, and a goal worked entirely in PTY mode has
`spend: null`. The cockpit draws nothing there rather than `$0.00`, which would describe an unmeasured
goal as a free one. `costUsd` is a **running** total: it climbs while agents work and stops when the
last one ends.

## The live tail

`agent:tail` is a per-agent rolling last-non-empty-line, folded in `Hub.updateTail` with ANSI stripped.

It is a **liveness** signal, not a progress one, and it is **ephemeral**: it lives only in the `Hub`'s
in-memory map and the cockpit's ref, so a reload or a cockpit opened mid-run shows nothing until the
next output. `note_progress` (see [11](11-mcp-tools.md)) is the durable, attributed counterpart, and
the two sit side by side rather than one replacing the other.

## Debug logging

`src/debug.ts` provides `debugEnabled()` and `debugLog(scope, message)`, gated on `LUBBDUBB_DEBUG`.
Scopes in use: `agent` (spawn/resume, including the events dir), `fileEvents` (drains, per-write
classification, plan ingestion, and the hook's own breadcrumbs at teardown), and `mcp` (the socket).

With debug on, `LUBBDUBB_EVENTS_DEBUG` is also exported to agents, so the file-events hook records a
breadcrumb per fire. Empty breadcrumbs when a write clearly happened localise the fault to `--settings`
not taking effect, rather than to draining or classification.
