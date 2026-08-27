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

All of that is retrospective. The [burn watch](#the-burn-watch) is the one cost reading taken while
the money is still being spent — it acts on nothing and files a visible obligation to go and look.

## The error log

**`src/errorLog.ts` is the one error-recording path.** Anything that catches a failure calls
`errors.record(...)`, which:

1. persists the entry to `error_events`, so it survives a reload;
2. mirrors it to stderr, so headless runs still see it;
3. emits `logged`, which the `Hub` fans out over WebSocket as `error:logged` plus a `dirty`.

`ErrorRecorder` is the narrow `{record}` seam handed to consumers, so they stay decoupled from the
emitter and tests can pass a plain capture object.

The log is the one record an operator can **clear** (`POST /api/errors/clear`, the cockpit's
Faults head): it is a list read and cleared rather than a record anything **decides** on, so the only
thing a clear can lose is a row nobody had read. The other three tables have no such button, because
every one of them is read back by something a decision depends on. Clearing stops nothing: the next
failure records as usual.

**One thing does read it back, and it decides nothing.** The pool's digest arm counts the log per
`source` per UTC day into the `byFault` section of the fleet's published digest, so a person opening
the fleet's `digest.md` in the pool repository can see what has been going wrong without a cockpit in
front of them ([28](28-cross-fleet-pool.md#the-faults-section)). It is a reading and never a trigger,
it is never mirrored to any other fleet, and a clear therefore costs it exactly what it costs the
panel — which is why the published table says under itself that a quiet quarter may be a cleared one,
rather than the clear button acquiring a warning about a file somewhere else.

The event is named **`logged`, not `error`**: an unlistened `error` event throws on an EventEmitter,
and recording a failure must never throw.

**A refused dispatch is deliberately not one of these.** `ensure` refusing a lease is a decision the
harness made and audits as such, and the failure mode worth catching is not the refusal but its
_repetition_ — which the queue rail derives from `decisions`
([09](09-execution.md#a-refusal-that-keeps-repeating)). Recording it here instead would put a hundred
rows an hour of one standing fact into the one list whose shape means "something threw once", in the
one record an operator clears.

### Who records what

| `source`   | Recorded by                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle`    | The harness's cycle `catch` (message + stack); plan-reconciliation fetch and status-comment failures; the plan ref-collision guard.                                                                             |
| `provider` | Provider snapshot `catch`es, via the optional `errors` in `IntegrationContext`; an Azure request that spent every retry (a recovered one records nothing); GitHub rate-limit notices.                                                                                                  |
| `agent`    | Spawn failures; terminal `failed` agents (with the exit code and an output tail); worktree removal failures; terminal-runtime warnings; invalid or unreadable `plan.json`; MCP channel/config/frame failures. |
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
`agent-lifecycle`, recording why an orphaned escalation was auto-dismissed — whether it was reached by
a terminal-state listener or by the pulse's `tidyDeadAgents` sweep
([10](10-agent-runtimes.md#the-questions-a-dead-agent-leaves-behind)).

## The activity feed

`world_events` is the world's counterpart to the decision log: what changed out there, rather than what
the harness chose. Rows are produced by the pure `diffWorlds` and stamped by the store. See
[03](03-world-model.md) for the full event vocabulary and the two rules that shape it (a new object
emits only its appearance; a removal emits nothing).

The very first cycle over a fresh store records **only** the baseline — no diff, no "everything is
new" flood.

## Usage accounting

Two sources that must not be conflated, both off the stream transport.

- **Per-turn spend** — each `result` event's cumulative `total_cost_usd` / `usage` / `num_turns` is
  recorded by `Store.recordAgentUsage`: the cumulative values onto the `agents` row (cache tokens
  folded into input, **and** kept apart beside it — see below), and the cost **delta** as a
  timestamped `usage_events` row.
- **The account's usage windows** — every stream agent's `rate_limit_event` carries them, and they
  land in `account_rate_limits` as one row for the fleet
  ([10](10-agent-runtimes.md#the-account-usage-windows)).

`raw`, the mock runtime, reports neither: it runs no model, so there is nothing to price.

`buildUsage` in the snapshot therefore ships both: `windows.fiveHourCostUsd` and
`windows.sevenDayCostUsd` are `Store.sumUsageCostSince` (available in every mode, because it is
self-computed), and `rateLimits` is `Store.readRateLimits()` — the freshest reading any agent has
reported, or `null`.

**The Usage chip on the top bar draws them**, and it is the only reader either has
([17](17-cockpit.md#the-usage-chip)). It draws **both** windows as percentages — either one parks the
fleet, and a chip carrying the five-hour alone reads fine on the morning a weekly allowance runs out —
in a fixed order, with the one nearer its limit lettered at full strength. It falls back to the
five-hour cost only where `rateLimits` is null altogether, which is the rule the shape of the reading
forces: that is API-key auth, an older CLI and a fleet that has not run yet, and a chip that went blank
there would leave the operator's spot on the bar empty in the deployments least able to spare it. And it
renders `capturedAt` — see below.

**The limits reading is turn-bound and the cost windows are not.** A reading arrives only when an
agent takes a turn, so an idle fleet's `capturedAt` ages while the account's real window keeps moving.
That is a staleness to render, not to hide behind a freshening probe.

### Two tables of deltas, added in one place

A local run is a session too, and its money is dated the same way — but in
`local_run_cost_deltas` rather than `usage_events` ([23](23-local-runs.md#what-it-costs)). Two tables,
because `usage_events.agent_id` is `NOT NULL` and is the **join** the reliability breakdown prices a
pull request's CI through: a local run id in that column would be a row that can never match, dressed
as one that should.

So the addition happens once, in `src/store/store.ts`:

- `sumUsageCostSince` is both tables, because the question it answers — what has this deployment spent
  in this window — has one answer. It is what the gauges draw and what the pets' beats are earned from
  ([22](22-pets.md#the-two-economies)).
- `listCostDeltasSince` is both, merged and dated, for the timeline.
- `listUsageEventsSince` is the **agents' alone**, deliberately, for the one reader that needs to know
  whose.

A third source of spend is added in that method, or it is money the cockpit states nowhere while
claiming to state all of it.

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

**Null is not zero.** The mock runtime reports no usage at all ([above](#usage-accounting)), so an
agent that measured nothing contributes no row and no agent count, and a goal worked entirely on it has
`spend: null`. The cockpit draws nothing there rather than `$0.00`, which would describe an unmeasured
goal as a free one. `costUsd` is a **running** total: it climbs while agents work and stops when the
last one ends.

## The window

`src/insightsWindow.ts`. Every reading the Insights page draws is measured over one stretch of time,
chosen by the operator and resolved here — the key comes in on the query string of the three fetched
routes ([16](16-http-api.md#the-fetched-routes)), and the resolution is passed down to every fold under
them.

Before this, each reading picked its own span and none of them lined up: six hours for the production
graph, five and seven days for the spend tiles, a fortnight for the spend timeline, another fortnight
for CI health, eight weeks for the trend — and all-time for the run half of reliability and for the
spend totals. Two figures side by side on one surface described different stretches of the fleet's life,
and nothing said so. A number moving in one panel could not be read against a number in another, which
is what made the whole set feel inert.

Five windows, each with the resolution it is drawn at:

| Key   | Span      | Timeline     |
| ----- | --------- | ------------ |
| `6h`  | 6 hours   | 12 × 30m     |
| `24h` | 24 hours  | 24 × 1h      |
| `7d`  | 7 days    | 28 × 6h      |
| `30d` | 30 days   | 30 × 1d      |
| `all` | unbounded | 26, computed |

**The bucket count is stated rather than derived** from `span / bucket`, because the two must agree and
a derived count hides the disagreement: a span that is not a whole number of buckets silently draws a
final bar covering less time than the ones beside it — a bar shorter for a reason nothing on the glass
gives.

**`all` is genuinely unbounded**, which is what makes it worth having: it is the reading the panels gave
by default, and folding it into a long fixed span would quietly drop the deployment that has been
running since March. `ResolvedWindow.startMs` is `null` for it and every fold reads that as "no lower
bound" rather than as a date; the store reads take `sinceOrEpoch`, written once so that a route reaching
for `?? new Date(0)` itself cannot spell the same decision differently. A _timeline_ still needs two
ends, so `timelineSpan` takes the earliest datum the caller actually holds and divides what it finds —
the buckets describe the history that exists rather than a span guessed at here, and a harness that
started last Tuesday does not draw twenty-five empty buckets in front of itself.

**"The earliest datum" means the earliest across every population the timeline buckets**, not the
earliest of whichever one is handiest. `buildSpendTrend` folds its closures and its runs together for
this; `buildReliabilityInsights` folds its agents and its `pr_ci` events. Off one of two, the headline
figures — which are counts over the unbounded window — include history the axis beneath them starts
after, so the graph disagrees with the number printed above it on the one window whose entire purpose
is to show everything. Nothing throws and no row is malformed; it only shows when the two populations
have different oldest members, which no fixture stamping everything at one clock ever does.

**A run counts where it ended**, and where it started only while it is still going (`runInstant`). A run
that opened before the window and finished inside it spent its money inside it, and counting it at its
start would leave a nine-hour agent out of the six-hour window it in fact dominated.

**A run that has not ended is inside every window that ends at `now`** (`runInWindow`), whatever its age
— which is the same sentence read to its conclusion. `runInstant` dates a live run at its start because
the start is the only end it has, and that is right for placing it on a timeline; it is wrong as a cut,
because the money that run is spending is being spent inside every window drawn now. An eight-hour agent
still out, read at its start, fell out of the six-hour window while the top bar's chip showed the money
it had spent — and the Economics tab, short-circuiting on `measuredRuns === 0`, drew "No agent ran in
this window" over a working fleet. A local run is the case that meets this normally: it is held open for
as long as somebody is looking at it ([23](23-local-runs.md#what-it-costs)), so outliving the window is
what it does.

**A reading with no control of its own takes the window the page opens on** (`defaultWindow`). The
Knowledge page's cost figure ([27](27-knowledge.md#what-it-costs)) is the caller: it draws one number,
has no time bar, and a second control there would be a second answer to "over what stretch" on a page
whose whole argument is that one figure should be readable beside another. It is the one reading here
that dates a run by **when it started** rather than by `runInstant`: the knowledge block is written
into a launch's arguments once, at the top of the run, where money is spent throughout one.

**The window is shipped back on every payload** as `InsightsWindowView`, and the page draws that rather
than the key it asked with. A caption computed in the browser from the key is free to disagree with the
buckets the server actually cut, and the caption is the half a reader would believe.

**The `window` query parameter is declared with the rule, not in the routes.** `InsightsQuery` lives in
`src/insightsWindow.ts` beside the union it validates, for the reason `ShortfallBody` lives with the
shortfall rule: three routes take it and all three must accept exactly the set the cockpit can offer.
The default is applied there too, so a route reached without one answers for the same stretch the page
opens on rather than for whatever that route's author picked.

## The spend breakdown

`buildSpendInsights` (`src/spendInsights.ts`) answers the question a cost figure raises and cannot
hold: **where did it go**. It is served by `GET /api/spend` ([16](16-http-api.md#the-fetched-routes))
and drawn by the Insights page's Economics and Work mix tabs ([17](17-cockpit.md#economics)). Three
splits of one pot of money, plus the coverage caveat:

- **By phase** — `deliberation` (`:plan`, `:appraisal`), `build` (the pickup root and every `:part:`),
  `ci` (`pr:<n>:ci`, `pr:<n>:ci-gate`), `landing` (every other `pr:*`), `evidence` (`:assess`,
  `:retro`), `local` (a local run), `job` (`job:*`) and `other`. A partition: they sum to the fleet
  total. The issue-subtree phases are `issueOriginRole`'s vocabulary rather than a second one, so **a
  new origin suffix is classified in exactly one place** — an unrecognised suffix surfaces as `other`
  rather than being folded into whichever neighbour looked closest. `local` is the one phase that is
  **not** read off an origin ref, and `phaseOf` is not asked about it: a local run carries the goal's
  own ref, which is the one shape that would classify as `build`.
- **By goal** — `rollUpIssueSpend`'s own per-issue totals, ranked, with the phase split inside each
  row and `unattributedCostUsd` as the last row rather than a footnote.
- **Over time** — rolling buckets over `usage_events` at [the window](#the-window)'s own resolution.
  Rolling rather than calendar buckets: a calendar day needs a timezone the harness has no opinion
  about, and the last bucket is therefore "up to now" — still filling, which is why the page draws it
  hollow.
- **By task type** and **by failing check** — `rollUpTaskTypes` and `rollUpChecks`
  (`src/taskTypeSpend.ts`), the grain below `phases`. See below.
- **`landed` and `lostCostUsd`** — the two figures the Economics headline's ratio needs beside the
  total: pull requests merged inside the window, and what the runs that failed or crashed inside it
  cost. They ride on **this** payload rather than being fetched from the reliability one because
  "$26 of $118 never landed" is one sentence, and fetching its two halves from two routes is how they
  end up describing two windows. `lostCostUsd` counts `failed` and `crashed` only: a killed run is a
  steer, and counting an operator's own change of mind as waste makes every steered fleet look broken.

**The window is applied once, at the top of the fold**, and everything below reads the list it
produces. Applying it per split would put the same filter in five places for four of them to get subtly
different — and the way that shows up is a phase table whose costs do not add to the total beside it.

### By task type, and by check

A phase is the coarsest useful grain and stops one question short of the operator's: not "what does
landing cost" but **"what is `dotnet test` costing me, and what are review comments costing me"**.
Two rollups answer it, both keyed on columns the dispatcher writes at dispatch time:

- **`Task.rule`** — the `DISPATCH_RULES` id that proposed the task. A partition of every measured
  **agent** run (each has one rule, or `null`, which is a row and not a silence), so review comments
  get a figure of their own that no phase can give them. Labels come from the registry, never
  restated. Nothing dispatched a local run, so it can hold none — and the panel states that remainder
  under the table rather than letting a rule-keyed partition read as the whole of the money.
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
the panel can say how much of the fleet it is speaking for. Without it, a fleet run entirely on the
mock runtime draws a complete-looking breakdown of nothing.

**The goal rows are their own fold.** `buildSpendGoals` produces the ranked per-issue rows, the phase
split inside each and the `attribution` map behind both; `buildSpendInsights` calls it and so does
the trend below. Its own function because two readings want the goals and only one of them wants a
run ranking and a check table — and because the alternative, a second roll-up in the trend module, is
the second opinion this section spends four paragraphs refusing to have.

**A goal is named from the world, then from the run record.** The world baseline is the tracker's
_open_ set, so every goal that has closed, been retired or been dismissed is missing from it — while
the money the fleet spent under it stays on the table forever. `buildSpendGoals` therefore takes
`runs` as well as `issues`: a live issue's title wins, because it is the current one, and a goal the
world has forgotten is named from the run record the harness minted while it _was_ live
([03](03-world-model.md)), which is never rewritten. `title` stays nullable and the panel still has a
fallback, but it now means one thing only — a goal older than the run record itself.

## The spend trend

`buildSpendTrend` (`src/spendTrend.ts`) answers the question the breakdown cannot, being a single
stretch: **is what I did working**. It is served by `GET /api/spend/trend`
([16](16-http-api.md#the-fetched-routes)) and drawn by the Insights page's Trend tab
([17](17-cockpit.md#the-trend-tab)). Eight buckets, three readings, one shared axis.

**A bucket is one window, and there are eight of them.** The axis is the last eight windows _of the
length the operator picked_ (`trendSpan`) — `7d` gives eight weeks, `24h` gives eight days — which is
what keeps one control meaningful on the one tab that is inherently about change. It has a second
payoff: the comparison a headline draws against "the previous window" is literally the last two bars
here, rather than a second notion of "before" for a reader to reconcile. The route's `since` therefore
comes from `trendSince` rather than the window's own, which would fetch a single period and draw seven
empty bars.

**Cost over time is not the answer, which is why this is not a token timeline.** A fleet's bill falls
when it is idle exactly as readily as when it is efficient, so a total per day says nothing about
whether an optimisation worked. Every reading here is therefore a **rate over a unit of delivered
work**.

**The unit is a goal that closed, never a run.** Every per-run rate the harness could report is
gameable for free: split the same work across twice as many smaller agents and input-per-run halves
while nothing whatever improves. A closed goal cannot be subdivided by a dispatch change. It is the
more awkward denominator — goals differ in size — so the **whole cohort's costs are shipped**
(`SpendTrendBucket.costs`) rather than only the median, and the panel draws the spread as points. A
median with no spread beside it lets a week that happened to close three small goals read as
progress.

**A goal lands in the week it closed and carries spend from whenever that spend happened.** The last
closure per goal, so a goal that came back and landed again counts once and in the week it finally
landed.

**Closures come from the ticket mirror, not from `world_events`.** `Store.listTicketsClosedSince`
([14](14-persistence.md#the-ticket-mirror)) returns the `tracker_items` rows in the closed state whose
`changed_at` falls inside the window. The obvious source — the `issue_closed` world event — is the one
that has nothing in it on a real deployment: `diffWorlds` emits that event only for an `open → closed`
transition seen **in place**, and both real issue providers snapshot the tracker's open set
(`listOpenWorkItems`, `listOpenIssues`), so a closed item simply leaves `next.issues` and the
transition is never evaluated. `FakeIssuesIntegration` keeps closed issues in its world, which is why
the suite and the demo site were the only places the cohort ever filled. The mirror is fed by
`listTicketHistory`, which asks by last-changed and returns both states, so the closures are already
there on every existing database — no migration, and nothing to wait a sweep for.

**`changed_at` is a last-modified, not a close date, and that is the trade.** The tracker gives no
close timestamp to mirror and inventing a column would only date closures from the day it shipped, so
a closed item edited afterwards drifts to a later week. A cohort a few items out of place is what this
is measured against — the alternative on every real deployment is no trend at all.

`issue_closed` still exists and is still read elsewhere — the [activity feed](#the-activity-feed) and
anything else that consumes the world's event kinds ([03](03-world-model.md)). Nothing in the trend
depends on it.

### Cohort and period are different weeks

Two kinds of reading share the axis and the difference is stated on every field, because the shared
axis actively invites comparing them:

- **Cohort** — a property of the goals that closed that week, counting spend from wherever it
  happened: `medianCostUsd`, `medianInputTokens`, `costs`, `byPhase`, `reopened`.
- **Period** — what was observed inside the week itself: `settled`, `completed`, `lostCostUsd`,
  `reds`.

**CI reds are a period reading on purpose.** Attributing a red to the goal it eventually belonged to
would need every red inside every goal's lead time, which reaches back further than any window this
module can ask for — and would silently under-report exactly the early weeks it has no history for.
`redsPerGoal` is reds observed that week over goals delivered that week: a rate of pipeline noise
against delivered work, needing no lineage walk.

### Absolutes ride with every share

`byPhase` is **dollars per goal**, not a share, and `SpendTrendPhaseShift` ships both. This is the
reading the whole tab exists for: a fleet that plans more in order to review less shows a rising
deliberation _share_ and a falling deliberation _cost_, and a share column on its own reports that
as a regression. A share is only ever drawn next to the absolute it is a share of.

### What is withheld, and why

**The current week is partial and is dropped from the comparison.** Goals are still closing into it,
so every cohort figure on it is an under-count by construction; folding it into the recent half is
exactly the shape that makes a fleet look like it improved on the day it was read. The panel draws
that bucket hollow.

**`comparison` is null below two complete weeks a side.** A comparison drawn off one week of goals is
noise with a percentage sign on it, and withholding it from the payload is the only way the panel can
be made not to draw it. The weeks counted are the ones that **closed a goal**, not the buckets on the
axis: `trendSpan` returns a fixed eight buckets whatever the data, so a count of buckets is a
condition with one answer and withholds nothing — which is how "$20, was $10, +100%" off one goal a
side reached the headline tile.

**Goals that closed with no measured spend are counted apart** (`goalsUnmeasured`) and appear in no
figure, for `totals.unmeasuredRuns`' reason exactly.

**Reopened goals are read from the world, not from an event.** `diffWorlds` has no `closed → open`
transition to emit, so a goal that came back is only visible as one that closed inside the window and
is nonetheless open in the baseline. It is the one reading here that can contradict the other two: a
fleet that got cheaper by closing goals it had not finished looks like progress on every other chart
in the tab.

**Derived, never stored** — and, unlike a token timeline, **it works on every database from before it
was written.** `usage_events` dates dollars and has never dated tokens, so a per-day token trend
would start empty on the day it shipped; a goal's tokens come off the `agents` rows and are as old as
the goal. That is a large part of the argument for cohorting goals rather than bucketing tokens.

**Fetched on the tab's first visit**, not with the breakdown: it reads two months of world events and
the closed end of the ticket mirror on top of the same all-time agent walk, and a tab an operator
never opens should cost nothing.

## The burn watch

Every reading above is a post-mortem, read by an operator who went looking. `burnPass`
(`src/spendBurn.ts`) is the one cost reading taken **while the money is still being spent**:
`recordAgentUsage` folds a cumulative report onto the `agents` row on every `result` event, so
`Agent.costUsd` climbs turn by turn, and a run that is going to cost forty dollars is answerable long
before it settles.

`SpendBurnDesk` runs it once a pulse from `Harness.runCycle`, beside the other bookkeeping desks and
deliberately not in the dispatcher: it staffs nobody, holds nothing, and no rule reads what it
writes. It is handed the cycle's own `agents` and `tasks` rather than taking its own reads, so the
pulse walks those two tables once. Configured by `spendBurn` ([02](02-configuration.md#spendburn)).

**The comparison is against the run's own kind of work, and the bucket is the rule _and_ the
profile.** That pairing is not a refinement — it is what stops the check being useless. A goal pinned
to a deep profile legitimately costs several times the same rule on a cheap one, so a rule-only
baseline would flag every pinned run on the deployment and nothing else. Both halves are already on
the task, resolved once at dispatch.

**The median, never the mean.** The runaway this exists to catch is exactly the observation that
drags a mean upwards, so a fleet that had three expensive afternoons would quietly raise its own
threshold until nothing could trip it. `rollUpTaskTypes`' `perRunUsd` is a mean and is deliberately
not reused here; it answers "what does this cost me", which is a different question and wants every
run in it.

**Three things must hold together**, because a multiple on its own fires constantly:

- **`minimumRuns` settled runs in the bucket**, or there is no median worth the name. Below that the
  bucket is **absent rather than zero** — a zero would make every live run in a young bucket
  infinitely over its median.
- **`floorUsd` in absolute money.** Four times the median of a rule that costs eight cents is
  thirty-two cents, and a notice about that is the one that teaches an operator to dismiss the next
  one unread.
- **`multiple` itself**, kept generous: the spread inside one bucket is real work, not noise.

`ceilingUsd` is a separate, profile-blind arm for the case the other three cannot cover — a
deployment with no history at all, where the first runaway is also the first run. Off by default,
because the right number is a property of the deployment's work and nothing here can guess it. The
notice says which arm fired: a run flagged for passing a flat ceiling and one flagged against its own
kind of work are different facts, and the ceiling notice says out loud that it is not a comparison.

**It files a note and kills nothing.** An expensive run is not a wrong run, and this module cannot
tell the two apart — a bucket mixes a one-line fix with a goal that touches nine files. Killing on a
threshold would eventually kill work that was going to land. The verdict is a `burn` human task
([13](13-jobs-and-tickets.md#human-tasks)): visible, holding nothing, and answered the same two ways
a bench row is. What the operator lacked was not the stop button but the prompt to go and look.

**The title carries no figure and the detail carries all of them.** `recordHumanTask` dedups on
`(agentId, originRef, title, kind)`, so a title naming the dollars would file a fresh row every turn
the run reported — one notice per pulse, about one agent. The same dedup refreshes the detail in
place, which is what makes the figure an operator reads the one that is true _now_ rather than the
one that tripped the watch.

**It settles itself**, for the close-out sweep's reason — the run it names is a thing it watches every
pulse — with a resolution naming what the run finally cost and how it ended. A notice the operator
already settled is not re-filed while the run continues. Turning the watch off files nothing and
**still settles what is standing**, or a row about a run that ended last Tuesday would have no way
left to close.

**The mock runtime reports no usage at all** ([above](#usage-accounting)), so `costUsd` stays null and
no run there can ever trip this. That is the fail-open direction and the only safe one: unmeasured is not
free, and a watch that cannot see must not be allowed to conclude anything — in either direction.

## The reliability breakdown

`buildReliabilityInsights` (`src/reliabilityInsights.ts`) answers the question the spend breakdown
stops one short of: the money bought _something_, and **did it work**. It is served by
`GET /api/reliability` ([16](16-http-api.md#the-fetched-routes)) and drawn by the Insights page's
Reliability tab ([17](17-cockpit.md#reliability)). Two halves, and they are the two halves of one
funnel:

- **Run outcomes**, over the window. Every agent the harness settled inside it, split by how it ended (`done`,
  `failed`, `crashed`, `killed`, `interrupted`) and by the **spend panel's own phases** — the same
  `phaseOf` classifier, imported rather than re-written, so a row here and a row there are about the
  same set of runs. Plus what the faults cost, the median run length per phase, and the origins the
  harness went round more than once.
- **CI health**, over the same window. Transitions into failing and into passing, the red rate over
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
module**, for the sentinel scanner's reason: a reader that re-derived the format for itself would report
zero failures, silently, the first time the wording changed.

**One fold behind the headline counts.** `tallyRunOutcomes` is exported and called twice — by
`buildStateSnapshot`, which puts `runOutcomes` on `/api/state`, and by this module, which spreads it as
the tab's headline counts over the windowed run list. Two counts of one population written a hundred
lines apart is the disagreement this reading is least able to survive, and agreement by construction is
the only kind that holds.

**Both halves take the window, and that is the change.** The run half used to be all-time and the CI
half a rolling fortnight, so a completion rate and a red rate sat side by side describing two different
stretches of the fleet's life with nothing on the glass saying so. The cut is made **once**, at the
door of `buildReliabilityInsights`, and every fold under it reads the list that produces: applying it
per fold would put the same filter in four places for three of them to get subtly different.
→ [the window](#the-window)

**Derived, never stored,** and **fetched, never polled**, for the spend breakdown's reasons exactly.
Everything it folds — the `agents` rows, `usage_events`, and the `pr_ci` rows of `world_events` — is
already durable, already dated, and pruned by nothing.

**The CI read is ordered, and the order is load-bearing.** `listWorldEventsOfKindsSince` returns
**oldest first**, unlike its two neighbours in `WorldStore`, because the fold pairs each failing with
the _next_ passing. A descending read pairs every red with the green that preceded it and reports the
flakiest pipeline in the repository as recovering instantly.

## Causes: why the fleet came back

The reliability breakdown counts reds and prices them. It cannot say **why** any of them happened,
and a flaky runner, a stale assertion, a missing `.js` extension and a real defect are the same red,
the same dollars and the same row everywhere else the harness draws one. `remedies` is the record
that closes that, and `buildRemedyInsights` (`src/remedyInsights.ts`) is its reading — the Insights
page's Causes tab, on the same payload and over the same window ([17](17-cockpit.md#causes)).

**The agent that fixed it writes it.** `report_remedy` ([11](11-mcp-tools.md)) is called at the end
of a `pr:<n>:ci` or `pr:<n>:comments` dispatch, and the knowledge is at its cheapest exactly then:
that agent read the failing assertion the harness put in its prompt
([07](07-pull-requests.md)) and then made the fix. A post-hoc classifier over CI logs would be a
_second_ opinion about a call the first one already made — the arrangement the phase and CI-status
classifiers above are both refused, and for the same reason.

**Two axes, because a cause and a preventability are different questions.**

- **`cause`** — what was actually wrong. Two taxonomies, one per kind, in
  `src/remedies/remedies.ts`: a CI failure may be `flake`, `environment`, `inherited`, `stale_test`,
  `missed_gate`, `contract_drift`, `defect` or `other`; a review round may be `missed_requirement`,
  `convention`, `approach`, `scope`, `docs`, `clarity`, `defect` or `other`. They are split rather
  than shared because a review round is never a flake and a red check is never a matter of taste, and
  a taxonomy nobody can hold in mind is one where everything lands on `other`. `defect` and `other`
  appear in both under **one name**: a bug the suite caught and a bug a reviewer caught are the same
  fact about the fleet, and two names for it would split the count that matters most.
- **`guard`** — what would have caught it before the push: `local_check`, `documented`,
  `undocumented`, `unpreventable`, in that order, which is the order of what it costs an operator to
  act on each. This is the axis that answers _how do we get fewer of these_, and it is why the record
  is two enums rather than one.

**The kind, the pull request and the checks are never claimed.** `remedyOrigin` resolves the first
two from the caller's own task origin and refuses every other caller by name; the checks come from
`Task.ciChecks`, which is what the harness dispatched that agent about. A `kind` an agent could
assert is a column reporting whatever each agent took it to mean, and the counts would be worth
nothing.

**`undocumented` is the one verdict that may carry a claim**, and it rides on the same call rather
than a second tool — atomic, exactly as a retrospective's lessons are ([27](27-knowledge.md)).
A claim on any other guard is **refused rather than dropped**: a claim reaches every later dispatch
once it is vouched for, so the gate on what may become one has to be visible to the agent raising it.
The claim goes to the knowledge base through the path `raise` uses, so a wall two other agents have
already documented is recorded as agreement rather than as a third copy
([27](27-knowledge.md#the-remedy-arm)). Its provenance is the pull request (`pr:<n>`), resolved from
the credential rather than asserted.

**The remedy row is untouched by any of it.** The account of an event and a durable claim are
different animals: the row keeps its counts and its dollars, it lands whatever becomes of the claim —
including under an operator's rejection of it — and nothing on this page is derived from the
knowledge base.

**An account is not a red, and not a run.** One agent that settled four reds in one dispatch files
one row; a pull request that went red four times over four days collects four. So `accounts` is never
comparable to `CiHealth.reds`, and the panel never subtracts one from the other —
`RemedyInsights.unaccounted` is the honest form of that question and counts **dispatches** with no
account at all, which is the thing an operator can chase. It is drawn with the total rather than in a
footnote, because every share in the section is a share of what was _reported_.

It is counted **by membership, never by subtracting two counts.** The two populations are windowed on
different dates — a dispatch is in the window on its `createdAt`, an account on the date it was filed —
so a dispatch made just before the boundary that filed its account just after appears on one side
only, and subtracting let it cancel a dispatch that genuinely reported nothing. The route therefore
passes the in-window return dispatches' **task ids**, and the fold subtracts the ones an account
names. Same class as the run/call straddle the MCP tab's silence reading has to avoid.

**Money is divided, and the payload says so.** Cost is the filing agent's spend inside the window,
split evenly across the accounts it filed. One agent answering three unrelated reds genuinely spent
its money on all three and no reading says which third went where — dividing is the only claim the
data supports.

**Nothing gates on a remedy.** No dispatch rule, desk or gate reads the table; a pull request goes
green whether or not one was ever filed, and an agent that files none costs the account and nothing
else. There are exactly two readers: this panel, and the prior-remedy note below.

**Derived, never stored,** like every other fold here. A pre-summed table of causes would go stale the
moment one more account landed.

### The note a later dispatch carries

`src/remedies/priorRemedies.ts` renders the record back into the prompt of the **next** agent
dispatched for a red or a review ([05](05-dispatcher.md#the-rule-book)), which is the half that
reduces the work rather than merely measuring it. The saving is the one `ciEvidence` already argues
for — **turns, not bytes**: an agent handed "the last three reds on `format:check` were line endings"
goes to the formatter, where an agent handed the check name alone reproduces the whole gate to find
out what a person already found out three times.

It is **evidence, never instruction**, framed as `renderKnowledgeBlock`'s block is and for its reason: a
wall of assertions read as orders makes every agent worse the moment one goes stale, silently, with
no test able to see it. Every line is attributed to its pull request, ordered newest first, and the
header says out loud that the code in front of the agent is the authority.

Three bounds, and the last is the point. The CI note shows only accounts naming a check that is red
**now** — an account of `knip` is noise on a dispatch about `test`. The review note is not filtered at
all, because there is no review equivalent of a check name and filtering to this pull request would
leave it empty on the first review of every branch. And **what the cap dropped is named**, never
silently cut, exactly as `ciEvidenceNote` names its own: an agent that reads a partial record as a
whole one concludes something from the absence of an entry that was merely trimmed.

The note and the **ask** are separate, and both are appended rather than interpolated
([05](05-dispatcher.md#prompt-templates)). The ask — "call `report_remedy` before you finish" —
renders unconditionally, because the account is the thing being asked for and a fleet with nothing
recorded yet is the fleet that most needs it. The note renders only when the record says something,
so a deployment with an empty table produces byte-identical prompts to a build without the feature.

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
