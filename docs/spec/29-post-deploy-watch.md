# 29 — The post-deploy watch

`src/environments/` records where a goal's landed work has got to ([24](24-environments.md)). It
stops one question short of the one asked next: **is the thing behaving now that it is there.** A
goal reads `reached` at `liveUk` whether the fix worked, did nothing, or made the outage worse — the
subsystem observes deployment and has no opinion about consequence, which is correct for what it is
and is where the operator's job resumes by hand.

This is the layer above. A goal declares, in advance, what a running system would have to show for
the work to have done what it claimed; an arrival opens a window; and for the length of that window
the harness asks the operator's own telemetry, on a schedule, and compares what comes back against
what was declared.

The one-line version, because it is the thing most easily got wrong: **the harness never decides
what to watch for, and never judges a reading.** Both are declared, up front, by parties who already
know — and everything from the declaration onwards is a scripted pass with no model in it.

> **Partly built.** The windows, the readings, the verdict, the bench row, the Signals card,
> [the watch hint and its tick at approval](#the-planner-at-plan-time-writes-a-hint),
> [`{until}` and the baseline that ends at the merge](#until-and-the-baseline-that-ends-at-the-merge) and
> [sources](#sources) are built. **Not yet built**, and each section that describes them says so:
> [authoring the watch on `delivered`](#the-assessor-on-delivered-writes-the-checks) and
> [the accept that releases it](#the-operator-accepts-the-set); [the assessor's stated `none`](#declaring-nothing-is-a-legitimate-answer);
> [the source only the operator can run](#a-source-only-the-operator-can-run);
> [the outcome](#the-outcome) and [discussing it in Claude](#discussing-an-outcome).
> **What runs today instead:** the planner is asked for the hint and not for checks, but a plan document's
> executable `watch` block still parses and is dry-run at submission; the working agent amends them with
> `watch_declare` at conclude time; a check reading an `operator` source is `unknown`, because nothing
> asks a person for it; and the goal page draws every check's verdict with no headline. Remove each item
> from this list in the change that builds it.

## What it is not

| Not                    | Because                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An APM                 | Nothing here stores telemetry, draws a time series, or is somewhere to go and look. It asks a declared question on a schedule and keeps the answers for one goal, for days.                                                                                      |
| Anomaly detection      | No baseline is inferred, no threshold is learned, no reading is scored. An expectation is declared or the check does not exist.                                                                                                                                  |
| An alerting system     | A finding is a bench row on one goal. There is no routing, no severity ladder, no on-call. The team's existing alerts are unaffected and unduplicated.                                                                                                           |
| A dispatch input       | Same rule as the rest of `src/environments/`: nothing under `src/dispatcher/` may import it. A regression files a row and draws a card; the route from a reading to new work is an operator's click. → [05](05-dispatcher.md)                                    |
| A provider integration | An environment's telemetry is a **command**, exactly as its deployed commit is. Application Insights is one answer; the harness holds no opinion and ships no SDK. → [Asking the environment](#asking-the-environment)                                           |
| A gate                 | A watch holds nothing by default. It reports, and the close-out carries what it says. One opt-in makes it hold, and it is off. → [What a finding does](#what-a-finding-does)                                                                                     |
| A point-in-time read   | A window accumulates and asks _is this behaving_. _Is the data this change writes shaped correctly_ is one reading taken at a moment somebody chose, which is a `state` row on a validation sheet and lives there. → [36](36-remote-validation.md#two-lifetimes) |
| A model spend          | No agent is dispatched to read telemetry, interpret a number or decide whether a reading is bad. The only model tokens are riders on sessions already running. → [Cost](#cost)                                                                                   |

## The declaration

A **watch** belongs to a goal and is a list of checks, each of which is one question with one
declared expectation. Two kinds, and the difference is not cosmetic — they fail in opposite
directions and need opposite guards.

| Kind      | Asks                        | Expectation                            | Cannot be trusted without |
| --------- | --------------------------- | -------------------------------------- | ------------------------- |
| `signal`  | how many of these are there | `tolerate`, a count it must not exceed | a `presence` query        |
| `measure` | what is this number         | a threshold, or a baseline             | a baseline reading        |

A signal asks about something that should not be happening: exceptions, failures, retries, a log
line that only gets written when something has gone wrong. Its expectation is a count, almost always
zero.

A measure asks for one number: a percentile, a rate, a duration, a queue depth. Its expectation is
either an absolute (`under`, `over`) or a comparison against what the same query returned **before
the work arrived**.

Both are declarable. A `measure` arrived with the baseline capture that makes it honest — an
absolute threshold alone is a number somebody guessed, and a measure declaring neither a threshold
nor a baseline reads as a check and cannot fail, which `WatchSchema`
(`src/validation/watchDocument.ts`) refuses at ingestion. A measure's expectation is written as
`expect`:

```jsonc
"measures": [
  {
    "id": "orders-p95",
    "title": "The orders proc is no slower than it was",
    "query": "requests | where timestamp > datetime({since}) | where name == 'POST /orders' | summarize value = percentile(duration, 95)",
    "expect": { "noWorseThan": "baseline" }, // or { "under": 500 } / { "over": 99.5 }
    "unit": "ms",
  },
]
```

`noWorseThan: "baseline"` is read **lower-is-better**, which is what a percentile, a duration and a
queue depth all are; a measure whose good news is a bigger number declares an `over` instead. That is
one rule rather than a per-measure direction, because a direction field would be a second thing to
get wrong about a comparison the thresholds already express.

A measure declares no `presence`, and that is not an omission. Presence exists because zero rows is
indistinguishable from a healthy release; a measure that answers no row at all is already `unknown`
under the output contract, which requires exactly one row carrying a numeric `value`.

### Every query carries `{since}`

**A watch query declares its own time bound, written against the `{since}` token, and one that carries
no token is refused at ingestion** — `carriesSince` (`src/validation/watchQueryShape.ts`), beside
`aggregatingTail` and through the same `refuseQueryShape`, so all three writers are held to it by one
rule. Signals, their presence queries and measures alike; the author writes the `where`, because which
column carries the time — `timestamp`, `TimeGenerated`, something a `project` renamed — is a fact about
their telemetry and not one the harness may guess:

```kusto
traces
| where timestamp > datetime({since})
| where customDimensions.MessageTemplate startswith "Statement workflow {AttemptedWorkflow} rejected"
```

The harness substitutes the instant the reading is about, before the query reaches a shell: **the
moment the work arrived on that environment** for a window's reading (`watch_windows.opened_at`, which
is the arrival), and **one window's length before the merge** for the dry run that takes the baseline
([`{until}`](#until-and-the-baseline-that-ends-at-the-merge)). One query, two clocks, which is the
arrangement the two readings were always asking for — the dry run proves the defect is real _before_
the fix, and the window asks whether it is still happening _since_ the fix.

This is the one refusal whose absence is indistinguishable from the subsystem working, and it fails in
the direction that reads as a regression rather than as a fault:

- **An unbounded signal counts the defect it was declared for.** The retention period contains every
  occurrence from before the work shipped, so a `tolerate: 0` check reads `regressed` on its first
  reading and on every reading after it, and settles regressed — a bench row in front of an operator
  reporting the bug the goal fixed, with numbers that are correct and an answer that is not.
- **An unbounded presence query proves nothing.** It answers rows because the code path ran at some
  point in the retention period, which is not what it is asked: it exists to say the path is running
  _now_, on the environment the window is watching, and an environment where the job has stopped
  running answers exactly as an environment where it is running fine.
- **An unbounded measure is not the number the work is about.** A percentile over the whole retention
  period is dominated by the period before the change, which is the comparison the baseline already
  makes — and makes it against itself.

A check declared before the token existed is not silently read: `preparedQuery`
(`src/environments/watchResult.ts`) hands back a refusal rather than a query, and both observers route
through it, so the reading is `unknown` and says why. Not `regressed`, which would be the false finding
this refusal exists to stop, and not `clean` — `unknown` never folds to clean
([the verdict](#the-verdict)), and a query nothing bounds has not answered the question.

`state` queries ([36](36-remote-validation.md)) carry no such token and are not held to this, which is
the two lifetimes apart: a state row is one reading taken at a moment somebody chose, about the shape
of data rather than about a period.

### `{until}`, and the baseline that ends at the merge

A second token, `{until}`, bounds the other end. A **measure's query must carry it**, refused at
ingestion by `carriesUntil` beside `carriesSince` (`src/validation/watchQueryShape.ts`), through the
same `refuseQueryShape`, so the plan document's `watch` block, `watch_declare` and the operator's
`WatchCheckSchema` are held to it by one rule. A signal's query and its `presence` query may carry it,
and should. Both tokens are replaced by `withPeriod`, through `preparedQuery`.

| Reading                  | `{since}`                            | `{until}` |
| ------------------------ | ------------------------------------ | --------- |
| A window's reading       | The arrival on that environment      | Now       |
| The dry run and baseline | One window's length before the merge | The merge |

**The merge** is the instant the goal's last pull request merged, the commit its delivery was
assessed on. That is the last moment the change is known not to be running anywhere, and it does not
move afterwards.

It is read from `goal_landings` (`goalMergedAt`, `src/environments/landings.ts`): the latest
`merged_at` among the goal's landings, leaving out a squash the clone placed off the integration
branch, since that is not when the work reached anything. `merged_at` is the provider's own closing
time for the merged pull request — GitHub's `closed_at`, Azure's `closedDate` — stored when the sweep
records the landing, and a [carried](24-environments.md#a-stacked-pull-request-rides-its-carrier)
landing takes its carrier's, because that merge is when the stacked work reached the integration
branch — and keeps its own where the carrier's row has none, since its own merge onto the topic branch
is earlier, which is the safe side for a baseline to end on. It is the provider's instant rather than the landing's own `recorded_at`, because `recorded_at`
is when the harness _noticed_: a pulse later at best, and as late as `closedPrWindowMs` after a
restart that straddled the merge — late enough for a fast deployment to be inside the baseline. A row
from before the column, or one the provider gave no time for, has `recorded_at` stand in; that is the
right side of the error to be on only because nothing earlier is known, and it heals nothing, so it is
said here rather than hidden. Not the delivery verdict's time either: the assessment runs after the
merge, by however long the assessor took.

**Before anything has merged**, the dry run falls back to the window ending now — `{until}` is now
and `{since}` one window before it — which is exactly what a dry run read before the token existed.
That is the plan-time dry run, which still runs today, and an amendment taken before the goal's first
landing; the work is not running anywhere then, so _now_ is as good an end as the merge would be.

That is the one decision this section makes, and it exists because checks are now written after the
merge. A baseline read over _one window before now_ was right when it was taken at plan time, weeks
before anything shipped. Taken on `delivered`, "now" can already be after a fast deployment, and a
baseline that includes the change is the change compared with itself, which reads `clean` on any
regression. Ending it at the merge makes it the same reading whenever it is taken, by the harness on
`delivered` or by a person [days later](#a-source-only-the-operator-can-run), as long as the source
still holds that period.

It also gives back what plan-time checks used to prove. A signal's dry run over the window before the
merge reads the defect while it was still running, so `fires` there is still the evidence that the
defect was real and that the query sees it.

`LUBBDUBB_WATCH_UNTIL` is passed beside `LUBBDUBB_WATCH_SINCE`, for the wrapper that assembles its
own query. A check declared before the token existed carries no `{until}`. Its window readings are
unchanged, because `{until}` would be now anyway. A **measure's** dry run after the merge is refused by
the dry run itself (`WatchDryRun`, `src/environments/watchDryRun.ts`) before anything is put to the
environment — a measure that cannot be ended at the merge would read the change into its own
baseline — so it reads `unknown` with `missingUntilRefusal` as its reason, never a baseline taken over
the wrong period. Only the dry run knows its period ends in the past, so the refusal is its own rather
than `preparedQuery`'s. A
signal without `{until}` keeps working: its dry run proves the query resolves and the defect fires, and
reading on past the merge widens that question without turning it into a false one.

A window's period is `watchPeriod` (`src/environments/exposure.ts`), taken once per window per pass,
so every check read in that pass shares one `{until}`. A finding's bench row draws the query through
the same helper, with `{until}` at the reading that regressed (`watchWindowReadings`,
`src/environments/watchFinding.ts`).

### A signal query returns rows, never a count

**A signal's `query` and its `presence` query each answer one row per occurrence, and the harness
does the counting. A query that aggregates is refused at ingestion**, by `WatchSchema`
(`src/validation/watchDocument.ts`) through `aggregatingTail`
(`src/validation/watchQueryShape.ts`), so all three writers — the planner's `watch` block, the
working agent's `watch_declare` and the operator's own edit through `WatchCheckSchema` — are held to
it by one rule rather than by three.

The refused shape is a **scalar** tail: `| count`, `| summarize` with no `by` clause,
`| make-series`, and a pipe-less `select count(…)` with no `group by`. A `summarize … by role`
answers one row per group, which is one row per occurrence of a group, and is accepted.

This is the one output-contract mistake that defeats every guard the subsystem has, which is why it
is refused rather than documented:

- **The verdict is permanent.** `watchCheckVerdict` counts `rows.length` against `tolerate`, and an
  aggregate answers exactly one row whatever its value is — so a `tolerate: 0` check reads
  `regressed`, on every reading, for the life of the watch, on the arithmetic being right.
- **`presence` is neutralised.** An author who aggregates the signal usually aggregates the presence
  query too, and an aggregating presence query can never answer zero. The arm that exists to catch a
  query naming an operation that does not exist reports the code path live on an environment where
  it has never run.
- **The dry run inverts.** A correct signal matching nothing reads `zero` and is handed back; an
  aggregate reads `fires` and hands the operator positive evidence for accepting it.

The prompts say it where the query is written rather than only here — the `query`, `presence` and
`tolerate` field descriptions on both schemas, and both notes in `src/plans/planning.ts`. `tolerate`
is _how many rows the harness may count_, and a field described as a count is half of why the
mistake gets made.

A **measure** is exempt, and that is the point of the two kinds: a measure is required to answer
exactly one row carrying a numeric `value`, which is precisely the shape a signal may not have.

`state` queries ([36](36-remote-validation.md)) are held to the refusal too, through this same
`aggregatingTail` rather than a second copy of it: they are read by a different executor against a
different clock, and the mistake they can make is identical.

The two shapes are the two things a change is for. New behaviour should not throw — a signal, and
there is no before to compare against. Changed behaviour should be better than it was — a measure,
and an absolute threshold is a number somebody guessed where a baseline is a number that was
measured.

### Why it is declared and never derived

The harness can see that an environment started logging something it had not logged before. It
cannot see that the rewritten proc is 40ms slower at p95, that the retry it added is now masking the
failure it was meant to fix, or that the one exception that matters is drowned in the four hundred
that were always there. Deriving would mean the harness forming an opinion about what a change was
_for_, from evidence it does not have — the thing refused at every other point where a positive
terminal could have been guessed at (`conclude_part`'s `kind`, `undeclared` versus `more_work`, a
validation result inferred from a green build → [20](20-validation.md#states)).

So the question is written down by somebody who knows, and the harness runs it.

### Declaring nothing is a legitimate answer

A goal with nothing running to watch — a refactor, a docs change, a build fix — declares no watch,
and its reading is **null**. Null is a third fact and not a synonym for clean, exactly as a goal that
declared no validation checks is not a goal whose checks all passed
([20](20-validation.md#the-flag)). Nothing counts watches, nothing rewards a longer list, and a
surface that folded null into clean would report the whole fleet as verified.

**Declaring nothing is said, never left unsaid.** Where some environment declares a `watch`, null is
not what a planner gets by writing nothing: the plan's hint is either intents or `none` with a reason,
and a plan document with neither is refused. The reason is drawn on the plan sheet and ticked at
approval. **Not yet built:** the authoring agent's `watch_plan` call either declares checks or carries
an `emptyReason`, refused without one, and the reason is shown as the goal's [outcome](#the-outcome).

This is what the feature was missing, and the reason it rarely fired. Both prompts said that declaring
nothing was a legitimate answer, and nothing asked why, so the cheapest reply to a prompt with a
schema, a dry run and three refusals in it was the one that wrote nothing. That reply still exists. It
just has to say why, and an operator reads the reason before any work is released. A refactor is
still allowed its `none`: forcing a check onto a change with nothing running to watch gets you a
query that can only ever read clean, which is worse than null, because it reports a verification
that never happened.

## Who writes it, and when

> **Not yet built**, apart from [the hint](#the-planner-at-plan-time-writes-a-hint),
> [its tick](#the-operator-ticks-the-hint) and [the operator's own edits](#the-operator-at-any-point),
> which run today. What runs instead of the rest is in the marker at the top of this document.

Three moments, and the shape is validation's check set exactly
([20](20-validation.md#when-the-check-set-is-written)), for its reason. **A watch written at plan
time is a guess about code that does not exist yet.** It was written there first, and it went wrong
the way validation's checks went wrong: the work started, a reviewer asked for a retry on deadlock,
the fix stopped producing the timeout the plan's signal counted, and the check described a change
nobody had shipped. The `watch_declare` tool was the apparatus built to survive that, and it only
reached the agent that wrote the first part — never the one fixing a review comment, which is where
the design actually moved.

So the checks arrive late instead, and the plan carries what is honestly knowable before any code
exists: what _worked_ would look like, in words.

|            | **The hint** (plan time)            | **The checks** (after `delivered`)    |
| ---------- | ----------------------------------- | ------------------------------------- |
| Written by | The planner, in the plan document   | The assessor, in the turn it delivers |
| Against    | Code that does not exist yet        | Merged code                           |
| Shape      | Intents in prose, or `none` and why | Queries, each on a named source       |
| Read by    | An operator, who **ticks** it       | The operator, who **accepts** it      |
| Binds      | Nothing                             | The windows, once accepted            |

### The planner, at plan time, writes a hint

The plan document carries **`watchHint`** ([08](08-planning.md#the-plan-document),
`src/plans/planDocument.ts`, its schema in `src/plans/watchHint.ts`), and it is **required** wherever
`watchNote` is appended — that is, wherever some environment declares a `watch`. It is one of two
shapes, and a hint carrying both or neither is refused:

```jsonc
"watchHint": {
  "intents": [
    {
      "kind": "signal",          // or "measure"
      "source": "logs",          // a source name some environment declares — a guess, binding nothing
      "says": "The statement job stops timing out",
      "why": "~37 timeouts a day in traces today; the ticket is about exactly these"
    }
  ]
}
// or
"watchHint": { "none": "Docs-only change: nothing running behaves differently" }
```

It carries no query, no `tolerate`, no threshold and no `presence` — an intent naming any other key is
refused. Those are facts about code, and the planner is writing before the code exists. `kind` and
`source` are there so the operator can see what _sort_ of evidence is coming, and so the planner has to
think about where it would be read. The assessor is free to change both.

**One test decides whether a hint is required, and both halves read it.** `watchHintRequired`
(`src/plans/planning.ts`) is true when some environment declares a `watch`; `watchNote` is empty
exactly when it is false, and the planner's two submission paths — `plan_submit` and the plan file —
pass it to `validatePlanDocument` as `{ watchHintRequired }`, which refuses a document with no hint.
A hint that is present is held to its shape everywhere, required or not; what is _not_ required
anywhere else is its presence. An amendment, a regroup or a rewrite at the operator's own keyboard
is never asked for one, and a document without one **leaves the standing hint alone**, as an absent
`validation` or `watch` block leaves its rows alone. A replan that carries one replaces it.

**The `watch` block still parses, and is no longer asked for.** `watchNote` asks for the hint and
tells the planner not to write executable checks; the tool schema says the same of `watch`. A plan
that carries one anyway — a planner or a template override written before the hint — is ingested and
dry-run exactly as before, until [the assessor writes the checks](#the-assessor-on-delivered-writes-the-checks)
and the block goes.

**For a defect this is still the strong case: the bug report _is_ the signal.** A ticket reading _"job
X keeps timing out in proc Y"_ contains its own intent — job X stops timing out — and the planner can
write it before a line of the fix exists. What used to be proved at plan time, that the defect is real
and the query sees it, is now proved by the authoring dry run, which reads
[the period before the merge](#until-and-the-baseline-that-ends-at-the-merge), when the defect was
still running. The proof comes later than it did, but it is the same proof.

### The operator ticks the hint

The hint is a caveat on the approval card ([08](08-planning.md#what-the-plan-raises-is-acknowledged-not-merely-rendered)),
id `watch`, labelled **How we'll know it worked**, with the intents — one line each, `**signal** · logs —
The statement job stops timing out`, its `why` in brackets — or `Nothing to watch:` and the `none`
reason, as its detail (`watchHintDetail`, `src/plans/watchHint.ts`). `planCaveats` raises it from the
stored `plan.watchHint`, so a plan with no hint raises none. Approve is held until it is ticked,
exactly as it is held for the planner's risks.

It is the one caveat raised on **every** plan where a hint is required, and that departs on purpose
from the rule that a gate firing on every plan gets ticked blind. A tick there is not a warning being
acknowledged. It is the operator agreeing, before anything is built, what _worked_ is going to mean,
and that is the agreement the whole outcome is measured against. The detail is different on every
plan, which is what stops it becoming a reflex. A tick can carry words like any caveat's, kept on the
plan as any caveat's are. **Not yet built:** those words reach the assessor with the hint.

On a deployment where no environment declares a `watch`, no hint is asked for, so no box is drawn
unless a planner volunteers one — and one volunteered is held to the same shape.

### While the work happens, nothing is asked

**Not yet built.** No working agent is asked about the watch. `watchDeclareNote` is no longer appended
to `plan-part`, and **`watch_declare` is retired** into `RETIRED_TOOL_NAMES`
([11](11-mcp-tools.md#retired-tools)), answering with a refusal that points at the assessor. The hint
binds nothing, so an agent fixing a review comment or a red build has no earlier assessment to keep
true, and can make the fix the code needs. Being bound by the watch is exactly what this stage must
not do to it.

One sentence stays, appended to `plan-part` and the pull-request fix prompts and never interpolated:
_if you added a log line, a metric or an exception that says whether this is behaving, say so in the
pull request description_. The assessor reads the merged pull requests, and the message template is
in the diff either way. The sentence just makes it findable. It is still the second-order reason this
subsystem exists: an agent with a reason to instrument its own work instruments it.

### The working agent, at conclude time

**Built, and retired by the section above when it lands.** Today the agent working a part amends the
plan's checks through `watch_declare` (`src/mcp/tools/watchDeclare.ts`), named by `watchDeclareNote`
(`src/plans/planning.ts`), which is appended to `plan-part` and never interpolated. It merges on a
check's slug as `validation_amend` does, parses with `WatchSchema`, adds and amends and withdraws
nothing, and lands as a pending change an operator accepts or declines
([the plan sheet](#in-the-cockpit)). It is the only party that can see the message template it
just wrote, which is why the assessor now writes the checks: the assessor can see it too, and so can
every agent that changed the code after this one did.

### The assessor, on `delivered`, writes the checks

**Not yet built.** The assessor already casts the verdict and, on `delivered`, authors the validation
check set ([20](20-validation.md#one-agent-two-outputs)). It writes the watch third, with
**`watch_plan`** (_src/mcp/tools/watchPlan.ts_), because it is the one agent standing in the merged
code with every part settled — the only point at which the message template, the operation name and
the shape of the fix are all known and none of them will move.

The order is the safety, as it is for the check set, and the fallback is the same shape:

| The turn ends                     | What stands             | What happens next                                   |
| --------------------------------- | ----------------------- | --------------------------------------------------- |
| Before the verdict                | Nothing decided         | Unchanged                                           |
| After the check set, before watch | Goal parked, watch owed | Rule `watch-plan` fires on the next pulse           |
| After all three                   | Parked, both authored   | `watch-plan` sees an authored watch and stands down |

Rule `watch-plan` (_src/dispatcher/rules/watchPlan.ts_, a `DISPATCH_PIPELINE` entry registered in
`STAGES`, ranked directly below `validation-plan`) is the catch-up, on the origin
`issue:<n>:watch-plan` declared in `src/issueOrigins.ts`. It dispatches a code agent into a read-only
checkout of the default branch, and it is gated on four things: the goal is parked as delivered, it
has a plan, its watch has not been authored, and some environment declares a `watch`.

`watch_plan` declares the **whole** watch: omission is withdrawal, as with `validation_plan`. It is
parsed with `WatchSchema`, so every refusal below — `{since}`, a scalar tail, a signal with no
`presence`, a measure with nothing that could fail — holds the assessor exactly as it held the
planner. It requires a **`note`** on every call, saying where the checks departed from the hint and
why. _The plan said "stops timing out"; part 2 added a retry, so a timeout no longer means a failure,
and the honest check is "fails after all retries"._ An operator who ticked an intent is entitled to
see what became of it. It requires **`emptyReason`** on a call declaring no checks. It refuses a goal
with no standing delivery, so `more_work` writes nothing, and the code a check would be written
against cannot move under it.

The hint and the operator's words on its tick are appended to the assessor's prompt as an **input,
not an instruction**, in `authoringBriefing`'s words: check what the hint names where the merged code
says it still matters, drop what the code no longer does, add what the hint could not have known to
ask for, and say so in the `note`. What is refused is departing silently, never departing.

Each check is [dry-run](#the-dry-run) as `watch_plan` records it, and a measure's
[baseline](#until-and-the-baseline-that-ends-at-the-merge) is taken in the same spawn. A dry run that
hands a query back is answered to the assessor in the tool's reply, so it can fix the query in the
same turn.

### The operator accepts the set

**Not yet built.** What `watch_plan` writes lands **proposed**, not live: the `goal_watches.live` and
`proposal` columns that held `watch_declare`'s pending changes now hold the assessor's set, and
`listGoalWatches` stays live-only. Nothing a model wrote is put to an environment on a schedule until
a person has read it. The dry run is the one exception, and it always was.

The goal page's Signals card draws the set with the `note` above it, each check with its source, its
query, what its dry run read and — where it changed from the hint — a **changed from plan** chip.
Three answers:

- **Accept** — the checks go live, together. This is the second click of the flow, and it is the one
  that authorises a query to run against the operator's telemetry with the operator's credential, on
  a schedule, for days.
- **Edit** — the operator's own edit on one check ([below](#the-operator-at-any-point)), which leaves
  the rest proposed.
- **Send back**, with words — the watch is un-authored and `watch-plan` dispatches again with those
  words appended. This is the check set's
  [send-back](20-validation.md#when-an-operator-sends-a-check-set-back), on the same record.

**An arrival that lands before the accept is held, not lost.** A fast deployment can arrive before the
assessor has written anything, and the rule that a window opens only for a fresh arrival would
otherwise mean the watch never ran on the one environment it was for. So the arrival pass
**cuts staleness first** and then defers an arrival whose goal's watch is owed or proposed, leaving it
unstamped — `sheetableArrivals`' arrangement exactly
([20](20-validation.md#one-agent-two-outputs)). When the set is accepted, the window opens sized from
the **arrival**, and its first reading's `{since}` is that arrival. A reading taken late still covers
every minute the change has been running. An empty or sent-back-and-abandoned watch stamps the arrival
and opens nothing.

### The operator, at any point

**Approves**, first: an agent-authored query is not run against an environment until the plan
carrying it is approved, and an amendment lands as a pending change rather than taking effect. That
approval is the whole of the authorisation story — the query runs inside the operator's own command,
with the operator's own credential.

And **writes, edits and deletes**, from the goal's own page — the Signals card
(`web/src/components/SignalsSection.tsx`, `PUT` and `DELETE`
`/api/issues/:number/watch/checks/:checkId`). A plan document is written once, weeks before the work
ships; a query that names the wrong operation is wrong for as long as it stands, and re-opening the
plan to fix one is not what happens. So the third writer is the one holding the running system, on
the page they are already on. A declaration written here is refused by `WatchCheckSchema` — the plan
document's own rules, so a signal still cannot be written without a `presence` query and a measure
still cannot be written with nothing that could fail it — and it **runs the dry run in the same
call**, exactly as accepting an agent's declaration does, which is what puts it to an environment
once and takes a measure's baseline.

**A check the operator wrote or edited is `authored: 'operator'`, and a replan does not touch it.**
This is the one exception to _a document speaks for the whole watch_
([`ingestGoalWatch`](#persistence)), and it is exactly as narrow as it needs to be: a check they
wrote was never in the document, so sweeping it would be a replan deleting somebody's work without
their seeing it, and a check they edited is a deliberate correction of the plan's wording, so the
plan's version of that id is dropped on the floor rather than restored on the next amendment. The
opposite reading — the plan wins — makes the goal page a surface whose edits quietly expire, which is
worse than one that cannot edit at all.

A **delete** takes any check, the planner's included, with the readings taken against it; the plan
re-declares its own on the next replan, because the document still says it. That is the honest
outcome rather than a surprise: what a delete removes is a check, not the plan's opinion. An **edit**
clears the dry run, the baseline and the window's readings **only where the query or the `presence`
query changed** — a reading is a reading of _that_ question, and a re-worded title or a moved
threshold is the same question. The distinction is load-bearing for one field only: a baseline is
read _before the work arrived_, and after an arrival it cannot be retaken.

An accepted `watch_declare` proposal does **not** make a check the operator's. It applies text to a
row that already has an author, and a replan is still entitled to replace it — which is the behaviour
that was there before `authored` existed, kept.

**Not yet built:** with checks authored on `delivered`, a replan no longer writes checks, so it no
longer has anything to sweep. The assessor's `watch_plan` is what speaks for the whole watch, and a
check the operator wrote or edited is still left alone by it, on exactly this argument. A
`watch_plan` call that omits an `authored: 'operator'` check does not withdraw it. An accepted set is
`authored: 'assessor'`.

## The dry run

**A declared check is run once, immediately, against the environment it will watch** — at plan
submission, and again on each amendment. The reading is stored on the check and drawn on the plan
sheet.

**Not yet built:** with checks authored on `delivered`, the dry run is taken when `watch_plan`
records them and when an operator writes or edits one, and it is drawn on the Signals card beside the
accept rather than on the plan sheet. A plan carries a hint and no queries, so nothing is dry-run at
plan submission. What a dry run proves, and the three readings below, are unchanged.

Three outcomes, and each is worth something different:

| Presence | Signal | Means                                                                                                         |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| fires    | fires  | The query is proven live and the reported defect is proven real. This reading is the baseline.                |
| fires    | zero   | The code path runs and the thing being reported is not happening. Either the query is wrong or the ticket is. |
| zero     | —      | The telemetry has never heard of this code path. Wrong name, wrong application, or nothing instrumented.      |

A fourth reading is handed back the same way: a signal that answers **one row carrying one number**
and nothing else. That is the signature of a query that aggregated somewhere the schema could not
see it — inside an operator's wrapper, or in a tail the tail-detector does not know — and the dry run
is the cheapest place to catch it, before the operator spends a credential accepting it
(`scalarShaped`, `src/environments/watchResult.ts`). A signal legitimately matching one occurrence
with one numeric column is refused too, and told what to write; a second column is enough to say it
is rows.

Rows two and three are handed back to the author as a refusal it can act on, the way a schema
violation from `plan_submit` is. A syntactically valid query against a table that exists, matching
nothing, forever, is the failure this whole subsystem is most able to produce and least able to
notice — and the dry run is where it is cheap to catch, before an agent has spent a day on the work.

**It is put to one environment, not to all of them** — the first that declares an `observe`. A dry
run answers "does this query parse and resolve", which is a property of the query rather than of the
deployment, and asking every environment would spawn a process per environment per check on every
submission to learn the same thing several times over. Where the answer legitimately differs between
environments is exactly what `presence` is for, and that is asked at watch time, per environment.

An amendment re-asks. The reading is a reading of _that_ query, so a re-declaration clears the
columns rather than leaving the previous answer standing under new text — and a check an amendment
stopped declaring is dropped, because at this stage the row carries nothing but its declaration and
the dry run of it, both of which the amendment has replaced. (Once a window's readings hang off a
check, dropping the row would orphan them; the plan document records that as the open question it
is.)

**What a dry run proves is that the query parses and resolves, never that it will ever match.** The
operation it asks about may not exist until the change deploys. Syntax is settled here; whether the
pipe is live at watch time is `presence`'s job, below. Two failures, two guards, and neither folded
into the other.

### `presence`, and why a signal is not trusted without one

A signal query naming an operation that does not exist returns zero rows. **Zero rows is
indistinguishable from a healthy release**, and it is the direction that reads as success — so the
harness would report a fix verified on the strength of a typo.

So a signal declares a second query whose only job is to prove the code path is running at all, and
a signal is allowed to report `clean` only while its presence query is answering. Presence zero is
`unknown`, and says so in words: _the watch could not read this environment — the job has not run
here_.

This is not hypothetical tidiness. The commonest real case is the first environment a goal reaches:
an acceptance environment where the scheduled job does not run, the queue is empty and no real
traffic arrives. Everything there answers zero. Without presence, every goal is verified on the
environment where nothing happened, and the card says so in the operator's own words.

### The baseline, and why a measure is not trusted without one

A measure declared with `noWorseThan: "baseline"` has its query run at **declaration time**, days
before the arrival, and that reading is stored on the check (`goal_watches.baseline_value`). It is
the number the work has to beat, taken on the same query, from the same source, before anything
changed. Its period is **the window that ends at the merge** — `{until}` the merge and `{since}` one
`forMs` before it, the same length the window it will be compared against runs for, through
`watchWindowMs` rather than a second reading of that field — so the before and the after are measured
over spans of the same size, and the before holds none of the change however late it is taken. Before
the goal has merged it ends now, as set out in [`{until}`](#until-and-the-baseline-that-ends-at-the-merge).

**It rides the dry run rather than being a second call.** The dry run already puts the query to an
environment the moment it is declared, so the baseline is that reading kept rather than discarded —
one spawn, one answer, and no second code path free to ask a different question of a system that had
already changed. A dry run that did not answer therefore leaves the baseline null, which is
_never taken_ and not zero: a measure declaring `noWorseThan: "baseline"` with no baseline reads
`unknown`, because a comparison against nothing is not a comparison that passed.

An absolute threshold is allowed and is the right shape for new behaviour that has no before. It is
the wrong shape for an optimisation, where it is a number somebody guessed and where the interesting
comparison — did this actually get better — is available for free.

A measure declaring **neither** a threshold nor a baseline is refused at ingestion. It reads as a
check and cannot fail, which is the shape most likely to be written by somebody who meant to come
back to it — `arrival.opens: []`'s refusal, one document over.

## Asking the environment

`EnvironmentObserver` (`src/environments/observer.ts`), a seam beside `EnvironmentProber`, with a
scripted fake for the tests. One method: **run this query against this environment and give me back
what it said.**

`CommandEnvironmentObserver` runs the `observe` command of the [source](#sources) a check reads, in a
shell in `repoRoot`, exactly as `CommandEnvironmentProber` runs `at` (`src/environments/prober.ts`).

### The query is passed by environment variable, and its return is verified

`LUBBDUBB_ENVIRONMENT`, `LUBBDUBB_WATCH_ID`, `LUBBDUBB_WATCH_SOURCE` (the source's name, so one
wrapper can serve several), `LUBBDUBB_WATCH_QUERY`, `LUBBDUBB_WATCH_SINCE` and `LUBBDUBB_WATCH_UNTIL`.
The operator's command is two lines and reads the query out of the variable. `{since}` and `{until}` are
already substituted in what `LUBBDUBB_WATCH_QUERY` carries — a wrapper has nothing to fill in, and the
instants are passed beside it only so one that assembles its own query can say what period it read.

A window's reading also carries **`LUBBDUBB_WATCH_COMMITS`**: the goal's landed commits, the ones its
arrival was confirmed on, space-separated. It names _the change_ rather than the build deployed now,
which is what lets a wrapper on a staged rollout bind "tenants on any build that contains every one of
these" ahead of the query — a hotfix mid-window is another build that contains them, not a narrower
reading. It is absent at the [dry run](#the-dry-run), which is taken before anything has landed, so a
wrapper that scopes on it must read unscoped when it is unset; the dry run proves syntax and nothing
more either way. The harness cannot check that a wrapper scoped on it — an id echo proves the query
was run, not how it was filtered — which is why a staged environment declares an
[exposure](#exposure) as well, and why that is the backstop rather than the prose.

This is a deliberate departure from `at`, which passes **nothing** in, and the reason for the
departure is worth stating because it is the rule that keeps it safe. `at` refuses a parameter
because an operator's command that never learned about a `{commit}` placeholder would silently
answer a wider question — the prompt-template failure in another costume
([05](05-dispatcher.md#prompt-templates)). A per-goal query is unavoidably a parameter, so instead of
avoiding the failure the harness makes it **observable**:

- the harness appends its own projection to a `kql` query it hands over, carrying the check's id
  (`idProjection`, `src/environments/watchResult.ts`), and a wrapper for any other language echoes
  `LUBBDUBB_WATCH_ID` into each row;
- a result that does not carry that id back is not an answer. It is `unknown`, with the detail _the
  command answered without the query it was given_.

The projection is written as a pipeline segment — `| extend lubbdubbWatchId = "<id>"` — and is
appended only where the source's language is `kql` ([what a language changes](#what-a-language-changes)).
That is the one place the harness has an opinion about a query language: every other source's wrapper
echoes `LUBBDUBB_WATCH_ID` itself, and the verification is identical either way.
Interpolating the id is safe where interpolating the query is not, and for a stated reason: the id is
the check's own slug, which the document schema holds to kebab-case, while the query is
agent-authored and reaches the shell only as a variable's value.

A stale wrapper script that ignores the variable and runs something hardcoded therefore fails loudly
on its first reading, where a dropped placeholder would have answered confidently and wrongly
forever. The same mechanism is also the injection boundary: agent-authored text reaches the shell as
a variable's value and never as part of a command string.

### The output contract, which is all the schema the harness has

The harness knows nothing about Application Insights, Kusto, `customDimensions` or `exceptions`. It
imposes a shape on what comes back and reads nothing else:

- the command prints a **JSON array of rows** on stdout and exits 0;
- a **signal** answers with rows; the harness counts them, and renders up to two named label columns
  verbatim if present;
- a **measure** answers with **exactly one row** carrying a numeric `value`;
- every row must carry the id echo, in the column `lubbdubbWatchId`.

Anything else — a non-zero exit, a timeout, no output, output that is not a list of rows, three rows
where one was required, a `value` that is not a number — is the observation failing, which is
`unknown` and never `clean`. That includes the silent success, for `at`'s reason: a query with
nothing to report and a broken query print the same thing.

**An empty result carries no echo, and that is not a hole in the guard.** Zero rows is exactly the
answer a signal is not allowed to be trusted on alone, which is why it declares a `presence` query —
and a presence query's own rows are where the echo is checked, on the read that is not permitted to
come back empty. A wrapper that has stopped honouring `LUBBDUBB_WATCH_QUERY` therefore fails on the
first reading either way.

A reading is killed after 30 seconds, and the kill answers nothing.

### How an author learns the schema

The harness does not know it and does not need to; the author does. Four sources, cheapest first,
and the dry run is the backstop that means none of them has to be complete:

- **The repository.** For a check about a line the agent just wrote, the message template is in its
  own diff. This covers the case nothing else can.
- **`schema`**, prose on the environment: what table structured logs land in, what the role names
  are, where properties live. Fifteen lines an operator writes once, appended to the prompt —
  appended, never interpolated ([09](09-execution.md)).
- **`describe`**, an optional command whose output is cached and appended the same way. A schema
  query, a sample row, whatever answers "what does this look like" on that stack.
- **The repository.** What an author gets wrong once — a property that arrives as a string and needs
  casting — is something true of this deployment that the repository does not state, and the place
  for it is the repository's own documentation, written down once rather than rediscovered at full
  price by every agent.

## Sources

Everything above says _the_ `observe` command, which is one source. Real telemetry is not one thing. On the deployment this was built for, App Insights is reachable with
the `az` login the harness already runs under, and the SQL database behind it is not, because its
credential is a person's. So an environment declares **sources**, and a check names the one it reads.

```jsonc
"watch": {
  "sources": {
    "logs": {
      "language": "kql",
      "runBy": "harness",
      "observe": "./scripts/ai-query.sh liveUk",        // wraps `az monitor app-insights query`
      "queryUrl": "https://portal.azure.com/#…/{queryGzip}"
    },
    "sql": {
      "language": "sql",
      "runBy": "operator",
      "queryUrl": "…"                                      // optional: where a person runs it
    }
  },
  "schema": "…", "describe": "…", "forMs": 172800000
}
```

**The harness still holds no opinion about telemetry, and none about auth.** A source is a name, a
language and who can run it. Which credential a command uses, which workspace it reads and how it
signs in are the operator's command's business, as `observe` always was. A source that gains a
managed identity next quarter changes `runBy` from `operator` to `harness`, gains an `observe`, and
nothing else in the subsystem moves.

**`observe` alone is the shorthand for one source**: `{ "logs": { "language": "kql", "runBy":
"harness", "observe": …, "queryUrl": watch.queryUrl } }`. Every configuration written before sources
keeps working, and a check with no `source` reads the environment's only one. The shorthand is read in
one place — `watchSources` (`src/environments/watchSource.ts`) — and every reader of a watch's commands
goes through it, so nothing downstream sees `observe` and `sources` as two spellings.
`validateEnvironments` refuses an environment declaring both `observe` and `sources`, an empty
`sources`, a `harness` source with no `observe`, an `operator` source with one, a language not in the
list below, and a `watch.queryUrl` beside `sources` — a link there would be read by nothing, since each
source carries its own.

**A check names a source by name, and each environment maps names to its own commands.** `logs` on
`testUk` and on `liveUk` are different commands against different workspaces, and that is the point:
the check is the question and the source says where to ask it. An environment that does not declare
the source a check names does not read that check. On that environment the check is `unknown`, with
the reason _liveEu has no `sql` source_. That is never a clean reading and never a refusal of the
whole watch. A check naming **no** source on an environment that declares more than one is `unknown`
there too, naming the sources it could have meant — the harness does not pick one. Both are answered by
`resolveWatchSource` (`src/environments/watchSource.ts`), which the window's reading and the dry run
share; the column is `goal_watches.source`, written by all three writers.

The [dry run](#the-dry-run) puts each check to the **first environment that declares its source** — for
a check naming none, the first that watches at all — so a `sql` check on a deployment where only
`liveUk` has SQL is proved against `liveUk`.

**Until [the operator's source](#a-source-only-the-operator-can-run) is built, a check reading an
`operator` source is `unknown`** on that environment, with the reason _operator-run sources are not
read yet_, and nothing is spawned for it. That is the configuration shape accepted ahead of the
behaviour, so a deployment can declare its SQL source now; no reading of it is ever clean.

### What a language changes

The language is what the refusals at ingestion read. Every one of them is about query shape, and
shape depends on the language:

| Language | `{since}` / `{until}` | Scalar-tail refusal                                 | Id echo                    | Kinds               |
| -------- | --------------------- | --------------------------------------------------- | -------------------------- | ------------------- |
| `kql`    | Required              | `aggregatingTail`, as today                         | `\| extend` projection     | `signal`, `measure` |
| `sql`    | Required              | `aggregatingTail`'s `select count(…)` arm, as today | The wrapper, or the person | `signal`, `measure` |
| `promql` | Required              | None can be written                                 | The wrapper                | `measure` only      |
| `other`  | Required              | None can be written                                 | The wrapper                | `measure` only      |

**A source whose aggregation the harness cannot see takes measures only.** An aggregating signal
query is the one mistake that defeats every guard ([above](#a-signal-query-returns-rows-never-a-count)),
and the refusal only works where the harness can read the query's tail. A metrics query aggregates by
nature, so in PromQL a signal's "count of occurrences" is a measure with an `under` anyway, and it
should be written as one.

Where that is refused depends on whether the configuration is to hand, because a language belongs to
an environment's source and not to the check. The operator's own edit
(`PUT /api/issues/:number/watch/checks/:checkId`) runs beside the configuration, so a signal naming a
`promql` or `other` source is refused there with a 400 (`watchSourceRefusal`), and the form refuses it
before it is sent. The plan document's `watch` block and `watch_declare` are parsed by `WatchSchema`,
which sees no configuration, so such a signal is stored — and **read `unknown` on each environment where
the source is measures-only**, saying so, with nothing put to the source. The dry run is that reading, so
its refusal comes back to the author at submission.

**The id projection is appended only to `kql`.** It is a pipeline segment and means nothing to
another language, so every other harness-run source relies on the wrapper echoing
`LUBBDUBB_WATCH_ID` into each row. That was the escape hatch for a non-pipeline language before
sources existed, and verification is identical either way. `LUBBDUBB_WATCH_SOURCE` is passed beside
the query, so one wrapper can serve several sources.

The fence on the bench row takes the source's language as its info string, ` ```sql `, so the copy
control and the wrap follow the language; the source's own `queryUrl` is the link under it. The Signals
card and the Watch card draw a **source chip** beside each check — `logs · kql`, dashed where a person
runs it, amber where the check names a source nothing declares or names none where there are several
(`web/src/components/WatchSourceChip.tsx`); the Watch card reads the chip against its own environment's
sources. The plan sheet draws the name of a source a check names. The operator's add and edit form
offers a source picker where the deployment declares more than one.

**The authoring prompt lists each environment's sources with their language and who runs them**, and
says plainly that a `harness` source costs nothing and an `operator` source costs a person's time —
two readings per environment, once [that is built](#a-source-only-the-operator-can-run). An `operator`
source is for a question no telemetry can answer, not for convenience. It is appended to `watchNote` and
`watchDeclareNote` (`src/plans/planning.ts`) beside each environment's `schema`, never interpolated, and
names the measures-only languages where any environment declares one.

### A source only the operator can run

**Not yet built.** The harness never spawns anything for a `runBy: operator` source. It cannot,
because it does not hold the credential, and a check that pretended to read on a schedule would read
`unknown` ninety-six times. Instead it asks a person **twice per environment**, at the two moments a
single reading is worth most:

| Ask          | When                                                        | Period                               |
| ------------ | ----------------------------------------------------------- | ------------------------------------ |
| The baseline | When the set is accepted (a signal's dry run asks here too) | Before the merge                     |
| The reading  | When that environment's window reaches `forMs`              | The arrival to the end of the window |

Each ask is a `human_tasks` row, `kind: 'watch_reading'`, one per check per environment per ask. Its
detail is the query **as it will be put**, with `{since}` and `{until}` already substituted, so it
runs as it stands. It is in a fence named for the language, with Copy, and the source's `queryUrl`
link where there is one. A signal's row carries its `presence` query under it, because the person is
being asked both questions.

Two ways to answer it, and both land in the same place:

- **Paste the result** on the row: the rows as JSON, or, for a measure, one number. It goes through
  the same output contract as a harness reading, apart from the id echo. A person who copied the
  query and pasted its answer is the evidence the echo stands in for.
- **Have Claude run it**: the desktop channel's `watch_reading` tool
  ([11](11-mcp-tools.md#the-desktop-channel)) lists the open asks and records an answer. The operator's
  own Claude Code, on their own machine, holds the credential the harness does not, so it can run the
  query with the operator's `sqlcmd` or their client of choice and hand back the rows. It records
  `read_by: 'operator'`, because a person's session ran it under a person's credential.

**An ask nobody answers is `unknown`, never clean.** The closing ask stays open for
`watch.operatorGraceMs`, 72 hours by default, after the window it belongs to. Past that, the check
settles `unknown` with the reason _nobody ran it_, and the row retracts itself. A baseline ask
unanswered by the time the window closes leaves the measure `unknown`, for the reason any measure
with no baseline is.

**A window waits for its operator readings before its outcome, and for nothing else.** Harness-run
checks in the same window are read on the schedule and settle at `forMs` as they always have. The
window's [outcome](#the-outcome) is drawn when its operator readings are in or out of grace, so a goal
does not read _worked_ on its harness checks while the SQL question it was really about has not been
asked.

## The window

Four files, split so the halves that decide things are pure. `src/environments/watchDesk.ts` is the
pass — a fifth on `EnvironmentDesk` and **below** its arrival pass, since a window opens on an
arrival the pass above records; `src/environments/watchWindow.ts` is the arithmetic of which arrivals
open one, which windows are due a reading and which have run out of time;
`src/environments/watchVerdict.ts` is the fold below; and `src/store/watches.ts` owns the two tables.

The order inside the pass is load-bearing too: open, then settle, then read, then file. Settling
before the readings is what stops a window that ran out between two pulses collecting one more
reading past its own end; filing after them is what puts this pulse's reading on the bench rather
than the last one's.

Two more things about _when_ a window is read, both of which a second implementation would get wrong
quietly. `watchIntervalMs` is measured off **that window's own newest reading** rather than against a
shared clock, so a window opened mid-interval is read on its own schedule and a backlog deferred past
the cap keeps its place. And the **whole window is read at once**, not check by check on separate
clocks: one _last read_ per window is the reading an operator is shown, and staggered per-check clocks
would make the card a set of answers taken at different times.

### Opening

A watch opens on an **arrival** — one goal's whole work confirmed in one environment
([24](24-environments.md#what-an-arrival-means)) — and never on a merge. Between the two sit a
release train and an approval gate, and a watch opened at merge would spend its window asking a
question about code that is not running yet, then close before it arrives.

It opens **per environment**, so a goal travelling `testUk` → `liveUk` → `liveEu` is watched three
times, separately, with separate readings. That is not redundancy: the acceptance environment is
usually where presence is zero and the production one is where the answer is.

`for` is spelled `forMs`, declared on the **environment's** `watch`, and defaults to 48 hours
(`watchWindow.ts`). A goal whose subject is a scheduled job needs a window long enough to contain
several runs — and that judgement is made once per environment rather than once per goal, because
what it is really about is the release cadence and the traffic pattern of the deployment, which the
operator knows and a planner drafting a document does not. A per-goal `for` on the plan document was
considered and left out for that reason: it would be a second place to answer the same question,
answered worse, by the party with less of the information. The operator's file is the one answer.

The window is sized from the **arrival**, not from the pulse that noticed it, so a probe pass that
ran long does not extend a watch by the length of its own delay.

### Only for an arrival the harness watched

The freshness guard from the announce pass applies unchanged and for the same reason: the first
pulse after this ships, or after an operator adds `watch` to an environment that has been probing for
a month, would otherwise open a watch on **every goal that ever arrived** — hundreds of queries a
pulse, hundreds of bench rows, against work that shipped in March.

So a watch opens only for an arrival confirmed within two probe intervals of now, and every arrival
is **stamped** as considered either way — `goal_arrivals.watched_at`, beside `announced_at` and for
its reason. The stamp is what makes the next arrival the first one watched, rather than the whole
history arriving at once.

The stamp is spent only where the feature is on. An arrival on a deployment where no environment
declares a `watch` is left unstamped, because stamping it would burn the one guard that makes turning
the feature on next month safe.

Three things have to be true to open a window, and each is a different kind of no: the environment
declares an `observe`; the goal declares at least one check; and the confirming reading is fresh. A
goal that declares its first check _after_ it arrived somewhere is therefore not watched there, which
is the honest reading rather than a gap — the declaration is what the operator approved, and
approving it after the deploy is approving it for the next one.

**Not yet built:** that last sentence stops being true for the assessor's set, which is written after
the merge by design and would otherwise miss every fast deployment. An arrival whose goal's watch is
owed or proposed is deferred unstamped, after the staleness cut, and opens its window when the set is
accepted. → [The operator accepts the set](#the-operator-accepts-the-set). The sentence still holds
for a check an operator adds by hand to a goal that has already arrived.

### Exposure

On many deployments _deployed_ is not _exposed_. Each tenant — or customer, cohort, ring — moves onto a
new build only when its own upgrade, migration, flag flip or canary promotion happens, which can take
hours or days. Until then most traffic still runs the previous build and still produces the failure
the release fixed, so a signal reads _still failing_ for work that is fixed; and a presence query can
read zero because no upgraded tenant has run the path yet. **The invariant: on a staged rollout a
reading never comes out clean, or regressed, on traffic that does not run the change. Low exposure
reads `unknown`, never passed or failed.**

An environment declares it with `watch.exposure` (`src/environments/exposure.ts`):

- **`command`** runs as `observe` does, with `LUBBDUBB_ENVIRONMENT` and `LUBBDUBB_WATCH_COMMITS`, and
  prints **one JSON object**: `{"share": 0.42, "lubbdubbWatchCommits": "<the variable, verbatim>"}` —
  the share of traffic on a build carrying _every_ commit named, between 0 and 1. The echo is
  `observe`'s id echo for the same reason: a wrapper that ignores the commits and answers for whatever
  is deployed now answers a wider question confidently, and without the echo that answer is
  indistinguishable from the right one. Anything else — no echo, no number, a number outside 0–1, a
  non-zero exit — is the probe not answering, which is `unknown` and never full exposure.
- **`atLeast`** is the share below which a reading is `unknown`; it defaults to **1**, the only floor
  at which an unscoped query reads nothing but the change. An operator lowers it deliberately, beside
  queries scoped on `LUBBDUBB_WATCH_COMMITS`.
- **`waitMs`** is how long a window waits for exposure, defaulting to seven days.

The window pass asks the probe once per due window, before any query (`WatchDesk.exposed`). Below the
floor, every check is recorded `unknown` with the share in words and **no query is run** — not a
reading taken and then discarded, because a reading of the old build is not evidence about this one.
An `unknown` files no bench row, so a slow rollout is a card saying so, not an alarm. The probe is
asked again on every reading, including after exposure: a rollback that drops the share drops the
readings back to `unknown` rather than letting the old build's traffic re-enter the window.

The window **opens on arrival and is clocked from exposure**. It opens as any window does — the
freshness guard and the arrival stamp are unchanged — but on an environment declaring an exposure its
first end is `arrival + waitMs` rather than `arrival + forMs`. The first reading that clears the floor
stamps `watch_windows.exposed_at` and moves the end to `exposed_at + forMs`, once; and from then on
`{since}` is `exposed_at`, not the arrival (`watchPeriod`), so the hours the change spent reaching
tenants are outside every query, the bench row's query included. A window that never reaches the floor
settles at `waitMs` with every check `unknown`, which is what happened, and an operator can extend it.

The baseline is unchanged: it is taken at the dry run, over all traffic, before the work arrived — a
_before_ that no tenant of the change contributes to, which is the comparison it is meant to be.

### Closing

At `for`, the watch **settles**: its readings stop, its verdict is fixed, and the rows stay on the
goal page as the permanent account of what production said about this work. A settled watch is never
re-opened by a later reading, for the reason a confirmed landing is never re-asked — this is a record
of what happened after a deploy, not a monitor.

An operator may **extend** a watch, which is the honest answer for a window that closed before the
weekly job ran. It **re-opens the window it names** rather than opening a second one, and that is a
decision rather than a shortcut: `watch_windows` is keyed on `(goal, environment)`, so a second
window is a different key and one goal's readings would be split across two rows nothing joins —
where the readings taken before it ran out are precisely the evidence behind whatever it says next.
The verdict that was fixed stays readable, in front of the ones it is about to take.

It is also the one thing in the subsystem that puts a settled verdict back in play, which is why it
is a click and never a rule. `settleWatchWindow`'s `settled_at IS NULL` guard is untouched by it and
still says what it always said: what that guard prevents is a _later reading_ moving a stamp the
harness already wrote, and an operator's decision is not a reading. The new end is measured from
**now**, by the environment's own `forMs` and through the one function the arrival pass sizes a
window with (`watchWindowMs`, `src/environments/watchWindow.ts`) — a second reading of that field is
one edit from a window extending by a different length from the one it opened with, with nothing
red. `watch_windows.extended_at` records that it happened, so the card can say why a window's end is
not the one its arrival would have given it.
→ `POST /api/issues/:number/watch/:environment/extend` (`src/server/routes/watches.ts`)

A settled window is never pruned either, which is the other half of the same rule: its readings are
the evidence behind a verdict that is now permanent, and a retention rule that dropped them would
leave the verdict standing with nothing behind it. What bounds them is `for` over `watchIntervalMs`
— 96 rows per check per environment on the defaults — so the table grows with the fleet's work
rather than with time. The one case a reading is deleted is a check an amendment stopped declaring,
which takes its readings with it in the same transaction: neither a verdict nor its evidence is left
behind, because a reading of a check no document declares is a number with no rule.

### A sheet does not read these checks

A remote validation sheet carried the goal's live `signal` and `measure` checks as rows once, read a
second time against each environment and approved a second time per environment — one question with
two answers in two tables. It no longer does: the window reads them, on its own clock, and the
validation page draws the window's readings read-only. Nothing a sheet does is ever written into
`watch_readings`, and the window's findings stay on the `watch` row.
→ [36](36-remote-validation.md#the-watch-is-not-on-the-sheet)

## The verdict

Per check, three-valued, and folded per environment:

| The reading says                                  | Verdict     |
| ------------------------------------------------- | ----------- |
| within what was declared, with presence answering | `clean`     |
| outside what was declared                         | `regressed` |
| the observation failed, or presence is silent     | `unknown`   |

Two rules, both of which a second implementation would get wrong quietly:

**`unknown` never folds to `clean`.** An expired credential, a missing binary, a job that never ran
and a genuinely quiet release all fail identically, and only the last is about the work. Read as
clean they are indistinguishable on the glass, and the cockpit states in the operator's own words
that a fix is verified for a reason that has nothing to do with the fix. This is
`GoalReachStatus`'s rule ([24](24-environments.md#the-three-verdicts)) one layer up, and it is the
same rule because it is the same mistake.

**A watch does not roll up to a word.** The card draws every check. A goal whose signal passed and
whose measure failed is a fix that worked and a proc that is still slow, and a single `regressed`
would hide the half that is good news — which is the half the ticket was about.

**Not yet built:** it does roll up to a headline, [the outcome](#the-outcome), and the headline has
to keep this rule. It names what passed as well as what did not, and the card under it still draws
every check.

## The outcome

**Not yet built.** The goal page opens on one answer, drawn above everything else the watch shows,
because the question an operator brings to a delivered goal is _did it work_, and until now the
answer was a set of per-check rows to read and fold in their head. A pure fold, `watchOutcome`
(_src/environments/watchOutcome.ts_), over the goal's settled windows:

| Outcome                     | When                                                                                       | Drawn                   |
| --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------- |
| **It worked**               | No check `regressed` anywhere, and every check settled `clean` on at least one environment | Green, with the numbers |
| **It made something worse** | Any check settled `regressed` on any environment                                           | Red                     |
| **Couldn't tell**           | Neither: some check is `unknown` everywhere it was read                                    | Amber, with each reason |
| **Nothing was measured**    | The watch was authored empty, or the hint was `none`                                       | Grey, with the reason   |

Until a window has settled there is no outcome, only _watching_. A goal that has a plan but whose
watch is still owed reads _not yet written_, which is not the same as nothing measured.

**The headline says what was measured, in numbers.** _Statement failures 37/day → 0; BuildStatement
p95 1,840 → 1,190 ms on liveUk over 48h._ For a measure that is before → after. For a signal it is
the rate the dry run read before the merge → what the window read. _It made something worse_ also
names any check that came back clean, which is the
[roll-up rule](#the-verdict) kept: one regressed check does not hide a fix that worked. Every check on
every environment is still drawn underneath.

**`unknown` never reaches _It worked_.** This is the verdict's own rule one layer up: a check that
was never read, read only on an environment where nothing ran, or left with an operator ask unanswered
has said nothing about the work. The outcome says _Couldn't tell_ and gives the reason in words.
_Extend_ is beside it, because the commonest cause is a window that closed before the job ran.

**The outcome holds nothing.** It is a reading, and readings never move the goal. That is
[a reading is never a `WorldEvent`](#a-reading-is-never-a-worldevent), and it is also an honest limit:
a number that moved after a deploy may have been moved by something else that shipped the same day
([what it does not see](#what-it-does-not-see)), so the outcome can say what happened but cannot say
the change caused it. `holds` stays exactly as it was. It is the opt-in on settling, the outcome
neither reads it nor writes it, and it is off.

### Discussing an outcome

**Not yet built.** _It made something worse_ and _Couldn't tell_ carry **Discuss in Claude**, which is
where a person decides what the reading means. Was it us? Was it something else that shipped? Is it
fine? None of those is the harness's call ([cost](#what-is-deliberately-not-added-later)).

The click writes a `note` to the goal's discussion file ([40](40-discussions.md)) through
`DiscussionFiles`, authored `LubbDubb (watch)`: the outcome, each check's expectation, its before and
after, its query in a fence, and the goal's merged pull requests. It then opens
`/lubbdubb:discuss <n>` through the Discussion tab's existing deep link. The conversation starts from
the numbers, and the operator's Claude has the repository and, often, the credential to run the query
again. It ends one of three ways, all through what discussions already do:

- **It was us** — an idea turned into a story ([40](40-discussions.md#turning-an-idea-into-a-story)),
  related back to the goal by `IssueCreateInput`.
- **It was something else** — a decision recorded on the goal: _p95 moved with the index rebuild on
  the 12th, not this change_.
- **It's fine** — the same, and the bench row is settled.

Without `discussionsDir` the button is not drawn, rather than disabled. The bench row's
[Raise a bug](#the-bench-row) is unchanged, and stays the direct path for an operator who already
knows.

## What a finding does

Three outlets, and no fourth. `src/environments/` is a lens: nothing under `src/dispatcher/` may
import it, which is asserted structurally, so a watch **cannot** spend an agent even by accident.

- **A `human_tasks` row** on the goal, naming the check, what it expected, what it read, why the
  check was declared and the query that read it ([13](13-jobs-and-tickets.md#human-tasks)). One row
  per watch that settled or is settling regressed, never one per reading.
- **The goal page**, which draws every check on every environment whether or not anything is wrong.
- **A bug**, through the filing job that already exists (`src/tickets/bugFiling.ts`), behind an operator's
  click. The reading rides as the operator's own report, so the fleet is handed the numbers rather
  than a paraphrase, and the bug is related back to the goal by `IssueCreateInput` rather than by a
  sentence in a prompt ([13](13-jobs-and-tickets.md#filing-a-ticket)).

The click is the bound. Arms A and B of a shortfall are put to a person before they happen because
they spend a fleet ([13](13-jobs-and-tickets.md)); a watch that filed its own bugs is the same loop
with a log spike as its trigger and nothing on the outside of it.

### The bench row

`kind: 'watch'`, filed by `src/environments/watchFinding.ts` from the pass that took the readings —
last inside `watchDesk.ts`, so it is filed off this pulse's reading rather than the one before it.

**One row per window, and this is the line the whole arm turns on.** A window is 96 readings per
check per environment on the defaults, and a row per reading is the Needs-you rail burying its own
asks under one goal's telemetry. The row is keyed on `(goal, environment)` through a title that
names the environment and never changes, so `recordHumanTask`'s dedup folds every later reading onto
the row the first one filed and rewrites its detail — which is what keeps the numbers on it the ones
the watch is reporting _now_.

**An `unknown` files nothing.** A window nobody could read has said nothing about the work, and a row
filed off one would put an expired credential in front of a person as though it were a regression.
It is the fold's own rule ([the verdict](#the-verdict)) one layer up, and the same mistake if it is
folded.

It wears the `DESK_SETTLED` marker like its siblings (`src/benchSettlement.ts`). A later reading in
an open window coming back clean says the obligation is not owed _right now_, which is a different
thing from a person saying they have dealt with it — so the harness retracts its own row and reopens
it if the reading regresses again, and an operator's own verdict stands for good. Without the marker
the dedup would refresh their settled row's detail and leave it settled, and the finding would come
back invisible.

The row carries the reading's own words and no summary of them, because no model read the numbers
and none will: where a number needs interpreting, that is a row on the bench with the number in
front of a person.

**And it carries the declaration the reading is measured against, because the person it is in front
of is the interpreter.** A number with nothing beside it is an alarm, not a finding: `7 rows where
the check declared no more than 3` says an operator must decide whether shipped work has regressed,
while telling them neither what the check was for nor how to look past the count. So the row draws,
per regressed check, the declaration's **`why`** — the sentence its author wrote about what the check
is watching for and why that matters ([the declaration](#the-declaration)) — and its **`query`**,
verbatim in a fence, which is the thing to run against the environment to see the rows the number
counted. Both are the declaration's own words, written before any reading existed, so neither is a
summary of the numbers; and `why` is optional on a declaration, so a check that declared none says
nothing rather than inventing one.

#### Each check is a heading, and its query is a `kql` fence

The detail is markdown and the cockpit's own renderer draws it
([17](17-cockpit.md#agent-authored-prose)), which is what settles how much of this can be structure
rather than more prose. A check's **title is an ATX heading** (`### `), not another bold paragraph:
a window can regress on several checks at once, and until the titles were headings where one check
ended and the next began was a thing an operator worked out from the wording. The heading is what the
row's own stylesheet rules between.

The query goes in a fence that **names its language** — ` ```kql `, or whatever language the check's
[source](#sources) declares — which is what earns it the copy
control and the one-operator-per-line wrap
([17](17-cockpit.md#a-fence-that-names-a-language-carries-a-copy-control)). The fence body is the query **as it was put to the environment** — the
declaration's own text with `{since}` substituted for the instant the work arrived, which is what makes
it runnable as it stands rather than a template the operator has to fill in. That is the invariant: the
wrap is the cockpit's, the copy is the fence's, and a fence rewritten here for any other reason would
hand an operator a query the harness never put to the environment. A dialect other than Kusto is a different info string, not a reflowed body.

#### Running it, where the environment said where

`queryUrl` on the check's [source](#sources) — `watch.queryUrl` beside the `observe` shorthand — is a
**URL template** an operator writes once, carrying `{query}`
(URL-encoded) or `{queryGzip}` (gzipped, base64'd, then URL-encoded — the shape the Azure portal's
Logs deep link wants). Filled per check by `watchQueryUrl` (`src/environments/watchQueryUrl.ts`), it
becomes a `Run it on <environment> ↗` link under the fence.

It is **optional and absent by default**, and no template draws **no link** rather than a dead one:
the harness has no idea where a given deployment's telemetry is read, and a guessed URL is a control
that goes somewhere wrong. `validateEnvironments` refuses a template carrying neither token, because
one that carries neither links every check on the deployment to the same page with nothing of its own
query in it — which reads as configured and is useless, the failure this document's refusals exist
for.

The tokens are declared once, in `watchQueryUrl.ts`, and the refusal imports them from there: the
substitution and the check on which substitutions exist cannot come to disagree.

It closes by saying what each of its three answers does — **Raise a bug** hands the fleet these
numbers as the operator's own report, **Done** says they looked and this is not a regression,
**Decline** says the same and that they are not acting on it — because the row's whole arm is the
click ([what a finding does](#what-a-finding-does)), and a click nobody can tell apart from its
neighbour is not a bound on anything.

### It holds nothing, unless asked

The close-out is **not** held while a watch is open. A 48-hour hold on every delivered goal would put
every goal on the bench in a state nobody can act on, which is the rail burying its own asks — the
argument that keeps an environment gate off the Needs-you rail
([24](24-environments.md#in-the-cockpit)).

What the close-out does carry, in its detail, is what the watch says: open and clean so far, settled
clean, settled regressed, or an environment nobody could read. A row settled early is closed in front
of that reading rather than past it, which is `validate`'s arrangement exactly
([20](20-validation.md#saying-so-on-the-bench)) — the detail is rewritten on every pulse, so the
sentence an operator reads at the moment they close the ticket is the one the watch is saying then.

`holds` on an environment is the opt-in for a team that wants the stricter thing, and it is off. It
names the obligations an arrival's `opens` names — `close_out`, `validate` — and what clears one is a
window that has **settled**, not one that is open. That is not a detail: both obligations are filed
on the _delivery_, pulses or days before the work arrives anywhere, and both hold a **new** row only,
so a hold scoped to open windows would read as configured and withhold nothing ever.
`watchClearedGoals` therefore has `openedGoals`' exact shape, null and all — an empty set would
withhold the obligation on every deployment on earth and would look identical to the feature working
— and an operator's _not waiting on an environment_ clears a hold as it clears a gate, so a goal whose
work will never reach an environment does not sit delivered with an empty bench for good.

### A reading is never a `WorldEvent`

Built, and the reason it had to be. The activity feed is the obvious place to put a regression, and `deliveryHold` expires a standing
delivery verdict on **any** world event matching the goal's issue ref
([03](03-world-model.md)) — so a watch reading written as one would un-park the goal it just reported
on and hand the finished fix straight back to the fleet to do again. Nothing errors, and the
re-dispatch of completed work looks like the harness deciding there is more to do. Watch readings
have their own table and their own wire list, and the cockpit merges them at the feed's door, which
is what arrivals already do and for this exact reason
([24](24-environments.md#in-the-cockpit)). A remote validation reading is held to the same rule, for
the same reason and with the same consequence: no reading of any kind creates or clears a hold
([36](36-remote-validation.md#what-a-finding-does-and-what-it-must-never-do)).

## Cost

The subsystem is designed around the fact that monitoring is a **standing** cost and a model is a
per-call one.

**No model runs in the reading loop.** The dry run, the baseline, every reading, the comparison, the
bench row's wording and the cockpit's rows are a scripted pass on the pulse. The only model tokens
this feature spends are two riders on sessions that were already dispatched: a `watch` block in a
plan document the planner was already writing, and one tool call from an agent already at work. The
spend is at declaration, once, and never per reading — which is the whole difference between this
design and dispatching an agent to go and look, whose cost would grow with every goal ever shipped.

The optional third is the bug-filing job, which is an existing desk job and fires only on a click.

What is left to bound is process spawns and calls to the operator's telemetry:

- **`watchIntervalMs`, default 30 minutes**, and deliberately not `environmentProbeIntervalMs`. Five
  minutes is right for a local ancestry question and absurd for this: a percentile over a 24-hour
  lookback does not move in five minutes, and a 48-hour watch read that often is 576 readings per
  check to answer a question nobody asks more than twice a day.
- **Nothing is asked when no watch is open**, which is the steady state for most of a fleet's life.
- **A cap per pulse — twenty windows**, oldest first, deferring rather than dropping, so a backlog
  drains in a fixed order and nothing starves — `MAX_LANDINGS_PER_PULSE`'s arrangement, and
  deliberately smaller than it: what this bounds is a process spawn per open check against the
  operator's telemetry, not an argument list.
- One spawn per open check per interval, and open watches are bounded by `for`, so nothing
  accumulates.

### What is deliberately not added later

Stated here so it is a settled decision rather than an obvious idea somebody has next quarter:
**nothing asks a model whether a reading is a real regression.** The expectation is declared, the
comparison is arithmetic, and a verdict that came from a judgement nobody can reproduce is worse than
no verdict — it costs money on every reading, it disagrees with itself between runs, and it is
unfalsifiable on the glass. Where a number needs interpreting, that is a row on the bench with the
number in front of a person.

## Configuring an environment

`watch.sources` may stand in place of `watch.observe`, as set out in [Sources](#sources); `observe`
stays valid as the shorthand for one `kql` source run by the harness, so the example below is still a
correct configuration. **Not yet built:** `watch.operatorGraceMs`, default 72 hours, for
[operator-run sources](#a-source-only-the-operator-can-run).

```jsonc
{
  "environments": [
    {
      "name": "testUk",
      "at": "az pipelines runs list --pipeline-ids 42 --status completed --result succeeded --top 1 --query '[0].sourceVersion' -o tsv",
      "arrival": { "opens": ["validate", "close_out"], "comment": true },
      "watch": {
        "observe": "./scripts/telemetry.sh testUk",
        "schema": "Structured logs land in `traces`, properties in `customDimensions`. Roles are orders-api, web, worker. SQL calls are in `dependencies` with type == 'SQL'.",
        "describe": "./scripts/telemetry-schema.sh testUk",
        "queryUrl": "https://portal.azure.com/#blade/Microsoft_OperationsManagementSuite_Workspace/Logs/query/{queryGzip}",
      },
    },
    { "name": "liveUk", "at": "./scripts/deployed-sha.sh uk", "watch": { "observe": "./scripts/telemetry.sh uk" } },
  ],
  "watchIntervalMs": 1800000,
}
```

`for` is spelled **`forMs`**, inside `watch`, and is the one place this document's original naming
was corrected in the building: the harness's other durations carry the suffix
(`environmentProbeIntervalMs`, `closedPrWindowMs`), and an unsuffixed one is exactly the unit
ambiguity the convention exists to remove — a window read in the wrong unit settles in two minutes or
in two months, with nothing red. Two things read it, and through one function
(`watchWindowMs`, `src/environments/watchWindow.ts`): the arrival that opens a window, and the
operator's click that extends one.

`watch` is optional per environment. An environment without one is observed for reach and nothing
more, and a goal whose environments declare no `observe` draws no watch surface at all — the same
off-by-default arrangement as `environments` itself.

`environments` is `fileOnly` in `CONFIG_FIELDS` and stays that way: `observe` is another shell
command the harness runs on a schedule, which is a thing to write deliberately in a file. No agent
can write it; nothing in `src/mcp/` touches config.

`validateEnvironments` (`src/environments/policy.ts`) grows the refusals whose absence is otherwise silent:

- an empty `observe` on a declared `watch`, which leaves every check unanswerable forever;
- a `holds` naming an obligation the harness does not file, so holding it would hold nothing;
- a `describe` without an `observe`, which is a schema for a question nothing asks;
- a `queryUrl` carrying neither `{query}` nor `{queryGzip}`, which links every check to the same page
  with nothing of its own query in it ([running it](#running-it-where-the-environment-said-where));
- an `exposure` with no `command`, an `atLeast` outside (0, 1] — `90` meant as a percentage would
  hold every reading at `unknown` for ever — or a `waitMs` that is not a positive duration.

A staged environment adds one block to its `watch`:

```jsonc
"watch": {
  "observe": "./scripts/telemetry.sh uk",
  "exposure": { "command": "./scripts/exposure.sh uk", "atLeast": 0.9, "waitMs": 432000000 },
}
```

**Query authors are told.** Where any watched environment declares an `exposure`, the watch note a
working agent reads (`watchDeclareNote`, `src/plans/planning.ts`) appends a paragraph naming it: every query — signal, measure and presence alike — is scoped to traffic on a build carrying
the change, as that environment's `schema` says to. Appended after the schema prose, never
interpolated ([05](05-dispatcher.md#prompt-templates)). Unscoped, "zero failures" may only mean nobody
has upgraded yet. The planner's `watchNote` carries the environments' schema prose and not this
paragraph: a hint has no query to scope. → [Exposure](#exposure)

## In the cockpit

→ [17](17-cockpit.md). Four surfaces and one changed reading.

**Not yet built**, in this section: the Signals card's proposed set with **Accept**, **Edit** and
**Send back**; the operator-reading asks; and the outcome card at the top of the goal page, with
**Discuss in Claude**. Each is described where it belongs above
([the hint](#the-planner-at-plan-time-writes-a-hint), [the accept](#the-operator-accepts-the-set),
[the operator's source](#a-source-only-the-operator-can-run), [the outcome](#the-outcome)). Source chips
are built and described [with sources](#what-a-language-changes). What follows is what runs today.

**The plan sheet draws the hint** as a _How we'll know it worked_ section above the checks
(`web/src/components/WatchHintDigest.tsx`): each intent with its kind and source as chips, what it
`says`, and its `why` muted under it — or _Nothing to watch_ and the `none` reason. A plan from before
hints draws nothing there. The tick itself is the approval card's, beside the risks.

**The plan sheet** draws the watch beside the validation checks, each check with its query, its
expectation, and the dry-run readings under it (`web/src/components/WatchDigest.tsx`). Read-only but
for one control, for `ValidationDigest`'s reason: the sheet is where checks are _defined_, and
approving the plan is what authorises the query to run against the operator's own telemetry with the
operator's own credential. A check nothing has asked about yet says so, in those words — not yet put
to an environment is not a clean reading.

The one control is the ruling on an agent's declaration. A check `watch_declare` wrote arrived
**after** the approval, so it draws as a pending change with accept and decline beside it: the live
check above it still stands, nothing has been put to an environment, and accepting is what does it —
which is also what takes a measure's baseline. Declining leaves a live check exactly as it was and
drops a row that was never anything but a proposal. The state lives on the check
(`goal_watches.live` and `goal_watches.proposal`) rather than on the plan-amendment path, so a
declaration made at conclude time does not put a goal's whole plan back through approval to carry
one query. → `POST /api/issues/:number/watch-proposals/:checkId` (`src/server/routes/watches.ts`)

`listGoalWatches` is **live-only**, and that is the guard rather than a filter: every reader that puts
a query to an environment goes through it, so an agent's unapproved query cannot reach the operator's
telemetry by a route somebody forgot to filter. The sheet reaches the pending rows through
`listProposedGoalWatches`, which nothing else reads. A replan's drop sweep skips proposal-only rows
for the same reason the ruling exists — they were never part of the document, so a planner neither
adopts nor discards them, and a decision taken off an operator without their seeing it is what the
approval prevents.

**The goal page's Signals card** draws the declarations themselves — every declaration on the goal, its
query, what it expects, and what the dry run read — with the controls that change them
(`web/src/components/SignalsSection.tsx`, embedded by `web/src/console/goalRunners.tsx`). Its count reads in **readings**, never in checks: a windowed reading and a point-in-time check are
different clocks, and one word for both is how the goal page came to mean four things by "check"
([17](17-cockpit.md#one-noun-per-thing)). It sits on the **Watch** pane, above the window's own card,
which is the order the questions are asked in: this is _what should be true of it running_, and the
card below is _what has been read since_. The pane is the obligation and the two cards are its halves.
It is not a second copy of the plan sheet's block: the sheet draws a document under review at approval
time, and this draws a live goal being operated weeks later.

Its rows carry the plan sheet's ruling control unchanged, so an operator who never opens a plan sheet
still sees an agent's declaration and can accept or decline it. A check the operator wrote says so —
a `yours` chip, which is the only place the replan rule above is visible.

**Nothing is drawn where nothing is declared and no plan could declare one**: a goal that declared no
checks reads null, and an empty card headed _Signals_ is a surface reporting the fleet verified. A
goal that has a plan draws the card with whatever list it has, because the add controls are how a
list starts.

**The goal page's Watch card** draws the window one environment's arrival opened, headed
`Watch · <environment>` (`web/src/console/goalEnvironments.tsx`, `web/src/console/console.css`). It was drawn
**inside** that environment's own row on the Environments card while the environments and the watch
shared a pane, because a watch belongs to an arrival and two surfaces drawn as siblings would be free
to disagree about which environment a reading came from. The heading carries that guarantee now: the
environment is in the card's own title and in the tab above it, and a watch reading is never drawn
without the environment it was read in. The card is on the **Watch** pane, which exists only where
some environment declares a `watch` block and is named for the environment that declares it
([17](17-cockpit.md#the-panes)) — so the pane, the tab's qualifier, the card's heading and the
readings are one environment all the way down.

**A window that has not opened says so, and is not an empty list of readings.** A window that never
opened and a window that opened and read nothing are different answers, and only the second is about
the work — the same distinction the unread check makes one level down. The card names the environment
and says nothing of this goal has arrived there yet.

The block says how long the window has left, or when it settled — and, where somebody extended it,
that it was extended, since otherwise the card states a window length no configuration would produce.
The **extend** control sits at the end of that line rather than among the readings, because what it
acts on is the window: a control level with the checks would read as an answer to one of them. Then
it draws **every check** —
whether or not anything is wrong, and with no roll-up to a word. A check nothing has read yet says
so, in those words, for the plan sheet's reason: not yet put to an environment is not a clean
reading.

A measure draws as a line of **expected, before, now**. The before is what makes the card worth
looking at — a p95 of 310ms means nothing alone and everything beside the 8,400ms it replaced — and
it is available precisely because the baseline was taken at declaration. A measure whose baseline was
never taken says _before: never taken_ rather than printing a number with nothing beside it.

**An `unknown` says why in words**, on the row, and never in the vocabulary of a clean one. Every
colour on the block is a `--cn-*` token: a literal would be a surface that stays dark when somebody
switches to Light, and nothing in `npm run check` reads the stylesheets but
`test/cockpitTheme.test.ts`.

**The Needs-you rail** carries one row for a settled-regressed watch, with the reading in it and the
bug-filing control beside it (`src/asks/inboxAsks.ts`, `web/src/console/taskAsks.tsx`). It is a
`human_tasks` row like every other on the rail, so it folds off the reading the desk already took
rather than computing a second one — which is the disagreement the strip's fold exists to prevent,
made once for the whole cockpit.

Its detail is the markdown the desk wrote, drawn by `renderMarkdown` like every other bench row, so
the row's structure — a heading per check, the query in a `kql` fence with **Copy** beside it, and the
`Run it on …` link where the environment named a `queryUrl` — is authored in one place and read in
one. Nothing about the row is assembled a second time in the cockpit: a surface that rebuilt the
reading from the snapshot would be free to disagree with the sentence beside it, which is the whole
argument for the row being a `human_tasks` row in the first place.

The control opens the bug modal already holding the row's own detail: the check, what it expected and
what it read. A **seed rather than a payload** — it lands in the editable box every bug is composed
in, so what is filed is still what the operator sends, and the numbers ride as their own report
rather than as a paraphrase somebody would have had to retype. It is drawn only where there is a
tracker to file into and a goal to relate the bug back to, and a false draws no button rather than a
disabled one.

**The track strip's Environments stage** gains the watch's reading — `reached liveUk · watch clean` —
folded off the card below it rather than computed a second time, which is the strip's existing rule
([17](17-cockpit.md), `web/src/view/goalStages.ts`). This is the one place a watch is reduced to a
word, and the reduction is one-directional: `regressed` is answered first, then anything not `clean`
reads _watch not read_, and only a window whose every check came back clean says so. A row with space
for one reading must never fold an unread environment into an all-clear — the card underneath still
draws every check.

With no environment declaring a `watch`, none of this renders: not an empty card, not a row of
question marks. A goal that declared no checks renders nothing either, because null is not clean.

## What it does not see

- **A regression outside what was declared.** This is the design's central trade. A watch answers
  the questions somebody wrote down and is blind to everything else, which is why it is a complement
  to the team's own alerting and not a replacement for it.
- **Attribution when two goals arrive together.** A release train carries four goals to production at
  once; each is watched separately, but a reading that regressed cannot say which of the four did it.
  The card reports what the goal's own declared checks say, and says nothing about causation.
- **A rollback.** A settled watch is not re-opened, so an environment that goes back past the commit
  keeps the verdict taken while it was there. An open window on an environment declaring an
  [exposure](#exposure) does see one — its readings drop back to `unknown` — and one without does not.
- **Whether a query was scoped.** `LUBBDUBB_WATCH_COMMITS` reaches the wrapper; nothing proves the
  wrapper filtered on it. The exposure floor is what bounds the cost of an unscoped query.
- **Anything finer than `watchIntervalMs`.** A spike that opens and closes between two readings did
  not happen, as far as this is concerned.
- **A check whose telemetry is correct and whose question is wrong.** The dry run catches a query
  that resolves nothing; it cannot catch one that resolves the wrong thing confidently. That is what
  the operator's approval is for, and it is a human check by design.

## Persistence

→ [14](14-persistence.md). Three tables, owned by `src/store/watches.ts` and delegated from
`src/store/store.ts` under the same method names, per the store's composition rule.

| Table            | One row per                   | Written                                                                                                              |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `goal_watches`   | `(goal_ref, check_id)`        | `OR REPLACE` on the declaration; the merge key is the slug, and `authored` says which writer's it is                 |
| `watch_windows`  | `(goal_ref, environment)`     | `OR IGNORE` — an arrival opens one window, and re-arriving is not a second; an operator's extend re-opens _that_ row |
| `watch_readings` | `(window, check_id, read_at)` | append-only, and pruned only with the check an amendment dropped                                                     |

`goal_watches` also carries the dry run — the environment it was put to, when, what the check's own
query and its `presence` query each answered, the row count, and a measure's baseline. On the check rather than in a
readings table because it is a reading of the _declaration_, taken before any window exists, and it
is cleared by a re-declaration for the same reason.

All three were new tables **once**, and measures proved exactly what that does not buy: a table being
new once does not keep it exempt from the next column added to it
([14](14-persistence.md#migrations)). `goal_watches` grew a measure's thresholds, its unit, its
baseline and the pending amendment; `watch_readings` grew a measure's `value`; and both sets are
declared in `WATCH_COLUMNS` (`src/store/watches.ts`) and registered in `src/store/store.ts`. Without
them each column is invisible on every database from before this build — a threshold that reads
`undefined` is a measure that can never fail, on exactly the deployments with a history, and nothing
errors. The window pass proves the same point one table over: `goal_arrivals.watched_at` is a column
on an **existing** table, and it carries the `ColumnMigrations` entry the rule requires, declared in
`src/store/environments.ts` and registered in `src/store/store.ts`.

None of the new columns needs a backfill, and each for a stated reason.
`goal_watches.baseline_value` null means **never taken**, which the fold already reads as `unknown`
rather than as clean — and every database from before this build declares no measures anyway, since
the schema refused them. `expect_baseline` and `live` carry SQL defaults that are the honest reading
of a row written before either existed: a signal declares no baseline, and every check the operator's
own plan approval already authorised is live. `authored` defaults to `'plan'`, which is what every
row written before an operator could edit one actually was — and the wrong default is the expensive
one here, since a database whose rows all read `operator` is a fleet no replan can amend. It needs no backfill, and that is a property of the freshness guard rather than
an oversight: null there means _not considered yet_, and an arrival considered for the first time
opens a window only if its confirming reading is fresh — so a database full of nulls is walked once,
stamped, and opens nothing for work that shipped in March.

`goal_watches.source` is the check's [source](#sources), by name, declared in `WATCH_COLUMNS`. Null
means _the environment's only source_, which is exactly what every row written before sources read, so
it needs no backfill.

`watch_windows.settled_at` null means **still watching**, which is a null that means something: a
column added to it later, without the gated backfill, would reopen every settled window on the boot
an operator takes the build ([14](14-persistence.md#when-a-null-means-something)). `extended_at` is
that table's first added column and the one the warning is about — and it needs no backfill, for a
stated reason rather than by luck: its null means **never extended**, which is exactly true of every
row written before it existed. A column here whose null meant anything else would have to be gated on
`ensureColumns`' report.

`exposed_at` is the table's second added column, and its null **does** mean something — _the rollout
has not cleared the floor_, which holds every reading at `unknown` and keeps `{since}` at the arrival.
It needs no backfill anyway, and for a stated reason: the null is read only where the environment
declares `watch.exposure`, and no deployment declared one before the column existed. An operator who
adds one to an environment with open windows has those windows probed on their next reading, which is
the correct reading of _not yet known to be exposed_; the first that clears the floor restarts its
clock at `forMs`. Declared in `WATCH_COLUMNS`.

**`plans.watch_hint`** is the hint as JSON, a column on an existing table and so declared in
`PLAN_COLUMNS`. Null means _a plan from before hints existed_ — or one written where no hint was asked
for: no hint is drawn and no box is ticked (and, once it is built, the assessor is asked to author the
watch from the goal alone). That is the honest reading, so no backfill is needed. It is written only
by `setPlanWatchHint` from `ingestPlanDocument`, and only when the document carries a hint.

**Not yet built**, and each with its migration stated now so it cannot be forgotten later:

- **`watch_plans`**, one row per goal: `authored_at`, `note`, `empty_reason`, `accepted_at`,
  `sent_back` and its words. It is a new table, and `validation_plans`' shape is the model. Null
  `authored_at` means _owed_, which is what holds an arrival back. On the boot that takes this build,
  every goal that already has live checks gets a row stamped authored and accepted. Without that,
  every delivered goal on the deployment would read _owed_ and dispatch an assessor. That is a null
  that means something ([14](14-persistence.md#when-a-null-means-something)), so the stamp is gated on
  the table being created.
- **`watch_readings.read_by`**, `'harness'` or `'operator'`, a `ColumnMigrations` entry. Null reads as
  `'harness'`, which every earlier reading was.

`watch_readings` is bounded by `for` rather than by a retention rule: a window's readings are the
evidence behind its verdict, and a rule that dropped them would leave the verdict standing with
nothing behind it. At 30-minute intervals over 48 hours that is 96 rows per check per environment,
which grows with the fleet's work and not with time. → [Closing](#closing)

## Tests

At the `buildSystem` seam with `FakeEnvironmentObserver` injected beside `FakeEnvironmentProber`
([19](19-development.md)), plus unit tests on the pure halves — `test/watchResult.test.ts`,
`test/watchDryRun.test.ts`, `test/watchVerdict.test.ts`, `test/watchWindow.test.ts`,
`test/watchDesk.test.ts` and `test/watchFinding.test.ts`. The ones that earn their place are the silences:

- a signal with zero rows and **zero presence** is `unknown`, not `clean`;
- an observation that fails, times out, or answers without the id echo is `unknown`, not `clean`;
- a measure answering with two rows is `unknown`, not the first row;
- a measure whose baseline was never taken is `unknown`, not clean — it has nothing to compare
  against;
- a measure declaring neither a threshold nor a baseline is refused at ingestion;
- an **aggregating signal query is refused at ingestion**, through `WatchSchema` and through
  `WatchCheckSchema`, and a `summarize … by` is not (`test/watchAggregation.test.ts`);
- a signal whose reading is one row carrying one number is handed back by the dry run —
  `FakeEnvironmentObserver` answers an aggregating query as an engine does, one row whatever it was
  scripted with, so the guard has something to catch;
- `watch_declare` merges on the slug and takes effect on nothing until the operator accepts it, and
  an accepted amendment clears the readings of the text it replaced (`test/watchDeclare.test.ts`);
- a watch does **not** open for an arrival older than two probe intervals, and the arrival is stamped
  anyway;
- presence answering zero reads `unknown` in the goal page's own words, end to end — the case that
  reads as success;
- a settled watch is not re-opened by a later reading;
- a goal with no declared checks reads null, and draws nothing;
- a settled-regressed watch files **one** bench row, and a second reading files no second one;
- a settled-**unknown** watch files nothing — it is not a finding;
- the close-out's detail carries what the watch says and does **not** hold it with `holds` absent,
  and does hold it with `holds: ["close_out"]`;
- a goal delivered with a watch still open closes in front of the reading rather than past it;
- `extend` re-opens the settled window it names and nothing else, and the verdict that was fixed is
  still readable under it (`test/watchFinding.test.ts`);
- **no `WorldEvent` is written by any of it**, asserted against the world's own list;
- a watch opens **per environment**, so a goal travelling `testUk` → `liveUk` is watched twice with
  separate readings;
- the per-pulse cap defers rather than drops, oldest window first;
- nothing under `src/dispatcher/` imports the module, asserted structurally with the existing lens
  assertions;
- a measure without `{until}` is refused by every writer and a signal without it is not; after the
  merge the dry run and baseline put `{until}` at the merge and `{since}` one window before it, and
  before it they fall back to the window ending now; a measure from before the token reads `unknown`
  on that dry run with no baseline; the observe command is handed `LUBBDUBB_WATCH_UNTIL`; and the merge
  is the provider's instant with `recorded_at` standing in (`test/watchUntil.test.ts`).
- a plan document with neither `watchHint.intents` nor `watchHint.none`, or both, is refused wherever
  `watchNote` is appended, and accepted with neither where it is not; the approval is held until the
  `watch` caveat is ticked, and a plan with no hint raises none; `plans.watch_hint` reaches a database
  from before it (`test/watchHint.test.ts`).
- a check naming a source its environment lacks reads `unknown` there, with the source named; a check
  naming none where there are several does too; an `operator` source spawns nothing and reads `unknown`;
  a `promql` source refuses a signal at the operator's edit and reads it `unknown`; the id projection is
  appended to `kql` alone; `LUBBDUBB_WATCH_SOURCE` reaches the command; the bench row's fence takes the
  source's language; `goal_watches.source` reaches a database from before it; and `validateEnvironments`
  refuses each source shape that would read nothing (`test/watchSources.test.ts`).

**Not yet built**, and owed by the changes that build each piece:

- `watch_plan` with no checks and no `emptyReason` is refused, and authors nothing;
- `watch_plan` refuses a goal with no standing delivery;
- an assessor whose turn ends after the check set leaves the watch owed, and rule `watch-plan`
  dispatches for it on the next pulse;
- a `watch_plan` set takes effect on nothing until it is accepted, and `listGoalWatches` never returns
  it before then;
- an arrival landing while the watch is owed is **deferred, not stamped**, and opens a window sized
  from the arrival when the set is accepted;
- an `operator` source spawns nothing, files one `watch_reading` ask per check per environment per
  ask, and an unanswered closing ask settles `unknown` after `operatorGraceMs`;
- `watchOutcome`: any `regressed` reads _made something worse_ and still names the clean checks;
  `unknown` everywhere is never _worked_; an empty watch reads _nothing measured_ with its reason;
- **Discuss in Claude** writes one note and no `WorldEvent`, and draws no button without
  `discussionsDir`;
- the outcome changes no hold, asserted with `holds` absent and present;
- `watch_declare` answers with the retirement refusal.
