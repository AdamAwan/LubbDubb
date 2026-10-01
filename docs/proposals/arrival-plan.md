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

  Watch it for 48 hours                                  observe · from arrival
    E  signal  "IntakeFetch gave up" no more than 5      why: proves 2 holds under real load
    F  measure intake p95 no worse than baseline (812ms) why: retries must not slow the happy path

                                         [ OK, run all of it ]   [ Change something ]
```

The operator presses **OK** once. The harness then runs everything on that page and says nothing
more unless something needs a person. The goal page shows one status for that environment:
_Running_, _Needs you_, _Watching, 31h left_ or _Clear_.

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

1. **Standing OK.** Should an environment be able to say "run without asking when every row is
   already approved here and the tenant is set"? That is the fully hands-off version of the page
   above. It is safe for read-only rows; browser rows spend, so it would need its own switch.
2. **Plan approval as a preview.** The plan document already carries the hint, the watch and the
   `state` block. Should plan approval show a draft of the arrival plan, so the OK on arrival is
   usually a formality?
3. **Watch length per goal.** Today `forMs` is per environment. "Watch for a couple of weeks" on one
   goal argues for a per-plan override, bounded by the environment's own.

## Order of work

1. **Read-only page.** Draw the arrival plan from today's tables, with OK calling today's accept,
   approve and press routes in one request. No schema change. This alone proves the shape.
2. **Drop the sheet's watch rows.** Draw the window's readings instead; stop writing sheet
   `signal`/`measure` readings.
3. **One exception row.** Replace the `validate` and watch bench rows with the plan's row; point the
   close-out at the plan's status.
4. **`why` on checks.** Column with an `ensureColumns` entry, the authoring note, the page.
