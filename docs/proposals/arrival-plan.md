# Proposal — the arrival plan

**Status: under discussion.** Nothing here is built. When the work lands, the load-bearing reasoning
moves into [20](../spec/20-validation.md), [24](../spec/24-environments.md),
[29](../spec/29-post-deploy-watch.md) and [36](../spec/36-remote-validation.md), and this file is
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

  Check the data                              SQL · state.run
    D  intake_jobs.retry_count exists and is backfilled   migration 0042 adds it
       ▸ query · dry run on devUk before deploy: column not found (expected; it ships with this)

  Watch it                                    observe · until intake has run 500 times, at most 3 weeks
    E  signal  "IntakeFetch gave up", no more than 5   proves 2 holds under real load
       ▸ log added by part 2
    F  measure intake p95 no worse than 812ms (baseline)   retries must not slow the happy path

  Yours, once for the goal
    C  Look at the job page after a give-up            proves 2 · a screenshot to judge

                                         [ OK, run it ]   [ Change something ]
```

The operator presses **OK** once. The harness then runs everything on that page and says nothing
more unless something needs a person. The goal page shows one status per environment: _Queued_,
_Running_, _Needs you_, _Watching, 212 of 500 runs_ or _Clear_.

That is the whole proposal. The rest of this document is what has to change for that page to be
true, and what must not break on the way.

## Why today is a mess

The pieces all exist. What does not exist is one place that asks once. Between "delivered" and
"closed", one environment's validation currently takes the operator through:

| Today                                                 | Key                         | Where it lives          |
| ----------------------------------------------------- | --------------------------- | ----------------------- |
| Accept the check set (and decline rows)               | goal                        | proposal card           |
| Approve each `state` query for this environment       | (query digest, environment) | sheet                   |
| Approve each watch query _again_ for this environment | (query digest, environment) | sheet                   |
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

### One page per goal and environment

The **arrival plan** is keyed `(goal, environment)`, the key the sheet and the watch window already
use. It _is_ the sheet, renamed and widened, and it is drawn for every environment the goal reaches
that declares `validate` **or** `observe`.

| Section                  | Rows from                                  | Run by                           | Needs the OK |
| ------------------------ | ------------------------------------------ | -------------------------------- | ------------ |
| Prove it works           | the goal's checks an environment can carry | the environment's browser runner | yes          |
| Check the data           | the goal's `state` queries                 | `validate.state.run`             | yes          |
| Watch it                 | the goal's live watch checks               | `observe`, on the window's clock | no           |
| Yours, once for the goal | checks only a person can carry (`manual`)  | a person                         | no           |

Two of those lines are deliberate departures from a single "OK runs everything":

- **The watch needs no OK, as today.** Plan approval already authorised its queries to run on the
  window ([29](../spec/29-post-deploy-watch.md#the-operator-at-any-point)), and the window opens on
  arrival with no press ([29](../spec/29-post-deploy-watch.md#opening)). An environment that declares
  `observe` and no `validate` — production, often — gets a plan with only its watch section and no
  button. The watch section is on every page so the operator reads the whole of what will happen in
  one place, not because it waits for them.
- **Person checks are the goal's, not the environment's.** A `manual` check is done once, so it is
  drawn once, in its own section, on the first environment's page, and not repeated on the next.

A group is never a target, as today: a page per member environment. A page whose browser rows are
identical to a sibling member's offers **OK for all of `liveGroup`** beside its own OK.

The header names **how**: which runner, which tenant (the variable's _name_ for a `tenantEnv`, never
its value), how old the tenant's seed is, and how the watch ends.

### The check set keeps its own accept

The check-set accept stays exactly as it is today, card and all
([20](../spec/20-validation.md#the-check-set-is-proposed-before-it-is-work)), because a goal may never
reach an environment with `validate` — a documentation change, a gate released by hand, an arrival
stamped stale — and a set that could only be released by an arrival page would stay unreleased for
good, holding the close-out with nothing red. Deciding which goals will reach such an environment
would also need the dispatcher to read environment configuration, which the lens boundary forbids.

What changes is that an OK on an arrival page **also accepts the set** when it is still open, so an
operator who meets the page first does not have to find the card. Both write the same
`validation_plans.released_at`. A set re-authored after it was accepted goes back to proposed, as
today, and every arrival page drawn from it returns to _Needs you_.

### One OK

Pressing OK records, in one transaction:

- the check set's release, if it is still open;
- approval of every `state` query on the page, keyed `(query digest, environment)` exactly as today;
- **the intent to run** the page's browser rows.

The OK does **not** open a run row. A desk does that when it can (_below_), because the press today
can fail on the `(environment, tenant)` lock — two goals in one release share testUk's tenant — and an
OK that turned into a 409 is a button that did nothing.

The reasons behind today's separate consents carry over, because the OK is given **on a page that
names the place and shows the text**:

- _Consent to a place is not transferable._ The OK is per environment. Approving testUk approves
  nothing on liveUk.
- _Nothing runs an unapproved query, ever_ ([36](../spec/36-remote-validation.md#what-it-is-not)).
  The page shows the query text and the only dry run that exists before consent — the one taken at
  plan submission, on the first `observe` or `state` environment, usually before the work deployed —
  **labelled as such**. The per-environment dry run runs inside the OK, exactly as it runs inside
  today's approve call. A query whose dry run there fails, or returns the wrong shape, is not approved:
  it becomes a `blocked` row and an exception, and nothing else on the page waits for it.
- _Starting browser runs automatically spends on arrivals nobody reads._ The OK is the press; nothing
  browser-shaped starts without it.

**An OK is for the page as it was shown.** It covers the set revision, the query digests and the rows
on the page when it was pressed. Anything new — a re-authored set, an edited query, a check added by
amendment, a second arrival with new work — returns the page to _Needs you_ with only the new rows
marked. Nothing is pressed again without a press.

**Change something** opens the rows for the verbs that exist today: **send the checks back** (the
whole-set reject, [20](../spec/20-validation.md#when-an-operator-sends-a-check-set-back)), decline a
check, waive with a reason, deselect for this environment, edit a query, reseed. A decline is a state
on the check, so it is goal-wide: declining in testUk declines everywhere, and the page says so.

### After the OK

A desk, `ArrivalPlanDesk`, below `RemoteValidationDesk` and the watch pass and above
`DeliveryCloseOutDesk` in the pulse, carries the intent out:

| What         | Happens                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state` rows | Run at once (read-only, now consented).                                                                                                                                                                     |
| Browser rows | A `pending` run row is opened when the `(environment, tenant)` lock is free; the pin is taken then. Until then the page reads _Queued behind #398 on testUk_. Rule `remote-validation` dispatches as today. |
| No tenant    | The intent is kept, the row is `blocked` naming the variable or command that would supply one, and the run opens when one appears.                                                                          |
| Watch        | Unchanged: the window opened on arrival and reads on its own clock.                                                                                                                                         |

