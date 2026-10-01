# Proposal — the arrival plan

**Status: under discussion.** Nothing here is built. When the work lands, the load-bearing reasoning
moves into [20](../spec/20-validation.md), [29](../spec/29-post-deploy-watch.md) and
[36](../spec/36-remote-validation.md), and this file is deleted by that change.

## What the operator should meet

When a goal's work arrives in an environment, the operator should be shown one thing:

```
#412 Retry the intake fetch on 5xx  ·  arrived in testUk at a1b2c3d, 10 min ago

  Your criteria
    1. A 5xx from intake is retried with backoff
    2. After 3 failures the job gives up and says so

  Prove it works                                         browser · tenant $TEST_TENANT · seeded 2d ago
    A  Trigger a 5xx; the fetch is retried 3 times        proves 1   why: the retry is the whole change
    B  Fourth failure marks the job failed, not stuck     proves 2   why: the old bug was a silent hang
    C  Look at the job page after a give-up               proves 2   you: a screenshot to look at

  Check the data                                         SQL · state.run
    D  intake_jobs.retry_count exists and is backfilled   why: migration 0042 adds it
       ▸ query · dry run returned 0 rows missing

  Watch until intake has run 500 times (at most 3 weeks)       observe · from arrival
    E  signal  "IntakeFetch gave up" no more than 5      why: proves 2 holds under real load
       ▸ log added by part 2 · seen in testUk: 37 times since arrival
    F  measure intake p95 no worse than baseline (812ms) why: retries must not slow the happy path

                                         [ OK, run all of it ]   [ Change something ]
```

The operator presses **OK** once. The harness then runs everything on that page and says nothing
more unless something needs a person. The goal page shows one status for that environment:
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
3. **No check says why it exists.** A check cites the criterion it `satisfies`, but nothing on it
   says why _this_ check is the right proof. Watch checks carry a `why`; validation checks do not.

## The design

### One object per goal and environment

The **arrival plan** is keyed `(goal, environment)`, the key the sheet and the watch window already
use. It is assembled on arrival, exactly where a sheet is assembled today, and it _is_ the sheet,
renamed and widened. A group is never a target, as today: a plan per member environment.

It holds three sections, and every row in it carries a `why`:

| Section        | Rows from                    | Run by                                        |
| -------------- | ---------------------------- | --------------------------------------------- |
| Prove it works | the goal's checks            | the environment's browser runner, or a person |
| Check the data | the goal's `state` queries   | `validate.state.run`                          |
| Watch it       | the goal's live watch checks | `observe`, on the window's clock              |

The header names **how**: which runner, which tenant (the variable's _name_ for a `tenantEnv`, never
its value), how old the tenant's seed is, and how long the watch runs (`watch.forMs`).

### One OK

Pressing OK on an arrival plan is, in one write:

- **the check set's release** for this goal, if it is not released yet;
- **approval of every query shown**, keyed `(query digest, environment)` exactly as today;
- **the press**: a `pending` run row for the browser rows, under today's `(environment, tenant)` lock;
- **the watch's go-ahead** for this environment.

This keeps the reason behind each of today's separate consents, because the OK is given **on a page
that names the place and shows the text**:

- _Consent to a place is not transferable._ The OK is per environment. Approving testUk approves
  nothing on liveUk.
- _An operator approves a query having seen it and what it returned._ The query text and its dry run
  are on the page, one click open.
- _Starting browser runs automatically spends on arrivals nobody reads._ The OK is a press; nothing
  browser-shaped starts without it.

