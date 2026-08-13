# 16 — HTTP and WebSocket API

`src/server/app.ts` builds the Fastify instance; `src/server/hub.ts` fans events out to sockets. The
server listens on `config.host:<port>`, defaulting to **loopback** (`127.0.0.1`), and every `/api/*`
route and the `/ws` socket require a **bearer token** — see [Authentication](#authentication) below.
The MCP tool channel still uses a Unix socket rather than a second HTTP surface: a socket with 0600
file permissions is a stronger boundary than a token for a channel with fleet-wide write access to
the store, and it needs no credential in an agent's argv.

Rate limiting is registered with `global: false`: only routes that opt in are limited, so the
cockpit's frequent state polling is never throttled.

## Shape

`app.ts` is **wiring and nothing else**: the auth hook, the error handler, the `/ws` socket, the
static SPA, and a list of route modules it mounts in order. Everything else lives beside the thing it
is about.

| Module                  | Holds                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `routes/state.ts`       | `/api/state`, `/api/prompts`, `/api/config`, `/api/ci-policy`, `/api/health`                |
| `routes/agents.ts`      | One agent's transcript, and respond / kill / complete / interrupt                           |
| `routes/artifacts.ts`   | `/artifacts/:id` and `/attachments/:id`, their capability signers, and the path confinement |
| `routes/control.ts`     | `/api/pulse`, `/api/errors/clear`, `/api/control`, `/api/prs/:number/exclude`               |
| `routes/escalations.ts` | The whole "Needs you" inbox: escalations, proposals, recovery                               |
| `routes/findings.ts`    | Promote / file / dismiss                                                                    |
| `routes/humanTasks.ts`  | Work only a person can do: filing one, and the two ways it settles                          |
| `routes/issues.ts`      | Watch, conclusion, assay, delivered, shortfall, dismiss-run                                 |
| `routes/jobs.ts`        | `/api/jobs`, `/api/jobs/:id/cancel`, `/api/upnext/order`                                    |
| `routes/plans.ts`       | Replan, abandon, discuss, discuss/end                                                       |
| `routes/schedules.ts`   | Recurring blueprints: write, edit, run now, delete                                          |
| `routes/spend.ts`       | `/api/spend` — the breakdown behind the cost indicators                                     |
| `routes/readings.ts`    | `/api/retrospectives/:ref`, `/api/scratchpads/:ref`                                         |
| `routes/reliability.ts` | `/api/reliability` — run outcomes and CI health, the reading beside the spend one           |
| `routes/work.ts`        | The work graph and its ignore / file verdicts                                               |
| `stateSnapshot.ts`      | `buildStateSnapshot` and the readings it folds                                              |

Each module exports one `register(app, ctx)` — the `RouteModule` type in `routes/context.ts` — and
takes a `RouteContext` of `{system, hub, artifactKey, artifactSigner}`. It is the facade shape
`Store` has over `src/store/`, for the same reason: `buildApp` was a ~1,300-line closure holding all
44 routes, their 14 schemas and the state snapshot, with no natural stopping size (issue #237).

Two structural tests walk the **directory** rather than a filename, so a group added as a new module
is covered on the day it is written: `test/cockpitAuth.test.ts` reads the route table out of
`routes/` and requires a refusal from each, and `test/requestValidation.test.ts` asserts that no file
there reads a request itself.

A schema that encodes a **domain rule** rather than a request shape lives with the rule, not with the
route: `ShortfallBody` is in `src/delivery/shortfall.ts` beside `SHORTFALL_CAUSES` and
`shortfallArm`, which routes on the same fact its cross-field refinement checks.

## Authentication

`src/server/auth.ts` holds the whole decision as one pure function, `authorizeRequest`, with a
Fastify `onRequest` hook as a thin adapter. Three layers:

1. **Loopback binding.** `config.host` defaults to `127.0.0.1`. Binding a routable address with
   `auth.enabled: false` is refused at config load — the pair publishes an endpoint that spawns
   agents with write access to the repo.
2. **A bearer token.** `Authorization: Bearer <token>` on every `/api/*` request; `?t=<token>` on the
   `/ws` upgrade, because browsers cannot set headers on a WebSocket. The token is 32 CSPRNG bytes,
   base64url, taken from `LUBBDUBB_TOKEN` or minted into `auth.tokenFile` (0600, reused across
   restarts). It is **never** a config-file key and never a cookie — the cockpit holds it in
   `localStorage` and attaches it by hand, which is what makes the surface CSRF-proof by
   construction rather than by a second token.
3. **Host and Origin checks.** When bound to loopback, a non-loopback `Host` is refused (DNS
   rebinding). A present `Origin` that is not loopback is refused whatever it is; an absent one is
   fine, since no non-browser client sends it. Any loopback origin passes, so the Vite dev proxy on
   another port keeps working.

Origin and host are answered **before** the token, so a leaked credential never turns a rebinding
attempt back into a way in. The refusal is `403` for those two and `401` for the token.

**Refusals are throttled**, at 20 per source per minute, after which that source gets `429` without
its credential being read at all. Only refusals count — a successful request never does, so the
cockpit's continuous `/api/state` polling can't throttle itself, which is the same concern that makes
rate limiting `global: false`. This is not what makes the token unguessable (256 bits already does,
and no feasible number of attempts changes that); it bounds the cost of someone hammering the port.
Once tripped it is indiscriminate — a valid token from a source that has just been guessing waits out
the window too. The counter lives in the hook, not in `authorizeRequest`, which takes the answer as a
`throttled` boolean so the verdict stays a pure function of its inputs.

The guard matches a **path prefix**, so a route added later is protected without opting in;
`test/cockpitAuth.test.ts` asserts this by walking the route table out of `src/server/routes/` and
requiring a 401 from each. The SPA shell and its assets are deliberately unguarded: the token
arrives in a URL fragment the browser never sends, so the page has to load before it can
authenticate, and it holds no world state of its own.

**The first refusal of a run is recorded; the rest need `LUBBDUBB_DEBUG`.** A refusal that says
nothing is indistinguishable, server-side, between a wrong token and a client sending none at all —
and the second is the common one, because `web/dist` is gitignored, so a bundle built before the
token guard existed attaches no header and no `?t=` and keeps doing so through every restart and hard
refresh. So the entry names the path, the **channel** the credential arrived on (`bearer` / `query` /
`malformed` / `none`) and the `Host`/`Origin`, never the credential itself; `credential=none` also
carries the rebuild hint, and nothing else does — a refusal that did carry a token is a token
problem, and pointing its operator at the bundle would send them where the fault is not. Only the
first is recorded because a locked-out cockpit polls, which would bury it under copies of itself.
The channel comes from the same `presentedToken` the verdict used, so the line cannot contradict the
decision beside it, and it is `JSON.stringify`d before logging because every field in it is an
attacker-controlled header — a newline in an `Origin` would otherwise forge a second, fake log line.

A refused **upgrade** is answered with `Connection: close` and its socket destroyed. Without that the
connection belongs to neither side's bookkeeping and `app.close()` waits on it forever, so anyone
probing `/ws` would stop the harness shutting down.

`auth.enabled: false` removes all of it. That is how the test suite drives the routes, and it is a
supported local choice — but only while bound to loopback.

An unanticipated throw in any route is caught by `setErrorHandler`, recorded to the error log (which
mirrors it to stderr and streams it to the cockpit), and returned as a plain `500 {error}`.

## Request validation

Every route reads its path params and its body through a **zod schema**. A handler does not read the
request at all: it is **wrapped in `checked(schemas, handler)`** (`src/server/validation.ts`) and
handed `{params, body, req, reply}` already parsed. `checked` is the only caller of `readRequest` and
the only place a refusal becomes a `400`.

That is the shape and not an implementation detail. `req.params as { number: string }` is a claim
about data the server does not control, and the hand-written checks that used to follow one were
written per route, so what a route validated was whatever its author remembered. Removing the
assertions left 36 verbatim copies of `if (!input.ok) return reply.code(400).send({error})` — every
one correct, and nothing but a source grep saying the 37th had to be (issue #237). A handler that is
_handed_ checked values has no raw request to assert about and no check to skip.
`test/requestValidation.test.ts` asserts both structurally, over every file in `src/server/routes/`.
(`req.query` is out of scope on both of its sites — each asserts the value to `unknown` and tests its
type before use, so the assertion claims nothing.)

Four properties hold across the surface:

- **A refusal is a value, never a throw.** `setErrorHandler` means "an unanticipated throw" and
  records every one to the error log; a malformed request is neither unanticipated nor the harness's
  fault, so routing it there would bury real faults under other people's typos. `readRequest` returns
  `{ok: false, error}` and `checked` sends it as a `400 {error}`.
- **Every field states its own refusal in full** — `cap must be a number`, `invalid issue number` —
  because the 400 body joins the schema's messages and drops their field paths. A field declared
  without a message refuses with zod's stock text, which names nothing.
- **Params are read before the body**, so a request naming no such item is refused for that whatever
  else its body got wrong. Where a route answers 404/409 off the store first (`/api/findings/:id/*`,
  `/api/work/:ref/file`), it reads the params, asks the store, and reads the body after — a finding
  that does not exist is a 404 whatever the body says. Those three apply `checked` **a second time,
  by hand**, inside the outer handler (`return checked({body: X}, inner)(req, reply)`) rather than
  reaching past it, so the ordering costs nothing in refusal paths.
- **A missing body is read as `{}`**, so a route whose fields are all optional may be called with no
  body at all, while a required field still refuses by name.

The shared shapes are `IssueNumberParams` / `PrNumberParams` (a `:number` path segment parsed with
the same `Number` + `Number.isInteger` pair the seven hand-written copies used, so no path the old
check accepted is now refused), `IdParams`, `RefParams`, `TicketTitleBody`, `requiredBoolean` and
`optionalText`.
Optional text — a note, a summary, an operator's reworded title — is **trimmed, with blank read as
absent**, which every route taking one already did before falling back to its own default.

One tightening came with it: a **non-string** where text is expected is now a `400` naming the field,
where several routes tested `typeof x === 'string'` inline and silently fell back to the default.
Silently ignoring a field the caller clearly meant to set is the failure this is about.

## Routes

### `GET /api/state`

The whole cockpit snapshot. See below.

**The world in it is `Store.getWorldBaseline()` — the reading the last pulse persisted — never a fresh
`connector.getState()`.** That call is a provider fan-out (for `azure`, `2 + 3N` REST calls for `N` open
PRs), and the cockpit refetches this route on every `dirty`, one of which rides _every file an agent
writes_: reading the provider here made the request rate a function of agent tool-call volume and of how
many cockpit tabs were open. The pulse is the only provider reader. Two properties make it sound: the
baseline is written **before** the dispatch world is filtered, so it is the unfiltered world and an
`-ignore`d PR stays visible here with its health; and the reading's age is shipped as
`worldObservedAt` rather than implied, the same way `world_read` hands an agent an `observedAt`.

Before the first cycle there is no baseline, and the route ships an **empty** world with
`worldObservedAt: null` rather than falling back to a live fetch — a fallback re-arms the failure loop
this removes (boot while the provider throttles → the boot cycle fails → no baseline → every `dirty`
refetches → each fan-out fails → recording the error broadcasts another `dirty`, unbounded).

### `GET /api/health`

`{ ok: true, dispatcher }`.

### `GET /api/agents/:id/transcript`

`{ agentId, transcript }`. 404 when the agent is unknown.

### `GET /artifacts/:id`

Serves a local artifact an agent flagged, **addressed by flag id**. Rate-limited to 120/minute.
Confined, sandboxed and content-typed — see [12](12-artifacts-and-files.md). 404 for an unknown flag,
a missing agent or a path that escapes confinement; 400 for a URL ref (the cockpit links those
directly).

**It is deliberately outside the `/api` prefix**, so the prefix guard below does not apply to it, and
it authorizes itself with a per-flag capability instead. Opening a chip is a browser navigation,
which cannot carry the bearer token — see
[12](12-artifacts-and-files.md#the-route-lives-outside-api-and-authorizes-itself-issue-129) for why
the exception is a separate route rather than a hole in the guard.

### `GET /attachments/:id`

Serves an image an operator attached to a blueprint (issue #249), **addressed by attachment id**.
Rate-limited to 240/minute. 404 for an unknown id, or for a stored path that no longer resolves inside
`attachmentRoot`. Responds with the **sniffed** mime, `x-content-type-options: nosniff`, a `sandbox`
CSP, and `cache-control: private, max-age=300, immutable` — an attachment's bytes never change and its
id is minted with them.

**Outside the `/api` prefix, for the artifact route's reason and one more.** The cockpit loads these
as `<img src>`, a subresource fetch the browser makes on its own; it can no more carry the bearer
token than a navigation can. So it authorizes itself with the same per-run key the artifact
capability uses, signed over `attachment:<id>` — namespaced so a capability for a flag cannot open an
attachment. `/api/state` mints one URL per attachment into `attachmentUrls`; with auth off nothing is
minted and the bare path is the whole URL.

The expiry is **bucketed** rather than `now + ttl`, unlike an artifact's. An artifact URL is minted for
a click that may never come; a thumbnail is an `<img src>` the browser is loading now, and a URL that
changed on every state poll could never be cached — the image would be re-fetched every few seconds.
Bucketing makes the string identical across the polls inside one bucket, at the cost of a capability
living between one and two buckets instead of exactly one.

The path served comes from the **stored row**, never from the request, and is re-confined to
`attachmentRoot` before it is read — the belt-and-braces the artifact route applies to a flag's ref.

### `POST /api/pulse`

Runs a cycle. `{ ok: true, report }`.

### `POST /api/errors/clear`

Deletes the whole error log and returns `{ ok: true, cleared }` — how many rows went. Broadcasts a
coarse `dirty`, so a second cockpit watching stops showing rows that are gone rather than holding
them until its next poll. Idempotent (`cleared: 0` on an empty log), and it stops nothing: a fault
recorded after a clear lands as usual.

All of it, never a slice. "Clear the faults I can see" is a different sentence on a list the snapshot
truncates at 100, and two cockpits would disagree about which those were. It is a **delete**, not an
acknowledged-up-to watermark, because nothing in the harness reads `error_events` back — the log is a
list an operator reads and clears, so the only thing a clear can lose is a row nobody had read.

A `POST` rather than a `DELETE`: the auth hook and the structural route-table test that walks it both
key on the `/api` prefix, and one verb for one meaning on this surface is worth more than matching
HTTP's.

**Rate-limited to 60/minute**, for the reason the artifact and `/api/work` routes are and `/api/state`
is not: it writes the store on demand rather than on the cockpit's poll, and a delete over a table with
no bound on its row count is unbounded work behind a fixed-size request. One deliberate two-step click
never approaches the ceiling.

### `POST /api/control`

Body `{cap?, paused?}`. `cap` must be a number and `paused` a boolean, else 400. Applies via
`RuntimeControl.apply`, which additionally rejects a `cap` that is not a non-negative integer (400,
state untouched). On success it broadcasts `control:changed` so every open cockpit updates without a
refetch, and returns `{ ok: true, cap, paused }`.

Changes are **in-memory and ephemeral**; a restart reverts to `maxConcurrentAgents` / `startPaused`.

### `POST /api/prs/:number/exclude`

Body `{excluded: boolean}`. Adds or removes the `${labelPrefix}-ignore` label through the provider,
broadcasts `world:changed`, and runs a cycle so a now-included PR is picked up (or a now-excluded one
dropped). 400 on a non-integer PR number, a non-boolean `excluded`, or a provider failure.

### `POST /api/issues/:number/watch`

Body `{watched: boolean}`. Writes the **pair** — sets `${prefix}-watch` to `watched` and
`${prefix}-ignore` to `!watched` — so the two labels stay mutually exclusive. Broadcasts and runs a
cycle. Same 400s.

### `POST /api/issues/:number/conclusion`

Body `{verdict: 'done' | 'more_work' | null, note?: string}`. The operator's override of whether an
issue is finished — it wins over the agent's declaration and over the plan derivation (see
[06](06-issue-pickup.md#concluding-an-issue)). `null` **clears** the row, returning the issue to
whatever its plan derives or to `undeclared`.

It writes the harness's own record and **does not touch the tracker**: concluding an issue here is
what stops the re-pickup, while moving the work item to a done state stays a human act. Broadcasts
`world:changed`, and runs a cycle only for `more_work`, so an operator's "there's more here" bounces
the item back to pickup immediately rather than on the next heartbeat. 400 on a non-integer issue
number or a verdict that is not one of the three.

### `POST /api/issues/:number/delivered`

Body `{delivered: boolean, summary?: string}`. The operator's arm of the delivery verdict — the
harness's own park, which gates pickup and nothing else (see
[06](06-issue-pickup.md)). `false` **clears** the row, which is a delete so that "no verdict" has
exactly one representation. Like the conclusion route it writes the harness's own record and **never
touches the tracker**: `closed` stays the human's.

### `POST /api/issues/:number/shortfall`

Body `{cause: 'plan'|'part'|'goal'|null, part?: string, summary?: string}`. The operator's arm of the
assessor's _negative_ verdict — the issue was worked and its goal is still not reached — and, more
importantly, the escape hatch it has to have. `cause: null` **clears** the row (a delete, so "nothing
fell short" has one representation); anything else records one, which clears any standing delivery in
the store. `cause: 'part'` requires the part slug in `part`. 400 on a non-integer issue number, an
unrecognised cause, or a `part` cause with no slug.

The body's schema is `ShortfallBody` in **`src/delivery/shortfall.ts`**, not in the route: an
**absent** `cause` and an explicit **null** are the same value in JSON and opposite acts, and the
cross-field rule is the same fact `shortfallArm` routes on. Both belong beside the rule they encode,
where the next person changing shortfall semantics is reading (issue #237).

The escape hatch matters here in a way it does not for the other two verdicts. A shortfall lives
until the arm it named has been performed, and **rejecting** rule `issue-shortfall`'s proposal deliberately leaves
it standing — the verdict is still true; you simply declined to act on it. Without this route the row
and its cockpit chip would stand for good, with no way to settle it short of marking the issue
delivered, which claims something different.

Unlike the delivery it gates nothing, so recording one never parks an issue; see
[06](06-issue-pickup.md#the-shortfall--the-same-verdicts-other-polarity).

### `POST /api/issues/:number/assay`

Body `{verdict: 'workable'|'unclear'|null, summary?: string}`. The operator's arm of the goal assay,
and the escape hatch a blocking gate has to have: `workable` releases an issue the assayer refused,
`unclear` parks one without waiting for an agent to agree, and `null` **clears** the row — a delete,
so "not assayed" has exactly one representation (which is also what a crashed assayer leaves, i.e.
the fail-open). An operator verdict is fingerprinted against the issue as the last world snapshot saw
it, so it expires on the next edit exactly as an agent's does; an issue absent from that snapshot is
a 404 rather than a guess, since a verdict fingerprinted against an empty goal would be a silent
no-op dressed as an override. 400 on a non-integer issue number or an unrecognised verdict.

### `POST /api/issues/:number/bug`

Body `{summary: string, title?: string}`. The operator ran the thing and it does not do what they
expect — **raise a bug**. The one route on this surface that files into the _tracker_ rather than
writing the harness's own record, and the only one carrying a fact no agent can derive, since none of
them ran the feature.

- **The story's verdict is untouched.** The bug is its own work item and carries the work; the story
  keeps whatever it had. That split is what puts the operator's actual words in front of the fleet as
  the goal — a `more_work` written here instead would re-open the story with a brief carrying none of
  them (see [06](06-issue-pickup.md)).
- **`summary` is required**, where every other body on this surface takes an optional one. Elsewhere
  the operator has the row in front of them and a default says who decided; here their report _is_ the
  feature, so an empty one asks for nothing. Trimmed, capped at 4000 characters, **400** outside that.
- **Refusals in order:** **404** when the issue is absent from the last world snapshot (the `assay`
  route's check, for its reason), then **409** when no tracker is configured to file into, then the
  body's 400. The cockpit hides the button off the same `canFileTickets` flag, so a 409 means a direct
  call.
- **It queues a desk job and nothing more.** The `raise-bug` template is rendered with the report
  verbatim and the tracker coordinates, a `desk` job is created, an `issue_bug_filings` row opens at
  `filing`, and a manual cycle runs so the report reaches the fleet now rather than on the next
  heartbeat. The bug exists only once that job's agent has created it and called `link_ticket`
  ([11](11-mcp-tools.md#link_ticket)).
- **Repeatable.** The filing row is keyed on the job, so a story can carry several bugs — it can be
  wrong in more than one way, and each is its own bug ([14](14-persistence.md)).

### `POST /api/issues/:number/dismiss-run`

End the harness's run at a goal (issues #203, #234). A run is otherwise retained — minted while the
issue is still live, and drawn _and acted on_ even once the tracker has forgotten the issue — so this
is the **one** thing that ends it. No body. Since #234 it is terminal for the dispatcher as well as
for the card: a dismissed run is not unioned back into the issue list, so nothing further is
scheduled for the goal, which is what makes this the way to abandon one. How it ended is stamped from
the row — `judged` if the harness had judged the work, `abandoned` if it had not — so the outcome is
never claimed beyond the evidence. The write is one-way and idempotent: dismissing a goal with no run,
or one already dismissed, is a **409** rather than an error state, and the dismissal persists across a
restart. The report itself is untouched — the row is the run, not the write-up. 400 on a non-integer
issue number.

### `GET /api/work`

The durable work graph's roots — every node with no parent — plus `unrecorded`: work the harness did
that nothing in the tracker accounts for. Rate-limited rather than polled; the cockpit's Work panel
fetches it on open, because `/api/state` comes round every couple of seconds and the graph only ever
grows. Returns `{ roots, unrecorded, refUrls }`. Each unrecorded entry carries `ignored` — an item the
operator cleared is still reported, because the panel is what hides it and a row filtered out at the
source has no title left to offer back under the un-ignore. `refUrls` keys the root and unrecorded-item
refs the panel draws, resolved through the connector's own `resolveRefUrl` for the same reason the
subtree route does (#199): this route ships no snapshot, and a PR the graph remembers merging left the
world hours ago.

### `GET /api/work/:ref`

One subtree, walked from the given root by `parent_ref`. 404 when the ref names no node. Refs carry
colons (`issue:12`, `pr:41:ci`), so the route has to survive one in a path segment. Each node's URL is
resolved through the connector's own `resolveRefUrl` rather than read off the snapshot's `refUrls` —
that map is built from the world, and a PR the graph remembers merging left the world hours ago.
Returns `{ nodes, refUrls }`.

### `GET /api/retrospectives/:ref`

One goal's write-up in full, by `issue:<n>` ref. Fetched when a reader opens it rather than shipped
on `/api/state`, which is polled continuously — a document per issue would be paid for on every poll
by every open cockpit; the snapshot carries the summary and `hasDocument`, which is all the Manifest
station needs to draw itself. Returns `{ retrospective }`, and `null` rather than a 404 for a goal
nobody wrote up: "no retrospective" is an ordinary answer here, not a missing resource.

### `GET /api/spend`

The breakdown behind the cost indicators: the same money split by phase, by goal and over a
fortnight, plus the coverage caveat. Returns `{ insights }` — see
[18](18-observability.md#the-spend-breakdown) for what each split means and why the phases are a
partition.

Fetched on open for `/api/work`'s reason: it reads **every agent the harness has ever run** and every
dated cost delta of the last fourteen days, where `/api/state` comes round every couple of seconds for
every open cockpit. What the indicators themselves need — the rolling windows, and each goal's own
total — is already on the snapshot and costs nothing.

Derived on the server rather than in the browser, and not only because the timeline needs the store.
The per-goal totals are `rollUpIssueSpend`'s own, taken whole: the panel and the goal card state the
same figure inches apart in the cockpit, so a cockpit-side re-derivation would be a second opinion
about which goal a pull request's money belongs to. Read-only, and it takes no parameters — the
windows it reports are the same two `buildUsage` puts on the snapshot, asked the same way, so the
panel and the chip it opens from cannot disagree.

### `GET /api/reliability`

What the spending bought: run outcomes all-time and CI health over the last fortnight. Returns
`{ insights }` — see [18](18-observability.md#the-reliability-breakdown) for what each half means,
why the two windows differ, and why `killed` is not counted as a failure.

Fetched on open for `/api/spend`'s reason and at the same cost: it walks every agent the harness has
ever run, plus a fortnight of `pr_ci` transitions. What the **Yield gauge** needs to draw is already
on the snapshot as `runOutcomes`, folded by the same `tallyRunOutcomes` this route opens with, so the
gauge and the panel cannot disagree.

Both windows are resolved in the handler rather than inside the fold, so the `since` a row is
selected by and the `since` it is bucketed into are one value: a store read wider than the buckets
drops rows silently at the fold, and a narrower one draws an empty first day that was never empty.
Read-only, and it takes no parameters.

### `GET /api/scratchpads/:ref`

One goal's shared scratchpad in full — every entry every agent on it left, oldest first. Fetched on
open for the reason the write-up above is, with more force: a pad is unbounded prose from every agent
on the goal, where a retrospective is one document. The snapshot carries `issue.scratchpad`
(`{entries, updatedAt}`, and `null` when nothing has been written), which is all a way in needs to
draw itself.

Until this route existed the pad was readable only _by an agent_ (`scratch_read`) and quotable only by
the retrospective that was handed it — so the account of a run was checkable against nothing, and an
operator watching a goal go wrong could not read the reasoning as it was written.

The ref is resolved through the **same `padOriginFor`** an agent's write goes through, so any origin
on the goal (`issue:12:part:schema`, `issue:12:plan`) names the one pad and the cockpit cannot
disagree with the tool channel about which pad a ref means. Returns `{padRef, entries}`. An untouched
pad is an empty list — an ordinary answer — while a ref inside no issue at all (`pr:42`) is a **400**:
"nobody has written here" and "that is not a pad" are different answers, and only the first is
silence.

### `POST /api/work/:ref/file`

Ask an agent to create a tracker item for unrecorded work. The mirror of
`POST /api/findings/:id/file`, and an **operator click** for that route's reason: creating tracker
items on the harness's own initiative would be a new outbound capability on the world, and the
condition would be permanent until acted on, so a throttle would only set the rate at which a backlog
fills.

404 when the ref names no node; 409 when a filing already stands for it (naming whether one is in
flight or already filed); 409 when the node is not unrecorded work; 409 when no tracker is configured,
the same `config.canFileTickets` predicate the cockpit hides the button on. The not-unrecorded check is
asked of the very predicate the panel draws from, so the route can never refuse what the button
offered, and it is asked **before** the tracker check, so a deployment with nowhere to file still gives
the honest answer about a node that was never eligible.

Body may override `title`. Renders the `work-item-ticket` prompt template, creates a **desk** job —
filing touches no repository, and it is also what stops this recursing, since a desk job is never
itself unrecorded work — then opens the filing row, broadcasts and runs a cycle. Returns
`{ ok: true, filing, job, report }`. The node is parented to the new item only once the filing agent
reports it through `link_ticket`, and then by the **fold**, not by the tool — see
[11](11-mcp-tools.md) and [14](14-persistence.md#work-item-filings).

### `POST /api/work/:ref/ignore`, `DELETE /api/work/:ref/ignore`

The other verdict on the same row: **no** tracker item is wanted for this work. 404 when the ref names
no node; otherwise idempotent — the refusal of a second click lives in the write, `target_ref` being the
primary key. The `DELETE` undoes it and is silent when nothing stood, so "not ignored" has exactly one
representation.

A standing ignore makes `POST /api/work/:ref/file` **409**, asked of the same predicate the panel draws
from, so the route cannot file a ticket for work the operator has dismissed. It is a table of its own
rather than a third `work_item_filings` status because that row's `job_id` is `NOT NULL` — a filing is
an agent doing something, and an ignore is the operator saying nothing should be.

### `GET /api/prompts`

The rule dispatcher's prompt book: `{ dir, dispatcher, templates }`, where each template carries its
id, doc, declared placeholders, **effective** text (the override where one exists) and `overridden`.
`dir` is `promptTemplatesDir` — the path an operator would drop `<id>.md` into — which is what makes a
read-only view actionable.

Fetched on open rather than shipped on `/api/state`, the inverse of `/api/work`'s reason: the graph is
fetched because it only ever grows, this because it never changes at all — the override directory is
read once at boot, so re-sending the book every couple of seconds would be paying for a constant.

**Read-only.** Overriding stays a file drop: a write route would have to answer "when does this take
effect", and the honest answer is "at the next restart".

### `GET /api/config`

The configuration this process resolved at boot, for the cockpit's settings modal
([17](17-cockpit.md)): `{ groups }`, each group a titled list of `{path, value, isDefault}` entries —
dotted paths into the config object, with nested blocks expanded to leaves so one overridden member
of `planning` does not make the other three read as chosen.

`isDefault` is computed here rather than in the browser, against `defaultConfig()` — the built-in
defaults put through the **same path resolution** `loadConfig` applies. That indirection is the whole
point of the function: `repoRoot`, `worktreeRoot`, `deskRoot` and `promptTemplatesDir` are resolved
to absolute paths after merging, so comparing against the raw literals would report four of the
most-read keys as operator-chosen on every deployment — a viewer whose job is to say what you changed
getting it wrong in the same four places every time. `test/runningConfig.test.ts` asserts a config
that configures nothing reports nothing as configured.

Keys with an `undefined` value are omitted entirely (an unset optional is not a configured value),
arrays and label→weight maps are shipped whole (their shape is the thing worth reading, and expanding
them would key rows on an array index), and a top-level key naming no group falls into **Other**
rather than vanishing — the grouping is a display hint, never a filter, so a config field added later
is visible on the day it is written.

Fetched on open and **read-only**, both for `GET /api/prompts`' reasons. Nothing is redacted: `Config`
holds no secrets by construction ([02](02-configuration.md)).

### `GET /api/ci-policy`

The **effective** per-check CI policy, for the settings modal's CI tab ([17](17-cockpit.md)):
`{ policy: { rules, unmatched, policyKinds } }`, from `describeCiPolicy` in `src/ci/describeCiPolicy.ts`.

Its own route rather than another group on `/api/config` because it is a _derivation_ and not a
reading. `ci.checks` is already on that payload — as a raw JSON leaf, because `flatten` treats an
array as one. What the array does not say is everything that matters: each rule ships its
**effective** `onFailure` (`rule.onFailure ?? 'ignore'`) with `inherited` marking the ones that got it
by omission, its **effective** `states` (`ruleStates(rule)`, i.e. `['failing']` when the rule names
none) with `statesInherited` doing the same job, and `unmatched` states the constant
`classifyCiFailures` applies to a failing check no rule claims — `dispatch`. All are decided in
[07](07-pull-requests.md) and none is visible by reading the config file, which is what made a
mis-scoped glob invisible until a PR behaved oddly.

`policyKinds` is the Azure branch-policy kind → effective mode map read back through
`policyCheckMode`, each entry marked default-or-chosen. **Null when `integrations.sourceControl` is
not `azure`**: under any other provider these modes are consulted by nothing, and a table of defaults
nothing reads is a worse answer than no table.

Derived on the server for `isDefault`'s reason on `/api/config`: the web bundle imports no server code,
so a cockpit-side derivation would be a second copy of these defaults, free to drift from the rule
that consults them with nothing to catch it. `test/ciPolicy.test.ts` covers the empty policy, the
inherited `ignore`, a partial `policyChecks` map merging over the defaults, and Azure absent.

Fetched on open and **read-only**, both for `GET /api/prompts`' reasons. There is no config-write path
in the harness, and inventing one for this is a larger decision than making the policy visible.

### Launching a blueprint

#### `POST /api/jobs`

Queue an operator job. See [13](13-jobs-and-findings.md). 400 on a missing/empty prompt, a bad `kind`,
a non-string `title` or `branch`; **409** when a code job names a branch a live task holds. Returns
`{ ok: true, job, report }`. A **code** job with a tracker configured is a _blueprint_: it is filed as
a watched ticket (a desk job + a `WorkItemFiling`) that enters the planning funnel, and returns
`{ ok: true, job, filing, report }` with `job.kind === 'desk'` — the branch-collision 409 applies only
to the direct-dispatch arm (a desk job, or a code job with no tracker).

**Attachments (issue #249).** The body may carry `attachments: {name?, data}[]` — images the operator
pasted, dropped or picked in the composer, `data` base64 of the raw file.

- **Base64 in the existing JSON body, not `@fastify/multipart`.** A second request-parsing style would
  mean a route that reads the request directly, which this surface's one rule forbids, plus a new
  dependency; a third on the wire for a payload measured in single-digit megabytes is the cheaper
  trade.
- **A per-route `bodyLimit`** (`ATTACHMENT_BODY_LIMIT`, 32 MiB) replaces fastify's 1 MB default on
  this route **only**. A body over it is fastify's own **413**, before validation runs. This route
  already sits behind the bearer-token guard.
- **There is no `mime` field.** A client-declared type is attacker-controlled; the type stored — and
  the type an agent is told to trust — is sniffed from the decoded bytes.
- **Bounds** are `src/jobs/attachments.ts`, and only there: at most **4** images, **5 MB** each
  decoded, and **png / jpeg / gif / webp** decided by magic bytes. Each failure is a **400** naming the
  file (by the operator's own label) and the bound it broke, and **no job row is created** — validation
  runs before `createJob`, because a blueprint that says "make it look like this" without the "this" is
  worse than no blueprint.
- **The filename is never used as a path.** Files are stored `<index>.<ext>` from the sniffed format
  under `attachmentRoot`, which removes traversal as a category rather than sanitising it; the
  operator's name is kept as a display label. See [14](14-persistence.md#blueprint-attachments) and
  [09](09-execution.md#an-operators-attachments-reach-the-agent).
- The images follow **whichever job row this launch creates** — the blueprint itself, or the desk
  filing job the tracker fork turns it into — and change hands to `issue:<n>` when that filing agent
  calls `link_ticket`, which is what keeps them in front of the whole planning funnel. See
  [14](14-persistence.md#blueprint-attachments).

### `POST /api/upnext/order`

Re-order the "Up next" queue (issue #128). Body `{origins: string[]}` — the operator's desired
priority order of candidate origins. **400** when `origins` is not an array of strings, or contains a
duplicate. Replaces the whole override set (ranked `0..n-1`), broadcasts `world:changed`, and runs a
cycle so the new order takes effect immediately. It only re-orders — it never un-holds a held item,
and `manual-job` items stay first regardless — so this is safe to run inline. Returns `{ ok: true, report }`.

#### `POST /api/jobs/:id/cancel`

409 when the job is absent or no longer queued. Returns `{ ok: true, job }`. Any attachments are
dropped with it — rows first, then the files — the one deletion in the attachment story, since nothing
downstream can want a blueprint that never ran.

### Schedules

Recurring blueprints — the prompt an operator wants queued on a clock. See
[13](13-jobs-and-findings.md#schedules). **Nothing here dispatches**: a firing writes the same `jobs`
row `POST /api/jobs` writes, which rule `manual-job` then drains under the cap and the pause flag
like any other, so these four routes add a way for work to arrive and no way for it to be run.

#### `POST /api/schedules`

Body `{cron, prompt, title?, kind?}`. **400** on a missing/empty `cron` or `prompt`, a bad `kind`, or
an expression the parser refuses — and the refusal is the **parser's own sentence**, naming the field
and what that field accepts, because it is read by whoever just mistyped it and a second wording here
would be a worse one written further from the syntax. The title falls back to the prompt's first line
through `deriveJobTitle`, the same derivation the launch route uses. Created **enabled**, with
`nextRunAt` computed from the clock. No cycle is run: the first firing is due at a time that is by
construction still in the future. Returns `{ ok: true, schedule }`.

#### `POST /api/schedules/:id`

Every field optional (`{cron?, prompt?, title?, kind?, enabled?}`), so the pause toggle and a
reworded prompt are one route. **404** when absent, **400** on a refused expression — checked before
anything is written. `nextRunAt` is **recomputed from now** when the cron changed or the enabled flag
moved, and cleared when it is paused; an edit that only rewords leaves the recurrence exactly where
it was. Returns `{ ok: true, schedule }`.

#### `POST /api/schedules/:id/run`

Fire one now. **404** when absent. It ignores both gates the pulse applies on the operator's behalf —
a paused schedule still runs, and a previous firing still in flight does not hold it — because those
exist to stop agents stacking up unattended, which a click is not. It does **not** move `nextRunAt`:
running early is not a change of cadence. Broadcasts `world:changed` and runs a cycle, the launch
route's reason. Returns `{ ok: true, job, report }`.

#### `DELETE /api/schedules/:id`

**404** when absent. The jobs it queued are untouched — they are its history, and they are ordinary
jobs whether or not the intention behind them still stands. Returns `{ ok: true }`.

### `POST /api/findings/:id/promote`

404 when absent, 409 when not `open`, 400 on a bad `kind`. Body may override `title`, `prompt` and
`kind`. Creates the job, then resolves the finding, broadcasts, and runs a cycle. Returns
`{ ok: true, finding, job, report }`.

### `POST /api/findings/:id/file`

The defer arm. 404 when absent, 409 when not `open`, and 409 when no tracker is configured to file
into (the `issues` provider is `fake` or its config block is missing — the same predicate the snapshot
ships as `config.canFileTickets`, so the cockpit hides the button rather than offering a click that
cannot work). Body may override `title`. Renders the `finding-ticket` prompt template, creates a
**desk** job, then resolves the finding to `filing` with the job id, broadcasts and runs a cycle.
Returns `{ ok: true, finding, job, report }`. The finding reaches `filed` only when the filing agent
reports the ticket through `link_ticket` — see [11](11-mcp-tools.md).

### `POST /api/findings/:id/dismiss`

409 when absent or already resolved. Returns `{ ok: true, finding }`.

### `POST /api/human-tasks`

Body `{title, detail?, originRef?}`. The operator's own arm beside the `request_human_task` tool; the
row is the same one with no agent behind it, which is exactly what a null `agentId` means. Validated
through the **same** pure `validateHumanTask` the tool uses — a one-line title is a property of the
panel row, not of who typed it — so a newline or an over-long title is a 400 naming `detail` as where
the rest belongs. Broadcasts `dirty`. Returns `{ ok: true, humanTask }`.

### `POST /api/human-tasks/:id/done`

Body `{note?}`. 409 when the task is absent or already settled — compare-and-set against `open` in the
write, so a second click cannot overwrite the first verdict. When the task backs a plan part, the task
is settled **first** and `Store.concludeHumanPart` second (a failed part write then leaves a settled
task an operator can see, where the other order would leave a concluded part nothing accounts for),
and a cycle is run so the dependents it releases are dispatchable immediately. Returns
`{ ok: true, humanTask, part, report }`.

### `POST /api/human-tasks/:id/decline`

Body `{note}`, **required and non-empty**: a planner shown only "declined" has no reason to decide
differently to the way it just decided. 409 when absent or already settled. **The backing part is
deliberately not concluded** — that would release every dependent waiting on the thing that was
refused. The next pulse's reconciler blocks it with its own account of why; see
[08](08-planning.md#a-step-for-a-person). Returns `{ ok: true, humanTask, report }`.

### `POST /api/human-tasks/:id/dismiss`

No body. Clears a **settled** row off the bench: it is not a third verdict, so it takes no note,
concludes no part and runs no cycle — the status and the resolution are left exactly where they were.
**409 when the task is absent, still open, or already dismissed** — compare-and-set on both halves,
and the open arm is the guard that keeps this from being a quiet way to make an obligation go away.
The row is updated rather than deleted (the close-out sweep finds its own row by looking for it, so a
delete re-files the same obligation next pulse) and the snapshot keeps shipping it; the bench is what
stops drawing it. Broadcasts `dirty`, `dismissFinding`'s reason — nothing in the world moved. Returns
`{ ok: true, humanTask }`. → [13](13-jobs-and-findings.md#getting-it-off-the-bench--post-apihuman-tasksiddismiss)

### `POST /api/plans/:id/replan`

404 when the plan is unknown. Flips the plan to `planning`, **withdraws any pending plan proposal**
(the amended verdict is a new proposal, and the superseded card must not release a decomposition its
reader never saw), broadcasts, runs a cycle. **Tears nothing down** — see [08](08-planning.md).
Returns `{ ok: true, plan }`.

### `POST /api/plans/:id/abandon`

No body. 404 when the plan is unknown. **409 unless the plan is `active`, has live parts, and no part
has started** (`partHasWork`) — the guard is the point, since retiring a part with an agent, a branch
or a PR behind it would strand real work, and a plan with no parts is already being worked whole.
Retiring every live part **is** the collapse — the shape is the part list
([08](08-planning.md#shape-is-the-parts)) — so rule `issue-pickup` then works the issue as one pull
request. Broadcasts, runs a cycle. Returns `{ ok: true, detail, plan }`.

This is the way out of a decomposition approved onto an issue whose flat `issue/<n>` branch was
already taken: its parts block on the ref collision, and once released neither Reject (which settles
an `awaiting_approval` plan) nor Replan (which fails back to `parts`) can free it. A separate act
rather than a loosened `refusePlan` because it is a different sentence — see
[08](08-planning.md#when-the-collision-arrives-after-approval).

### `POST /api/plans/:id/discuss`

No body. 404 when the plan is unknown. **Discuss is a replan with a conversational planner** — same
mechanism as `/replan` (flips the plan to `planning`, withdraws any pending plan proposal for the same
reason), plus sets `plans.discussing`, which is the one thing that tells rule `issue-plan` to render the
`discuss-plan` template instead of `issue-replan`. Broadcasts, runs a cycle. See
[08](08-planning.md#discussing-a-plan). Returns `{ ok: true, plan }`.

### `POST /api/plans/:id/discuss/end`

No body. 404 when the plan is unknown. **409 when the plan is not currently being discussed**
(`plan.discussing` is false) — the same compare-and-set discipline `accept`/`reject` apply to
`awaiting_approval`, since an unguarded call would force any plan back to `awaiting_approval` on a
stale or duplicate request. Otherwise restores the plan to `awaiting_approval`, clears `discussing`,
broadcasts, runs a cycle — so the pending question is re-asked rather than left open on a
conversation that stopped. Does not touch the discussion agent itself. Returns `{ ok: true, plan }`.

### `POST /api/escalations/:id/answer`

Body `{response}` **or** `{answers}`, exactly one — a request carrying both is a 400, because which
text the agent would receive is ambiguous. `response` is the free-text answer to a single question.
`answers` is one entry per question of a questionnaire (`context.questions`, raised through
`escalate`), positional, `null` for the ones left blank; the server folds them into the single reply
the agent reads via `formatAnswers` in `src/escalation/questionnaire.ts`. **The fold is the server's,
not the cockpit's**: the wording an agent is answered in is a domain rule, and a second client must
not be able to phrase it its own way. An unanswered question is sent as an explicit non-answer rather
than omitted — an agent that asked three things and heard about two would sit waiting on the third.
The arm is a 400 when the item carries no questionnaire, when the array's length disagrees with it
(a client that disagrees about what was asked would put answers under the wrong questions), and when
every entry is blank.

400 when the response is missing, the escalation is unknown, or it is not `open`.
**409 when the item carries a pending proposal** (a merge, a drafted reply, or a plan's
decomposition): free text cannot be branched on, so answering here would settle the inbox item while
leaving the proposal pending. The error names the accept/reject routes that do settle it.
Returns `{ ok: true, escalation, routing }`, where `routing` is `typed_into_agent` (the escalation is
tied to a live agent, and the answer went straight into its session) or `queued_for_dispatch` (the
answer is recorded and the next cycle acts on it). **Also 409 when the item is a permission request**
(`context.permission`, issue #130) — the agent is blocked in a tool call, not at a prompt, so the
error names the permission route below. **Also 409 when the agent that asked it is awaiting a crash
recovery decision** — it is dead, so there is nothing to type into, and answering would settle a
question a `restore` is about to hand back to the same agent. The error names the recovery route.

### `POST /api/escalations/:id/dismiss`

Body `{note?}`. Clears an item without answering it, for when the thing was dealt with outside the
harness. The gap it closes: parking is only a _request_ — the `escalate` tool returns at once — so an
alert can outlive the situation that raised it, and before this the only way to empty it was to type a
message nobody wanted sent, least of all the agent that has to interpret it.

Offered on **every** item, which means the two kinds carrying a verdict cannot simply have their row
dropped: a permission request has an agent stopped inside a tool call, and a proposal has a rule held
off a PR. Each is routed to its own "no" instead, so dismissing means the same thing everywhere —
nothing goes out, nobody is left blocked. The arms, in order, mirroring the 409s on `/answer`:

| item                       | effect                                                | `dismissedAs`       |
| -------------------------- | ----------------------------------------------------- | ------------------- |
| carries a pending proposal | rejects it (`ProposalDesk.reject`, the note recorded) | `proposal_rejected` |
| a live permission request  | denies it, unblocking the agent                       | `permission_denied` |
| anything else              | marks it `dismissed`                                  | `cleared`           |

A cleared item records the reason in its own `context.dismissal` (no schema change) and in the
decision log under cycle id `human:<escalation id>`. **Nothing is typed into the agent** — that is the
point — but the agent's park latch _is_ released, which is load-bearing rather than tidy: while it is
held `AgentManager.handleWaiting` early-returns, so an agent whose alert was dismissed would otherwise
be unable to raise another one. 400 when the item is unknown or not `open`.

### `POST /api/escalations/:id/permission`

Body `{allow: boolean, note?}`. Allow or deny a permission request an agent is blocked on (issue #130).
Resolves the blocked `--permission-prompt-tool` call with the operator's verdict and settles the inbox
item; the same live agent then continues (allow) or reads the denial (deny). 400 when `allow` is not a
boolean; **409 when no pending permission request is attached** (already decided, or the agent died
first). Returns `{ ok: true, allowed }`.

### `POST /api/recovery/:taskId`

Body `{verdict}`, one of `restore` / `requeue` / `remove` — what happens to work the previous run
left orphaned. **Keyed on the task, not the agent**: a restart can orphan a task before its agent was
ever spawned, so the task is the only identity every candidate has (see [10](10-agent-runtimes.md#crash-recovery)). **While any of these is outstanding the
harness runs no cycles at all**, so this route is the only thing that can un-hold a booted-after-a-crash
harness; it therefore applies the verdict inline rather than emitting an action for a pulse that cannot
run to pick it up.

400 on an unknown verdict. **409 when the task is not awaiting a decision** (already decided, or never
a candidate), and **409 when the verdict cannot be applied** — a `restore` for work with no agent at all,
or for an agent with no session id, no worktree, or on a runtime that cannot resume. A refusal is not a decision: the item stays
pending, so `requeue` and `remove` are still available. Returns
`{ ok: true, verdict, agentId, taskId, detail, job?, remaining, report? }`, where `job` is the job a
`requeue` filed and `report` is the cycle run when `remaining` reaches 0.

### `POST /api/agents/:id/respond`

Body `{text}`. 400 when text is missing, 409 when the agent is not live. Types the text into the
session and flips it back to `running`.

### `POST /api/agents/:id/kill`

409 when the agent is not live. Marks the agent `killed` and its task `interrupted`; the agent is not
resumed on the next boot and its worktree is kept.

### `POST /api/agents/:id/interrupt`

409 when the agent is not live. Sends raw `\x03`. Mutates no status.

### Static SPA

When `web/dist` exists it is served statically, with a not-found handler that returns `index.html` for
anything that is not `/api` or `/ws` — so client-side routing works.

## The wire contract

Every shape these routes ship is declared once, in **`src/wire.ts`**, and both ends name that
declaration: `buildStateSnapshot` returns `CockpitState`, the fetched-on-open routes `satisfies` their
payload types, and `web/src/types.ts` re-exports the lot under the cockpit's own names (`AppState` is
`CockpitState`). So a key renamed, dropped or re-nested in the builder is a compile error at the site
that caused it.

It used to be two copies with nothing relating them. `buildStateSnapshot` had **no declared return
type**, so its shape was whatever TypeScript inferred from 439 lines of object construction; `AppState`
was a standalone hand-maintained mirror; and they met at one unchecked `json<AppState>(r)` assertion.
Rename a key and `typecheck`, `typecheck:web` and `knip` all stayed green — the panel rendered empty at
runtime and nowhere else. The tests were the visible symptom: several cast a real snapshot through
`unknown` to a locally re-declared shape, a third copy drifting independently of the other two.

Four properties hold it together:

- **Type-only, so the runtime constraint is untouched.** "The web bundle imports no server code" is
  about what gets bundled; `import type` is erased first. `test/wireContract.test.ts` asserts it
  structurally rather than trusting it: the shared modules must declare no runtime and import nothing
  by value, and `src/wire.ts` must be the **only** server module anything under `web/src/` names.
- **Domain types are reused, never re-declared.** A wire type either _is_ the server's type or
  `extends` it. The cockpit's copy previously widened the server's unions three different ways in one
  file — `Job.status` to `string`, `Proposal.action` to an index-signature bag, `Finding.status`
  re-declared member-by-member — with no rule for which. The widened ones lost the check exactly where
  the cockpit compares against a literal; the re-declared ones silently narrowed when a member was
  added server-side.
- **Every key is required unless the value is genuinely conditional.** The SPA is built from this tree,
  so there is one version of the wire and a missing key is a bug rather than deployment skew to
  tolerate. A key that may be _absent_ is optional; a key always sent but possibly empty is `| null`.
- **The open list and the closed list are different types.** `OpenPullRequest` requires `health`,
  `attention` and `ciVerdict`; `PullRequest` leaves them optional, because the recently-closed list
  carries none of them — nothing acts on a dead PR, so nothing folds a verdict for one.

Pinning the contract found three live cockpit bugs that had compiled for as long as they existed: the
presentation layer read `task.status === 'active'` (not a `TaskStatus`, so a running agent drew as
unstaffed), and the Production graph counted `outcome === 'ok'` and
`action.type === 'escalate'` — neither a value the harness emits, so the escalation series had always
read zero.

## The state snapshot

`buildStateSnapshot(system)` assembles everything the cockpit needs in one response. Several values are
read **once** and shared, so two parts of the UI cannot disagree.

| Key                             | Contents                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`                        | `heartbeatIntervalMs`, `maxConcurrentAgents`, `watchLabel`, `ignoreLabel`, `canFileTickets`.                                                                                                                                  |
| `control`                       | The **live** cap and pause state. The cockpit reads these, not the frozen `config` block.                                                                                                                                     |
| `worldObservedAt`               | When `world` was observed — the baseline's `takenAt`. **Null** before the first cycle, when `world` is empty.                                                                                                                 |
| `world`                         | The snapshot, with `health`, `attention` and `ciVerdict` per open PR and `pickup`, `conclusion`, `shortfall`, `assay`, `completion` and `spend` per issue.                                                                    |
| `retainedRuns`                  | Runs whose issue the world has forgotten (#203, #234), rebuilt from their stored snapshots by the same `retainedRunIssues` the dispatcher unions into its issue list, through the same per-issue enrichment a live one takes. |
| `plans`, `planParts`            | The plan graph — the same rows the per-issue chip reads, with `statusCommentRef` as a canonical ref.                                                                                                                          |
| `tasks`                         | Every task.                                                                                                                                                                                                                   |
| `jobs`                          | Operator jobs, newest first.                                                                                                                                                                                                  |
| `schedules`                     | Recurring blueprints, oldest first — **every** one, paused included, since this is the only surface anywhere that says a paused one exists. What a firing produces is an ordinary entry in `jobs`.                            |
| `agents`                        | Every agent row, including usage and the progress note.                                                                                                                                                                       |
| `flags`                         | Every artifact chip, grouped by the cockpit onto agents.                                                                                                                                                                      |
| `files`                         | Every file every agent wrote.                                                                                                                                                                                                 |
| `attachments`, `attachmentUrls` | Images an operator attached to a blueprint (#249), every ref in one list, plus the capability-carrying URL to load each one's bytes. The cockpit filters by `targetRef`: `job:<id>` while queued, `issue:<n>` once filed.     |
| `overlaps`                      | Paths two concurrently-live code agents wrote.                                                                                                                                                                                |
| `humanTasks`                    | Work only a person can do — open ones and a settled tail, newest first. Beside `findings` rather than inside `escalations`: nobody is parked on one.                                                                          |
| `findings`                      | Every finding.                                                                                                                                                                                                                |
| `escalations`                   | Every escalation.                                                                                                                                                                                                             |
| `recovery`                      | Work the previous run orphaned (a dead agent, or a task no agent ever started), each awaiting restore / requeue / remove. Non-empty ⇒ **the harness is running no cycles**.                                                   |
| `decisions`                     | The last 100 decisions, each with `subjectRef` — the one external thing the act is about (`issue:13`, `pr:42`), or null.                                                                                                      |
| `upcoming`                      | The last cycle's ranked queue with the headroom cut. Null until a cycle has run.                                                                                                                                              |
| `worldEvents`                   | The last 100 world events.                                                                                                                                                                                                    |
| `errors`                        | The last 100 recorded failures.                                                                                                                                                                                               |
| `refUrls`                       | The `ref → URL` map.                                                                                                                                                                                                          |
| `dispatchRules`                 | `DISPATCH_RULES` as data, so a decision row can expand into the rule that fired.                                                                                                                                              |
| `usage`                         | `{windows: {fiveHourCostUsd, sevenDayCostUsd}, rateLimits, unattributedCostUsd}`.                                                                                                                                             |

Eight consistency points:

- **The pickup verdict uses the same inputs rule `issue-pickup` consults** — the policy, `DEFAULT_COOLDOWN`, the
  world's `takenAt`, tasks, the last 200 decisions, the **unfiltered** open PR list, the plan graph,
  the planning policy, and the same headroom arithmetic — so the chip predicts what happens next cycle.
- **PR health is passed the full open-PR list** as stack context, so an inherited CI failure names the
  PR underneath; otherwise a stacked PR reads as "CI failing" with no agent and no visible reason.
- **The attention verdict sits beside health, never inside it** — health answers _can this merge_,
  attention answers _whose turn is it_, and they have different right answers for the same PR (see
  [07](07-pull-requests.md#prattentionstatuspr-ctx)). It reads the same unfiltered PR list and the
  same decision window, plus the proposals and the world events since the oldest standing rejection
  (`rejectionSignalQuery` → `Store.listWorldEventsSince`, so nothing is read until an operator has
  rejected something). Nothing in the dispatcher reads it.
- **The CI verdict is `classifyCiFailures(pr.ciChecks, config.ci)`**, beside `health` and `attention`
  and computed from the **same call the dispatcher makes** (see [07](07-pull-requests.md)). The
  alternative — shipping `config.ci` and re-matching in the browser — means a second glob matcher and
  a second first-match-wins ordering living nowhere near the rule they duplicate, and it fails
  silently: the cockpit would say _repair_ while the harness held. `test/ciPolicy.test.ts` asserts the
  shipped value against the function itself rather than against a transcribed literal, so a second
  expectation written out by hand cannot become a second implementation.
- **The assay verdict sits beside `conclusion` and `shortfall`, not inside `pickup`** — pickup answers
  "would an agent start next cycle", the assay answers "is there anything here to start on" (see
  [06](06-issue-pickup.md)). `{verdict, summary, by, decidedAt}`, or **null**, and null is a third
  reading rather than a synonym for `workable`: `pickup.reasons[0]` already carries the refusal text,
  but "refused" and "awaiting a verdict" differ _only_ in that prose, and telling them apart by reading
  a string written for a human is what `signalPolarity` refuses to do. `goalRef` is deliberately not
  shipped — it is the fingerprint the hold is measured against, not a reading. `commentRef` rides
  beside the verdict: the standing comment the assay desk keeps on the ticket, as a canonical ref.
- **A comment the harness maintains ships as a ref, never as the provider's id** (#171). Both records
  that keep one — `plan.statusCommentRef` and `issue.assay.commentRef` — are stored as a provider
  comment id and translated on the way out by `issueCommentRef` into `issue:<n>:comment:<id>` (see
  [15](15-integrations.md#comment-refs)). The store is untouched; the id is what `upsertIssueComment`
  round-trips, and it is exactly what must not reach a resolver, which reads a bare number as an issue
  number. The same function feeds `buildRefUrls`, so the ref the cockpit holds is always the ref the
  map was keyed by. **Null means no comment was written**, and a ref absent from `refUrls` means the
  provider could not build a URL — both draw nothing rather than a boolean nobody can act on.
- **`refUrls` covers closed PRs too**, since the cockpit's "recently closed" section links their
  numbers, and it resolves finding refs directly (a finding often names an item not in the world).
- **`refUrls` also keys world-event refs, every task's origin ref, every goal's own ref and every
  decision's subject** (#199), on top of the `#n` item keys. The world-signals card draws a world
  event's structured `ref` (`pr:42`, `issue:13`); the recovery and agent cards draw a task's colon-form
  origin (`pr:142:ci`, `issue:13:part:x`); the up-next queue draws a candidate's own origin, which is
  `issue:<n>` for every world issue **and every retained run** (the latter by definition absent from
  the issue list); and `decision.subjectRef` is keyed for whatever reads the audit rows. None of those
  is the `#n`
  the item lists key by, so each is resolved on its own. A `job:<id>` origin resolves to nothing and is
  omitted, and the feed's `#n`-in-prose still links off the item keys through `linkify`.
- **A decision's subject ref is derived on the server and shipped on the row** (`decisionSubjectRef`,
  `src/server/refUrls.ts`), not re-derived in the browser from the `action` bag the cockpit also
  holds. The same string keys `refUrls` and is looked up in it, and two readings of that bag are two
  chances to key one shape and look up another — a failure whose only symptom is a ref rendering
  plain, on exactly the action types the two readings disagree about. It is a `switch` on
  `action.type` rather than a scan for likely-looking fields, because `number` is a work item on
  `set_work_item_state` alone and would be read as one on any action that later grows a field by that
  name. An unknown type, or an act about nothing external, is null: the column draws a dash.

`usage.windows` are summed from `usage_events` (all modes, self-computed); `usage.rateLimits` is the
freshest PTY status-line payload, or `null`, in which case the cockpit chip falls back to cost.

`issue.spend` is the same money asked per **goal** rather than per window — `rollUpIssueSpend` over
`agents`, `tasks` and the work graph, so a pull request's CI agents and a plan's parts are charged to
the ticket they came out of. It is `null` where nothing was measured (every PTY agent), which is not
the same reading as zero. `usage.unattributedCostUsd` is its remainder — spend that reached no goal —
shipped so the per-goal figures read as a partition of fleet spend rather than an unbounded subset of
it. Neither is stored: cost is durable on the `agents` row, the origin on the `tasks` row, and the
lineage in `work_nodes`. → [18](18-observability.md#per-goal-spend)

## The WebSocket

`GET /ws`. On connect the socket immediately receives `{type:'dirty'}`.

Clients may send `{type:'subscribe'|'unsubscribe', agentId}`. Malformed frames are ignored.

### Server events

| Event                  | Payload                           | Delivery                           |
| ---------------------- | --------------------------------- | ---------------------------------- |
| `dirty`                | —                                 | broadcast; "re-fetch `/api/state`" |
| `cycle:start`          | `cycleId`, `source`               | broadcast                          |
| `cycle:end`            | `cycleId`, `rationale`, `summary` | broadcast (+ `dirty`)              |
| `world:events`         | `events`                          | broadcast (+ `dirty`)              |
| `world:changed`        | —                                 | broadcast by mutating routes       |
| `control:changed`      | `cap`, `paused`                   | broadcast                          |
| `agent:output`         | `agentId`, `delta`                | **subscribers only**               |
| `agent:tail`           | `agentId`, `line`                 | broadcast                          |
| `agent:flag`           | `flag`                            | broadcast (+ `dirty`)              |
| `agent:finding`        | `finding`                         | broadcast (+ `dirty`)              |
| `agent:status`         | `agentId`, `taskId`, `status`     | broadcast (+ `dirty`)              |
| `agent:waiting`        | `agentId`, `taskId`, `reason`     | broadcast (+ `dirty`)              |
| `agent:done`           | `agentId`, `taskId`, `status`     | broadcast (+ `dirty`)              |
| `escalation:created`   | `escalation`                      | broadcast (+ `dirty`)              |
| `escalation:answered`  | `escalation`, `routing`           | broadcast (+ `dirty`)              |
| `escalation:dismissed` | `escalation`                      | broadcast (+ `dirty`)              |
| `error:logged`         | `error`                           | broadcast (+ `dirty`)              |

Agent **output** is high volume, so it is delivered scoped to subscribers. Everything else is
low-volume and fleet-wide.

Three events deliberately have **no dedicated frame** and produce only a `dirty`: `usage`, `progress`
and `files`. Their payload is already on a row the `/api/state` refetch brings, unlike `agent:tail`,
which exists only as a broadcast and has to carry its own payload.

### The tail

`Hub.updateTail` folds each output delta into a per-agent rolling state (`partial`, `last`). ANSI is
stripped first, so a coloured transcript label never shows as a literal escape in the plain-text
preview (escapes never contain newlines, so stripping before the line split is safe). The partial-line
buffer is capped at 256 characters and the emitted line at 200. The state is dropped when the agent
finishes.

The tail is **ephemeral and per-server**: it lives only in the `Hub`'s map, so a cockpit opened
mid-run shows nothing until the agent's next output. That is precisely the gap `note_progress` fills —
see [11](11-mcp-tools.md).
