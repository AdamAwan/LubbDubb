# 39 — App errors

`src/appErrors/`. **Off by default**: an environment is read for errors only when it declares an
`errors` block, and with none declared nothing is spawned, nothing is stored and the route answers
with empty lists.

The post-deploy watch ([29](29-post-deploy-watch.md)) reads checks a plan **declared**. This reads
the errors **nobody declared**: an environment's own telemetry, grouped by fingerprint, watched for
what _moved_ — a group that is new since the deploy, one that came back, one running well above its
baseline — rather than drawn as an error list an operator has to read in full.

**Partly built.** What is described here as running is the command, its contract, grouping, states,
the key, the [tracker lock](#the-tracker-lock) and its presses, the route and the cockpit that draws
them. Three things are **not yet built**, and each section that names them says so:

- **Linking a group to the work that probably caused it** — the deploy window, frames against landed
  diffs, test-before-live and operation hints. The wire carries a `link` field for it that is always
  `null` today, and the cockpit draws it wherever it is non-null. → [Not yet built](#not-yet-built)
- **Promote to watch** — turning a group into a declared `signal` check on the fixing goal.
  → [Why there is no Watch press](#why-there-is-no-watch-press)
- **Cross-fleet links through the pool.** → [Not yet built](#not-yet-built)

## What it is not

| Not                   | Because                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A telemetry client    | The harness knows a command and an output contract, never Kusto, App Insights or Sentry. The same shape as `health` and `observe`.                                                                               |
| A `WorldEvent` source | `deliveryHold` expires a delivery verdict on **any** world event matching a goal's issue ref, so an error reading filed as one would un-park delivered goals. Own tables, own route — the arrivals rule again.   |
| A dispatch input      | Nothing under `src/dispatcher/` reads what this writes. It files only on an operator's press, opens no gate and reaches no prompt; Investigate starts the existing investigation by its label, and nothing else. |
| An error log          | The harness's own faults are `error_events` (`src/store/errors.ts`, [18](18-observability.md)). These are the **application's** errors, which is why the feature is called app errors.                           |

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

A fourth, `app_error_tickets`, is the [tracker lock](#the-tracker-lock)'s cache, one row per key and
owned by `AppErrorTicketStore` (`src/store/appErrorTickets.ts`) — its own module, because it is keyed
on the key rather than on an environment and nothing about a read writes it.

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

All four tables were introduced new and so need no `ColumnMigrations` entry **today** — the rule in
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

The key is what [the tracker lock](#the-tracker-lock) files under and searches for. It is computed
from the fingerprint and never stored, so changing how it is derived re-keys every group at once —
and, with them, orphans every ticket already filed under the old keys.

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
**One pass reads what it writes** inside the pulse — the [tracker desk](#the-search), directly below
it, which searches for the groups the read just moved. Nothing else does: no gate, no bench row, no
prompt.

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

## The tracker lock

Every fleet working an app reads the same telemetry. Reading is cheap and stays per fleet; what costs
is a filed bug and a model investigation, and two fleets doing either for one error is the waste to
stop. **The tracker is the lock**: it is live, every fleet already reads it, and a filed bug is the
record of _someone has this_. The pool ([28](28-cross-fleet-pool.md)) is the wrong lock — its clock is
a day — and a lock of the harness's own would be a second record of what the tracker already says.

### The key on the ticket

**The key is carried by the ticket, never by a prompt.** It is `errorKey` on `IssueCreateInput`
([15](15-integrations.md)), passed through `ticketFiler` ([13](13-jobs-and-tickets.md#filing-a-ticket))
and resolved by the provider where its own search can find it exactly:

| Provider     | Carries it as                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Azure DevOps | a **tag** — `[System.Tags] CONTAINS` matches a whole tag                                                         |
| GitHub       | a visible line, `` Error key: `err:shop:3f9a1c2b` ``, and a marker comment `<!-- lubbdubb:err:shop:3f9a1c2b -->` |
| fake         | the GitHub lines, so a test's search reads what it filed                                                         |

Told to an agent instead, a bug filed without it is invisible to every other fleet, with nothing red.
It is not a template placeholder either, for the same reason: `app-error-ticket-body` is
operator-overridable, and an override that never learned the token would drop it
([05](05-dispatcher.md#prompt-templates)). A label per key was the GitHub alternative and is refused:
labels are capped per repository and would clutter it with one per fault.

### The search

`IssueKeySink.findIssuesByKeys(keys)` (`src/sink/actionSink.ts`) answers, per key, every ticket
carrying it — open or closed, with its `closedAt`. **A search that fails throws; it is never an empty
answer.**

- **Azure DevOps** runs one WIQL query per fifty keys, the `CONTAINS` clauses OR'd, over open and closed
  items alike, and matches each item back to its key by tag, case-insensitively. `closedAt` is
  `Microsoft.VSTS.Common.ClosedDate`, else the item's last change.
- **GitHub** runs `repo:<o>/<r> is:issue in:body "k1" OR "k2" …`, at most six keys a query (the search
  refuses more than five `OR`s) and at most 256 characters (`keySearchBatches`,
  `src/integrations/github/issues.ts`). The search tokenises, so a hit is kept for a key only where its
  body carries the key **whole** (`bodyCarriesKey`) — `err:shop:3f9a1c2b0` is not `err:shop:3f9a1c2b`.

**`AppErrorTrackerDesk`** (`src/appErrors/tracker.ts`) is its own pulse entry, `appErrorTracker`,
directly below `appErrors` ([04](04-harness-cycle.md#the-pulse-registry)): it searches for the keys the
read just moved. It runs only where a tracker is configured (`trackerCoordinates`, the same predicate
the filing routes 409 on) and the provider can search. Each pass makes **one batched search** for the
keys owed (`keysOwed`): every group in `new`, `returned` or `spiking` whose key has not been searched
since the newest read. A group that has not moved is not searched for on the pulse; the tab is about
what moved. The search carries a 30-second deadline, because neither tracker client sets a request
timeout and the pulse awaits the desk — a search that never answered would hold the cycle for good.

The answer is cached in `app_error_tickets` — status, the ticket that answers for the key, its
`closed_at`, how many tickets carry the key, a detail and `checked_at`. `settleSearch` picks the
ticket: the **oldest open** one, else the **most recently closed**, else none. Two tickets under one key
is a duplicate two fleets filed in the same seconds; the row says how many carry it, and the next
search shows them side by side.

| The search found  | `tracker`                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| an open ticket    | `open`, its ref; a note when several carry the key                                              |
| only closed ones  | `closed`, the latest; _fixed <date>, error is back_ on a moved group, _closed <date>_ otherwise |
| nothing           | `none`                                                                                          |
| the search failed | `unknown`, with the failure as the note                                                         |
| never searched    | `null`                                                                                          |

**`unknown` is never `none`.** A failed search is recorded `unknown` for every key it carried, with the
failure on the error log through `errors.record`, and retried after the next read. Like the
[two-valued reading](#the-output-contract), the confident wrong answer — _no bug_, when nobody could
say — is what this refuses. **The cache is not a `WorldEvent` and nothing dispatches on it**: it is a
table the route reads, and nothing under `src/dispatcher/` does.

### The presses

All four are operator-pressed routes ([16](16-http-api.md)), each **searching again right before it
writes**, so the window in which two fleets can both file is seconds rather than a read interval. All
refuse with a 409 when no tracker is configured, and record what they did in the cache before
answering, so the row redraws without waiting for a search. Each is `src/appErrors/filing.ts`.

- **File bug** (`POST /api/app-errors/file-bug`, `{environment, fingerprint}`). Found open: the found
  ticket is answered, `reused: true`, and nothing is filed. Otherwise it files through `ticketFiler` as
  a **bug** (`issueBugType`) carrying the key, titled `<environment>: <group title>`, its body the
  `app-error-ticket-body` template — title, state, counts, first and last seen, operation, version, the
  top ten frames and the telemetry link. **Never the exception message**: messages carry user data,
  and the contract does not even ask the script for one. When the group is linked to a goal, the bug is
  `relatedTo` that goal's story — the Azure `related` relation or the GitHub cross-reference, as every
  other bug the operator raises ([13](13-jobs-and-tickets.md#the-other-filing-kind--a-bug-the-operator-raised)).
  It carries **no watch tag**: filing is a record, and the operator watches it from the Tickets tab like
  any ticket they want the fleet on.
- **Investigate** (`POST /api/app-errors/investigate`). Files exactly as File bug — or reuses the open
  one found — and puts on the **watch tag and the investigate label**
  ([38](38-bug-investigation.md#the-label)): at filing, as `labels` on the create; on a found ticket,
  through `requestInvestigation` (`src/issueWatch.ts`). That label is the only switch rule
  `issue-investigate` reads, so the existing read-only investigator takes it on a later pulse, held
  behind the appraisal like any other. **An investigation is claimed by its bug**: a second fleet
  pressing it finds the bug open and starts nothing — the labels it re-applies are already there.
- **Reopen** (`POST /api/app-errors/reopen`, `{key}`). Found open (somebody reopened or refiled it):
  answered, `reused`. Found closed: the latest closed ticket is reopened through
  `IssueKeySink.reopenIssue` — on GitHub its state, on Azure DevOps the **first of
  `issuePickupStates`**, the column the harness already reads as _to be worked_. With none named,
  Azure cannot be reopened from here and the route says to name it.
- **Search** (`POST /api/app-errors/search`, `{key}`) — the row's Retry search: one key, recorded as the
  pulse would.

**A press whose search fails does not file.** It answers a 502 naming the failure — not filing what may
be a duplicate — unless the request says `unsearched: true`, which is the row's **File bug anyway**:
the operator, told the lock could not be read, files regardless. A press already running for a key
refuses a second one (409), so two clicks in one cockpit are one bug. A tracker that refuses the
create is a 502 with its reason, and recorded through `errors.record`.

**Filing is always a click.** An automatic filer on a weekly live deploy of a week's changes would
flood the tracker.

### Why there is no Watch press

The fourth press once argued for — turn a group into a declared `signal` check with `tolerate: 0` on
the fixing goal, so the post-deploy watch ([29](29-post-deploy-watch.md)) confirms it is gone after
the fix arrives — is **not built**, and not for want of time. A `signal` check is a **query** the
environment's `observe` command runs, and it must carry a `presence` query and a `{since}` bound
([29](29-post-deploy-watch.md#every-query-carries-since)). The harness knows a fingerprint and an
`errors` command, never Kusto, so it cannot write that query generically; and reading the check
through the `errors` command instead is a second kind of check with its own presence story, which is
a change to the watch, not to this. Until then, the operator writes the signal on the goal's Signals
card — the group's operation and fingerprint are on the row.

### Where the key can miss

- **A refactor renames the failing method** → a new fingerprint, a new key, a group that reads `new`,
  and no ticket found for it. Linking (when built) is what ties it back to the change that moved it.
- **A bug filed by hand** carries no key. It is found only if someone adds the tag or the line; the
  row cannot know.
- **Two faults, one fingerprint** (one method, two causes) share a bug. Acceptable: the bug is about
  the method.
- **GitHub's search index lags** a create by seconds to minutes, so a second fleet pressing in that
  window can file a duplicate. It is the one gap the search at the press does not close, and the next
  search shows both.

## Seams

`AppErrorReader` (`src/appErrors/reader.ts`) — one method, `list({environment, command, since})`.
`CommandAppErrorReader` spawns the command; `FakeAppErrorReader` (`src/appErrors/fakeReader.ts`)
answers from scripted stdout per environment, records every request, and answers `unknown` for an
environment nobody scripted. Injected as `appErrorReader` on `buildSystem`.

The tracker lock reads through `IssueKeySink` beside `ActionSink` — `canSearchIssueKeys`,
`findIssuesByKeys`, `canReopenIssue`, `reopenIssue` — which `CompositeConnector` routes to the issues
provider's `IssueKeySearchCapable` / `IssueReopenCapable` ([15](15-integrations.md)). The provider HTTP
is `GitHubApi.searchIssues` / `reopenIssue` and `AzureDevOpsApi.queryWorkItemsByTags`, each with its
scripted fake; `FakeIssuesIntegration` searches the bodies it filed. A test of the presses flips
`config.integrations.issues` to a real provider after `buildSystem`, as the bug routes' tests do, and
keeps the fake connector underneath (`test/appErrorTracker.test.ts`). **A test that declares an
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

`tracker: AppErrorTracker | null` — `status` (`none`, `open`, `closed`, `unknown`), the ticket that
answers for the key, and a note, filled from `app_error_tickets` by `withTrackers`
([the search](#the-search)). Null where the key has never been searched — no tracker, or a group that
has not moved.

The route's payload is built by `currentAppErrors` (`src/appErrors/current.ts`), the one builder the
route, the tracker desk and the presses share, so a press files from exactly the row the tab drew. The
presses are [above](#the-presses); each answers an `AppErrorPressPayload` — the ticket ref, whether it
was `reused`, and for Investigate the label writes that failed.

## In the cockpit

The **Errors** tab (`tab=errors`, `web/src/components/AppErrorsPage.tsx`), in the nav beside Insights
only while `CockpitConfig.appErrors` is true — some environment declares an `errors` block. It reads
`GET /api/app-errors` on open, every minute after (`useAppErrors`, the Bot PRs tab's interval) and
straight after a tracker press lands: the route is too heavy for the snapshot, and a reading moves on
`appErrorIntervalMs`, not per pulse.

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
- **The tracker column carries the presses**, by what the search found (`trackerPresses`,
  `web/src/view/appErrors.ts`), each pressing for the member whose state the band reports:

  | Found     | Drawn                                                                                 |
  | --------- | ------------------------------------------------------------------------------------- |
  | `none`    | **File bug** (primary), and **Investigate** when the group links no goal              |
  | `open`    | _Filed:_ and the ticket — no File bug, no Investigate                                 |
  | `closed`  | the ticket, _fixed <date>, error is back_, **Reopen** and **File new**                |
  | `unknown` | _search failed — not 'no bug'_, the failure, **File bug anyway** and **Retry search** |

  The ticket is a `<Ref>` **beside** the buttons, in its own `cn-refs` group, never inside one
  ([17](17-cockpit.md#links)). A refused press says why on the button. Investigate is offered only on an
  unlinked group, because a linked one already names the goal to look at.

**On the goal**, the header's identity row carries _N new errors on test since this arrived_
(`web/src/console/goalErrors.tsx`) when any environment's group in `new`, `returned` or `spiking` links
to that goal, with how each link was made on hover; pressing it opens the Errors tab on that
environment's band. It counts per environment rather than per band, so a fault seen in two regions is
two there and one row on the tab. **A link made only by hint is not counted** (`countsOnGoal`): an
operation that looks like the goal's area is a reason to look, not a claim the work caused the error,
and every `how` entry naming a hint is read as one. It fetches only where `CockpitConfig.appErrors` is
true, so a deployment that reads no errors pays nothing on every goal page.

## Not yet built

Each removes its line here when it lands:

- **Linking.** One build is up to a week of changes, so the build version gives a **window**, not an
  answer, and the link is narrowed in steps, each shown with how it was made (`frame match`,
  `test arrival`, `hint`), never as a bare claim:
  1. **the window** — every goal whose landing is between the head's `previousSha` and `sha` is a
     candidate, often a dozen;
  2. **frames against diffs** — a top in-app frame in a file only one candidate's landed diff touched
     is a strong link;
  3. **test before live** — a group that went `new` on test when goal X arrived there, and then on
     live in the weekly deploy, is X's: test deploys more often, so it narrows what live's week cannot;
  4. **operation to feature** — `POST /orders` to the orders work, a hint only;
  5. **model triage on a press** — the bug-investigation flow ([38](38-bug-investigation.md)) with the
     trace attached, for what the first four leave open.

  Fills `link`, which the Errors tab's link column, the goal header's line and the presses' relation
  back to a story [already read](#in-the-cockpit).

- **Promote to watch.** → [Why there is no Watch press](#why-there-is-no-watch-press)
- **Cross-fleet links through the pool** ([28](28-cross-fleet-pool.md)). The pool is the wrong lock,
  but it can later show which fleet **linked** a group to which of its goals, which narrows the
  week-long window for fleets that do not own the change. Only the key, a goal ref and a ticket ref
  would cross; titles, messages and frames never do, since the pool carries no free text.

## What it does not see

- **Late ingestion.** `{since}` is the instant the last read started, and a telemetry store that
  ingests an event minutes after its timestamp reports it to neither read. Overlapping the windows
  would double-count instead, which is the worse of the two for a rate.
- **When a build actually arrived**, beyond the probe that noticed it. The head's `changedAt` is as
  precise as `environmentProbeIntervalMs`, and the first build the harness ever sees has none at all.
- **A fingerprint that changes under a refactor.** A renamed failing method is a new fingerprint and
  so a new group that reads `new`; relating it to the old one is the linking stage's job.
