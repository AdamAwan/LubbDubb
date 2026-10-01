# Proposal — the arrival sheet

**Status: under discussion.** Nothing here is built. When the work lands, the load-bearing reasoning
moves into the specs it changes — [08](../spec/08-planning.md), [11](../spec/11-mcp-tools.md),
[13](../spec/13-jobs-and-tickets.md), [14](../spec/14-persistence.md), [17](../spec/17-cockpit.md),
[20](../spec/20-validation.md), [24](../spec/24-environments.md),
[29](../spec/29-post-deploy-watch.md) and [36](../spec/36-remote-validation.md) — and this file is
deleted by that change.

## What the operator should meet

When a goal's work arrives in an environment, the operator should be shown one thing:

```
#412 Retry the intake fetch on 5xx  ·  arrived in testUk at a1b2c3d, 10 min ago

  Your criteria
    1. A 5xx from intake is retried with backoff
    2. After 3 failures the job gives up and says so

  Prove it works                              browser · tenant $TEST_TENANT · seeded 2d ago
    A  Trigger a 5xx; the fetch is retried 3 times     proves 1 · the retry is the whole change
    B  Fourth failure marks the job failed, not stuck  proves 2 · the old bug was a silent hang

  Check the data                              SQL · state.run on testUk
    q1 intake_jobs.retry_count exists and is backfilled   migration 0042 adds it
       ▸ query · runs on testUk when you press OK

  Watch it                                    observe · 48h here (acceptance: ends on time)
    r1 signal  "IntakeFetch gave up", no more than 5   proves 2 holds under real load
       ▸ log added by part 2 · not seen yet
    r2 measure intake p95 no worse than 812ms   baseline taken on devUk at plan time

  Also yours on this goal (once, not per environment)
    C  Confirm the support team's alert email reads correctly   proves 2 · nobody else can

                                        [ OK, run it ]   [ Change something ]
```

The operator presses **OK** once. The harness then runs everything on that sheet and says nothing more
unless something needs a person. The goal page shows one status per environment: _Preparing_,
_Needs you_, _Queued_, _Running_, _Watching, 212 of 500 runs_, _Regressed_, _Couldn't read_,
_Clear_, _Not validating here_ or _Nothing to check_.

That is the whole proposal. The rest of this document is what has to change for that sheet to be
true, and what must not break on the way.

## Why today is a mess

The pieces all exist. What does not exist is one place that asks once. Between "delivered" and
"closed", one environment's validation currently takes the operator through:

| Today                                                 | Key                         | Where it lives          |
| ----------------------------------------------------- | --------------------------- | ----------------------- |
| Accept the check set (and decline rows)               | goal                        | proposal card           |
| Approve each `state` query for this environment       | (query digest, environment) | sheet                   |
| Approve each watch query _again_ for this environment | (query digest, environment) | sheet                   |
| Accept an agent's watch declaration                   | watch check                 | plan sheet              |
| Deselect rows, reseed the tenant, press go            | (goal, environment)         | sheet                   |
| Hand individual checks to the fleet instead           | check                       | Validate pane           |
| Release an environment gate                           | goal                        | goal header             |
| Settle the `validate` bench row                       | goal                        | Needs-you rail          |
| Answer a watch finding, extend the window             | (goal, environment)         | Needs-you rail, Signals |

Three things make it feel worse than its length:

1. **Three consents for one read.** A `state` step needs the set accepted, its query approved here,
   and the sheet pressed. Each was added for a good reason; together they ask one question three
   times.
2. **Signals and metrics are read twice.** The watch reads them on its window's clock; the sheet
   reads the same queries again at a point in time, into a different table. Two answers to one
   question, drawn in two places.
