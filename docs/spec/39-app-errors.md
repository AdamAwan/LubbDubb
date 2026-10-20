# 39 — App errors

`src/appErrors/`. **Off by default**: an environment is read for errors only when it declares an
`errors` block, and with none declared nothing is spawned, nothing is stored and the route answers
with empty lists.

The post-deploy watch ([29](29-post-deploy-watch.md)) reads checks a plan **declared**. This reads
the errors **nobody declared**: an environment's own telemetry, grouped by fingerprint, watched for
what _moved_ — a group that is new since the deploy, one that came back, one running well above its
baseline — rather than drawn as an error list an operator has to read in full.

**Partly built.** What is described here as running is the command, its contract, grouping, states,
the key, [linking a moved group to the goal that probably caused it](#linking-a-group-to-work) —
deterministically, from the deploy window, frames against landed diffs, test-before-live and operation
hints — the [tracker lock](#the-tracker-lock) and its presses, the route and the cockpit that draws
them. Three things are **not yet built**, and each section that names them says so:

- **Model triage on a press** — the bug-investigation flow with the trace attached, for what the
  deterministic link leaves open. → [Not yet built](#not-yet-built)
- **Promote to watch** — turning a group into a declared `signal` check on the fixing goal.
  → [Why there is no Watch press](#why-there-is-no-watch-press)
- **Cross-fleet links through the pool.** → [Not yet built](#not-yet-built)

## What it is not

| Not                   | Because                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A telemetry client    | The harness knows a command and an output contract, never Kusto, App Insights or Sentry. The same shape as `health` and `observe`.                                                                                                                                  |
| A `WorldEvent` source | `deliveryHold` expires a delivery verdict on **any** world event matching a goal's issue ref, so an error reading filed as one would un-park delivered goals. Own tables, own route — the arrivals rule again.                                                      |
| A dispatch input      | Nothing under `src/dispatcher/` reads what this writes. It files only on an operator's press, opens no gate and reaches no prompt; Investigate starts the existing investigation by its label, and nothing else. A link is computed per request and stored nowhere. |
| An error log          | The harness's own faults are `error_events` (`src/store/errors.ts`, [18](18-observability.md)). These are the **application's** errors, which is why the feature is called app errors.                                                                              |

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

`src/appErrors/key.ts` only **mints** the key. How a ticket carries it — the body lines, the marker,
the whole-key match — is the tracker's business and lives with the filing seam, in
`src/tickets/searchKey.ts` ([the key on the ticket](#the-key-on-the-ticket)): to a provider the key is
an opaque search key, and no provider imports this feature.

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
it, which starts a search for the groups the read just moved. Nothing else does: no gate, no bench row, no
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
| `spiking`  | the head's `changedAt`; with no deploy on record, a day before now        |
| otherwise  | none — `steady` (including every muted group) and `gone` get `link: null` |

### The window

**The deploy window**, when the environment's [head](#the-deploy-window) records a deploy — a
`changedAt` and a `previousSha` — and the anchor is at or after `changedAt`: the goals with a landing
([24](24-environments.md#recording-a-landing)) that the head's `sha` reaches and its `previousSha` does
not. Asked of the clone with
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
the head's `changedAt` for the deploy window, before the anchor for the arrival window) is in neither, and
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

Per request, not by the desk: a link depends on landings, reach and the work graph, which move on
every pulse, so a stored link would be stale the moment the next landing was recorded, and a link
stored by nothing that reads it would be a second copy to keep true. **There is one builder of the
linked payload**, `currentAppErrors` (`src/appErrors/current.ts`): the view, the tracker cache folded
on, then `AppErrorLinker.link`. The route answers with it and [every press](#the-presses) finds its
group in it, so a press files from exactly the row the tab drew — its link, and so the story a bug is
related to, included. A press that rebuilt the row without the link would file every bug unrelated.

**One linked pass is shared.** `CurrentAppErrors.read` keeps the last linked payload and hands it out
again for thirty seconds while nothing it was built from has moved — no environment read, no head, no
landing, no reach reading, no work node, and no change to `appErrorMinCount` or `appErrorIgnore` — so
the Errors tab, every goal header's line and a press do not each pay a link pass. The tracker cache is
folded on afresh on every read (`withTrackers`), never kept in the shared payload, so a press's own
record shows on the next draw. A pass the deadline cut short is not kept: the next request asks again,
which is what lets the question that ran on in the background land. A press reading the shared payload
is safe because it [searches the tracker again](#the-presses) regardless.

The [tracker desk](#the-search) is the one reader that does not link: it reads `appErrorView`, the
view alone, with neither links nor trackers. It needs only each group's key and state, which linking
never changes, and linking there would put the clone's questions — up to five seconds of them — inside
the pulse for an answer nothing on the pulse reads.

What makes that affordable is that everything the clone says here is **about a fixed commit**, and so
never changes. `AppErrorLinker` keeps every `contains` answer whose heads are commit ids, and every
diff of a commit some window can still hold — a landing younger than a group's retention plus the
landing horizon; older diffs are dropped after each pass. A `contains` answer of `null`, and any
failure, is not kept and is asked again on the next request. A commit the clone **could not diff** is
remembered for ten minutes and not asked about again until then, so a shallow clone missing a parent
does not cost a `git` per request. The steady state is no `git` at all. Questions already in flight are
joined, not repeated, the deploy windows of every environment are asked about concurrently under the
one deadline, and at most four diffs run at once. A pass computes each group's anchor and window once,
and reads landings and reach readings indexed once (`placeFacts`), for both the diffs it asks for and
the links it makes.

**A request never waits on the clone past five seconds** — the route's, or a press's (`LINK_DEADLINE_MS`). Whatever has not
answered by then is unknown for this request — the window undecided, or the frame evidence unknown,
and `why` says the clone did not answer in time — and the question runs on in the background, so the
next request usually finds it answered. A `git` that never exits is bounded below that as well:
`changedFiles` carries its own thirty-second deadline, and only a commit id ever reaches its argument
list.

## The tracker lock

Every fleet working an app reads the same telemetry. Reading is cheap and stays per fleet; what costs
is a filed bug and a model investigation, and two fleets doing either for one error is the waste to
stop. **The tracker is the lock**: it is live, every fleet already reads it, and a filed bug is the
record of _someone has this_. The pool ([28](28-cross-fleet-pool.md)) is the wrong lock — its clock is
a day — and a lock of the harness's own would be a second record of what the tracker already says.

### The key on the ticket

**The key is carried by the ticket, never by a prompt.** It is the optional `searchKey` on
`IssueCreateInput` ([15](15-integrations.md#finding-a-ticket-by-a-search-key)), passed through
`ticketFiler` ([13](13-jobs-and-tickets.md#filing-a-ticket)) and resolved by the provider where its own
search can find it exactly. The body encoding is `src/tickets/searchKey.ts`, one helper for GitHub and
the fake:

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
  body carries the key **whole** (`bodyCarriesKey`, `src/tickets/searchKey.ts`) — `err:shop:3f9a1c2b0`
  is not `err:shop:3f9a1c2b`.

**`AppErrorTrackerDesk`** (`src/appErrors/tracker.ts`) is its own pulse entry, `appErrorTracker`,
directly below `appErrors` ([04](04-harness-cycle.md#the-pulse-registry)): it searches for the keys the
read just moved. It runs only where a tracker is configured (`trackerCoordinates`, the same predicate
the filing routes 409 on) and the provider can search. A pass first asks, in memory, whether any
environment's `readAt` has advanced since the desk last worked out what was owed; with none, it builds
nothing. Otherwise it builds the view and makes **one batched search** for the keys owed (`keysOwed`),
**per environment**: every group in `new`, `returned` or `spiking` whose key has not been searched since
**its own environment's** read, or whose state or last sighting changed since the desk last looked. A
group that has not moved is not searched for on the pulse; the tab is about what moved.

**The pulse never waits on the search.** The pass starts it and returns; the answer lands in the store
when it comes, and a pass that finds the last search still running skips. The search carries a
30-second deadline even so, because neither tracker client sets a request timeout, and a search that
never answered would otherwise keep every later pass skipping for good.

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
answering, so the row redraws without waiting for a search. Each is `src/appErrors/filing.ts`, and the
routes map what they answer through one `pressRoute`.

- **File bug** (`POST /api/app-errors/file-bug`, `{environment, fingerprint}`). Found open: the found
  ticket is answered, `reused: true`, and nothing is filed. Otherwise it files through `ticketFiler` as
  a **bug** (`issueBugType`) carrying the key, titled `<environment>: <group title>`, its body the
  `app-error-ticket-body` template — title, state, counts, first and last seen, operation, version, the
  top ten frames and the telemetry link. **Never the exception message**: messages carry user data,
  and the contract does not even ask the script for one. When the group's link names a goal, the bug is
  `relatedTo` that goal's story — read off the [linked payload](#where-it-is-computed) the tab drew — the Azure `related` relation or the GitHub cross-reference, as every
  other bug the operator raises ([13](13-jobs-and-tickets.md#the-other-filing-kind--a-bug-the-operator-raised)).
  A link with `goalRef: null` — undecided, tied, or no evidence — relates it to nothing, not to any of
  its `tied` goals. **A hint is not a relation**: a link whose every `how` is `route-hint` relates the
  bug to nothing either, for the reason the goal header does not count it
  ([in the cockpit](#in-the-cockpit)) — an operation that looks like a goal's area is a reason to look,
  and a relation on the tracker is a claim the goal caused the error.
  It carries **no watch tag**: filing is a record, and the operator watches it from the Tickets tab like
  any ticket they want the fleet on.
- **Investigate** (`POST /api/app-errors/file-bug` with `investigate: true`). Files exactly as File
  bug — or reuses the open one found — and puts on the **watch tag and the investigate label**
  ([38](38-bug-investigation.md#the-label)): at filing, as `labels` on the create; on a found ticket,
  through `requestInvestigation` (`src/issueWatch.ts`). That label is the only switch rule
  `issue-investigate` reads, so the existing read-only investigator takes it on a later pulse, held
  behind the appraisal like any other. **An investigation is claimed by its bug**: a second fleet
  pressing it finds the bug open and starts nothing — the labels it re-applies are already there.
- **Reopen** (`POST /api/app-errors/reopen`, `{key}`). Found open (somebody reopened or refiled it):
  answered, `reused`. Found closed: the latest closed ticket is reopened through
  `ActionSink.reopenIssue` ([15](15-integrations.md#reopening-a-ticket)) — on GitHub its state, on Azure DevOps the **first of
  `issuePickupStates`**, the column the harness already reads as _to be worked_. With none named,
  Azure cannot be reopened from here and the route says to name it.
- **Search** (`POST /api/app-errors/search`, `{key}`) — the row's Retry search: one key, recorded as the
  pulse would.

**A press whose search fails does not file.** It answers a 502 naming the failure — not filing what may
be a duplicate — unless the request says `unsearched: true`, which is the row's **File bug anyway**:
the operator, told the lock could not be read, files regardless. A press already running for a key
refuses a second one (409), so two clicks in one cockpit are one bug — the claim is held on the
`AppErrorTrackerDesk` instance (`claim` / `release`), not in module state. A tracker that refuses the
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

The tracker lock searches through `IssueKeySink` beside `ActionSink` — `canSearchIssueKeys`,
`findIssuesByKeys` — and reopens through `ActionSink.canReopenIssue` / `reopenIssue`, a general tracker
operation beside `closeIssue`. `CompositeConnector` routes them to the issues provider's
`IssueKeySearchCapable` / `IssueReopenCapable` ([15](15-integrations.md)). The routes reach the sink
once, as `System.sink` — the connector, or the sink a test injected in its place. The provider HTTP
is `GitHubApi.searchIssues` / `reopenIssue` and `AzureDevOpsApi.queryWorkItemsByTags`, each with its
scripted fake; `FakeIssuesIntegration` searches the bodies it filed. A test of the presses flips
`config.integrations.issues` to a real provider after `buildSystem`, as the bug routes' tests do, and
keeps the fake connector underneath (`test/appErrorTracker.test.ts`). **A test that declares an
`errors` block injects it and `environmentProber`**, or it spawns the declared command — and, because
such an environment is probed for its head, the `at` probe — on the machine running the tests.

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
  `readAt`, `okAt`), its `head` (a `DeployedHead`, or null before the probe first answered — the
  [deploy window](#the-deploy-window)), and its `groups`;
- each group an `AppErrorGroupView`: the stored `AppErrorGroup` (title, operation, version, frames,
  `url`, first and last seen, `returnedAt`) with `daily` made dense over the last fourteen UTC days,
  plus `key`, `state`, `count` (the total of that dense series, so the two always agree), `ignored`,
  `link` and `tracker`, both below. The state is computed off the same dense series.
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

`tracker: AppErrorTracker | null` — `status` (`none`, `open`, `closed`, `unknown`), the ticket that
answers for the key, and a note, folded on from `app_error_tickets` by `withTrackers` on every read
([the search](#the-search)). Null where the key has never been searched — no tracker, or a group that
has not moved.

The route's payload is built by `CurrentAppErrors` (`src/appErrors/current.ts`, `System.appErrorPayloads`),
the one builder of the linked payload, which the presses read too, so a press files from exactly the row the tab drew
([where it is computed](#where-it-is-computed)). The
presses are [above](#the-presses); each answers an `AppErrorPressPayload` — the ticket ref, whether it
was `reused`, and for Investigate the label writes that failed.

## In the cockpit

The **Errors** tab (`tab=errors`, `web/src/components/AppErrorsPage.tsx`), in the nav beside Insights
only while `CockpitConfig.appErrors` is true — some environment declares an `errors` block. It reads
`GET /api/app-errors` on open, every minute after and straight after a tracker press lands, through
`useAppErrors` — `usePolled` (`web/src/hooks.ts`), the same hook the Bot PRs tab polls through. Every
mount of it shares **one poll**, started by the first mount and stopped with the last, so the tab and
every goal header's line make one request between them: the route is too heavy for the snapshot, and a reading moves on
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
- **The link column** draws `link.goalRef` through `<Ref>`, each `how` as a pill (`frame match`, `test
arrival`, `route hint`), the `why` and _candidates: N_. A link with **no goal** draws a grey _no link_
  pill, the `tied` goals through `<Ref>` when the frames narrowed to several, the `why`, and
  _candidates: unknown_ when the window could not be decided — never `0`, which would say the deploy
  shipped nothing. **The tracker column** draws the status, the ticket through `<Ref>` and the note.
  Each is a dash while its field is null — a blank there would read as a stage that ran and found
  nothing.
- **The tracker column carries the presses**, by what the search found (`trackerPresses`,
  `web/src/view/appErrors.ts`), each pressing for the member whose state the band reports:

  | Found     | Drawn                                                                                 |
  | --------- | ------------------------------------------------------------------------------------- |
  | `none`    | **File bug** (primary), and **Investigate** when the group's link names no goal       |
  | `open`    | _Filed:_ and the ticket — no File bug, no Investigate                                 |
  | `closed`  | the ticket, _fixed <date>, error is back_, **Reopen** and **File new**                |
  | `unknown` | _search failed — not 'no bug'_, the failure, **File bug anyway** and **Retry search** |

  The ticket is a `<Ref>` **beside** the buttons, in its own `cn-refs` group, never inside one
  ([17](17-cockpit.md#links)). A refused press says why on the button. Investigate is offered only where the
  link names no goal — no link at all, or a link whose `goalRef` is null (undecided, tied, or no
  evidence) — because a group whose link names a goal already says where to look.

**On the goal**, the header's identity row carries _N new errors on test since this arrived_
(`web/src/console/goalErrors.tsx`) when any environment's group in `new`, `returned` or `spiking` links
to that goal, with how each link was made on hover; pressing it opens the Errors tab on that
environment's band. It counts per environment rather than per band, so a fault seen in two regions is
two there and one row on the tab. **A link made only by hint is not counted** (`countsOnGoal`): an
operation that looks like the goal's area is a reason to look, not a claim the work caused the error,
so a link whose every `how` is `route-hint` is left out (`countsOnGoal`: some `how` that is not
`route-hint`). A link with `goalRef: null` carries no `how` and is counted on no goal — not on any of its `tied` goals either, since a tie is exactly the evidence not choosing. It fetches only where `CockpitConfig.appErrors` is
true, so a deployment that reads no errors pays nothing on every goal page.

## Not yet built

Each removes its line here when it lands:

- **Model triage on a press** — the bug-investigation flow ([38](38-bug-investigation.md)) with the
  trace attached, for a group the [deterministic link](#linking-a-group-to-work) leaves without a goal.
  Today Investigate files the bug and sets the investigate label, and the investigator starts from
  the ticket alone.
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