The page then reports **only exceptions**. They go on the goal's existing **`validate` bench row**,
which stays the one rail item for validation, so `arrival.opens` and `watch.holds`, which name it,
keep working unchanged. Its detail lists each environment's exceptions:

- a check `failed` (rule `validation-failed` still runs, as today);
- a row `blocked`: no tenant, no runner, a query whose dry run failed here, an edit not yet OK'd;
- a `captured` screenshot waiting to be looked at;
- a run **abandoned** by the pin or the sweep, or still `pending` after four probe intervals;
- rows a press cannot read (`idle_reason`), named;
- a watch check that `regressed`, or **settled** `unknown`.

The `watch` bench row stays too, unchanged, for an environment with `observe` and no page button; on
an environment that has one, its finding is also drawn on the page.

**A settled `unknown` now files.** Today "an `unknown` files nothing"
([29](../spec/29-post-deploy-watch.md#the-bench-row)). Raising it while the window is open would put
every goal on the rail within one interval of reaching an acceptance environment, where presence is
zero by nature. Raising it once the window has **settled** `unknown` is the case the operator needs:
the watch could not answer, and they should hear that from the harness rather than find it.

### The close-out

The close-out waits on what it waits on today: the `validate` row
([24](../spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time)), which settles when no
environment's page has a validation exception outstanding. **The watch still holds nothing unless
asked** ([29](../spec/29-post-deploy-watch.md#it-holds-nothing-unless-asked)); its status is carried
in the close-out's detail, per environment, as today. `watch.holds` is the opt-in, unchanged, and a
window that settles `unknown` does **not** clear it — the operator's release does.

### What it replaces

| Today                                        | In this design                                                       |
| -------------------------------------------- | -------------------------------------------------------------------- |
| Sheet                                        | The arrival plan (rename, plus a reason per row).                    |
| Sheet `signal` / `measure` rows and readings | **Removed.** The page draws the watch window's own readings.         |
| Per-environment approval of watch queries    | **Removed.** It gated only the sheet's watch rows, which are gone.   |
| Per-environment approval of `state` queries  | Folded into OK. The `(digest, environment)` table stays.             |
| Press                                        | Folded into OK, opened by the desk when the lock is free.            |
| Check-set accept card                        | **Kept.** The OK also accepts it when still open.                    |
| `validate` bench row                         | **Kept**, as the one rail item; its detail is the pages' exceptions. |
| `watch` bench row                            | **Kept** for observe-only environments.                              |
| Hand a check to the fleet                    | Kept only for checks no environment can carry.                       |

Untouched: local validation ([32](../spec/32-local-validation.md)), which is a developer's loop on
this machine and answers no check; environment gates; `arrival.opens`; `watch.holds`.

### How long to watch

Today a window is a fixed time per environment (`watch.forMs`, 48 hours by default). Time alone is the
wrong measure: a fix to a weekly job has no evidence after 48 hours, and a fix on a busy endpoint has
plenty after one. What the operator wants to know is whether the changed code has run **enough times**
to say.

So a window ends on **evidence, within the environment's time limit**:

- **The time limit stays the environment's.** `forMs` is still the one answer to "how long can a
  watch run here", for the reason [29](../spec/29-post-deploy-watch.md#opening) gives: it is about the
  deployment's cadence, which the operator knows. A team that wants weeks sets weeks.
- **The evidence is the goal's.** The planner declares a **count**: one query that returns how many
  times the changed path has run since `{since}`, and a target, with a reason. _"Intake runs about 300
  times a day; 500 runs is two days of real traffic."_ This is not the second answer to the same
  question that [29](../spec/29-post-deploy-watch.md#opening) refused: it is a different question, how
  often _this code_ runs, which the ticket knows and the deployment does not.
- **The count is a measure-shaped query**, one row, one number, refused if it returns rows. A presence
  query cannot do this job: it must return one row per occurrence, so counting to 500 would ship every
  occurrence since arrival on every reading, growing for weeks.
- **The window settles at the target or the time limit, whichever comes first.** At the limit with
  the target unmet it settles `unknown`, never `clean`, and says _the code path ran 40 of 500 times_.
  A goal that declares no count settles at the time limit, as every window does today.
- **Readings stay bounded.** A window is read every `watchIntervalMs` for its first 48 hours and
  every six hours after, so three weeks is about 170 readings per check rather than about 1,000.
- **The baseline keeps its span.** A measure's baseline covers one `forMs` before arrival. Over a
  window that ends early or late it is compared as a rate, so a measure must be rate-shaped (a
  percentile, an error rate), which is what a measure is in practice; `WatchSchema` says so.
- **Extend** moves the time limit out by one `forMs` from now, as today, and keeps the target.

The target, and the environment's limit, are on the page before the OK. Changing the target there is
an edit to the goal's watch, like any other.

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
   **appended**, never interpolated. When it concludes, it is asked to `watch_declare` the exact line
   the diff emits. That arrives as a pending proposal, as today, and is one more consent: it is
   drawn on the plan sheet, and an operator who accepts the part's PR accepts it in the same place.
3. **Review reads for it.** The review agent is handed the owed lines, appended, and checks the diff
   emits them, as it checks any other acceptance line. A missing line is a review finding.
4. **Nothing waits on it.** A merged part settles by merge, as today. Owed telemetry is never a
   condition of a part settling: held, a merged part would wedge its dependents with nothing red.
5. **The first environment proves it.** On the arrival page a check with `emittedBy` whose presence
   has not answered is drawn as _not seen yet, owed by part 2_. When its window settles `unknown`,
   the exception says so: _part 2 was meant to log this, and testUk never saw it_.

### When a signal turns out wrong

Signals are first written at planning, amended by the working agent at conclude time, and editable by
the operator at any point ([29](../spec/29-post-deploy-watch.md#who-writes-it-and-when)). Finding out
after arrival that one is wrong is two different problems:

- **The query is wrong and the data is there.** While the window is **open** this already works: an
  edit clears that check's readings, and the next pass reads it again from the window's opening.
  Once the window has **settled**, nothing re-reads it, because a settled watch is never re-opened by
  a reading ([29](../spec/29-post-deploy-watch.md#closing)). So add a **Re-read** on a settled
  window: an operator's click, as extend is, that re-opens it for the edited checks only, from
  arrival, with the verdict it fixed still drawn beside the new readings.
- **The code does not log what is needed.** That is a defect in the work. It is filed as a bug from
  the exception, and the telemetry arrives with the next deploy.

**A measure whose query is edited after arrival has lost its baseline.** The baseline was read
before the work arrived and cannot be retaken. With an absolute threshold it falls back to that, and
the row says _no baseline, threshold only_; without one it reads `unknown`, as a measure with no
baseline does today. Comparing against another environment's reading is **not** offered: that
reading was taken after the work arrived there, so it cannot show a regression.

**The first environment is the rehearsal.** A signal whose window settles in testUk with presence
answering but its own query never once matching anything is drawn _matched nothing in 4,000 runs —
is it asking the right question?_ That is not an exception (a fix that works should match nothing);
it is a line on the page, read before the work reaches the environment that matters.

### A reason on every check

Validation checks gain `rationale`: one line, written by the check-set author beside `satisfies`,
saying why this check, and not a cheaper one, proves the criterion. It is not `why`, which already
means the fleet nomination's reason ([20](../spec/20-validation.md#the-check-set)). It is added to
the plan document's `validation` block, to `validation_plan` and to `validation_amend`, and the
instruction is appended to the authoring prompt. A check written before the field shows its
`satisfies` line alone.

## What must not break

Each of these is a current invariant the design has to carry through unchanged:

- **The harness never generates or infers a tenant.** No tenant configured is a `blocked` row naming
  the variable or command that would supply one; the OK's intent waits for it.
- **No reading is a `WorldEvent`.** The page's status is computed from rows, never written as an
  event, or `deliveryHold` un-parks the goal.
- **`unknown` never folds to `clean`.** _Clear_ requires every watch check `clean`.
- **A failed check is never a shortfall.**
- **Nothing runs an unapproved query.** The per-environment dry run is inside the OK.
- **Approval is keyed on `(digest, environment)`**, and an edit drops it everywhere.
- **An arrival waiting on its check set is never stamped away.** The page reads _Preparing_ until a
  set is authored. Assembly keys on _authored_ now, not _released_, so the freshness guard is re-keyed
  to match: a page is assembled for an arrival, or a set authored, within two probe intervals, so
  turning `validate` on does not draw pages for every old set.
- **A watch reading is written only by the window.** Removing the sheet's watch rows makes this
  simpler.
- **Two dispatches never share a browser profile.** Unchanged.
- **The lens boundary.** `ArrivalPlanDesk` lives under `src/environments/`; nothing under
  `src/dispatcher/` reads it. The rule still reads only the `pending` run row.
- **Validation blocks nothing** unless `arrival.opens` or `watch.holds` says so.

## Open questions

1. **Plan approval as a preview.** The plan document already carries the hint, the watch and the
   `state` block. Should plan approval show a draft of the arrival page, so the OK on arrival is
   usually a formality?
2. **Measures without a count.** A goal whose watch is only measures, with no count declared, settles
   at the time limit like today. Should a count be required whenever a watch exists?

## Order of work

1. **The page and the OK.** Draw the arrival page from today's tables; the OK writes the release, the
   approvals with their dry runs, and an intent row; `ArrivalPlanDesk` opens the run when the lock is
   free. Exceptions go into the `validate` row's detail. The sheet's own approval and press buttons go.
2. **Drop the sheet's watch rows** and the per-environment watch approvals; draw the window's readings.
3. **A settled `unknown` files**, with [29](../spec/29-post-deploy-watch.md#the-bench-row) and
   [13](../spec/13-jobs-and-tickets.md) updated to say so.
4. **`rationale` on checks.** Column with an `ensureColumns` entry, the plan-document field, the
   tools, the appended note, the page.
5. **Owed telemetry.** `emittedBy` on watch checks (column and `ensureColumns` entry), the
   presence-zero exemption, the appended notes for the building and review agents, the _not seen yet_
   line.
6. **Watch until evidence.** The count query and target on the plan's watch block, the count's
   readings (column and `ensureColumns` entry), settling on whichever comes first, the backed-off
   reading cadence.
7. **Re-read a settled window**, and the baseline-lost line.
