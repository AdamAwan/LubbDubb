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

Two operator readings are folded out of those records rather than kept beside them: the
[spend breakdown](#the-spend-breakdown), which asks where the money went, and the
[reliability breakdown](#the-reliability-breakdown), which asks what it bought. Neither has a table.

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

| `source`   | Recorded by                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle`    | The harness's cycle `catch` (message + stack); plan-reconciliation fetch and status-comment failures; the plan ref-collision guard.                                                                             |
| `provider` | Provider snapshot `catch`es, via the optional `errors` in `IntegrationContext`; Azure transient-retry notices.                                                                                                  |
| `agent`    | Spawn failures; terminal `failed` agents (with the exit code and an output tail); worktree removal failures; PTY sentinel-drift warnings; invalid or unreadable `plan.json`; MCP channel/config/frame failures. |
| `server`   | The Fastify `setErrorHandler` (method, URL, message, stack).                                                                                                                                                    |
| `boot`     | Each agent found orphaned at boot (a crash, not a clean shutdown); a failed restore.                                                                                                                            |

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
| `executed` | The effect happened (including a no-op, and an escalation raised to put an act to you).          |
| `deferred` | Held by the branch gate, the pause gate or the cap gate.                                         |
| `rejected` | Malformed action, or the effect failed.                                                          |
| `skipped`  | The origin already has an active task, the target agent is not live, or the cycle rationale row. |

Each cycle also records its dispatcher rationale as a `no_op`/`skipped` row detailed
`` `[${source}] ${rationale}` ``, so an idle cycle is as explainable as a busy one.

When any provider served a last-good slice, the detail carries `[stale: <integration ids>]`
between the source and the rationale ([03](03-world-model.md#worldsnapshot)). The cycle still decides
— a stale world is the best available one — but the row says what it decided against, because a
decision that looks wrong months later is most often a decision taken against a world that had
stopped updating, and the error log recording the provider failure is not what a reader of the
Decision log is looking at.

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
  folded into input, **and** kept apart beside it — see below), and the cost **delta** as a
  timestamped `usage_events` row.
- **PTY mode** — reports no per-turn usage. It instead captures the account rate limits from the
  status-line payload (`StatusFileRateLimits`), which is the one programmatic surface for the Pro/Max
  5h and weekly windows.

`buildUsage` in the snapshot therefore ships both: `windows.fiveHourCostUsd` and
`windows.sevenDayCostUsd` are plain `SUM`s over `usage_events` (available in every mode, because they
are self-computed), and `rateLimits` is the freshest status-line reading or `null`. The cockpit chip
prefers the real limits and falls back to cost.

### Dollars are net of cache, tokens are gross

The two halves of a usage report are **not** two views of one measurement, and every figure derived
from them inherits the difference.

- **`costUsd` is the provider's own price.** It is `total_cost_usd` off the `result` event, which
  already prices a cache read at a fraction of a fresh input token and a cache write at a premium.
  Nothing in the harness re-derives a price from tokens, and nothing should: the rate card is the
  provider's and it changes without us.
- **`inputTokens` folds `cache_creation_input_tokens` and `cache_read_input_tokens` into input**
  (`resultUsage`, `src/agents/streamJsonSession.ts`). With caching on, bare `input_tokens` is a tiny
  residue and would wildly under-report what a turn actually consumed, so the sum is the honest
  reading of _volume_ — and it is deliberately not a reading of _price_.

The consequence is that **cost ÷ tokens is not a rate card**: the discount lands in the numerator and
never in the denominator, so a fleet with warm caches reads as far cheaper per million tokens than
any published price. That ratio was for a long time the only measure the harness held of how much
cache the fleet was getting; it is a proxy, and it is no longer the reading the panel leads with.

`usage_events` rows carry the same net-of-cache dollars, so the rolling windows and the daily trend
inherit this without further comment.

### The cached share is stored, not inferred

`resultUsage` also keeps `cache_read_input_tokens` and `cache_creation_input_tokens` **apart** from
the sum, as `cacheReadTokens` / `cacheCreationTokens` on `AgentUsage` and the `agents` row. They are
**parts of `inputTokens`, never siblings of it** — nothing that already sums the gross figure changes
meaning, and fresh input is the subtraction.

The reason is that the two components are priced an order of magnitude apart, so the gross figure
cannot distinguish the two fleets an operator most needs to tell apart: one reading 90% of its input
from cache, and one reading none. They report identical `inputTokens` and very different bills — and
because `costUsd` arrives with the discount already applied, no figure derived from cost can separate
them either. This split is the only reading in the harness that can, which is what makes it the one
token figure a deployment can act on.

Both are **null on a row from before the columns existed**, and that is load-bearing rather than
incidental: those runs measured a gross figure and nothing about its cache share, so they are left
out of the fraction rather than counted as misses. `buildSpendInsights` therefore ships
`cacheMeasuredInputTokens` — the gross input of the runs the split is summed over — beside the two
figures, and the hit rate is a fraction **of that**, never of `totals.inputTokens`. It is the same
stance `unmeasuredRuns` takes one grain coarser: a figure that is silent about how much of the fleet
it speaks for reads as complete.

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
  `issueOriginRole` classifies: a planner that cost $4 and cut the goal into one part spent that
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

## The spend breakdown

`buildSpendInsights` (`src/spendInsights.ts`) answers the question a cost figure raises and cannot
hold: **where did it go**. It is served by `GET /api/spend` ([16](16-http-api.md#the-fetched-routes))
and drawn by the Spend panel ([17](17-cockpit.md#spend)). Three splits of one pot of money, plus the
coverage caveat:

- **By phase** — `deliberation` (`:plan`, `:assay`), `build` (the pickup root and every `:part:`),
  `ci` (`pr:<n>:ci`, `pr:<n>:ci-gate`), `landing` (every other `pr:*`), `evidence` (`:assess`,
  `:retro`), `job` (`job:*`) and `other`. A partition: they sum to the fleet total. The issue-subtree
  phases are `issueOriginRole`'s vocabulary rather than a second one, so **a new origin suffix is
  classified in exactly one place** — an unrecognised suffix surfaces as `other` rather than being
  folded into whichever neighbour looked closest.
- **By goal** — `rollUpIssueSpend`'s own per-issue totals, ranked, with the phase split inside each
  row and `unattributedCostUsd` as the last row rather than a footnote.
- **Over time** — 14 rolling 24-hour buckets over `usage_events`. Rolling rather than calendar days
  for the same reason the 5h/7d windows are: a calendar day needs a timezone the harness has no
  opinion about.
- **By task type** and **by failing check** — `rollUpTaskTypes` and `rollUpChecks`
  (`src/taskTypeSpend.ts`), the grain below `phases`. See below.

### By task type, and by check

A phase is the coarsest useful grain and stops one question short of the operator's: not "what does
landing cost" but **"what is `dotnet test` costing me, and what are review comments costing me"**.
Two rollups answer it, both keyed on columns the dispatcher writes at dispatch time:

- **`Task.rule`** — the `DISPATCH_RULES` id that proposed the task. A partition of every measured
  run (each has one rule, or `null`, which is a row and not a silence), so review comments get a
  figure of their own that no phase can give them. Labels come from the registry, never restated.
- **`Task.ciChecks`** — the checks a CI dispatch was sent to answer, as the provider names them.

**`decisions.rule` already recorded the same id and could not be used.** A decision row has no link
to the task it created, so it can say a rule fired and never what that firing cost. The column on
`tasks` is what closes that gap.

**A check's cost is a share, not a receipt.** One agent is dispatched for every red check on a PR at
once, and nothing in the harness records which of them it actually spent its turns on — so a run's
cost is **split evenly** across the checks it named. That keeps the rows a partition of
`attributedCostUsd`; charging each check the whole run would read better per row and add up to more
money than the fleet spent. `soleRuns` is shipped per check so a row that never shared can be told
from one that always did. CI money on runs that named no check is `unnamedCostUsd` — a remainder,
never dropped, for `unattributedCostUsd`'s reason exactly.

**The read path never parses a dispatch reason.** `ciDispatchReason` names the failing checks in
prose too, and reading that back is the defect `ciStatusOf`'s one-matcher rule exists to prevent: a
reader that re-derives a format reports zero, silently, the first time the wording changes — and a
spend table quietly reading `$0.00` is worse than a missing one. It is parsed **once**, by
`backfillTaskDispatchKind` at boot, to seed the runs that predate the columns. There, the risk is
bounded and visible: a sentence it does not recognise leaves the row null and lands in
`unnamedCostUsd`, which the panel states. The backfill only ever fills nulls, so it is idempotent and
cannot overwrite what the dispatcher recorded properly; the `rule` half of it is structural (each of
the four PR origins is minted by exactly one rule) rather than parsed at all.

**One attribution, not two.** The goal totals are the roll-up's, taken whole, and the phase split
rides on the `attribution` map it returns rather than on a second walk of the work graph. The panel
and the goal card state the same goal's cost inches apart in the cockpit, and a second lineage walk
would be a second opinion about which goal a pull request belongs to — free to disagree, silently, on
exactly the origin shapes the two readings classify differently. That is the sharp edge here: **a
change to how spend finds its goal belongs in `rollUpIssueSpend` and nowhere else.**

**Derived, never stored,** for per-goal spend's reason exactly. **Fetched, never polled**, for the
work graph's: it reads every agent the harness has ever run, and `/api/state` comes round every
couple of seconds for every open cockpit. What the _indicators_ need is already on the snapshot.

**`ci` and `landing` are separate from `build`** although all three are work on the same code,
because they fail differently and an operator acts on the difference: build is what a goal cost to
write, and the other two are what it cost to get through. A goal whose CI dwarfs its build is a flaky
pipeline, not an expensive goal.

**`ci` is split out of `landing` because it is the one an operator can act on alone.** Answering
review comments is the cost of being reviewed and a fleet cannot decline it; re-running failing
checks is the cost of a broken suite, which is a bug with a price — folded together the two are one
number that cannot say which it is. `pr:<n>:ci-gate` (checks waiting on an action rather than
failing) counts as `ci` too: same pipeline, same money, and a phase per dispatch state would rank
states instead of causes.

**`landing` is the remainder of `pr:*`, not a list of suffixes.** `merge`, `mergeable`, `comments`,
`comment:<id>`, `reply` and the bare `pr:<n>` all fall to it, and so does a concern nobody has
invented yet. Only `ci` is matched by name, because only `ci` is being lifted out — **a new pull
request concern must not need a change in `phaseOf` to be counted at all.** That is the opposite
stance to the issue subtree, and deliberately: there, an unnamed suffix means a _role_ nobody
decided, which is worth surfacing as `other`; here it means one more thing a pull request needed
before it landed, which is exactly what `landing` is.

**Unmeasured runs are counted, once.** A run that reported nothing appears in no figure on the panel
— the same silence the roll-up keeps — and `totals.unmeasuredRuns` is shipped beside the totals so
the panel can say how much of the fleet it is speaking for. Without it, a fleet run entirely in PTY
mode draws a complete-looking breakdown of nothing.

## The reliability breakdown

`buildReliabilityInsights` (`src/reliabilityInsights.ts`) answers the question the spend breakdown
stops one short of: the money bought _something_, and **did it work**. It is served by
`GET /api/reliability` ([16](16-http-api.md#the-fetched-routes)) and drawn by the Yield panel
([17](17-cockpit.md#yield)). Two halves, and they are the two halves of one funnel:

- **Run outcomes**, all-time. Every agent the harness has settled, split by how it ended (`done`,
  `failed`, `crashed`, `killed`, `interrupted`) and by the **spend panel's own phases** — the same
  `phaseOf` classifier, imported rather than re-written, so a row here and a row there are about the
  same set of runs. Plus what the faults cost, the median run length per phase, and the origins the
  harness went round more than once.
- **CI health**, over 14 rolling days. Transitions into failing and into passing, the red rate over
  them, how long a pull request stays red, which pull requests went red repeatedly, and what the `ci`
  and `landing` phases each cost inside the same window — fleet-wide as `ciCostUsd`, and **per pull
  request** as `CiSubject.costUsd`, so a count of reds and the money it took to answer them sit in
  one row.

**The two windows differ on purpose.** A completion rate is a property of the harness and wants every
run it has ever done behind it. A red rate is a property of a pipeline _as it stands_, and folding in
a suite that was fixed a month ago describes a repository that no longer exists. `windowDays` is
shipped so the panel states the window rather than assuming it.

**Faults and stops are different counts.** `killed` and `interrupted` are an operator's decision, and
a fleet someone steers is not an unreliable one — only `failed` and `crashed` count against
`completionRate`. Stopped runs still carry their cost, because money spent on a run someone stopped
is money spent.

**Live runs are in no rate.** An unfinished run has no outcome, so `settled` is the denominator
everywhere and `live` is reported beside it. A rate that folded live runs in would fall every time
the fleet got busy.

**Cost per red is per verdict, not per fix.** `CiSubject.costUsd` over `reds` is what the panel
draws, and one CI agent often answers several reds at once — a pull request that went red four times
and was fixed once divides the same money four ways. It prices the pipeline breaking, not a repair.
Both figures are windowed off dated `usage_events` rather than whole agent rows, so a run that
started before the window does not drop its entire cost into a fortnight it barely touched. A CI run
whose pull request reported no verdict inside the window reaches `ciCostUsd` and no row: **the total
is over the fleet, the rows are a ranking**, the same stance every other table here takes about its
cap.

**A red is a CI verdict, not a pull request.** One pull request that failed nine times is nine reds;
`prsAffected`/`prsObserved` is the other reading and both are shipped. `pending` and `unknown` are not
verdicts and count as neither — crucially, a rerun passing through `pending` on its way back to green
does **not** end the red span, or every retry would read as an instant recovery. A red with no green
after it is still red _now_, so its span runs to the read rather than to its last event: otherwise the
pull request nobody has fixed shows the least red time on the board.

**Two classifiers, both borrowed.** Phases come from `spendInsights.phaseOf` and CI statuses from
`worldDiff.ciStatusOf`; neither is re-derived here. `ciStatusOf` is the sharp edge — `world_events`
stores a kind, a ref and a _sentence_, so the status a transition carried survives only inside that
sentence. **The matcher that writes it and the matcher that reads it are the same regexp in the same
module**, for the PTY sentinel's reason: a reader that re-derived the format for itself would report
zero failures, silently, the first time the wording changed.

**The gauge and the panel fold once.** `tallyRunOutcomes` is exported and called twice — by
`buildStateSnapshot`, which puts `runOutcomes` on `/api/state` for the Yield gauge to draw, and by
this module, which spreads it as the panel's headline counts. A panel opened from a gauge must begin
by agreeing with it, and agreement by construction is the only kind that holds. The gauge draws
**nothing** until the first run settles: a rate over no runs is not 100%.

**Derived, never stored,** and **fetched, never polled**, for the spend breakdown's reasons exactly.
Everything it folds — the `agents` rows, `usage_events`, and the `pr_ci` rows of `world_events` — is
already durable, already dated, and pruned by nothing.

**The CI read is ordered, and the order is load-bearing.** `listWorldEventsOfKindsSince` returns
**oldest first**, unlike its two neighbours in `WorldStore`, because the fold pairs each failing with
the _next_ passing. A descending read pairs every red with the green that preceded it and reports the
flakiest pipeline in the repository as recovering instantly.

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
