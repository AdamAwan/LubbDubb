# 39 — App errors

`src/appErrors/`. **Off by default**: an environment is read for errors only when it declares an
`errors` block, and with none declared nothing is spawned, nothing is stored and the route answers
with empty lists.

The post-deploy watch ([29](29-post-deploy-watch.md)) reads checks a plan **declared**. This reads
the errors **nobody declared**: an environment's own telemetry, grouped by fingerprint, watched for
what _moved_ — a group that is new since the deploy, one that came back, one running well above its
baseline — rather than drawn as an error list an operator has to read in full.

**Partly built.** What is described here as running is the command, its contract, grouping, states,
the key, a read-only route and the cockpit that draws it. Two things are **not yet built**, and each
section that names them says so:

- **Linking a group to the work that probably caused it** — the deploy window, frames against landed
  diffs, test-before-live and operation hints. The wire carries a `link` field for it that is always
  `null` today. → [Not yet built](#not-yet-built)
- **The tracker as the cross-fleet lock** — searching for a group's key before offering File bug or
  Investigate, and filing with the key on `IssueCreateInput`. The wire carries a `tracker` field for
  it that is always `null` today.

The cockpit draws both fields wherever they are non-null, so neither stage needs a change in `web/` to
be seen. → [In the cockpit](#in-the-cockpit)

The design both are argued in is [`proposals/error-ingestion.md`](../proposals/error-ingestion.md),
which the change that finishes them deletes.

## What it is not

| Not                   | Because                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A telemetry client    | The harness knows a command and an output contract, never Kusto, App Insights or Sentry. The same shape as `health` and `observe`.                                                                             |
| A `WorldEvent` source | `deliveryHold` expires a delivery verdict on **any** world event matching a goal's issue ref, so an error reading filed as one would un-park delivered goals. Own tables, own route — the arrivals rule again. |
| A dispatch input      | Nothing under `src/dispatcher/` reads what this writes. It files nothing, opens no gate and reaches no prompt.                                                                                                 |
| An error log          | The harness's own faults are `error_events` (`src/store/errors.ts`, [18](18-observability.md)). These are the **application's** errors, which is why the feature is called app errors.                         |

## Configuring an environment

```jsonc
{
  "name": "live",
  "at": "./scripts/deployed-sha.sh live",
  "group": "prod",
  "errors": { "list": "./scripts/ai-errors.sh live {since}" },
}
```

`errors.list` is a shell command run in `repoRoot` with `LUBBDUBB_ENVIRONMENT` and
`LUBBDUBB_ERRORS_SINCE` set. `validateEnvironments` (`src/environments/policy.ts`) refuses:

- an `errors` that is not an object;
- an empty `list`, which answers nothing and would read `unknown` forever;
- a `list` that carries **no `{since}`**. Every read is bounded by the instant the last answered one
  reached, and an unbounded query counts old errors as new on every read — the
  [29](29-post-deploy-watch.md#every-query-carries-since) refusal, held at boot rather than at
  ingestion because here the command _is_ the query.

`{since}` is substituted into the command text (every occurrence) and passed beside it in
`LUBBDUBB_ERRORS_SINCE`. It is an ISO-8601 instant, which carries nothing a shell would read.

Three top-level keys tune it ([02](02-configuration.md)): `appErrorIntervalMs` (default 15 minutes),
`appErrorMinCount` (default 2) and `appErrorIgnore` (default empty).

## The output contract

The command prints one JSON **list**, one object per error group:

```jsonc
[
  {
    "fingerprint": "…", // required: stable across deploys, versions and environments
    "title": "NullReferenceException in OrderService.Submit", // required
    "count": 42, // required: whole number ≥ 1, occurrences since {since}
    "firstSeen": "2026-10-19T10:00:00Z", // required: ISO timestamps, first ≤ last
    "lastSeen": "2026-10-19T11:00:00Z",
    "version": "2026.10.14.3", // optional
    "operation": "POST /orders", // optional
    "frames": ["src/Orders/OrderService.cs:118"], // optional: top in-app frames
    "link": "https://portal.azure.com/…", // optional: absolute http(s)
  },
]
```

`parseAppErrorReport` (`src/appErrors/report.ts`) is pure and is the whole of the schema.

- **The fingerprint is the script's job**, and the contract says what it must be: stable across
  deploys, versions and environments, free of line numbers, ids and user data. For App Insights that is
  `problemId`. It is capped at 200 characters — it is an identity, not a message.
- **A row that breaks the contract is refused, named and left out**, and the rest of the report still
  reads. The refusals go to the error log through `errors.record` once per read, with the first ten
  reasons. A report in which **every** row was refused is not "no errors": it is `unknown`, because a
  script that prints only rows the harness cannot read is a broken script.
- **One fingerprint printed twice is one group**: counts summed, the span widened, the later row's
  title and detail kept. A script grouping by `problemId` _and_ version prints exactly this.
- **A read is bounded to the 500 most frequent groups.** What was left out is said on the reading's
  `detail`; the reading is still `ok`.
- Titles are capped at 300 characters, `version` and `operation` at 200, `frames` at twenty of 300.
  Anything else in an object is ignored.

**The reading is two-valued — `ok` or `unknown` — and `unknown` is never "no errors".** `[]` is the
only way to say nothing went wrong. A non-zero exit, a signal, a timeout, empty output, output that is
not JSON, and JSON that is not a list are all `unknown` with an account of why. Unlike `health`, the
exit code is **not** forgiven when stdout parses: a failed `az` call that printed `[]` before dying is
precisely the confident wrong answer this rule exists to refuse. The command is killed after 60
seconds — twice the health check's, because a telemetry query over a fortnight is slower than an
`HTTP 200`.

## What is stored, and for how long

Three tables, all owned by `AppErrorStore` (`src/store/appErrors.ts`). A read's reading row, groups
and day counts are written in one transaction; the prune is a second, once per desk pass:

| Table              | One row per                       | Holds                                                                                                          |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `app_error_reads`  | environment                       | The last read: status, detail, `read_at` and `ok_at` (last _answered_ read)                                    |
| `app_error_groups` | `(environment, fingerprint)`      | Title, operation, version, frames, url; first and last seen as the harness has accumulated them; `returned_at` |
| `app_error_days`   | `(environment, fingerprint, day)` | Occurrences on one UTC day                                                                                     |

- **`ok_at` moves only on an `ok` read**, and it is what the next read's `{since}` is: a read that
  failed for a day leaves the next one reaching back over that day rather than skipping it. `{since}`
  is never further back than **fourteen days** (`MAX_LOOKBACK_MS`), which is also a first read's reach.
- **First and last seen are the harness's**, not the read's: `firstSeen` is the earliest any read has
  reported, so a bounded query's "first seen in this window" never overwrites an older sighting.
- **A count is spread evenly across the UTC days its row spans inside the read**, remainder on the
  last day (`spreadCounts`, `src/appErrors/groups.ts`). A fifteen-minute read lands on one day; a first
  read's fortnight does not all land on today, which would read as a spike against its own history.
  It is an approximation, and the only one available from a contract that reports a count rather than
  a series.
- **`returned_at`** is stamped when a read reports a group whose `firstSeen` is at least the quiet
  period (`QUIET_MS`, three days) after the `lastSeen` already held.
- **Retention.** The retained window is the last fourteen UTC days, today included (`retainedDays`,
  `RETENTION_DAYS`) — **one window, read by both the prune and the wire**, so the fortnight's `count`
  a group ships is exactly the sum of the `daily` series it ships beside it. Day counts before it are
  deleted, and a group not seen for thirty days (`GROUP_RETENTION_DAYS`) is deleted with its days,
  once per desk pass that read any environment — across every environment, so a removed
  environment's groups age out the same way. Seen again after that, a group is a stranger, and reads
  `new`.

All three tables were introduced new and so need no `ColumnMigrations` entry **today** — the rule in
[14](14-persistence.md#migrations) still applies to the first column anyone adds.

## The deploy window

`new` and `spiking` are both questions about _the latest deploy_, and the deploy is the environment's
**head**, which the environment desk's probe records ([24](24-environments.md#the-head)) — this
feature does not ask the probe itself. A route read joins each environment's `environment_heads` row
on as its `head`:

- `sha` — what the probe named, several commits joined by a space as the probe's own several-services
  rule names them;
- `previousSha` — what it named before that changed;
- `changedAt` — **when the harness noticed the change**, at the probe's cadence. It is the
  `deployedAt` every state below is measured from.

The first head ever recorded is **no deploy at all**: `changedAt` stays null, because the harness
cannot say when that build arrived, and the states fall back to the last day. A probe that could not
answer leaves the head as it was. An environment that declares `errors` is probed for its head on
`environmentProbeIntervalMs` even when no landing is pending, which is what keeps the head fresh on an
environment the fleet has nothing in flight for.

## States

`appErrorState` (`src/appErrors/states.ts`) is pure and recomputed on every route read, so `gone`
arrives with the clock rather than waiting for another telemetry query. In order, first match wins:

| State      | When                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `gone`     | not seen for `QUIET_MS` (three days)                                                                                                           |
| `steady`   | **muted**: ignored, or fewer than `appErrorMinCount` occurrences over the retained fortnight                                                   |
| `new`      | first seen at or after `deployedAt`; with no deploy on record, first seen within the last day (`NEW_FALLBACK_MS`)                              |
| `returned` | `returned_at` within the last `QUIET_MS`                                                                                                       |
| `spiking`  | the daily rate since the deploy's day is at least `SPIKE_RATIO` (3) times the baseline — the daily rate over the `BASELINE_DAYS` (7) before it |
| `steady`   | otherwise — known noise                                                                                                                        |

- **The minimum count and the ignore list mute every moved state**, not only `new`: a single
  exception that returns is still a single exception. A muted group still reads `gone` when it stops.
- **The baseline is floored at one a day** (`SPIKE_FLOOR_PER_DAY`), so a group that happened once last
  week does not "spike" at three. It is measured only over days on or after the group's own first
  sighting, and a group with no such day has no baseline and cannot spike — it is `new` instead.
- **With no deploy on record**, the window is the last day against the week before it.
- The deploy's own day counts as after the deploy. Day counts cannot be split at an instant, and
  reading it the other way would hide the morning of every bad deploy in the baseline.
- `appErrorIgnore` matches a fingerprint or its key, so an operator can paste either.

## The key

`appErrorKey(project, fingerprint)` (`src/appErrors/key.ts`) is `err:<project>:<hash>`: the first eight
hex characters of the fingerprint's SHA-256. Short, exact-match searchable, and carrying no code or
message text into a tracker's tag list.

The project is the pool's name ([28](28-cross-fleet-pool.md#the-project-name)), slugged to lower case
`a-z 0-9 . _ -`, so every fleet on one project mints the same key for the same fault. **Unlike the
pool, the key has a fallback** — `github.repo`, then `azureDevOps.repository`, then the basename of
`repoRoot` — because the key is also how a single fleet names a group, and a fleet with no pool still
reads errors. The fallback is honest about what it costs: two fleets that derive different names do
not share a key, which is the fork-and-rename case the pool's own refusal exists for. A deployment
that wants the key shared declares `pool.project`.

Nothing carries the key anywhere yet: it is on the wire, and it reaches a tracker only when the
tracker lock is built.

## Groups

Every environment is still **read** on its own — three regions of production are three queries, three
readings and three sets of groups, for the reason every other reading in [24](24-environments.md#groups)
is per environment. The route adds a **band roll-up** on top, computed per request:

- a band's `status` is `ok` only when every member's latest reading is `ok`, `null` when no member has
  been read, and `unknown` otherwise — one member that could not answer is a band that could not;
- a band's groups are its members' groups **by key**, so one fault on two regions is one row naming
  both, with the counts summed and the most moved member's state.

An environment that declares no `group` is a band of one named for itself, exactly as in
`environmentGroups`.

## The desk

`AppErrorDesk` (`src/appErrors/desk.ts`) is its own pulse entry, `appErrors`
([04](04-harness-cycle.md#the-pulse-registry)), **directly below `environments`**: that desk's probe
records the head a reading is held against, so above it a deploy would be noticed a pulse late.
**Nothing reads what it writes** inside the pulse — no gate, no bench row, no prompt — so nothing
below it is ordered on it.

Every environment that declares `errors` is read **concurrently**, each unless its last read is
younger than `appErrorIntervalMs` — an `unknown` read counts, so a broken query is retried on the
interval rather than every pulse:

1. compute `{since}` from `ok_at`, capped at fourteen days back;
2. run the command, and parse what it printed;
3. merge each row into what is held for its fingerprint — only the span and the return mark are read
   back (`groupMarks`), not the groups' day series;
4. write the reading, every group named and its day counts, in one transaction.

Then, if any environment was read, the prune runs once. An `unknown` read writes the reading and
touches no group. An environment whose read throws is recorded through `errors.record` and neither
fails the cycle nor stops the others.

## Seams

`AppErrorReader` (`src/appErrors/reader.ts`) — one method, `list({environment, command, since})`.
`CommandAppErrorReader` spawns the command; `FakeAppErrorReader` (`src/appErrors/fakeReader.ts`)
answers from scripted stdout per environment, records every request, and answers `unknown` for an
environment nobody scripted. Injected as `appErrorReader` on `buildSystem`. **A test that declares an
`errors` block injects it and `environmentProber`**, or it spawns the declared command — and, because
such an environment is probed for its head, the `at` probe — on the machine running the tests.

## On the wire

`GET /api/app-errors` (`src/server/routes/appErrors.ts`), not on `/api/state`: a fortnight of day
counts per group is too much to send every couple of seconds to every open cockpit. Returns
`AppErrorsPayload` (`src/wire.ts`):

- `project` — the key's project segment;
- `environments` — one `AppErrorEnvironmentView` per environment that declares `errors`, in config
  order: its `band`, its `reading` (an `AppErrorRead`, or null before the first read — status, detail,
  `readAt`, `okAt`), its `head` (a `DeployedHead`, or null before the probe first answered — the
  [deploy window](#the-deploy-window)), and its `groups`;
- each group an `AppErrorGroupView`: the stored `AppErrorGroup` (title, operation, version, frames,
  `url`, first and last seen, `returnedAt`) with `daily` made dense over the last fourteen UTC days,
  plus `key`, `state`, `count` (the total of that dense series, so the two always agree), `ignored`,
  and the two placeholders below. The state is computed off the same dense series.
  Sorted moved-first — `new`, `returned`, `spiking`, `steady`, `gone` — then most recently seen;
- `bands` — the [roll-up](#groups).

`link: AppErrorLink | null` — the goal a group is probably the work of (`goalRef`), how the link was
made (`how`, e.g. `frame match`, `test arrival`, `hint`), a sentence saying why, and how many
candidates the deploy window held. **Always null: linking is not yet built.**

`tracker: AppErrorTracker | null` — `status` (`none`, `open`, `closed`, `unknown`), the ticket found
under the key, and a note. **Always null: the tracker lock is not yet built.**

## In the cockpit

The **Errors** tab (`tab=errors`, `web/src/components/AppErrorsPage.tsx`), in the nav beside Insights
only while `CockpitConfig.appErrors` is true — some environment declares an `errors` block. It reads
`GET /api/app-errors` on open and every minute after (`useAppErrors`, the Bot PRs tab's interval): the
route is too heavy for the snapshot, and a reading moves on `appErrorIntervalMs`, not per pulse. Read
only; the controls that act on a group — File bug, Reopen, Investigate, promote to watch — arrive with
the tracker lock and their routes.

- **One tab per band**, from `bands`: a declared group is named with its members (`prod: liveEu,
liveUs`), and an environment in no group is a band of one under its own name. Each tab carries its
  moved count, and an `unknown` chip when any member could not answer. Which band is open is
  `Place.errorsBand` (`band=`), so a link from a goal card lands on the right one; a band the payload
  does not hold reads as the first.
- **Three cards over the table**: the deploy window per member (the head's `previousSha → sha` and when
  the harness noticed it; the first build read says it has no deploy time, which is why `new` means
  the last day there), the last read per member, and the project — the key's middle segment.
- **`unknown` is a warning, never an empty table.** A member whose last read is `unknown` draws an amber
  chip, the sentence _this is not "no errors"_, when it last answered, and the reading's `detail`. A
  table of no rows under an unanswered read would be exactly the confident wrong answer the
  [two-valued reading](#the-output-contract) exists to refuse.
- **Counts per state**: new, spiking, returned, then _N steady, N gone (hidden)_. `steady` and `gone`
  are folded away by default — the panel is "watch for what moved", not an error list — and **Show
  steady and gone** is `Place.errorsSteady` (`steady=1`), never a `useState`.
- **One row per band group**, horizontally scrollable at width: the state chip in its tone (`new` red,
  `spiking` amber, `returned` violet, `steady` grey, `gone` green), the title, the key in mono, the
  operation, the members it was seen on when the band has several, first and last seen, the top frame,
  **Open in App Insights** off `url`, a fourteen-bar sparkline of `daily` with the last three days in
  the state's hue, the count, the link and the tracker. The roll-up carries state, count and members;
  everything else is taken from the member whose state the band reports (`bandRows`,
  `web/src/view/appErrors.ts`), with the members' days summed.
- **The link column** draws `link.goalRef` through `<Ref>`, each `how` as a pill and the `why`; **the
  tracker column** draws the status, the ticket through `<Ref>` and the note. Each is a dash while its
  field is null — a blank there would read as a stage that ran and found nothing.

**On the goal**, the header's identity row carries _N new errors on test since this arrived_
(`web/src/console/goalErrors.tsx`) when any environment's group in `new`, `returned` or `spiking` links
to that goal, with how each link was made on hover; pressing it opens the Errors tab on that
environment's band. It counts per environment rather than per band, so a fault seen in two regions is
two there and one row on the tab. **A link made only by hint is not counted** (`countsOnGoal`): an
operation that looks like the goal's area is a reason to look, not a claim the work caused the error,
and every `how` entry naming a hint is read as one. It fetches only where `CockpitConfig.appErrors` is
true, so a deployment that reads no errors pays nothing on every goal page.

## Not yet built

In the order the proposal stages them, each of which removes its line here:

- **Linking** — the deploy window's candidate goals from landings between the head's `previousSha` and
  `sha`, frames matched against each candidate's landed diff, a group that went `new` on test
  when a goal arrived there, operation hints, and model triage on a press. Fills `link`, which the Errors
  tab's link column and the goal header's line [already draw](#in-the-cockpit).
- **The tracker lock** — the key as a field of `IssueCreateInput` resolved by `ticketFiler`
  ([13](13-jobs-and-tickets.md#filing-a-ticket)), a batched search for every group's key per read, and
  File bug / Reopen / Investigate / promote to watch. Fills `tracker`.

## What it does not see

- **Late ingestion.** `{since}` is the instant the last read started, and a telemetry store that
  ingests an event minutes after its timestamp reports it to neither read. Overlapping the windows
  would double-count instead, which is the worse of the two for a rate.
- **When a build actually arrived**, beyond the probe that noticed it. The head's `changedAt` is as
  precise as `environmentProbeIntervalMs`, and the first build the harness ever sees has none at all.
- **A fingerprint that changes under a refactor.** A renamed failing method is a new fingerprint and
  so a new group that reads `new`; relating it to the old one is the linking stage's job.
