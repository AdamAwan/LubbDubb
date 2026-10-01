# Proposal — the arrival sheet (v1)

**Status: under discussion.** Nothing here is built. When the work lands, the load-bearing reasoning
moves into the specs it changes — [20](../spec/20-validation.md), [24](../spec/24-environments.md),
[29](../spec/29-post-deploy-watch.md) and [36](../spec/36-remote-validation.md) — and this file is
deleted by that change. Two follow-ups are argued separately: [watch length](watch-length.md) and
[owed telemetry](owed-telemetry.md).

## What the operator should meet

When a goal's work arrives in an environment, the operator is shown one page:

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

  Watching (no action needed)                 observe · 48h from arrival
    r1 signal  "IntakeFetch gave up", no more than 5    clean so far
    r2 measure intake p95 no worse than 812ms           clean so far

  Also yours on this goal (once, not per environment)
    C  Confirm the support team's alert email reads correctly   proves 2

                       [ OK, run it ]   [ Change something ]   [ Not validating here ]
```

The operator presses **OK** once. The harness runs everything on the page and says nothing more
unless something needs a person. The page's status is one of _Preparing_, _Needs you_, _Queued_,
_Running_, _Done_ or _Not validating here_. The watch keeps its own status beside it, as today.

## Why

Between "delivered" and "closed", one environment's validation today asks the operator to accept the
check set, approve each `state` query for this environment, approve each watch query _again_ for this
environment, deselect rows, reseed, and press go — on two surfaces. Three consents for one read; the
same signals read twice, by the watch and by the sheet, into two tables; and no check saying why it
is the right proof (a check's only `why` is the fleet nomination's,
[20](../spec/20-validation.md#the-check-set)).

## The design

### The sheet, widened

The object is today's **sheet** ([36](../spec/36-remote-validation.md#the-sheet)), keyed
`(goal, environment)` and kept under its own name, with four sections:

| Section                | Rows from                                                    | Needs the OK |
| ---------------------- | ------------------------------------------------------------ | ------------ |
| Prove it works         | checks whose first step a carrier here can run               | yes          |
| Check the data         | the goal's `state` queries                                   | yes          |
| Watching               | the goal's watch window here, read-only                      | no           |
| Also yours on the goal | checks whose first step is a person's, or that have no steps | no           |

- **Watching is a read-only projection** of the goal's watch checks and its `watch_windows` row. It
  is stored nowhere on the sheet and changes nothing about the watch: the window opens on arrival
  with no press, reads on its own clock, and files on the `watch` row exactly as today
  ([29](../spec/29-post-deploy-watch.md#opening)). An environment with `observe` and no `validate`
  shows this section alone, with no buttons, and has no `remote_sheets` row or `sheeted_at` stamp, so
  `RemoteValidationDesk`'s early return and stamping are untouched
  ([36](../spec/36-remote-validation.md#the-desk)).
- **Person checks are the goal's.** A check whose first step is a person's
  ([20](../spec/20-validation.md#who-carries-a-step)), or that has no steps, is listed on every
  sheet in the same section, marked done once it is. `sheetRows` stops putting it on each sheet as a
  `check` row, so the press and `idle_reason` stop counting rows nobody can run there. A check whose
  fleet steps are cut by an inline person step stays in _Prove it works_ with a _then you:_ line,
  as `segmentBoundary` already splits it.
- **Every check carries a `rationale`**: one line beside `satisfies`, saying why this check proves the
  criterion. A new field, added to the plan document's `validation` block, `validation_plan` and
  `validation_amend`, with the instruction appended to the authoring prompt. Older checks show their
  `satisfies` line alone.
- Query rows are labelled `q1…` and watch rows `r1…`, so no letter is shared with a check's.

### One OK

The OK runs in two steps, because the dry runs are spawns of up to thirty seconds and cannot sit in a
database transaction:

1. **Dry runs.** Every `state` query on the page not yet approved here is dry-run against this
   environment, as today's approve call does. Each result is drawn on its row.
2. **One transaction:** the check set accepted through `ProposalDesk.accept` if it is still open, so
   its proposal and escalation close the ordinary way; approval of every query whose dry run answered
   properly, keyed `(query digest, environment)` as today; and an **intent** to run.

A query whose dry run fails is not approved: it is drawn `blocked` with **Retry dry run**, and the rest
of the page does not wait for it.

The reasons behind today's separate consents carry over, because the OK is given on a page that names
the place and shows the text. It is per environment, so testUk's OK approves nothing on liveUk. No
query that is not already approved here runs on this environment before the OK; until then the page
shows the query text and, where one exists, the plan-submission dry run, labelled with where and when
it ran. And nothing browser-shaped starts without the OK.

**The OK covers the page as shown.** The intent records a fingerprint of the rows it was given over —
check ids with their revision, query digests. When the fingerprint moves — a re-authored set, an
amended check, an edited query — the page returns to _Needs you_ with the new rows marked.

**Change something** offers the verbs that exist today: send the checks back (the whole-set reject),
decline a check, waive, deselect for this environment, edit a query, reseed. A decline is goal-wide,
and the page says so. Declining every remaining check is offered as _send the checks back_ instead, so
a released set of nothing never reads like one declared empty on purpose
([20](../spec/20-validation.md#declining-a-single-row)).

**Not validating here**, with a required note, records that this environment will not be validated
for this goal. It clears the page's hold (below).

### The intent

A row in a new table, `remote_run_intents`, keyed `(goal, environment)`: the fingerprint, when it was
given, and its state — `given`, `withdrawn`, `consumed` or `not_here`.

- **Consumed** when the press opens a run for it. After that run settles the button reads **Run
  again**, which gives a new intent; a fix that deploys is re-validated by pressing it.
- **Withdraw OK** while it is still waiting.
- If the run is abandoned — by the pin, the sweep or a cancel — the page returns to _Needs you_ with
  the reason. Nothing re-opens a run on its own.

**Ship day.** Every sheet that already exists has no intent, which reads as "awaiting OK" and would
file or reopen a `validate` row on every delivered goal the first pulse after deploy. So the boot that
creates the table writes a `consumed` intent for every existing sheet, gated on the table having just
been created ([14](../spec/14-persistence.md#when-a-null-means-something)).

### After the OK

`RemoteValidationDesk`, where it is today, gains one arm: for each `given` intent whose
`(environment, tenant)` lock is free, it **rebuilds the sheet's rows** from the current checks,
approvals and tenant, then calls today's press **unchanged** — lock, pin, open the run, read the
`state` rows, count what the run owes its agent ([36](../spec/36-remote-validation.md#the-press)).
While the lock is held it does nothing and the page reads _Queued behind #398_. With no tenant the
intent waits and the row says which variable or command would supply one.

The rebuild is not optional. Rows store `blocked_reason` when the sheet is assembled, approving a
query later writes only `remote_query_approvals`, and the press skips any row with a reason — so
without it the OK's approvals would never be read. The same fault exists in today's code for an
approval given after assembly, and for a tenant that appears after a refused press.

### Where the operator hears about it

On the goal's existing **`validate` bench row**, so `arrival.opens` and `watch.holds`, which name it,
keep working. Its settle rule is today's — nothing owed to a person (`owedToAPerson`,
`src/validation/ready.ts`) — with **one** addition, counted in its file, settle and reopen arms alike:
**a sheet with at least one row to OK, awaiting its OK**. That is what stops the close-out being asked
for before the operator has seen the page
([24](../spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time)). A sheet with nothing to OK
gets no button and no hold. _Not validating here_ clears it.

The row's detail lists, per environment: a check `failed` (rule `validation-failed` still runs); a
row `blocked`; a `captured` screenshot to look at; a run abandoned; person checks still owed.

The watch is unchanged: its findings stay on the `watch` row, and it holds nothing unless
`watch.holds` asks ([29](../spec/29-post-deploy-watch.md#it-holds-nothing-unless-asked)).

### What it removes

- **The sheet's `signal` and `measure` rows, their readings and their per-environment approvals.**
  The page draws the window's readings instead, so one question has one answer.
- **Retiring the names.** Environments declare `permits: ["signal", "measure"]` today, and
  `validatePermits` refuses an unknown kind at boot (`src/environments/policy.ts`). Both stay accepted
  and are ignored with a warning; a `permits` that held only those two permits no validate rows. A
  one-off migration deletes the existing rows and readings.
- **The sheet's own approve and press buttons**, replaced by the OK.

Kept as they are: the check-set accept card (the OK also accepts it), the `validate` and `watch` rows,
fleet hand-over, local validation, environment gates, `arrival.opens`, `watch.holds`.

## What must not break

- The harness never generates or infers a tenant.
- No reading is a `WorldEvent`; status is computed from rows.
- `unknown` never folds to `clean`.
- A failed check is never a shortfall.
- Nothing runs an unapproved query; approval stays keyed on `(digest, environment)`.
- The close-out follows the checks; the watch holds nothing unless asked.
- An arrival waiting on its check set is never stamped away. Assembly keys on _authored_ so the page
  can read _Preparing_; the freshness guard is re-keyed to "arrival or authoring within two probe
  intervals", so turning `validate` on does not draw pages for every old set.
- The press stays the only writer of a run row.

## Tests that say it works

At the `buildSystem` seam, with `FakeStateReader`, `FakeTenantKeeper` and `FakeWorktreeManager`:

- OK, then a pulse: an approved `state` row is read.
- OK with no tenant; a tenant appears; the run reads its rows.
- The lock held by another goal: the page reads _Queued_, then runs when it frees.
- A sheet with nothing to OK files no hold.
- A database that already holds sheets files and reopens no `validate` rows on first boot.
- After a failed run, _Run again_ runs it again.
- An environment whose `permits` lists `signal` boots, with a warning.

## Order of work

1. The rebuild-before-press fix on its own, with its test, since today's code has the same fault.
2. The widened sheet, the OK, `remote_run_intents` with its ship-day backfill, the desk arm, the
   `validate` row's hold, Not validating here, Run again.
3. Removing the sheet's watch rows and approvals, the retired `permits` names and the migration.
4. `rationale`.
