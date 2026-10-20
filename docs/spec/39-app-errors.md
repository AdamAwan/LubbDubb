# 39 — App errors

`src/appErrors/`. **Off by default**: an environment is read for errors only when it declares an
`errors` block, and with none declared nothing is spawned, nothing is stored and the route answers
with empty lists.

The post-deploy watch ([29](29-post-deploy-watch.md)) reads checks a plan **declared**. This reads
the errors **nobody declared**: an environment's own telemetry, grouped by fingerprint, watched for
what _moved_ — a group that is new since the deploy, one that came back, one running well above its
baseline — rather than drawn as an error list an operator has to read in full.

**Partly built.** What is described here as running is the command, its contract, grouping, states,
the key, a read-only route, and [linking a moved group to the goal that probably caused
it](#linking-a-group-to-work) — deterministically, from the deploy window, frames against landed
diffs, test-before-live and operation hints. Three things are **not yet built**, and each section that
names them says so:

- **Model triage on a press** — the bug-investigation flow with the trace attached, for what the
  deterministic link leaves open. → [Not yet built](#not-yet-built)
- **The tracker as the cross-fleet lock** — searching for a group's key before offering File bug or
  Investigate, and filing with the key on `IssueCreateInput`. The wire carries a `tracker` field for
  it that is always `null` today.
- **The cockpit** — the per-environment panel and the goal card line. Nothing in `web/` reads the
  route yet, `link` included.

The design all three are argued in is [`proposals/error-ingestion.md`](../proposals/error-ingestion.md),
which the change that finishes them deletes.

## What it is not

| Not                   | Because                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A telemetry client    | The harness knows a command and an output contract, never Kusto, App Insights or Sentry. The same shape as `health` and `observe`.                                                                             |
| A `WorldEvent` source | `deliveryHold` expires a delivery verdict on **any** world event matching a goal's issue ref, so an error reading filed as one would un-park delivered goals. Own tables, own route — the arrivals rule again. |
| A dispatch input      | Nothing under `src/dispatcher/` reads what this writes. It files nothing, opens no gate and reaches no prompt. A link is computed for the route and stored nowhere.                                            |
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

Three tables, all owned by `AppErrorStore` (`src/store/appErrors.ts`), all written in one
transaction per read:

| Table              | One row per                       | Holds                                                                                                          |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `app_error_reads`  | environment                       | The last read: status, detail, `read_at`, `ok_at` (last _answered_ read) and the deploy window                 |
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
- **Retention.** Day counts older than fourteen days (`RETENTION_DAYS`) are deleted on every read; a
  group not seen for thirty days (`GROUP_RETENTION_DAYS`) is deleted with its days. Seen again after
  that, it is a stranger, and reads `new`. A removed environment's groups age out the same way.

All three tables were introduced new and so need no `ColumnMigrations` entry **today** — the rule in
[14](14-persistence.md#migrations) still applies to the first column anyone adds.

## The deploy window

`new` and `spiking` are both questions about _the latest deploy_, so each read also asks the
environment's own `at` probe ([24](24-environments.md#the-probe)) where it is, and `nextDeploy` keeps
three facts on the reading:

- `deployedSha` — what the probe named, several commits joined by a space as the probe's own
  several-services rule names them;
- `previousSha` — what it named before that changed;
- `deployedAt` — **when the harness noticed the change**, at read precision.

The first head ever read is **no deploy at all**: `deployedAt` stays null, because the harness cannot
say when that build arrived. A probe that could not answer leaves all three as they were. Nothing
else in the harness records an environment's head over time — reach is per landing, and arrivals are
per goal — which is why this pass keeps its own.

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

`AppErrorDesk` (`src/appErrors/desk.ts`) runs as a pass on `EnvironmentDesk`, directly below the health
pass. **Nothing reads what it writes** inside the pulse — no gate, no bench row, no prompt — so its
position is a preference, for health's reason.

For each environment that declares `errors`, unless its last read is younger than
`appErrorIntervalMs` — an `unknown` read counts, so a broken query is retried on the interval rather
than every pulse:

1. compute `{since}` from `ok_at`, capped at fourteen days back;
2. ask the probe where the environment is;
3. run the command, and parse what it printed;
4. write the reading, the deploy window, every group named and its day counts, and the prune, in one
   transaction.

An `unknown` read writes the reading and touches no group. A pass that throws is recorded through
`errors.record` and never fails the cycle.

## Linking a group to work

`src/appErrors/link.ts` (pure) and `src/appErrors/linker.ts` (the clone). A moved group is linked to
the goal it is **probably** the work of, and the link carries how it was made and why — never a bare
claim. Deterministic only: no model is asked anything. One build is often a week of work, so the build
gives a **window** of candidate goals, not an answer; the evidence below narrows it.

Only a group that moved is linked, and each from its own instant — its **anchor**:

| State      | Anchor                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| `new`      | its first sighting                                                        |
| `returned` | `returnedAt`                                                              |
| `spiking`  | the deploy it spiked after; with no deploy on record, a day before now    |
| otherwise  | none — `steady` (including every muted group) and `gone` get `link: null` |

### The window

**The deploy window**, when the reading holds a deploy (`deployedAt`, `deployedSha`, `previousSha`)
and the anchor is at or after `deployedAt`: the goals with a landing ([24](24-environments.md#recording-a-landing))
that `deployedSha` reaches and `previousSha` does not. Asked of the clone with
`GitObserver.contains`, both heads split on spaces as the probe's several-services rule names them —
so a landing is in the deploy only when every service holds it, and was in the build before only
when every service held it.

**The arrival window** otherwise — the first build the harness saw, a group anchored before the
deploy, a spike with no deploy on record: the goals with a landing the reach probe **first found on
the environment** in the seven days (`ARRIVAL_LOOKBACK_MS`) before the anchor. That is the reach
row's `observedAt`, the same instant an arrival is stamped from, read per landing so a goal that has
only partly reached the environment is still a candidate.

Both are **three-valued, and an undecided window is no link** — never a smaller window. The rule from
[24](24-environments.md#the-three-verdicts) holds here unchanged:

- in the deploy window, a landing the clone cannot place against either head (`contains` answered
  `null`, or did not answer in time) makes the whole window undecided;
- in the arrival window, a landing that could have been there — recorded before the anchor, on the
  integration branch or not yet placed — whose reach on the environment is `unknown` or not yet
  asked makes it undecided. `absent` is a decision and is simply not a candidate.

An undecided window is drawn as `goalRef: null`, `candidates: null` and a `why` naming the landing it
could not place. Reading it as "no candidates" would say the deploy shipped nothing, and point the
operator at the wrong deploy.

**A landing recorded more than thirty days before the window** (`LANDING_HORIZON_MS`; before
`deployedAt` for the deploy window, before the anchor for the arrival window) is in neither, and
cannot make either undecided. Without the bound one landing whose commit the clone never held —
a rebuilt clone, a deleted fork — leaves every window on that environment undecided for good. With
it, a fault whose cause shipped more than a month before the deploy that surfaced it is linked to
nothing, which the link's `why` already allows for.

Landings off the integration branch (`onIntegration` `no`) are in no window; a stacked pull request
is present on its carrier's commit ([24](24-environments.md#a-stacked-pull-request-rides-its-carrier)).

### Frames against diffs

The strongest evidence. Each candidate's diff is the union of the paths its commits **in the window**
changed against their first parent (`GitObserver.changedFiles`, `git diff-tree` on the commit and its
`^`); the group's `frames` are matched against it (`src/appErrors/frames.ts`):

- a frame is reduced to a path — backslashes to slashes, a trailing `:118`, `:118:5`, `:line 118` or
  `(118,5)` dropped, a drive letter dropped — and one file named by several frames counts once;
- a frame and a changed path match when the shorter is a **whole-segment suffix** of the longer,
  ignoring case. The deployed `/app/api/Orders/OrderService.cs` and the bare `Orders/OrderService.cs`
  both meet the repository's `api/Orders/OrderService.cs`; `MyOrderService.cs` does not, and nor does
  `api/Billing/OrderService.cs`.

A candidate's score is how many of the group's files its diff touched. **The one highest score
links, with `frame-match`** ("changed only by" when no other candidate touched any; "changed most by"
otherwise). Several candidates at the highest score is no frame link: they go on `tied`, for the
evidence below to separate.

A diff the clone could not list makes the frame evidence **unknown**, never a miss: it is neither a
frame link nor a reason to fall through to the route hint, since the frame it could not see might
have decided it.

### Test before live

A group with the same fingerprint on **another** environment, first seen there no later than this
group's anchor, is held against that environment's arrival window over **one day** (`TEST_ARRIVAL_MS`)
before that first sighting — the same three-valued window, so an undecided one is no evidence. If
exactly one goal of _this_ group's window is in it, that environment votes for the goal; when every
voting environment names the same goal, it is the test arrival. Test deploys more often than live, so
it narrows what live's week cannot.

- With no frame link, it links on its own: `test-arrival`.
- With a frame tie it breaks the tie if it names one of the tied goals: `frame-match` and
  `test-arrival`.
- With a frame link to the same goal, both are named. To a different goal, the frame wins — it is the
  stronger evidence — and `why` says where the test arrival pointed.

### Operation to feature

The weakest, and only when nothing above had anything to say and the frame evidence was not unknown:
the words of the group's `operation` — lower-cased, split on anything not a letter or digit, HTTP
verbs, `api`, ids and tokens under three letters dropped, a plural stemmed — against the same words
of each candidate's title in the work graph. The one candidate sharing the most words links with
`route-hint` alone, and its `why` opens "A hint only". `POST /orders` is orders work far more often
than it is not, and occasionally it is not.

### Where it is computed

On the route, per request, not by the desk: a link depends on landings, reach and the work graph,
which move on every pulse, so a stored link would be stale the moment the next landing was recorded,
and a link stored by nothing that reads it would be a second copy to keep true.

What makes that affordable is that everything the clone says here is **about a fixed commit**, and so
never changes. `AppErrorLinker` keeps every `contains` answer whose heads are commit ids, and every
diff, for the life of the process; an answer of `null`, and any failure, is not kept and is asked again
on the next request. The steady state is no `git` at all. Questions already in flight are joined, not
repeated, and at most four diffs run at once.

**The route never waits on the clone past five seconds** (`LINK_DEADLINE_MS`). Whatever has not
answered by then is unknown for this request — the window undecided, or the frame evidence unknown,
and `why` says the clone did not answer in time — and the question runs on in the background, so the
next request usually finds it answered. A `git` that never exits is bounded below that as well:
`changedFiles` carries its own thirty-second deadline, and only a commit id ever reaches its argument
list.

## Seams

`AppErrorReader` (`src/appErrors/reader.ts`) — one method, `list({environment, command, since})`.
`CommandAppErrorReader` spawns the command; `FakeAppErrorReader` (`src/appErrors/fakeReader.ts`)
answers from scripted stdout per environment, records every request, and answers `unknown` for an
environment nobody scripted. Injected as `appErrorReader` on `buildSystem`; the probe the desk asks is
the one injected as `environmentProber`. **A test that declares an `errors` block injects both**, or it
spawns the declared command and the `at` probe on the machine running the tests.

Linking asks the clone through `GitObserver` — `contains` and `changedFiles` — injected as
`gitObserver`. `FakeGitObserver` answers `changedFiles` from `setChangedFiles` and `null` for a commit
nobody scripted, and records every question on `calls`. A test with no landings asks the clone nothing.

## On the wire

`GET /api/app-errors` (`src/server/routes/appErrors.ts`), not on `/api/state`: a fortnight of day
counts per group is too much to send every couple of seconds to every open cockpit. Returns
`AppErrorsPayload` (`src/wire.ts`):

- `project` — the key's project segment;
- `environments` — one `AppErrorEnvironmentView` per environment that declares `errors`, in config
  order: its `band`, its `reading` (an `AppErrorRead`, or null before the first read — status, detail,
  `readAt`, `okAt`, and the deploy window `deployedSha` / `previousSha` / `deployedAt`), and its
  `groups`;
- each group an `AppErrorGroupView`: the stored `AppErrorGroup` (title, operation, version, frames,
  `url`, first and last seen, `returnedAt`) with `daily` made dense over the last fourteen UTC days,
  plus `key`, `state`, `count` (the fortnight's total), `ignored`, `link`, and the `tracker`
  placeholder below.
  Sorted moved-first — `new`, `returned`, `spiking`, `steady`, `gone` — then most recently seen;
- `bands` — the [roll-up](#groups).

`link: AppErrorLink | null` — [the link](#linking-a-group-to-work). Null for a group nothing is
linked for (`steady`, `gone`, ignored); otherwise always an object, even when no goal was found:

| Field        | Is                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `goalRef`    | the goal the group is probably the work of (`issue:<n>`), or **null** when the evidence did not single one out         |
| `how`        | what made it, strongest first: `frame-match`, `test-arrival`, `route-hint` (`AppErrorLinkHow`); empty with no goal     |
| `why`        | one sentence for a person — "OrderService.cs changed only by #412, of 11 goals in the deploy window 1a2b3c4..5d6e7f8." |
| `candidates` | how many goals the window held; **null when the window could not be decided**, which is never the same as `0`          |
| `tied`       | the goals the frames narrowed to and nothing separated, when that is why there is no goal; empty otherwise             |

`tracker: AppErrorTracker | null` — `status` (`none`, `open`, `closed`, `unknown`), the ticket found
under the key, and a note. **Always null: the tracker lock is not yet built.**

## Not yet built

In the order the proposal stages them, each of which removes its line here:

- **Model triage on a press** — the bug-investigation flow ([38](38-bug-investigation.md)) with the
  trace attached, for a group the [deterministic link](#linking-a-group-to-work) leaves without a goal.
- **The tracker lock** — the key as a field of `IssueCreateInput` resolved by `ticketFiler`
  ([13](13-jobs-and-tickets.md#filing-a-ticket)), a batched search for every group's key per read, and
  File bug / Reopen / Investigate / promote to watch. Fills `tracker`.
- **The cockpit** — the Errors-per-environment panel, drawing the moved groups and folding `steady`
  away, with first and last seen, the `url` and the link with its `why`; and the goal card's "2 new
  errors on test since this arrived".

## What it does not see

- **Late ingestion.** `{since}` is the instant the last read started, and a telemetry store that
  ingests an event minutes after its timestamp reports it to neither read. Overlapping the windows
  would double-count instead, which is the worse of the two for a rate.
- **When a build actually arrived**, beyond the read that noticed it. `deployedAt` is as precise as
  `appErrorIntervalMs`, and the first build the harness ever sees has no `deployedAt` at all.
- **A fingerprint that changes under a refactor.** A renamed failing method is a new fingerprint and
  so a new group that reads `new`; nothing relates it to the old one. Its frames are linked like any
  other new group's, which is usually to the refactor.
- **A culprit outside the window.** The window is the last deploy's, or a week of arrivals: a fault
  that sat dormant for three deploys until traffic found it is linked to whichever goal happens to
  touch its file in the latest one, or to nothing. The link says _probably_ for this reason, and shows
  its evidence rather than asserting it.
- **Two goals carried by one commit.** A stacked pull request's landing is its carrier's commit
  ([24](24-environments.md#a-stacked-pull-request-rides-its-carrier)), so its frames match exactly as
  the carrier's do and the two read `tied`. That is the truth about what shipped, not a defect of the
  match.