3. **No check says why it is the right proof.** A check cites the criterion it `satisfies`. Its only
   `why` explains why it was nominated for the fleet ([20](../spec/20-validation.md#the-check-set)),
   not why this check proves the criterion.

## The design

### One sheet per goal and environment, widened

The object is today's **sheet** ([36](../spec/36-remote-validation.md#the-sheet)), keyed
`(goal, environment)`, kept under its own name — a new noun for the same thing is what
[17](../spec/17-cockpit.md) refuses — and widened. It is drawn for every environment the goal reaches
that declares `validate` **or** `observe`. Query rows are labelled `q1…` and watch rows `r1…`, so no
letter is shared with a check's.

Only the validate half is stored. The **watch section**, and the whole page on an environment with
`observe` and no `validate`, are a read-time projection of the goal's watch checks and its
`watch_windows` row: no `remote_sheets` row, no `goal_arrivals.sheeted_at` stamp, and nothing
`RemoteValidationDesk` assembles. That keeps the desk's early return and its stamping rules exactly
as they are ([36](../spec/36-remote-validation.md#the-desk)). _Preparing_ applies to the validate
sections only.

| Section                | Rows from                                                    | Run by                           | Needs the OK |
| ---------------------- | ------------------------------------------------------------ | -------------------------------- | ------------ |
| Prove it works         | checks whose first step a carrier here can run               | the environment's browser runner | yes          |
| Check the data         | the goal's `state` queries                                   | `validate.state.run`             | yes          |
| Watch it               | the goal's live watch checks, and pending agent proposals    | `observe`, on the window's clock | no           |
| Also yours on the goal | checks whose first step is a person's, or that have no steps | a person                         | no           |

- **The watch needs no OK, as today.** Plan approval already authorised its queries to run on the
  window ([29](../spec/29-post-deploy-watch.md#the-operator-at-any-point)), and the window opens on
  arrival ([29](../spec/29-post-deploy-watch.md#opening)). An environment with `observe` and no
  `validate` — production, often — gets a sheet with only its watch section and no button. The watch
  is on every sheet so the operator reads the whole of what will happen in one place.
- **Person checks are the goal's.** A check whose first step is a person's
  ([20](../spec/20-validation.md#who-carries-a-step)), or a prose check with no steps, is done once.
  Every sheet lists it in the same _Also yours on this goal_ section, marked done once it is; it is
  never repeated as work per environment, and it does not depend on which environment arrives first.
  A check whose fleet steps are cut by an inline person step stays in _Prove it works_ with a
  _then you:_ line at the boundary, exactly as `segmentBoundary` already splits it. Today `sheetRows`
  puts every non-declined check on every sheet as a `check` row; it now leaves person-first checks
  out, so the press and `idle_reason` stop counting rows nobody can run there.
- **A check whose steps no environment can carry** is still handed to the fleet from the Validate
  pane, as today. Nothing here narrows hand-over.

The header names **how**: which runner, which tenant (the variable's _name_ for a `tenantEnv`, never
its value), how old the tenant's seed is, and how the watch ends.

### The check set keeps its own accept

The check-set accept stays exactly as it is
([20](../spec/20-validation.md#the-check-set-is-proposed-before-it-is-work)), because a goal may never
reach an environment with `validate`, and a set that could only be released by a sheet would stay
unreleased for good, holding the close-out with nothing red. What changes is that the OK **also
accepts the set** when it is still open, so an operator who meets the sheet first does not have to
find the card. Both write `validation_plans.released_at`. A set re-authored after it was accepted
goes back to proposed, as today, and every sheet drawn from it returns to _Needs you_.

### One OK

The OK happens in two steps, because the dry runs it needs are spawns of up to thirty seconds each
and cannot sit inside a database transaction:

1. **The dry runs.** Every `state` query on the sheet not yet approved here is dry-run against this
   environment, as today's approve call does, and every pending agent watch proposal on the sheet
   is dry-run as its accept does today, taking its baseline. Each result is drawn on its row.
2. **The write**, in one transaction: the set's release if still open; approval, keyed
   `(query digest, environment)`, of every query whose dry run answered properly; acceptance of the
   watch proposals that dry-ran properly; and an **intent** to run the browser rows.

A query whose dry run fails, or answers the wrong shape, is not approved. It is a `blocked` row with
**Retry dry run** beside it, and nothing else on the sheet waits for it.

The reasons behind today's separate consents carry over, because the OK is given on a sheet that
names the place and shows the text:

- _Consent to a place is not transferable._ The OK is per environment. Approving testUk approves
  nothing on liveUk.
- _Nothing runs an unapproved query, ever_ ([36](../spec/36-remote-validation.md#what-it-is-not)). No
  query that is not already approved here runs on this environment before the OK. A query approved
  here for an earlier goal still runs at assembly, as today. Before the OK, the sheet shows the query text and, where
  one exists, the plan-submission dry run — taken on the first environment with a `state.run` (for
  `state`) or an `observe` (for the watch), usually before the work deployed — labelled with where and
  when it ran.
- _Starting browser runs automatically spends on arrivals nobody reads._ The OK is the press.

**An OK covers the sheet as it was shown**: the set revision, the query digests and the rows on it.
Anything new — a re-authored set, an edited query, an amended check — returns the sheet to _Needs
you_ with only the new rows marked; nothing runs on a stale OK. A sheet is never reassembled today
([36](../spec/36-remote-validation.md#the-desk)), so this needs a **row re-sync**: when the set's
revision moves, the desk adds rows for new checks and marks dropped ones, keeping the readings of
rows that did not change.

**Agent watch proposals are goal-wide and never hold anything.** Accepting one on testUk changes what
liveUk's window reads too, so the row says so. A new proposal is drawn on the sheet but does not
return it to _Needs you_ and does not count toward the `validate` row's holds — that would hold the
close-out on the watch. A proposal accepted after the work has deployed takes its baseline from
post-change data, so it is drawn with the baseline-lost line (_below_).

**Change something** opens the rows for the verbs that exist today: **send the checks back** (the
whole-set reject, [20](../spec/20-validation.md#when-an-operator-sends-a-check-set-back)), decline a
check, waive with a reason, deselect for this environment, edit a query, reseed. A decline is a state
on the check, so it is goal-wide, and the sheet says so. Declining every remaining check is refused
here and offered as _send the checks back_ instead, so a released set of nothing never reads like a
set declared empty on purpose ([20](../spec/20-validation.md#declining-a-single-row)).

**Not validating here** is a sheet-level verb, with a required note: this environment will not be
validated for this goal. It clears both of the `validate` row's new holds for that environment, the
way the gate's _not waiting on an environment_ release clears a gate. Without it, a sheet on an
environment the operator never means to use, or an intent waiting on a tenant nobody will configure,
would hold the close-out for good.

**A group** is a page per member, as today. _OK for all of `liveGroup`_ is offered only when every
member has arrived and their rows, queries and tenants are identical; it still dry-runs on each.

### The intent

The intent is a row in a **new table**, `remote_run_intents`, keyed `(goal, environment)`, holding
the set revision and query digests it covered and when it was given or withdrawn. A new table rather
than a column on `remote_sheets`, because a null column there would read "not OK'd" on every sheet
that exists, and flip them all to _Needs you_ the day it ships
([14](../spec/14-persistence.md#when-a-null-means-something)). Nothing about `remote_runs`, its
statuses or the `remote_runs_open` predicate changes.

Its life:

- **Consumed** when a run row is opened for it. One intent, one run.
- **Back to _Needs you_** when that run is abandoned — by the pin, the sweep or the operator's cancel —
  with the reason on the sheet. The desk never re-opens a run on its own, so a pin that keeps refusing
  writes one abandoned row, not one per pulse.
- **Withdraw OK** removes it while it is still queued.

The intent's columns sit in the new table's `CREATE`; later columns need `ensureColumns` entries like
any other table.

### After the OK

`RemoteValidationDesk` gains the arm that carries the intent out. It stays where it is, in
`src/validation/remote/` and between `remoteValidation` and `validationReady` in the pulse, because it
writes the `pending` row a rule reads — which is why it is not in `src/environments/`
([24](../spec/24-environments.md#the-desk)).

The arm does **one** thing: when the `(environment, tenant)` lock is free, it calls today's press
**unchanged** — lock, pin, open the run, run the `state` rows, count what the run owes its agent
([36](../spec/36-remote-validation.md#the-press)). While the lock is held it does nothing and the
sheet reads _Queued behind #398_. It never takes the pin itself, so a run queued for hours opens on a
fresh pin, and the press stays the only writer of a run row. With no tenant the intent waits, and the
row is `blocked` naming the variable or command that would supply one. The watch is untouched: its
window opened on arrival and reads on its own clock.

### Where the operator hears about it

**Validation** stays on the goal's existing **`validate` bench row**, so `arrival.opens` and
`watch.holds`, which name it, keep working. Today it is filed, kept and settled on one count: what is
owed to a person (`owedToAPerson`, `src/validation/ready.ts`). That count gains three things, in the
file, settle and reopen arms alike: a sheet awaiting its OK, an intent queued or a run running, and
an unresolved failure on an environment. Holds added only to a row that already exists would hold
nothing on the environment where every check had already passed elsewhere — liveUk's sheet would wait
for an OK nobody was asked for. That is what keeps the close-out behind the checks, as
[24](../spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time) requires. Its detail lists,
per environment:

- a check `failed` (rule `validation-failed` still runs), with **Raise a bug**;
- a `blocked` row: no tenant, no runner, a dry run that failed, an edit not yet OK'd;
- a `captured` screenshot to look at;
- a run abandoned by the pin, the sweep or a cancel;
- a run still `pending` after four probe intervals **while not waiting on fleet headroom**;
- rows a press cannot read (`idle_reason`), named;
- person checks still owed.

**A failure after the row was settled** — liveUk failing a week after the operator marked the row
done — must not fold silently onto a settled row ([13](../spec/13-jobs-and-tickets.md)). Today rows
are keyed by title, one per goal. They become keyed `(goal, environment | null)`: the goal-wide row
keeps a null environment and today's title, and a late failure files a **separate** row titled for
that environment.
If the close-out is already filed or done, it is not retracted, and nothing filed after it re-holds
it: the late row stands alone.

**The watch** stays on the **`watch` row**, for every environment, and is mirrored on the sheet. It is deliberately not on the `validate` row: there it would hold the close-out on the watch,
which [29](../spec/29-post-deploy-watch.md#it-holds-nothing-unless-asked) forbids. `watch.holds` keeps
today's rule, including that a settled `unknown` clears it.

**The `watch` row gains two `unknown` arms.** Today an `unknown` files nothing
([29](../spec/29-post-deploy-watch.md#the-bench-row), [13](../spec/13-jobs-and-tickets.md)), and a
settled window is never read again, so the filing happens in a new step **at settle**, after the
window is settled and before the pass files anything else. It files in two cases only:

- the observation itself failed for the whole window — the command, the credential, the store;
- a check with `emittedBy` settled with its presence never having answered: _part 2 was meant to log
  this, and testUk never saw it_.

Its wording is its own: _the watch could not answer_, with **Raise a bug** for an `emittedBy` check,
never _Done means not a regression_. A presence of zero on an environment where the path never runs, or an evidence target not met, files
nothing, as `unknown` files nothing today ([29](../spec/29-post-deploy-watch.md#the-bench-row)). Those
are the normal state of an acceptance environment, and filing them would put every goal on the rail.

### The close-out

Unchanged: it waits on the `validate` row, and carries the watch's status per environment in its
detail ([29](../spec/29-post-deploy-watch.md#it-holds-nothing-unless-asked)).

### What it replaces

| Today                                        | In this design                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| Sheet                                        | **Kept**, widened: reasons, the watch section, person checks, the OK.     |
| Sheet `signal` / `measure` rows and readings | **Removed.** The sheet draws the window's readings; see _Retiring them_.  |
| Per-environment approval of watch queries    | **Removed** with them. It gated only those rows.                          |
| Per-environment approval of `state` queries  | Folded into OK. The `(digest, environment)` table stays.                  |
| Accepting an agent's watch declaration       | Also drawn on the sheet and accepted by its OK; goal-wide; holds nothing. |
| Press                                        | Folded into OK, carried out by the desk when the lock is free.            |
| Check-set accept card                        | **Kept.** The OK also accepts it when still open.                         |
| `validate` bench row                         | **Kept**; its owed count gains three things; a late row per environment.  |
| `watch` bench row                            | **Kept**, for every environment; gains two `unknown` arms at settle.      |

**Retiring them.** Environments already declare `permits: ["signal", "measure"]`, and
`validatePermits` refuses an unknown kind at boot (`src/environments/policy.ts`), so deleting the
names would stop those deployments starting. Both stay accepted and are ignored with a warning, the
way a retired tool name answers rather than vanishing
([11](../spec/11-mcp-tools.md#retired-tools)); a `permits` that held only those two is read as
permitting no validate rows — the environment's page is its watch alone — rather than refused as
empty. The watch section depends on `observe`, never on `permits`. A one-off
migration deletes existing `signal` and `measure` sheet rows and their readings.

Untouched: local validation ([32](../spec/32-local-validation.md)), environment gates, `arrival.opens`,
`watch.holds`, fleet hand-over.

### How long to watch

Today a window is a fixed time per environment (`watch.forMs`, 48 hours by default). Time alone is the
wrong measure in production: a fix to a weekly job has no evidence after 48 hours, and a fix on a busy
endpoint has plenty after one. What the operator wants to know is whether the changed code has run
**enough times** to say.

- **The time limit stays the environment's.** `forMs` is still the one answer to "how long can a
  watch run here", for the reason [29](../spec/29-post-deploy-watch.md#opening) gives. A team that
  wants weeks in production sets weeks there.
- **Evidence is opt-in per environment.** An environment that sets `watch.untilEvidence` ends a window
  when the goal's evidence target is met, or at `forMs`, whichever comes first. Every other
  environment ends on time, as today. Acceptance environments, where real traffic never arrives,
  simply do not opt in.
- **The target is the goal's.** The planner declares a `count` check — one query returning how many
  times the changed path ran since `{since}` — and a target, with a reason: _"intake runs about 300
  times a day; 500 runs is two days of production traffic."_ That is not the second answer to the
  window's length that [29](../spec/29-post-deploy-watch.md#opening) refused: it asks how often _this
  code_ runs, which the ticket knows and the deployment does not.
- **`count` is a third kind in `WatchSchema`**, beside `signal` and `measure`. It returns one row and
  one number, is exempt from the tail refusal that stops a signal aggregating, carries `{since}`, is
  dry-run with the others — exempt from the dry run's one-row-one-number refusal (`scalarShaped`),
  which is exactly its shape — and approved with the plan like them. A reading that fails is `unknown`
  with that reason; the sheet shows the count with the time it was read, never a stale number as if
  current. A window that never got a count reading settles at `forMs` as `unknown`.
- **Settling on evidence checks after the read.** The pass is open → settle → read today
  ([29](../spec/29-post-deploy-watch.md#the-window)); a window whose target is met by this pass's
  reading is settled at the end of the same pass, before anything is filed, so evidence costs no
  extra interval and the row describes the settled window.
- **Extend** is offered only on a window that ran out of time. One that met its target is done.

**Long windows need bounded reads**, for every kind, not just `count`. A signal or presence query
returns a row per occurrence since `{since}`; read from arrival over three weeks, that is thousands of
rows on every reading and a thirty-second kill that turns it `unknown`. So on a window longer than 48
hours, signal and presence readings take `{since}` as the previous reading's time, and the window is
read every `watchIntervalMs` for its first 48 hours and every six hours after — about 170 readings per
check over three weeks.

The **verdict must then fold running totals**, not the newest reading. Today it reads only the newest
reading per check and compares its row count against `tolerate`, with presence at zero rows meaning
`unknown` (`src/environments/watchVerdict.ts`). On six-hour slices a weekly job's presence is zero in
most of them, and a regression in one slice clears in the next. So each check carries
`total_matched` and `total_presence` on its window (columns with `ensureColumns` entries): a signal is
judged on its total against `tolerate`, and presence counts as answered once its total since arrival
is above zero. An edit to the query resets both; an extend that takes a window past 48 hours seeds
them from the last cumulative reading. The **baseline** reads at most 48 hours back, whatever
`forMs` is, so a three-week window does not make its baseline a three-week read.

### Making sure the telemetry exists

A signal is declared at plan time, but the log line or metric it reads is often added by the work
itself. Today nothing makes sure it is. The dry run cannot tell — the line does not exist until the
change deploys — and today it **refuses** a signal whose presence finds nothing, telling the planner
to fix a query that is correct ([29](../spec/29-post-deploy-watch.md#the-dry-run)).

Make the instrumentation part of the work, without gating anything on it:

1. **The plan says what must be emitted.** A watch check that reads telemetry the work adds names
   the **part** that adds it (`emittedBy`), and that part's acceptance carries the line: _"Log
   `IntakeFetch gave up` with the job id when the fourth attempt fails."_ A check with `emittedBy` is
   **exempt from the presence-zero refusal**, because zero is what it should read before deploy.
2. **The building agent is told, and declares.** The part's prompt is handed the owed telemetry,
   **appended**, never interpolated. On concluding it is asked to `watch_declare` the exact line the
   diff emits. That arrives as a pending proposal, as today, and is drawn on every sheet for the goal
   — so the operator's OK accepts the accurate line, not the planner's guess.
3. **Review reads for it.** The review agent is handed the owed lines, appended, and checks the diff
   emits them, as it checks any other acceptance line. A missing line is a review finding.
4. **Nothing waits on it.** A merged part settles by merge, as today. Held, a merged part would wedge
   its dependents with nothing red.
5. **The first environment proves it.** A check with `emittedBy` whose presence has not answered is
   drawn _not seen yet, owed by part 2_, and files on the `watch` row if its window settles that way.

### When a signal turns out wrong

Signals are first written at planning, amended by the working agent, and editable by the operator at
any point ([29](../spec/29-post-deploy-watch.md#who-writes-it-and-when)). Finding out after arrival
that one is wrong is two different problems:

- **The query is wrong and the data is there.** While the window is **open** this already works: an
  edit clears that check's readings and the next pass reads it again. Once the window has
  **settled**, nothing re-reads it, because a settled watch is never re-opened by a reading
  ([29](../spec/29-post-deploy-watch.md#closing)). So add **Re-read** on a settled window: an
  operator's click, as extend is, that re-opens the **whole window** — it is still read whole, one row
  per `(goal, environment)` — with the edited checks read back from arrival and the verdict it fixed
  still drawn beside the new readings. On a long window the edited checks walk forward from arrival
  in 48-hour slices over successive passes, so the re-read is never one read over weeks.
- **The code does not log what is needed.** That is a defect in the work: **Raise a bug** from the
  `watch` row, and the telemetry arrives with the next deploy.

**A measure's baseline is one reading**, taken at declaration on the first environment with an
`observe`, and compared against every environment's window
([29](../spec/29-post-deploy-watch.md#the-baseline-and-why-a-measure-is-not-trusted-without-one)). The
sheet says where and when it was taken, as the mock does. A measure whose query is edited after the
work has deployed anywhere has lost its baseline — it cannot be retaken from before the change — so
it falls back to its absolute threshold with _no baseline, threshold only_, or reads `unknown`.
Whether to take a baseline per environment, before each arrival, is an open question.

**The first environment is the rehearsal.** A signal whose window settles with presence answering but
its own query never once matching is drawn _matched nothing in 4,000 runs — is it asking the right
question?_ It is a line on the sheet, not an exception: a fix that works should match nothing.

### A reason on every check

Validation checks gain `rationale`: one line, beside `satisfies`, saying why this check, and not a
cheaper one, proves the criterion. It is not `why`, which already means the fleet nomination's reason
([20](../spec/20-validation.md#the-check-set)). It is added to the plan document's `validation` block,
to `validation_plan` and to `validation_amend` ([11](../spec/11-mcp-tools.md)), and the instruction is
appended to the authoring prompt. A check written before the field shows its `satisfies` line alone.

## What must not break

- **The harness never generates or infers a tenant.** No tenant is a `blocked` row naming the
  variable or command that would supply one; the intent waits.
- **No reading is a `WorldEvent`.** Status is computed from rows, never written as an event.
- **`unknown` never folds to `clean`.** _Clear_ needs every watch check `clean`, and a goal with no
  checks and no watch reads _Nothing to check_, never _Clear_.
- **A failed check is never a shortfall.**
- **Nothing runs an unapproved query.** Per-environment dry runs happen inside the OK.
- **Approval is keyed on `(digest, environment)`**, and an edit drops it everywhere.
- **The close-out follows the checks.** The `validate` row keeps today's settle rule and gains holds;
  it loses none.
- **The watch holds nothing unless asked**, and `watch.holds` is unchanged.
- **An arrival waiting on its check set is never stamped away.** The sheet reads _Preparing_ until a
  set is authored. Assembly keys on _authored_ now, so the freshness guard is re-keyed: a sheet is
  assembled for an arrival, or a set authored, within two probe intervals, so turning `validate` on
  does not draw sheets for every old set.
- **A watch reading is written only by the window.**
- **Two dispatches never share a browser profile.**
- **The lens boundary.** The desk arm lives in `src/validation/remote/` beside the desk it extends; the
  rule still reads only the `pending` run row.

## Open questions

1. **Plan approval as a preview.** Should plan approval show a draft of the arrival sheet, so the OK
   on arrival is usually a formality?
2. **A baseline per environment.** Take a measure's baseline on each environment before the work
   arrives there, rather than once on the first?
3. **A count required?** On an environment with `untilEvidence`, should a watch with no `count` be
   refused at plan submission rather than ending on time?

## Order of work

1. **The widened sheet and the OK**, together with **dropping the sheet's watch rows** and their
   per-environment approvals, so nothing on the sheet is left needing an approval it no longer has a
   button for: the retired `permits` names and the row-deleting migration; `remote_run_intents` (new
   table); the desk arm calling the press; Withdraw OK, Retry dry run, Not validating here; the row
   re-sync; `sheetRows` leaving person-first checks out; the `validate` row's owed count, keying and
   late row.
2. **Agent watch proposals on the sheet**, accepted by the OK.
3. **`rationale` on checks.** Column with an `ensureColumns` entry, the plan-document field, the
   tools, the appended note.
4. **Owed telemetry.** `emittedBy` (column, `ensureColumns` entry), the presence-zero exemption, the
   appended notes, the _not seen yet_ line, the filing step at settle with both `unknown` arms.
5. **Bounded long windows.** Incremental signal and presence reads; `total_matched` and
   `total_presence` with `ensureColumns` entries and the verdict folding them; the backed-off cadence;
   the 48-hour baseline cap.
6. **Watch until evidence.** The `count` kind, `watch.untilEvidence`, settling after the read.
7. **Re-read a settled window**, and the baseline-lost line.