**An edit re-asks only what changed.** Editing a query drops its approvals everywhere (today's rule)
and the plan returns to _Needs you_ with only that row marked new. Everything already approved stays
approved.

**Change something** opens the same rows for the verbs that already exist: decline a check, waive
with a reason, deselect for this environment, edit a query, reseed. No new verbs.

### After the OK

| What         | Happens                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| `state` rows | Run at once (they are read-only, and now consented).                                |
| Browser rows | Rule `remote-validation` dispatches, as today.                                      |
| Person rows  | Become the only items on the rail for this plan, one row, listed.                   |
| Watch        | Window reads from **arrival**, not from the OK (`{since}` already makes this free). |

The plan then reports **only exceptions** to the Needs-you rail, as one row per plan:

- a check `failed` (rule `validation-failed` still runs, as today);
- a row `blocked` (no tenant, no runner, an unapproved query after an edit);
- a `captured` screenshot waiting to be looked at;
- a person's step;
- a watch check that `regressed`, or stays `unknown` past one interval.

Nothing else reaches the operator. A clear plan says _Clear_ on the goal page and on the close-out.

### What it replaces

| Today                                        | In this design                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Sheet                                        | The arrival plan (rename, plus a `why` per row).                                                                                  |
| Sheet `signal` / `measure` rows and readings | **Removed.** The plan draws the watch window's own readings.                                                                      |
| Per-environment query approval buttons       | Folded into OK. The `(digest, environment)` table stays.                                                                          |
| Press                                        | Folded into OK.                                                                                                                   |
| Check-set accept card                        | Folded into the first OK, where an environment can run the checks. Stays as today on a deployment with no `validate` environment. |
| `validate` bench row                         | Replaced by the plan's one exception row.                                                                                         |
| Hand a check to the fleet                    | Kept only for checks no environment can carry.                                                                                    |
| Watch bench row                              | Folded into the plan's exception row.                                                                                             |

Untouched: local validation ([32](../spec/32-local-validation.md)), which is a developer's loop on
this machine and answers no check; environment gates; `watch.holds`; the close-out, which reads the
plan's status instead of the `validate` row.

### How long to watch

Today a window is a fixed time per environment (`watch.forMs`, 48 hours by default). Time is the
wrong measure: a fix to a weekly job has no evidence after 48 hours, and a fix on a busy endpoint has
plenty after one. What the operator wants to know is whether the changed code has run **enough times**
to say.

So a watch ends on **evidence, with a time limit**:

- The planner declares, per goal, how many times the changed path has to run before the watch can
  settle (`until.runs`) and the longest it may take (`until.within`), with a one-line reason. "Intake
  runs about 300 times a day; 500 runs is two days of real traffic. At most three weeks."
- The count is the `presence` query, which every signal already has. Presence already proves the code
  path is running; counting its rows says how much.
- The window settles when the count is reached. If the time limit passes first, it settles as
  `unknown`, never `clean`, and says _the code path ran 40 of 500 times_. That is an exception on the
  rail, because the watch could not answer.
- The environment's `forMs` becomes the default time limit where a goal says nothing, and an upper
  bound the plan may not exceed.

Both numbers are on the page before the OK, and either can be changed there.

### Making sure the telemetry exists

A signal is declared at plan time, but the log line or metric it reads is often added by the work
itself. Today nothing makes sure it is. The planner can name a log line that no part was told to
write. The dry run cannot catch that, because the line does not exist until the change deploys, and
it says so ([29](../spec/29-post-deploy-watch.md#the-dry-run)). The gap shows up only after arrival,
as a presence query that never answers.

Close it by making instrumentation part of the plan, not a hope:

1. **The plan says what must be emitted.** Each signal or measure that reads telemetry the work adds
   names the part that adds it, and that part's acceptance carries it: _"Log `IntakeFetch gave up`
   with the job id when the fourth attempt fails."_ A watch check reading telemetry no part adds, and
   that the dry run cannot find, is refused at plan submission.
2. **The working agent confirms it.** Concluding a part that owes telemetry requires a
   `watch_declare` naming the exact line or metric the diff emits, which may correct the planner's
   wording. A part that owes telemetry and declares none does not conclude.
3. **Review reads for it.** The review agent is handed the owed telemetry and checks that the diff
   emits it, as it checks anything else on the part's acceptance.
4. **The first environment proves it.** On the arrival plan, a signal whose presence has never
   answered is drawn as _not seen yet_ next to the part that owed it. If it is still silent after the
   environment's first interval with real traffic, it is an exception: _part 2 was meant to log this,
   and testUk has not seen it_.

Steps 1 and 2 use mechanisms that exist: part acceptance, `watch_declare`, and the plan's refusals.
Step 4 is `presence` read per environment, as today.

### When a signal turns out wrong

Signals are first written at planning, amended by the working agent at conclude time, and editable by
the operator at any point ([29](../spec/29-post-deploy-watch.md#who-writes-it-and-when)). The hard case
is finding out after arrival that one is wrong. There are two kinds:

- **The query is wrong, the data is there.** It filters on the wrong event, or reads the wrong
  field. Today an edit clears the check's readings, and a check declared after an arrival is not
  watched in that environment at all
  ([29](../spec/29-post-deploy-watch.md#only-for-an-arrival-the-harness-watched)), so the fix waits
  for the next environment.
- **The code does not log what is needed.** That is a defect in the work. It is filed as a bug from
  the plan's exception row, and the new telemetry arrives with the next deploy.

Three changes make the first case cheap:

1. **An edit re-reads from arrival.** Every watch query already carries `{since}`, so a corrected
   query in an environment the goal has reached restarts that check's readings from the arrival
   time, inside the same window, rather than waiting for another environment. Only the edited check
   is re-read; the edit is an approval change for this environment, so it comes back to the page as
   the one new row to OK.
2. **A measure whose query changed after arrival says what it lost.** Its baseline was read before
   the work arrived and cannot be retaken. It falls back to its absolute threshold if it has one, or
   to the reading the same query took in the previous environment the goal passed through, and the
   row says which. With neither, it reads `unknown`, as a measure with no baseline does today.
3. **The first environment is the rehearsal.** A signal whose presence never answers there, or that
   answers but never once matches anything, is raised as an exception in that environment: _"this
   signal has seen 4,000 runs and matched nothing. Is it asking the right question?"_ The fix is made
   before the work reaches the environment that matters.

### A `why` on every check

Validation checks gain a `why`, written by the check-set author beside `satisfies`. The author is
told what it is for: one line saying why this check, and not a cheaper one, proves the criterion.
It is **appended** to the authoring prompt, not interpolated. A check written before the field
existed shows its `satisfies` line alone.

## What must not break

Each of these is a current invariant the design has to carry through unchanged:

- **The harness never generates or infers a tenant.** No tenant configured is a `blocked` row naming
  the variable or command that would supply one.
- **No reading is a `WorldEvent`.** The plan's status is computed from rows, never written as an
  event, or `deliveryHold` un-parks the goal.
- **`unknown` never folds to `clean`.** The plan's _Clear_ requires every watch check `clean`; an
  `unknown` keeps it at _Watching_ and, past one interval, raises an exception.
- **A failed check is never a shortfall.**
- **An arrival waiting on its check set is never stamped away.** The plan shows _Preparing_ until
  the set is authored, however long that takes.
- **A watch reading is never written by anything but the window.** Removing the sheet's own
  signal/measure readings makes this simpler, not harder.
- **Two dispatches never share a browser profile.** Unchanged: remote stays per environment.
- **Validation blocks nothing** unless `arrival.opens` or `watch.holds` says so.

## Open questions

1. **Plan approval as a preview.** The plan document already carries the hint, the watch and the
   `state` block. Should plan approval show a draft of the arrival plan, so the OK on arrival is
   usually a formality?
2. **A count for measures.** A signal has a presence query to count runs with. A measure (a p95, a
   rate) does not. It could borrow the presence query of a signal on the same path, or declare its
   own.

## Order of work

1. **Read-only page.** Draw the arrival plan from today's tables, with OK calling today's accept,
   approve and press routes in one request. No schema change. This alone proves the shape.
2. **Drop the sheet's watch rows.** Draw the window's readings instead; stop writing sheet
   `signal`/`measure` readings.
3. **One exception row.** Replace the `validate` and watch bench rows with the plan's row; point the
   close-out at the plan's status.
4. **`why` on checks.** Column with an `ensureColumns` entry, the authoring note, the page.
5. **Watch until evidence.** `until.runs` and `until.within` on the plan's watch block, the count read
   from presence, and settling on whichever comes first.
6. **Fixing a signal after arrival.** Re-read from arrival on an edit, the baseline fallback, and the
   first-environment rehearsal exception.
7. **Owed telemetry.** The part link on watch checks, the plan refusal, the conclude requirement and
   the review note.
