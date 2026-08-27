# 29 — The post-deploy watch

**Partly built.** [The declaration](#the-declaration), [the dry run](#the-dry-run),
[asking the environment](#asking-the-environment) and [configuring an
environment](#configuring-an-environment) describe running code, and their paths are backticked.
Everything from [the window](#the-window) onwards — opening, readings, verdicts, measures and
baselines, what a finding does, and every cockpit surface but the plan sheet's — is **not built**:
its paths stay italic, and the marker comes off section by section in the change that makes each
true, not later and not in one sweep at the end. [26](26-setup.md) states the same discipline for
its own unbuilt half. `docs/plans/29-post-deploy-watch.md` tracks which stage owns what.

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

## What it is not

| Not                    | Because                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An APM                 | Nothing here stores telemetry, draws a time series, or is somewhere to go and look. It asks a declared question on a schedule and keeps the answers for one goal, for days.                                                   |
| Anomaly detection      | No baseline is inferred, no threshold is learned, no reading is scored. An expectation is declared or the check does not exist.                                                                                               |
| An alerting system     | A finding is a bench row on one goal. There is no routing, no severity ladder, no on-call. The team's existing alerts are unaffected and unduplicated.                                                                        |
| A dispatch input       | Same rule as the rest of `src/environments/`: nothing under `src/dispatcher/` may import it. A regression files a row and draws a card; the route from a reading to new work is an operator's click. → [05](05-dispatcher.md) |
| A provider integration | An environment's telemetry is a **command**, exactly as its deployed commit is. Application Insights is one answer; the harness holds no opinion and ships no SDK. → [Asking the environment](#asking-the-environment)        |
| A gate                 | A watch holds nothing by default. It reports, and the close-out carries what it says. One opt-in makes it hold, and it is off. → [What a finding does](#what-a-finding-does)                                                  |
| A model spend          | No agent is dispatched to read telemetry, interpret a number or decide whether a reading is bad. The only model tokens are riders on sessions already running. → [Cost](#cost)                                                |

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

**Only `signal` is declarable so far.** A `measure` arrives with the baseline capture that makes it
honest — an absolute threshold alone is a number somebody guessed, and a measure declaring neither a
threshold nor a baseline reads as a check and cannot fail. `WatchSchema`
(`src/validation/watchDocument.ts`) refuses a `measures` key rather than accepting one nothing reads;
the output contract below already parses a measure's row, because the shape it refuses is the same
shape a stale wrapper produces.

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

## Who writes it, and when

Three writers, at the three moments each knows something the others do not. This is the same
arrangement as the validation sheet, for the same reason: a plan's author, its implementer and its
operator hold different facts and none of them holds all three.

### The planner, at plan time

Writes the `watch` block into the plan document, beside `validation`
([08](08-planning.md), `src/plans/planDocument.ts`). It knows the goal, the ticket and the
repository, so it can name a code path, an operation, a role, a feature flag.

**For a defect this is the strong case, and it is worth stating on its own: the watch is knowable
before the fix is, because the bug report _is_ the signal.** A ticket reading _"job X keeps timing
out in proc Y"_ contains its own post-deploy check — job X stops timing out — and that check can be
written, and proven to fire, before a line of the fix exists.

### The working agent, at conclude time

**Not built.** The tool ships with measures; a planner's declaration is the only writer today, and
an instruction naming a tool that does not exist is worse than none.

Amends through the `watch_declare` tool (_src/mcp/tools/watchDeclare.ts_), which merges on a check's
slug exactly as `validation_amend` does ([20](20-validation.md#validation_amend)).

It is the only party in the system that knows what the code actually emits. A planner cannot guess
the message template of a log line that did not exist when it wrote the plan, and nothing downstream
can recover it. That is also the second-order reason this tool exists at all: an agent told _"if you
added a log line or a metric for this, declare the watch that reads it"_ has a reason to add one.
The declaration makes the fleet instrument its own work.

It also amends the **planner's** checks where the fix changed what the right question is. A timeout
fixed by adding a retry does not stop producing timeouts; the honest signal becomes "the job fails
after retries", and only the agent holding the diff knows that.

### The operator, at any point

Edits, adds and deletes on the plan sheet, and **approves** — an agent-authored query is not run
against an environment until the plan carrying it is approved, and an amendment lands as a pending
change rather than taking effect. That approval is the whole of the authorisation story: the query
runs inside the operator's own command, with the operator's own credential.

## The dry run

**A declared check is run once, immediately, against the environment it will watch** — at plan
submission, and again on each amendment. The reading is stored on the check and drawn on the plan
sheet.

Three outcomes, and each is worth something different:

| Presence | Signal | Means                                                                                                         |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| fires    | fires  | The query is proven live and the reported defect is proven real. This reading is the baseline.                |
| fires    | zero   | The code path runs and the thing being reported is not happening. Either the query is wrong or the ticket is. |
| zero     | —      | The telemetry has never heard of this code path. Wrong name, wrong application, or nothing instrumented.      |

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
before the arrival, and that reading is stored on the check. It is the number the work has to beat,
taken on the same query, from the same source, before anything changed.

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

`CommandEnvironmentObserver` runs the operator's `observe` command in a shell in `repoRoot`, exactly
as `CommandEnvironmentProber` runs `at` (`src/environments/prober.ts`).

### The query is passed by environment variable, and its return is verified

`LUBBDUBB_ENVIRONMENT`, `LUBBDUBB_WATCH_ID` and `LUBBDUBB_WATCH_QUERY`. The operator's command is
two lines and reads the query out of the variable.

This is a deliberate departure from `at`, which passes **nothing** in, and the reason for the
departure is worth stating because it is the rule that keeps it safe. `at` refuses a parameter
because an operator's command that never learned about a `{commit}` placeholder would silently
answer a wider question — the prompt-template failure in another costume
([05](05-dispatcher.md#prompt-templates)). A per-goal query is unavoidably a parameter, so instead of
avoiding the failure the harness makes it **observable**:

- the harness appends its own projection to the query it hands over, carrying the check's id
  (`idProjection`, `src/environments/watchResult.ts`);
- a result that does not carry that id back is not an answer. It is `unknown`, with the detail _the
  command answered without the query it was given_.

The projection is written as a pipeline segment — `| extend lubbdubbWatchId = "<id>"` — because the
queries these environments answer are pipeline queries. That is the one place the harness has an
opinion about a query language, and it is escapable: an operator whose telemetry is not can echo
`LUBBDUBB_WATCH_ID` from the wrapper instead, and the verification is identical either way.
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
- **Knowledge.** What an author gets wrong once — a property that arrives as a string and needs
  casting — is a claim about this deployment that the repository does not state, which is exactly
  what `src/knowledge/` is ([27](27-knowledge.md)). Learned once, injected into the next author's
  block, rather than rediscovered at full price by every agent.

## The window

### Opening

A watch opens on an **arrival** — one goal's whole work confirmed in one environment
([24](24-environments.md#what-an-arrival-means)) — and never on a merge. Between the two sit a
release train and an approval gate, and a watch opened at merge would spend its window asking a
question about code that is not running yet, then close before it arrives.

It opens **per environment**, so a goal travelling `testUk` → `liveUk` → `liveEu` is watched three
times, separately, with separate readings. That is not redundancy: the acceptance environment is
usually where presence is zero and the production one is where the answer is.

`for` is declared on the watch and defaults to 48 hours. A goal whose subject is a scheduled job
needs a window long enough to contain several runs, which is a judgement its author makes and the
operator can overrule.

### Only for an arrival the harness watched

The freshness guard from the announce pass applies unchanged and for the same reason: the first
pulse after this ships, or after an operator adds `watch` to an environment that has been probing for
a month, would otherwise open a watch on **every goal that ever arrived** — hundreds of queries a
pulse, hundreds of bench rows, against work that shipped in March.

So a watch opens only for an arrival confirmed within two probe intervals of now, and every arrival
is **stamped** as considered either way. The stamp is what makes the next arrival the first one
watched, rather than the whole history arriving at once.

### Closing

At `for`, the watch **settles**: its readings stop, its verdict is fixed, and the rows stay on the
goal page as the permanent account of what production said about this work. A settled watch is never
re-opened by a later reading, for the reason a confirmed landing is never re-asked — this is a record
of what happened after a deploy, not a monitor.

An operator may **extend** an open or just-settled watch, which is the honest answer for a window
that closed before the weekly job ran.

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

## What a finding does

Three outlets, and no fourth. `src/environments/` is a lens: nothing under `src/dispatcher/` may
import it, which is asserted structurally, so a watch **cannot** spend an agent even by accident.

- **A `human_tasks` row** on the goal, naming the check, what it expected and what it read
  ([13](13-jobs-and-tickets.md#human-tasks)). One row per watch that settled or is settling
  regressed, never one per reading.
- **The goal page**, which draws every check on every environment whether or not anything is wrong.
- **A bug**, through the filing job that already exists (`src/bugFiling.ts`), behind an operator's
  click. The reading rides as the operator's own report, so the fleet is handed the numbers rather
  than a paraphrase, and the bug is related back to the goal by `IssueCreateInput` rather than by a
  sentence in a prompt ([13](13-jobs-and-tickets.md#filing-a-ticket)).

The click is the bound. Arms A and B of a shortfall are put to a person before they happen because
they spend a fleet ([13](13-jobs-and-tickets.md)); a watch that filed its own bugs is the same loop
with a log spike as its trigger and nothing on the outside of it.

### It holds nothing, unless asked

The close-out is **not** held while a watch is open. A 48-hour hold on every delivered goal would put
every goal on the bench in a state nobody can act on, which is the rail burying its own asks — the
argument that keeps an environment gate off the Needs-you rail
([24](24-environments.md#in-the-cockpit)).

What the close-out does carry, in its detail, is what the watch says: open and clean so far, settled
clean, or settled regressed. A row settled early is closed in front of that reading rather than past
it, which is `validate`'s arrangement exactly ([20](20-validation.md#saying-so-on-the-bench)).

`holds: ["close_out"]` on an environment is the opt-in for a team that wants the stricter thing, and
it is off.

### A reading is never a `WorldEvent`

The activity feed is the obvious place to put a regression, and `deliveryHold` expires a standing
delivery verdict on **any** world event matching the goal's issue ref
([03](03-world-model.md)) — so a watch reading written as one would un-park the goal it just reported
on and hand the finished fix straight back to the fleet to do again. Nothing errors, and the
re-dispatch of completed work looks like the harness deciding there is more to do. Watch readings
have their own table and their own wire list, and the cockpit merges them at the feed's door, which
is what arrivals already do and for this exact reason
([24](24-environments.md#in-the-cockpit)).

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
- **A cap per pulse**, oldest watch first, deferring rather than dropping, so a backlog drains in a
  fixed order and nothing starves — `MAX_LANDINGS_PER_PULSE`'s arrangement.
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
in two months, with nothing red. Nothing reads it yet; it is validated so an operator's file cannot
carry a value the window pass will later misread.

`watch` is optional per environment. An environment without one is observed for reach and nothing
more, and a goal whose environments declare no `observe` draws no watch surface at all — the same
off-by-default arrangement as `environments` itself.

`environments` is `fileOnly` in `CONFIG_FIELDS` and stays that way: `observe` is another shell
command the harness runs on a schedule, which is a thing to write deliberately in a file. No agent
can write it; nothing in `src/mcp/` touches config.

`validateEnvironments` (`src/environments/policy.ts`) grows the refusals whose absence is otherwise silent:

- an empty `observe` on a declared `watch`, which leaves every check unanswerable forever;
- a `holds` naming an obligation the harness does not file;
- a `describe` without an `observe`, which is a schema for a question nothing asks.

## In the cockpit

→ [17](17-cockpit.md). Four surfaces and one changed reading. **Only the plan sheet is built**; the
three below it and the strip's fold are italic for that reason.

**The plan sheet** draws the watch beside the validation checks, each check with its query, its
expectation, and the dry-run readings under it (`web/src/components/WatchDigest.tsx`). Read-only, for
`ValidationDigest`'s reason: the sheet is where checks are _defined_, and approving the plan is what
authorises the query to run against the operator's own telemetry with the operator's own credential.
A check nothing has asked about yet says so, in those words — not yet put to an environment is not a
clean reading. An amendment from an agent draws as a pending change
with accept and decline, because approving the plan is what authorises the query.

**The goal page's Environments card** grows a watch block **inside** each environment's row —
indented, on the well, with a tinted left edge. Inside the row and not beside it, because a watch
belongs to an arrival: drawn as a sibling, the two surfaces would be free to disagree about which
environment a reading came from, which is the disagreement the strip's fold exists to prevent one
layer up.

Each check draws as a line of **expected, before, now**. The before is what makes the card worth
looking at — a p95 of 310ms means nothing alone and everything beside the 8,400ms it replaced — and
it is available precisely because the baseline was taken at declaration.

**An `unknown` says why in words**, on the row, and never in the vocabulary of a clean one.

**The Needs-you rail** carries one row for a settled-regressed watch, with the reading in it and the
bug-filing control beside it.

**The track strip's Environments stage** gains the watch's reading — `liveUk · watch clean` — folded
off the card below it rather than computed a second time, which is the strip's existing rule
([17](17-cockpit.md)).

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
  keeps the verdict taken while it was there.
- **Anything finer than `watchIntervalMs`.** A spike that opens and closes between two readings did
  not happen, as far as this is concerned.
- **A check whose telemetry is correct and whose question is wrong.** The dry run catches a query
  that resolves nothing; it cannot catch one that resolves the wrong thing confidently. That is what
  the operator's approval is for, and it is a human check by design.

## Persistence

→ [14](14-persistence.md). Three tables, owned by `src/store/watches.ts` and delegated from
`src/store/store.ts` under the same method names, per the store's composition rule.

| Table            | One row per                   | Written                                                                    |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `goal_watches`   | `(goal_ref, check_id)`        | `OR REPLACE` on the declaration; the merge key is the slug                 |
| _watch_windows_  | `(goal_ref, environment)`     | `OR IGNORE` — an arrival opens one window, and re-arriving is not a second |
| _watch_readings_ | `(window, check_id, read_at)` | append-only, pruned with its window                                        |

`goal_watches` also carries the dry run — the environment it was put to, when, what the check's own
query and its `presence` query each answered, and the row count. On the check rather than in a
readings table because it is a reading of the _declaration_, taken before any window exists, and it
is cleared by a re-declaration for the same reason.

The last two are not built. All three are new tables, so none needs a `ColumnMigrations` entry — and a table being new **once**
does not keep it exempt from the next column added to it
([14](14-persistence.md#migrations)).

`watch_windows.settled_at` null means **still watching**, which is a null that means something: a
column added to it later, without the gated backfill, would reopen every settled window on the boot
an operator takes the build ([14](14-persistence.md#when-a-null-means-something)).

`watch_readings` is the one table here that grows with time rather than with the fleet's work, and it
is bounded by pruning with its window rather than by a cap on rows: a window's readings are the
evidence behind its verdict, and a retention rule that dropped them would leave the verdict standing
with nothing behind it.

## Tests

At the `buildSystem` seam with `FakeEnvironmentObserver` injected beside `FakeEnvironmentProber`
([19](19-development.md)), plus unit tests on the pure fold. The ones that earn their place are the
silences:

- a signal with zero rows and **zero presence** is `unknown`, not `clean`;
- an observation that fails, times out, or answers without the id echo is `unknown`, not `clean`;
- a measure answering with two rows is `unknown`, not the first row;
- a watch does **not** open for an arrival older than two probe intervals, and the arrival is stamped
  anyway;
- a settled watch is not re-opened by a later reading;
- a goal with no declared checks reads null, and draws nothing;
- nothing under `src/dispatcher/` imports the module, asserted structurally with the existing lens
  assertions.
