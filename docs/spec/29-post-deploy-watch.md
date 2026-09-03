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
    "query": "requests | where name == 'POST /orders' | summarize value = percentile(duration, 95)",
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

Amends through the `watch_declare` tool (`src/mcp/tools/watchDeclare.ts`), which merges on a check's
slug exactly as `validation_amend` does ([20](20-validation.md#validation_amend)) and refuses exactly
what a plan document refuses, because it parses with `WatchSchema` rather than a second copy of it.
The instruction that names it is appended to the two prompts that dispatch work (`watchDeclareNote`,
`src/plans/planning.ts`), never interpolated into one.

It is the only party in the system that knows what the code actually emits. A planner cannot guess
the message template of a log line that did not exist when it wrote the plan, and nothing downstream
can recover it. That is also the second-order reason this tool exists at all: an agent told _"if you
added a log line or a metric for this, declare the watch that reads it"_ has a reason to add one.
The declaration makes the fleet instrument its own work.

It also amends the **planner's** checks where the fix changed what the right question is. A timeout
fixed by adding a retry does not stop producing timeouts; the honest signal becomes "the job fails
after retries", and only the agent holding the diff knows that.

**It adds and amends, and withdraws nothing.** An agent holding one part's diff knows about one check
and nothing about the others, and a withdrawal from it would need a pending-delete state to be honest
about. A check that should go is the operator's to delete or a planner's to stop declaring.

The planner's own guidance is appended too (`watchNote`, `src/plans/planning.ts`), and both notes
reach the dispatch rules as **rendered strings** rather than as an import: `src/dispatcher/` still
names nothing under `src/environments/`, which is the lens boundary this subsystem is built inside.

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
before the arrival, and that reading is stored on the check (`goal_watches.baseline_value`). It is
the number the work has to beat, taken on the same query, from the same source, before anything
changed.

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
- **The board.** What an author gets wrong once — a property that arrives as a string and needs
  casting — is something true of this deployment that the repository does not state, which is a
  **note** ([27](27-obstacles.md#what-it-is)). Raised once and written down, rather than
  rediscovered at full price by every agent.

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
- a `describe` without an `observe`, which is a schema for a question nothing asks.

## In the cockpit

→ [17](17-cockpit.md). Four surfaces and one changed reading.

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

**The goal page's Signals card** draws the declarations themselves — every check on the goal, its
query, what it expects, and what the dry run read — with the controls that change them
(`web/src/components/SignalsSection.tsx`, embedded by `web/src/console/GoalPage.tsx`). It sits under
Validation and above the environments, which is the order the questions are asked in: validation is
_did we build it_, this is _did it do anything_, and the environment rows below carry what each
window has read since. It is not a second copy of the plan sheet's block: the sheet draws a document
under review at approval time, and this draws a live goal being operated weeks later.

Its rows carry the plan sheet's ruling control unchanged, so an operator who never opens a plan sheet
still sees an agent's declaration and can accept or decline it. A check the operator wrote says so —
a `yours` chip, which is the only place the replan rule above is visible.

**Nothing is drawn where nothing is declared and no plan could declare one**: a goal that declared no
checks reads null, and an empty card headed _Signals_ is a surface reporting the fleet verified. A
goal that has a plan draws the card with whatever list it has, because the add controls are how a
list starts.

**The goal page's Environments card** grows a watch block **inside** each environment's row —
indented, on the well, with a tinted left edge (`web/src/console/GoalPage.tsx`,
`web/src/console/console.css`). Inside the row and not beside it, because a watch belongs to an
arrival: drawn as a sibling, the two surfaces would be free to disagree about which environment a
reading came from, which is the disagreement the strip's fold exists to prevent one layer up.

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
bug-filing control beside it (`web/src/view/needsYou.ts`, `web/src/console/NeedsBand.tsx`). It is a
`human_tasks` row like every other on the rail, so it folds off the reading the desk already took
rather than computing a second one — which is the disagreement the strip's fold exists to prevent,
made once for the whole cockpit.

The control opens the bug modal already holding the row's own detail: the check, what it expected and
what it read. A **seed rather than a payload** — it lands in the editable box every bug is composed
in, so what is filed is still what the operator sends, and the numbers ride as their own report
rather than as a paraphrase somebody would have had to retype. It is drawn only where there is a
tracker to file into and a goal to relate the bug back to, and a false draws no button rather than a
disabled one.

**The track strip's Environments stage** gains the watch's reading — `reached liveUk · watch clean` —
folded off the card below it rather than computed a second time, which is the strip's existing rule
([17](17-cockpit.md), `web/src/view/goalPage.ts`). This is the one place a watch is reduced to a
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
  keeps the verdict taken while it was there.
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

`watch_windows.settled_at` null means **still watching**, which is a null that means something: a
column added to it later, without the gated backfill, would reopen every settled window on the boot
an operator takes the build ([14](14-persistence.md#when-a-null-means-something)). `extended_at` is
that table's first added column and the one the warning is about — and it needs no backfill, for a
stated reason rather than by luck: its null means **never extended**, which is exactly true of every
row written before it existed. A column here whose null meant anything else would have to be gated on
`ensureColumns`' report.

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
  assertions.
