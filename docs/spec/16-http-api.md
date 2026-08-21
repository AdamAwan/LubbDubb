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

| Module                  | Holds                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `routes/state.ts`       | `/api/state`, `/api/prompts`, `/api/config`, `/api/ci-policy`, `/api/mcp`, `/api/health`      |
| `routes/agents.ts`      | One agent's transcript, and respond / kill / complete / interrupt                             |
| `routes/artifacts.ts`   | `/artifacts/:id` and `/attachments/:id`, their capability signers, and the path confinement   |
| `routes/control.ts`     | `/api/pulse`, `/api/errors/clear`, `/api/control`, `/api/prs/:number/watch`                   |
| `routes/escalations.ts` | The whole "Needs you" inbox: escalations, proposals, recovery                                 |
| `routes/findings.ts`    | Promote / file / dismiss                                                                      |
| `routes/humanTasks.ts`  | Work only a person can do: filing one, and the two ways it settles                            |
| `routes/issues.ts`      | Watch, priority, conclusion, assay, delivered, shortfall, dismiss-run                         |
| `routes/jobs.ts`        | `/api/jobs`, `/api/jobs/:id/cancel`, `/api/upnext/order`, `/api/upnext/profile`               |
| `routes/plans.ts`       | Plan history, replan, acceptance ticks, part model pins                                       |
| `routes/validation.ts`  | One validation check's current reading — result, defer, waive, reset — and who runs it        |
| `routes/schedules.ts`   | Recurring blueprints: write, edit, run now, delete                                            |
| `routes/spend.ts`       | `/api/spend` and `/api/spend/trend` — the breakdown behind the cost indicators, and its trend |
| `routes/readings.ts`    | `/api/retrospectives/:ref`, `/api/scratchpads/:ref`                                           |
| `routes/reliability.ts` | `/api/reliability` — run outcomes, CI health, and why the fleet came back                     |
| `routes/work.ts`        | The work graph and its ignore / file verdicts                                                 |
| `stateSnapshot.ts`      | `buildStateSnapshot` and the readings it folds                                                |

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

### The SPA fallback

`web/dist` is served by `@fastify/static` off the root, **read from disk per request**: the plugin
snapshots nothing at boot, so a rebuild under a running server is picked up by the next request and
restarting to see a cockpit change is unnecessary. What the restart in `npm run serve` actually buys
is the `web:build` in front of it ([19](19-development.md#scripts)).

Anything the static plugin misses reaches `setNotFoundHandler`, which decides between the app shell
and a 404 through `wantsAppShell` in `app.ts`. Deep links are the reason the shell arm exists —
`/goals/42` is a route in the bundle, not a path on disk, and a reload of one has to be answered with
`index.html`. **A request carrying a file extension is never given the shell.** Vite hashes asset
names and `emptyOutDir` deletes the previous ones, so every browser still holding the last
`index.html` goes on asking for chunks that no longer exist; answering those with the shell returns
`200 text/html` for a JavaScript module, which the browser refuses on the MIME type. The cockpit does
not start, a reload does not clear it, and the server logged a successful request — the symptom is a
harness that looks broken after an upgrade, with nothing anywhere naming the bundle. A 404 says the
same staleness out loud, and one reload fixes it.

The extension is the test, rather than `Accept`: a module request and curl both ask for any type at
all, so deciding on that header would 404 a deep link typed into a terminal and fix nothing. Cockpit
routes are ref ids and slugs, which carry no dot. `test/appShell.test.ts` asserts both directions
against the predicate rather than through `buildApp` — the test job builds no `web/dist`, so the
static plugin is never registered there and an injected request would prove nothing.

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

Every route reads its path params, its query string and its body through a **zod schema**. A handler
does not read the request at all: it is **wrapped in `checked(schemas, handler)`**
(`src/server/validation.ts`) and handed `{params, body, query, req, reply}` already parsed. `checked` is the only caller of `readRequest` and
the only place a refusal becomes a `400`.

That is the shape and not an implementation detail. `req.params as { number: string }` is a claim
about data the server does not control, and the hand-written checks that used to follow one were
written per route, so what a route validated was whatever its author remembered. Removing the
assertions left 36 verbatim copies of `if (!input.ok) return reply.code(400).send({error})` — every
one correct, and nothing but a source grep saying the 37th had to be (issue #237). A handler that is
_handed_ checked values has no raw request to assert about and no check to skip.
`test/requestValidation.test.ts` asserts both structurally, over every file in `src/server/routes/`.
(The two artifact routes still read `req.query` directly — each asserts the value to `unknown` and
tests its type before use, so the assertion claims nothing about the data. Since #329 a query string
can be _declared_ instead, and a route whose parameters are filters should declare one: those are the
half an operator hand-edits in the address bar, so they are the half that most wants validating.)

Four properties hold across the surface:

- **A refusal is a value, never a throw.** `setErrorHandler` means "an unanticipated throw" and
  records every one to the error log; a malformed request is neither unanticipated nor the harness's
  fault, so routing it there would bury real faults under other people's typos. `readRequest` returns
  `{ok: false, error}` and `checked` sends it as a `400 {error}`.
- **Every field states its own refusal in full** — `cap must be a number`, `invalid issue number` —
  because the 400 body joins the schema's messages and drops their field paths. A field declared
  without a message refuses with zod's stock text, which names nothing.
- **Params are read first, then the query, then the body**, so a request naming no such item is
  refused for that whatever else it got wrong. Where a route answers 404/409 off the store first (`/api/findings/:id/*`,
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
unwatched PR stays visible here with its health; and the reading's age is shipped as
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

### The harness's own build

`src/server/routes/upgrade.ts`. Its own module rather than two more routes on `control.ts`: that
file owns the _fleet's_ live controls, and this owns the process they run inside. They share a pause
flag and nothing else. Full behaviour is [21](21-self-update.md).

#### `POST /api/upgrade/check`

Takes a fresh reading of the install directory against its upstream, skipping the interval that
otherwise bounds how often the remote is touched. Rate-limited to 30/minute — it is the one route on
this surface that reaches the network on request rather than on the pulse. Broadcasts `dirty` to
every open cockpit (a reading one operator took is a fact for the others) and returns
`{ ok: true, build }`.

#### `POST /api/upgrade`

Body `{action: 'drain' | 'cancel' | 'apply', interrupt?: boolean}`; anything else is a 400. Applies
the transition and returns `{ ok: true, build }`.

A refused transition is a **409 with the desk's own wording**, not a 400: the request was well-formed
and the operator is not wrong, the world moved — an agent started, a second cockpit already drained,
the build is current. That is the shape the recovery route uses for a verdict someone else settled.

`apply` ends the process it is talking to. The reply and the broadcast are written first — the
handoff is deferred past them in `main.ts` — so a cockpit learns the answer from the response rather
than from a dropped socket.

### `POST /api/prs/:number/watch`

Body `{watched: boolean}`. Adds or removes the `${labelPrefix}-watch` label through the provider,
folds the tag onto the world baseline, broadcasts `world:changed`, and runs a cycle so a now-watched
PR is picked up (or a now-unwatched one dropped). 400 on a non-integer PR number, a non-boolean
`watched`, or a provider failure.

It also records a `pr_watch_seeds` row, in **both** directions: the seeding desk
([07](07-pull-requests.md#watching)) must not answer for a pull request a person has answered for, or
un-watching one the harness opened would be undone on the next pulse.

### `POST /api/issues/:number/watch`

Body `{watched: boolean}`. Writes the one label — sets `${prefix}-watch` to `watched`. Folds the tag
onto the baseline **and onto the ticket mirror**, broadcasts, and runs a cycle.

**On a container it cascades.** The tag is written on every item `watchCascadeTargets` names — the
issue itself and, for a Feature or Epic, every descendant beneath it — because a container is never
dispatched at and a tag on one alone would change nothing
([06](06-issue-pickup.md#watching-a-container-cascades)). Un-watching walks the same tree. On success:
`{ok: true, watched, cascaded}`, `cascaded` being the number of descendants written.

400 on a non-integer issue number or a non-boolean `watched`, and on a provider failure — including a
**partial** one, where the error names how many of how many landed and which numbers kept their old
tags. Every failed write is recorded on the error log. `world:changed` is broadcast either way,
because whatever landed has already changed the world the cockpit is showing — and only the items
whose write the provider took are folded onto the baseline.

#### Why both watch routes patch the baseline

`store.patchWorldLabels` runs **before** the broadcast, and the ordering is the whole of why the
toggle changes under the click. `GET /api/state` serves the baseline and never a live provider read
(above), so a broadcast ahead of the fold only makes the cockpit redraw the state it already had.
The cycle at the end of the route cannot supply it either: `runCycle` coalesces to nothing while
another cycle is in flight ([04](04-harness-cycle.md#cycles)), which is most clicks on a busy fleet,
and where it does run the operator waits a whole cycle for a button to change.

The fold is not optimism — it only ever runs for a write the provider confirmed, so it is observed
fact arriving early, and the next pulse reads the same tag back off the tracker and writes the same
baseline. It is deliberately not sticky: a world read that disagrees wins, because the tracker stays
the source of truth and a patch that outlived its observation would be the cockpit lying about a tag
nobody can see ([04](04-harness-cycle.md#the-world-baseline)).

#### And why the issue route also patches the mirror

There are **two** readers of this tag, not one. `GET /api/state` serves the baseline; `GET /api/tickets`
is built from `tracker_items`, and the Tickets tab is the one surface carrying an explicit **Unwatch**
button. So `store.patchTicketLabels` folds the same confirmed write, over the same `landed` set, onto
the mirror ([14](14-persistence.md#folding-a-watch-click-onto-the-mirror)).

Without it the argument above holds twice over and then some: the mirror's own writer is `TicketSweep`,
which runs **last** in a cycle — the same cycle that coalesces away — so the row an operator just
un-watched goes on reporting `watched`, the `watch=unwatched` filter cannot find it, and clicking again
does exactly as little. The tag is off the tracker throughout. That is a toggle which reads as broken,
and it is what issue #417 reported.

The PR route has no equivalent because the mirror holds tracker items and a pull request was never one.

### `POST /api/issues/:number/profile`

Body `{profile?: string}`. Pins this goal's work to a model profile; absent or empty **clears** the
pin, which is the state a ticket starts in rather than a third value. Like the watch route it writes
**labels on the tracker** — `${prefix}-model-<profile>` set, every other model label cleared, so the
ticket carries at most one answer — and it is the only reason this is a tracker write rather than a
store one: a pin is visible where a human already looks, which is what makes "does it expire?" a
question with no mechanism behind it ([02](02-configuration.md#pinning-one-goal-to-a-profile)).

The same call **answers a standing profile proposal from the assayer**, whichever way the operator
went. That is what makes "keep mine" a decision rather than a refusal to answer: the tag goes on
deliberately disagreeing with the proposal, and a gate that re-read the disagreement would ask the
same question for ever. What is recorded is that the question was answered, never what it was answered
with — the tag is that. Broadcasts `world:changed` and runs a cycle, so a goal released from the gate
moves immediately.

400 when the deployment configures no profiles, when `profile` names one that is not configured
(by name, with the configured set listed — the boundary half of the boot rejection), and on a provider
failure, which is recorded on the error log. Returns `{ok: true, profile, answered}`.

### `POST /api/issues/:number/priority`

Body `{priority: boolean}`. Marks this goal a priority, or clears the mark: every origin under it —
its pickup, its plan, its parts, its assay, its assessor, its validation checks and the pull requests
its branches opened — is ranked ahead of the natural cross-rule order and ahead of an
`/api/upnext/order` drag, behind rule `manual-job` only
([05](05-dispatcher.md#marking-a-goal-a-priority)).

**The harness's own record, not a tracker label** — unlike the watch and profile routes above, and for
the reason that separates them: those two state something about the _goal_ that a human reading the
ticket needs, while this states something about **this deployment's queue**, which is not a fact the
tracker can honour and not one every other board reader should inherit.

Idempotent both ways, and a second flag keeps the original timestamp — the row records when the
operator decided, and clicking a button that is already on decides nothing new. Broadcasts
`world:changed` and runs a cycle, safe inline for `/api/upnext/order`'s reason: it re-orders and never
un-holds. 400 on a non-integer issue number or a missing/non-boolean `priority`. Returns
`{ok: true, priority, report}`.

### `POST /api/issues/:number/conclusion`

Body `{verdict: 'done' | 'more_work' | null, note?: string}`. The operator's override of whether an
issue is finished — it wins over the agent's declaration and over the plan derivation (see
[06](06-issue-pickup.md#concluding-an-issue)). `null` **clears** the row, returning the issue to
whatever its plan derives or to `undeclared`.

It writes the harness's own record and **does not touch the tracker**: concluding an issue here is
what stops the re-pickup, while moving the work item to a done state stays a human act. Broadcasts
`world:changed`, and runs a cycle only for `more_work`, so an operator's "there's more here" bounces
the item back to pickup immediately rather than on the next heartbeat. 400 on a non-integer issue
number or a verdict that is not one of the three. The cockpit writes `more_work` through
[`/instruction`](#post-apiissuesnumberinstruction) rather than here — a bounce-back carrying none of
what the operator wants is the weaker half of what they were doing — and this arm stays as the API's
way to say it, and as what `null` clears.

### `POST /api/issues/:number/instruction`

Body `{text}`, required and non-empty (max 4 000). What the operator wants done on this goal, in their
own words — _change the button to primary_, _the permission is wrong_. This is what the cockpit's
**More work** control writes, and what the bare `more_work` toggle became.

It writes **two** rows and both are load-bearing. The instruction is what reaches the agent, appended
to every dispatch on the goal until one concludes it
([09](09-execution.md#the-operators-own-instructions-reach-the-agent)); the `more_work` conclusion is
what makes there _be_ a next dispatch, since rule `work-item-back-to-pickup` acts on an explicit
verdict and nothing else. The verdict's note deliberately does **not** repeat the instruction — one
fact rendered twice in one prompt reads as two, and the prior-work briefing renders a conclusion's
note. Broadcasts `world:changed` and runs a cycle, for the toggle's reason sharpened: an operator who
has just said what they want should not wait a heartbeat to be listened to. 400 on an empty `text` or
a non-integer issue number. Returns `{ok: true, instruction, conclusion}`.

**On a goal with a standing delivery the conclusion is skipped**, and `conclusion` comes back null.
The conclusion is a means rather than the operator's statement, and there it would not schedule
anything: it would _clear the delivery_ (`VERDICT_EXCLUSIONS.conclusion` lists it), un-parking rule
`issue-assess` and re-blocking `issue-retro`, `validate-check` and the close-out obligation, all
three of which gate on `deliveryParked`. There is already a next dispatch on a delivered goal — the
retrospective, which `instructionsFor` deliberately includes — so the instruction is read either way,
and writing the verdict would cost a finished goal another trip round the funnel with nothing red.

### `DELETE /api/issues/:number/instruction/:id`

Take one back — the escape hatch free text sent to an agent has to have, and the only way an
instruction stops standing other than an agent concluding the goal. Withdrawing the **last** one clears
the operator's `more_work` with it, so the item is not bounced back to pickup for words nobody is going
to read; an **agent's** own declaration is left exactly where it was found, because it is about the
work rather than about the instruction. 409 when there is no standing instruction with that id, so a
double click is refused rather than silently succeeding. Returns `{ok: true, standing}`.

### `POST /api/issues/:number/delivered`

Body `{delivered: boolean, summary?: string}`. The operator's arm of the delivery verdict — the
harness's own park, which gates pickup and nothing else (see
[06](06-issue-pickup.md)). `false` **clears** the row, which is a delete so that "no verdict" has
exactly one representation. Like the conclusion route it writes the harness's own record and **never
touches the tracker**: `closed` stays the human's.

### `POST /api/issues/:number/environment-gate`

Body `{released: boolean, note?: string}`. The operator saying this goal is **not waiting on an
environment** — a docs change, a config change, work whose deployment nothing here can see — or
putting it back to waiting. It lifts every gate on that goal at once, so its `validate` and
`close_out` rows are filed on the next pulse, which the route runs itself rather than leaving to the
next beat. `false` **clears** the row, a delete so that "not released" has one representation.

`note` is **required** when `released` is true, and that is the schema's own `.refine` — `GateReleaseBody`
in **`src/environments/arrival.ts`**, beside the rule it encodes rather than in the route, for
`ShortfallBody`'s reason. Every other operator verdict's summary is optional because it records a
judgement about the work; this one records a decision to stop waiting for evidence, on a goal that
will then read as closed-out with nothing on the glass to say no environment ever confirmed it. 400
on a release with no note, or a non-integer issue number.

The escape hatch has to exist wherever a gate does: without it a goal that is never going to reach an
environment sits delivered with an empty bench for good, which is the harness losing an obligation
rather than holding one. → [24](24-environments.md#lifting-the-hold)

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

### `POST /api/issues/:number/shortfall/overrule`

Body `{text}`, required and non-empty (max 4 000). The operator saying the assessment itself is
**wrong**, and why. 409 when no shortfall is standing — the route says one specific thing, and with
nothing standing there is no verdict to be wrong; an operator who means the plain thing has
[`/delivered`](#post-apiissuesnumberdelivered). 400 on empty `text` or a non-integer issue number.
Returns `{ok: true, delivery, instruction}`.

It exists because neither arm of the card says this. Accepting spends an agent on a follow-up part
for work already done; rejecting leaves the verdict standing, so rule `issue-assess` dispatches
again, the fresh assessor reads the same repository and records the same shortfall. Nothing typed
into that card survives the loop either — `shortfallRef` is nobody's dispatch origin, so
`rejectionGuidance` reaches no agent with the note. Without this the operator has no way to say
"that finding is mistaken" that anything reads.

It writes **two** rows, `/instruction`'s arrangement for its reason — half of it does nothing.

The **delivery** is the verdict. It clears the shortfall through `VERDICT_EXCLUSIONS` rather than a
`DELETE` of its own, parks the assessor that would otherwise re-derive the finding, and releases the
three things gated on `deliveryParked`: rule `issue-retro`, rule `validate-check` and the close-out
obligation. Those are the steps that follow delivery, and while a shortfall stands none of them can
run at all — which is why overruling is what _unblocks_ verification rather than skipping it.

The **instruction** is what gets the correction into the record. The harness never edits the ticket
itself — only an agent can tell "this changes the goal" from "this is a note about how to do the
work" ([09](09-execution.md#the-operators-own-instructions-reach-the-agent)) — so the instruction
block, which already carries the tracker's own read/amend commands, is the one mechanism there is.
On a delivered goal it lands in front of the retrospective agent, dispatched by the delivery this
same call writes. One `text` fills both: the operator's words are the reason the goal is delivered
_and_ the correction to be written down, and quoting them twice from one field is what keeps the two
from drifting.

The proposal is **not** settled here — rejecting it is the cockpit's existing call and the honest
verb for "no follow-up part". Folding it in would give this route a second opinion about a
settlement `POST /api/proposals/:id/reject` already owns. Broadcasts
`world:changed` and runs a cycle, so the retrospective it releases is dispatched now rather than on
the next heartbeat.

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
  verbatim and the tracker named, duplicate candidates from the ticket mirror are appended to it, a
  `desk` job is created, an `issue_bug_filings` row opens at `filing`, and a manual cycle runs so the
  report reaches the fleet now rather than on the next heartbeat. The agent writes the bug up; the
  **harness** files it — with its type, its assignee and the relation back to this story — when the
  agent hands over the title and body through `link_ticket` ([11](11-mcp-tools.md#link_ticket)). Two
  writes are what make a bug traceable, and neither is a sentence an agent could drop
  ([13](13-jobs-and-findings.md#filing-a-ticket)).
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

Body `{note?}`, and **required when the goal's validation plan is flagged** — this is the button that
ends the harness's run at a goal, it is one-way, and it is exactly the "close the goal and move on"
it is named after. The 400 states the counts. It blocks nothing else: the note is the whole of the
requirement, and it is kept on the run as `dismissNote` so what the goal owed and what was said about
it survive together. A clear goal, or one with no checks at all, is dismissed with no body as before.
→ [20](20-validation.md)

### `GET /api/issues/filing-target`

Whether a report **about LubbDubb** can be filed right now, where it would land and as whom — the live
half of the gate on the top bar's compose modal (issues #413, #449). Answers a `FilingTargetProbe`:
`{available: true, target, identity, watchable, reason: null}`, or
`{available: false, target: null, identity: null, reason}`. A **union, not five independent fields**:
an available target always names itself and an unavailable one always says why, so there is no way to
draw a modal head naming nowhere.

The target is always `AdamAwan/LubbDubb` and never the tracker the fleet is pointed at, which is the
whole of issue #449 — a fault in the cockpit belongs on the cockpit's tracker. The identity is the
operator's own `gh` login, and it is asked live because that is the one thing about filing here that
config cannot state. `watchable` is the exception that still depends on config: the watch label is what
makes a fleet pick an issue up and a fleet only sweeps its own tracker, so it is true only where this
deployment's issues provider is GitHub pointed at that same repository — the dogfooding case. Elsewhere
the modal draws no watch box rather than an inert one.

Every failure arm is a **200**, never a 5xx. A logged-out CLI is an answer to the question that was
asked, and the caller is a modal that wants to say why it is falling back to the external new-issue
form rather than one that wants an exception. Two arms reach it: the CLI threw (absent, logged out, or
refused), or it did not answer inside eight seconds — the last one because a request that never returns
leaves the modal that fired it spinning, which is worse than the fault it was checking for. Both are
**recorded** to the error log: an operator whose `gh` login has lapsed should find that in the Errors
panel and not only in a modal they closed.

Not on `/api/state`: it costs a round trip to the CLI and the only reader is a modal that opens
rarely.

### `POST /api/issues`

File the operator's own report about LubbDubb, directly (issues #413, #449). Body
`{title, body, watch?}`; answers `{ok: true, number, url}` — the new issue's number in LubbDubb's repo
and its address. A **URL and not a `ref`**, unlike every other filing on this wire: `issue:<n>` is the
harness's vocabulary for an item in the tracker the fleet is pointed at, and the cockpit resolves it
against that tracker, so a ref here would draw a link to whichever issue of the customer's repo shared
the number.

The one filing route with **no desk agent between the click and the create**. `/api/issues/:number/bug`
dispatches one because the dedupe and the write-up are the judgement being delegated; here the operator
has already written the thing up, and spending a model call to re-type it would add nothing.

It files through `system.upstream` and **not** `ticketFiler`: `ticketFiler` files into the tracker the
fleet is pointed at, and this is a bug report about the cockpit ([15](15-integrations.md)). The
type/assignee resolution the other filing arms need does not arise — one repository, no work item
types, and the byline is the operator's own `gh` login. **`watch` defaults to false**, and is honoured
only where the probe says `watchable`: the label is what makes the fleet pick an issue up, so
defaulting it on would mean a half-formed thought is being worked before the operator has finished
reading it back, and applying it on a deployment whose fleet sweeps some other repo would tag an issue
nothing here ever looks at.

Refusals: **400** for a missing or blank `title`/`body` or a non-boolean `watch`, through
`checked({body})` like every other route here; **502** carrying the CLI's own words when it refuses the
create, so the modal can keep what was typed. There is no 409 arm — no configured tracker gates this
route, which is why the top bar's compose button is no longer behind `canFileTickets`.

**No cycle and no `world:changed`**, unlike every other filing route. What was created is in LubbDubb's
tracker, which on all but the dogfooding deployment this harness does not sweep at all — and on that one
the next pulse finds it. The modal's success state is the address of the thing, not a row in the world
the cockpit draws.

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

**Unrecorded means parentless, and a job is adopted by three arms.** A dispatched code job with no
parent is what the detector reports, so what counts as unrecorded is decided entirely by the fold's
adoption: **A** — a job owns the pull request its own branch carries; **B** — a job is adopted by the
issue its own PR names; **C** — a job is adopted by the origin it stands in for, resolved by walking
`Job.originRef` down to the longest prefix the graph holds a node for, so `issue:41:retro` lands on
`issue:41` while `issue:41:part:api` — itself a node — lands on itself.

Arm C is what makes the list honest. Arms A and B can only adopt a job that produced a pull request,
and a requeued assay, plan, retro or review-comment job opens none — so every one of them was
parentless forever and the panel offered to file a second tracker item for work an existing one
already named. Not a stale row that ages out: the condition is permanent until acted on, which is how
the list came to be mostly `Requeued: Plan issue #35699` and read as noise.

A prefix walk rather than a table of known suffixes, because an origin vocabulary the fold does not
recognise must fail to the **visible** mistake — the row staying in the list, where an operator sees
it — and a table would silently adopt the next origin added under whichever parent its author last
thought about. The walk cannot invent an edge either: every candidate is a ref something emitted, or
one `existing` already holds, so a closed issue the world no longer sweeps still adopts its own
requeued work.

Arm C runs last and **only ever fills a null**, so arm B's adoption and an operator's own filing both
outrank it, and a job with no origin — the hand-launched one, which stands in for nothing — stays
unrecorded. That is the case the detector was written for. → [14](14-persistence.md#work-graph)

### `GET /api/work/:ref`

One subtree, walked from the given root by `parent_ref`. **Two consumers**: the work tab, for a root
the operator expanded, and the goal page's record card, for `issue:<n>` — the goal it is drawn on.
The second is why a 404 here is not a fault and is not recorded through `errors`: a goal picked up
minutes ago, or one the harness never worked, has no node yet, and filing an error report for the
ordinary case is worse than the empty state. 404 when the ref names no node. Refs carry
colons (`issue:12`, `pr:41:ci`), so the route has to survive one in a path segment. Each node's URL is
resolved through the connector's own `resolveRefUrl` rather than read off the snapshot's `refUrls` —
that map is built from the world, and a PR the graph remembers merging left the world hours ago.
Returns `{ nodes, refUrls }`.

### `GET /api/tickets`

One page of the **ticket mirror**: every item the tracker's assignment filter has returned since the
harness first swept, worked or not, live or frozen (issues #329, #351). Rate-limited and fetched rather
than polled, for `/api/work`'s reason — the list is all-time and only grows.

Six query parameters, every one defaulting so a bare call is the tab's own first request:

| Parameter  | Values                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| `watch`    | `any` \| `watched` \| `unwatched`                                           |
| `tracking` | `any` \| `live` \| `frozen` — the harness's reading. **Defaults to `live`** |
| `state`    | `any`, or a provider-native state exactly as the tracker spells it          |
| `feature`  | a feature number, or `none` for the items the tracker says have no parent   |
| `order`    | `added` \| `changed` \| `cost`                                              |
| `cursor`   | opaque; this route's own output handed back                                 |

They default **here** as well as in `Place`, which is what keeps a bare `?tab=tickets` and a bare
`/api/tickets` the same place. `tracking` defaulting to `live` is a deliberate change of what a bare
call means: the tab is a work surface now, and opening it on a thousand frozen rows would bury the ones
that are still work.

**`state` is free-form, and validated only for length**, because the vocabulary is the tracker's and
this route cannot hold the list. A state no item carries narrows to an empty list — a filter that found
nothing, not a place that does not exist. The two literals `open` and `closed` are read as the _old_
two-valued `state` axis and mapped onto `tracking`: no tracker spells a state that way, and a saved link
that silently matched nothing would be worse than an alias that is written down. `place.ts` carries the
same alias, and has to. Any other hand-edited value is a `400` naming the field; a stale cursor is not —
a cursor whose row has left the filtered set restarts the list, because repeating rows is a failure a
reader can see and a silently skipped page is not.

Returns `{ rows, total, kept, live, totalCostUsd, nextCursor, states, features, orphanCount, anchorAt,
backfilling, refUrls }`. `total` and `totalCostUsd` describe the **whole filtered set**, not the page —
an infinite list with no total says nothing about whether a reader is near the end — while `kept` and
`live` describe the mirror itself, which no filter changes. `states` and `features` are the facets, and
they are counted over the **whole mirror** rather than the filtered set: a facet counted after its own
filter shows `1` beside whichever value was selected and nothing beside the rest, which is a control
that erases its own alternatives. Each state facet carries `live` beside `count` — how many of its rows
are still in the open set, and **zero** for every closing state the tracker has, which is what lets the
cockpit widen the `tracking` axis on a pick that would otherwise return nothing
([17](17-cockpit.md#three-axes-because-they-are-three-questions)). `states` is **empty for a provider
with no native states**, which is what tells the cockpit not to draw that filter tier at all. `anchorAt` is the frozen one-month floor and
`backfilling` says whether the first sweep has landed; both are shipped because the tab has to _say_
them, an empty list mid-backfill being indistinguishable from an empty tracker. `refUrls` covers the
page's own rows, resolved through the connector's `resolveRefUrl` rather than read off the snapshot —
that map is built from the world, and most rows here left it long ago.

Note what it does **not** ship: the pickup reasons and the assay. Those are live readings the cockpit
already holds on `/api/state`, and a second copy of them here would be a second answer to a question
the dispatcher has already answered.

Three readings are quoted rather than re-derived: cost from `buildSpendGoals`, the outcome word from
`resolveIssueConclusion` (folded server-side by `src/tickets/outcomes.ts`), and the watch bucket from
`src/watchLabels.ts` — the same precedence the dispatcher's gate resolves through. It is a lens: no
rule under `src/dispatcher/` reads the table behind it. → [17](17-cockpit.md#the-tickets-tab),
[14](14-persistence.md#the-ticket-mirror)

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
partition. A `SpendRun` carries `id` and `kind` rather than an `agentId`, because a run in that
ranking can be a **local run** ([23](23-local-runs.md#what-it-costs)) and an id of one kind sitting in
a field named for the other is a join nobody can see fail.

Fetched on open for `/api/work`'s reason: it reads **every agent the harness has ever run**, every
local run it has recorded, and every dated cost delta of the last fourteen days, where `/api/state` comes round every couple of seconds for
every open cockpit. What the indicators themselves need — the rolling windows, and each goal's own
total — is already on the snapshot and costs nothing.

Derived on the server rather than in the browser, and not only because the timeline needs the store.
The per-goal totals are `rollUpIssueSpend`'s own, taken whole: the panel and the goal card state the
same figure inches apart in the cockpit, so a cockpit-side re-derivation would be a second opinion
about which goal a pull request's money belongs to. Read-only, and it takes no parameters — the
windows it reports are the same two `buildUsage` puts on the snapshot, asked the same way, so the
panel and the chip it opens from cannot disagree.

### `GET /api/spend/trend`

The same money on a week axis, cohorted by the goals that closed: median cost and tokens per goal,
the stage split as dollars per goal, and whether the work still landed. Returns `{ trend }` — see
[18](18-observability.md#the-spend-trend) for why the unit is a closed goal, why cohort and period
weeks are different weeks, and what is withheld rather than drawn thin.

Fetched on the Trend tab's **first visit** rather than alongside `/api/spend`, which is one step
further than the other fetched-on-open routes go: it reads two months of `world_events` and the closed
end of the ticket mirror on top of the same all-time agent walk, and the tab an operator never opens
should cost nothing. The closures are the mirror's and not `world_events`', which is the whole reason
the tab has anything to draw — see [18](18-observability.md#the-spend-trend). Its goals come
from `buildSpendGoals`, the fold `/api/spend` ships — the two tabs state one goal's cost a click
apart, and agreement by construction is the only kind that holds.

### `GET /api/reliability`

What the spending bought: run outcomes all-time, CI health over the last fortnight, and — over that
same fortnight — the accounts agents wrote of why they had to come back. Returns
`{ insights, remedies }` — see [18](18-observability.md#the-reliability-breakdown) for what each half
of the first means, why the two windows differ, and why `killed` is not counted as a failure, and
[18](18-observability.md#causes-why-the-fleet-came-back) for the second.

`remedies` rides on **this** payload rather than a route of its own because it is a section of this
panel and shares its window: two fetches for one modal would be two chances for the two halves to
describe different fortnights. It is folded from the same `usage_events` this handler already read,
and its `unaccounted` denominator counts tasks whose **origin** is `pr:<n>:ci` or `pr:<n>:comments` —
the same fence `report_remedy` uses, so the numerator and the denominator are one population.

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

File a tracker item for unrecorded work. The mirror of `POST /api/findings/:id/file`, and an
**operator click** for that route's reason: creating tracker items on the harness's own initiative
would be a new outbound capability on the world, and the condition would be permanent until acted on,
so a throttle would only set the rate at which a backlog fills.

404 when the ref names no node; 409 when a filing already stands for it (naming whether one is in
flight or already filed); 409 when the node is not unrecorded work; 409 when no tracker is configured,
the same `config.canFileTickets` predicate the cockpit hides the button on. The not-unrecorded check is
asked of the very predicate the panel draws from, so the route can never refuse what the button
offered, and it is asked **before** the tracker check, so a deployment with nowhere to file still gives
the honest answer about a node that was never eligible.

Body may override `title`; the default is the work's own. **No agent and no job**: the item's body was
already the harness's own walk of the work subtree, so all a desk agent added was one API call
([13](13-jobs-and-findings.md#filing-a-ticket)). The route claims the filing row first — `target_ref`
is the primary key, so a double-click loses there rather than after a second ticket exists — renders
the `work-item-ticket-body` template, files it, links the row, broadcasts and runs a cycle. Returns
`{ ok: true, filing, report }` with the filing already `filed`. A tracker that refuses the create
releases the claim and answers **502**, so the button comes back rather than the node sitting on a
filing that will never complete. The node is parented to the new item by the **fold** on that cycle,
not by the route — the recorder stays the graph's only writer ([14](14-persistence.md)).

### `POST /api/work/:ref/ignore`, `DELETE /api/work/:ref/ignore`

The other verdict on the same row: **no** tracker item is wanted for this work. 404 when the ref names
no node; otherwise idempotent — the refusal of a second click lives in the write, `target_ref` being the
primary key. The `DELETE` undoes it and is silent when nothing stood, so "not ignored" has exactly one
representation.

A standing ignore makes `POST /api/work/:ref/file` **409**, asked of the same predicate the panel draws
from, so the route cannot file a ticket for work the operator has dismissed. It is a table of its own
rather than a third `work_item_filings` status because a filing is the harness creating the item, and
an ignore is the operator saying nothing should be.

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

The configuration this process resolved at boot, for the cockpit's config page
([17](17-cockpit.md#configuration)): `{ groups, file, projectFile, text, revision, pending, canRestart }`. Each group is a
titled list of entries — dotted paths into the config object, with nested blocks expanded to leaves so
one overridden member of `planning` does not make the other three read as chosen — carrying:

| Field                | What it answers                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`, `isDefault` | what it is, and whether _this operator_ chose it — the baseline is the built-in default with the project layer folded in ([02](02-configuration.md#the-project-layer)) |
| `fromProject`        | set when that baseline came from the project's shared config, so a row can name the file it came from and a reset can say what it falls back to                        |
| `type`, `options`    | what widget draws it, from `CONFIG_FIELDS` ([02](02-configuration.md#fields))                                                                                          |
| `access`             | `plain`, `advanced` (behind the disclosure) or `fileOnly` (not offered)                                                                                                |
| `live`               | whether saving it takes effect now, because `configApply.ts` holds an arm for it                                                                                       |
| `env`                | the environment variable currently beating the file, or null                                                                                                           |
| `why`, `ms`          | the one line under the key, and whether the number is a duration                                                                                                       |

`file` is the absolute path a save writes, and `text` is its current contents. `projectFile` is the
targeted project's shared config, or null when that repository carries none — read, never written: it
belongs to the team and changes by a commit. `text` is what the raw editor edits and what the review
step diffs against. `revision` fingerprints that file's current text and rides
back on the save, which is what makes a stale one refusable. `pending` is what has reached the file and
is waiting for a restart. `canRestart` says whether this process has a supervisor to hand off to.

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

Fetched on open rather than polled, for `GET /api/prompts`' reason. Nothing is redacted: `Config` holds
no secrets by construction ([02](02-configuration.md)), and a write path is a new reason that has to
hold rather than a reason to weaken it — no field on the form accepts a credential.

### `POST /api/config`

Save it. Body is `{set?, clear?, baseline}` — dotted paths to set, dotted paths to clear, and the
`revision` the form was built from. Answers `{ok, revision, changes, pending}`, each change saying
whether it was applied or is waiting.

The order is the whole of it, and every step before the write is a refusal that leaves the file
untouched:

1. **409** when `baseline` is not the file's current revision — an editor, or Claude, wrote it in
   between, and a form that wrote anyway would clobber them. The refusal says to reload.
2. **400** for a path nothing declares, one whose field is `fileOnly`, one the environment is already
   beating, or a value of the wrong type for its declared one — `port: "4300"` is refused here rather
   than booting and failing at the point something tries to listen on a string.
3. **400** with **the loader's own message** when the config the candidate file would produce does not
   load. The candidate is built and run through `loadConfig` ([02](02-configuration.md#two-loaders)),
   so the CI policy, the policy kinds, the model policy, the burn watch and the
   reachable-host-with-`auth.enabled: false` refusal all answer for themselves. The form cannot save a
   config the next boot would reject.

Only then is the file written — surgically and atomically ([02](02-configuration.md#writing-the-file))
— and the result applied through the one `LiveConfig.apply` a hand edit also lands on. Broadcasts
`config:changed`.

### `POST /api/config/preview`

The same ladder `POST /api/config` walks, stopping short of the write: `{ok, text, changes}` — the bytes
that would be written, and what applying them would do. Body is the save's, plus an alternative `text`
for the raw arm.

It exists so the review step can promise something about the file. The splice that preserves comments,
key order and every untouched line is server code; a second implementation of it in the cockpit would be
free to disagree with the one that actually writes. One function answers both routes, for the same
reason inverted — a preview that refused _less_ than the save it previews is worse than no preview.

### `POST /api/config/raw`

The whole file, written by hand from the cockpit's Raw file section. Body is `{text, baseline}`.

Deliberately the same ladder and the same apply as the field save. It skips only the per-field checks,
which have nothing to check when the operator has handed over every byte — and it does **not** skip the
loader, so a removed key is refused by name here exactly as it would be at boot. That is what makes the
section an editor rather than a way to brick a deployment.

### `POST /api/config/restart`

Apply a restart-only change: pause dispatch and hand this process off to the supervisor, which
relaunches it on the config the file now holds. Body is `{interrupt?}`.

Two **409**s, with the upgrade route's reasoning — the request is well-formed and the operator is not
wrong, the world is simply not ready. Agents still running is the first (`interrupt: true` stops them;
they come back on the next boot). The second is the honest degradation: a deployment the supervisor did
not start has nothing to come back from an exit, so the restart is refused by name rather than stopping
a harness nothing will relaunch.

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

Fetched on open and **read-only**, both for `GET /api/prompts`' reasons. `POST /api/config` can save
`ci.checks` whole, which is a different thing from a rule editor: the list is ordered and the order is
the semantics, so editing it rule-by-rule is its own shape and its own decision.

### `GET /api/mcp`

How the operator points their **own** Claude Code at this harness, for the config page's MCP tab
([17](17-cockpit.md#the-mcp-tab)): `{ running, serverId, registration: {command, args}, credentialPath,
skillPath, tools }`, read off the live desktop channel ([11](11-mcp-tools.md#the-desktop-channel)).

Fetched on open and read-only, both for `GET /api/prompts`' reasons — the bridge path, the two file
paths and the tool descriptions are all fixed for the life of the process.

**Every field is asked of the channel rather than composed here**, and that is the whole of the route.
`registration` is `McpDesktopServer.registration()`, whose bridge path is resolved from the server
module's own URL, so it is right in a checkout and in a `dist` install without either being a case
anybody has to think about; `tools` is `advertised()`, which is what `tools/list` would answer. A
cockpit that wrote either down would be a second copy of the install instructions, correct on the day
it was written and silently wrong after the next rename — and the failure is a _connected_ server whose
every call is refused, or a command that registers a server pointing at nothing.

`running` is the channel's own `token !== null`. It is a real state and not an error: the stable socket
is refused when another harness holds it, and the tab says so rather than handing over a command that
would reach the other one.

The payload **carries no secret**. The credential is a file the bridge reads at spawn, and this route
names its path only — which is the same property that lets the registration be pasted into a chat, a
runbook or a ticket.

### Launching a blueprint

#### `POST /api/jobs`

Queue an operator job. See [13](13-jobs-and-findings.md). 400 on a missing/empty prompt, a bad `kind`,
a non-string `title` or `branch`; **409** when a code job names a branch a live task holds. Returns
`{ ok: true, job, report }`. A **code** job with a tracker configured is a _blueprint_: the harness
files it as a watched ticket that enters the planning funnel and queues **nothing**, returning
`{ ok: true, ticketRef, report }` with no `job` at all ([13](13-jobs-and-findings.md#filing-a-ticket));
a tracker that refuses the create answers **502**. The branch-collision 409 applies only to the
direct-dispatch arm (a desk job, or a code job with no tracker).

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
- The images are written under **the ref the work ends up on** — `job:<id>` for a blueprint that
  dispatches, `issue:<n>` for one the harness files as a ticket. The number is known before any byte is
  written, so nothing is keyed on a job and then moved, and the image is in front of the whole planning
  funnel from the moment it lands. A create that succeeds and an attachment write that fails is
  recorded rather than raised: the ticket is what the operator asked for. See
  [14](14-persistence.md#blueprint-attachments).

### `POST /api/upnext/order`

Re-order the "Up next" queue (issue #128). Body `{origins: string[]}` — the operator's desired
priority order of candidate origins. **400** when `origins` is not an array of strings, or contains a
duplicate. Replaces the whole override set (ranked `0..n-1`), broadcasts `world:changed`, and runs a
cycle so the new order takes effect immediately. It only re-orders — it never un-holds a held item,
and `manual-job` items stay first regardless — so this is safe to run inline. Returns `{ ok: true, report }`.

### `POST /api/upnext/profile`

Price one queued row. Body `{origin: string, profile?: string}` — which `agentModels`
profile the next dispatch on that origin runs on. Absent or empty **clears** the override, which is
the state a row starts in rather than a third value; the row goes back to its plan's part profile,
its goal's tag, or its rule's own entry.

**400** when `origin` is missing or empty, and when `profile` names one this deployment does not
configure — refused by name at the boundary exactly as the goal pin is, because a control that can
only send what the server sent it is reachable with a bad name only from a stale tab or a hand-rolled
request, and either way a profile that resolves to nothing would price nothing while reading as a
decision taken.

It prices and nothing else: the override never un-holds a held row and never lifts one over the
headroom cut, so like `/api/upnext/order` it is safe to broadcast `world:changed` and run a cycle
inline — which it does, so the queue redraws with the new price and a row that was about to dispatch
takes it. The override is standing rather than one-shot, and is pruned by the same
`upNextOverrideTtlMs` sweep once its origin stops being tracked
([05](05-dispatcher.md#pricing-one-queued-row)). Returns `{ok: true, profile, report}`.

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

**A `close_out` task on a goal whose validation is flagged refuses without a note** (400, stating the
counts), and the note lands on the row as its resolution. Only that kind, only while open, and only
when flagged: asking a note of somebody ticking off "plug the cable in" is the friction that gets the
whole flag ignored. The harness's own settlement of the same task, when it observes the ticket
closed, is unaffected — that is not an operator deciding to move on.
→ [20](20-validation.md)

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

### `GET /api/plans/:id/history`

404 when the plan is unknown. Ships `{ revisions, diff }` — every verdict this plan has had, oldest
first, and the last amendment read as a change (`latestPlanDiff`, null on a plan with one verdict).

**A route of its own rather than a field on `/api/state`**, for the reason the work graph and the
retrospective have theirs: it is read when a plan sheet is opened rather than on every poll, and the
write-ups it carries are the largest prose the store holds — a plan replanned three times would put
three of them into each snapshot. The diff is computed here rather than in the browser because it is a
_reading of the plan_, and a second derivation in the cockpit would be a second answer to a question
the server already answers. → [08](08-planning.md#revisions)

### `POST /api/plans/:id/acceptance`

`{ slug, criterion, met }`. 404 when the plan or the part is unknown; **409 when the text names no
criterion the part declares** — a tick the sheet could never draw again would report a confirmation
nobody would see. Keyed on the criterion's **text**, which is what the store holds, so a re-worded
criterion loses its tick. Broadcasts `dirty` and **runs no cycle**: a reviewer's note about finished
work schedules nothing, and a pulse per checkbox is a pulse per checkbox. Returns `{ ok: true, part }`.
→ [08](08-planning.md#acceptance-ticked)

### `POST /api/plans/:id/part-profile`

`{ slug, profile? }`. Overrides which model profile one part's work runs on — the planner's own sizing
of the part it cut, edited. 404 when the plan or the part is unknown; 400 when `profile` names one this
deployment does not configure. Absent or empty **clears** it, which is not a synonym for naming the
goal's current profile: a cleared part _inherits_, so re-pinning the goal later moves it too.

Unlike the acceptance route above it **runs a cycle**, because this changes what the next dispatch of a
pending part costs and an operator re-pricing one about to go out wants that to land before it does. A
part already dispatched keeps what its task row stored, since resolution happens once, at dispatch.
Returns `{ ok: true, part }`. → [02](02-configuration.md#pinning-one-goal-to-a-profile)

### `POST /api/issues/:number/validation/:checkId/{result,defer,waive,reset}`

Four routes, one write. `result` takes `{result: 'passed'|'failed', note}`, `defer` takes
`{reason, until?}`, `waive` takes `{reason}`, and `reset` takes no body and undoes any of them. The
note is **required and non-empty on all three that carry one**, `/decline`'s discipline: a reading an
operator acts on in a month must not be a state with no account of itself.

`:number` is the **goal**, not a plan: a check belongs to the goal, and the plan was only ever standing
in for it ([20](20-validation.md)). `:checkId` is the check's author-chosen id, never its letter — the
letter is what a person types, the id is what the store is keyed on. **409** when the goal has no such
check _or an amendment has superseded it_: the commonest cause is not a typo but an amendment landing
between the sheet being drawn and the click.

Each writes the check's whole current reading, clearing whatever the last one left behind, and
broadcasts `world:changed`. **None of them runs a cycle** — nothing here schedules work, and a pulse
per checkbox is a pulse per checkbox. Returns `{ ok: true, check }`. → [20](20-validation.md)

### `POST /api/issues/:number/validation/:checkId/handover`

Body `{to: 'fleet' | 'human'}`, and **the only writer of a check's `actor`**. Handing a check to the
fleet is an operator act by construction: no plan document, no amendment and no agent reaches this
route, which is what keeps "an agent may run this" a statement about the deployment rather than a
planner's guess about it. `fleetCandidate` is the planner's argument for pressing it; it is not this.

**409** on an unknown or superseded check, the four routes above's rule. **400** on handing over a
check that already reads `passed`, `failed`, `waived` or `deferred`, pointing at `reset`: rule
`validate-check` only ever runs an `unrun` check, so accepting would take and then never move — and
refusing also protects the reading, since an agent re-running a check behind the person who settled
it would overwrite their answer with its own. Taking a check **back** is always allowed; it stops
something from happening.

Broadcasts `world:changed` and **runs no cycle** — the rule picks the hand-over up on the next pulse
like any other world fact. Returns `{ ok: true, check }`. → [20](20-validation.md#the-hand-over)

### `POST /api/plans/:id/replan`

404 when the plan is unknown. Flips the plan to `planning`, **withdraws any pending plan proposal**
(the amended plan is a new proposal, and the superseded card must not release a plan its
reader never saw), broadcasts, runs a cycle. **Tears nothing down** — see [08](08-planning.md).
Returns `{ ok: true, plan }`.

It is also the **only** way out of a plan approved onto an issue whose flat `issue/<n>` branch was
already taken, whose parts block on the ref collision. There was a `POST /api/plans/:id/abandon`
beside it that retired the unstarted parts and worked the issue as one pull request; that was a
distinct act only while a plan with no parts was a different kind of plan, and it is gone with the
shape. → [08](08-planning.md#when-the-collision-arrives-after-approval)

There were two routes here for discussing a plan, `POST /api/plans/:id/discuss` and `/discuss/end`.
**Both are gone, and nothing replaced them.** Discuss is a `claude://code/new` deep link into the
operator's own Claude Code, which reads the plan and amends it over the desktop MCP channel — so the
click writes nothing at all, and there is no state to restore afterwards. →
[08](08-planning.md#discussing-a-plan), [11](11-mcp-tools.md#the-desktop-channel)

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

### `POST /api/agents/:id/resume`

The one way out of a usage-limit park (issue #318, [10](10-agent-runtimes.md#the-limit-park)). Takes no
body: there is no question and nothing to type, and the session is usually gone, since `claude` exits
with the exhausted account. Re-opens **that** conversation in **that** worktree and tells the agent to
carry on, then broadcasts `dirty` — the row, the fleet's live count and the park chip all ride the
snapshot rather than a frame of their own.

Not `respond`, and the 409 says which of the two ways it was reached: an agent parked on a question of
its own is _answered_, and one whose park a restart has already handed to the recovery desk is decided
there instead. The refusal is the manager's own sentence rather than a flat "not live", because those
are different situations with different next steps.

`POST /api/agents/:id/kill` stays available on a park — it is the only other verdict — and settles it
the way it settles any other agent.

### `POST /api/local-run`

`{issue, ref?}` — start the machine's one dev environment on that goal's code, stopping whatever was
running. **Start is also swap**: one environment, so there is no separate route and no second name for
one transition. Refuses with a 400 and the reason when nothing is configured to start or the checkout
will not prepare.

`ref` runs an earlier part of the goal rather than the tip of its stack. The schema checks its shape
only; that it is one of **that goal's own** part branches is a question about the plan, so the runner
asks it and refuses with the goal named. Both halves are load-bearing — a schema that accepted any
string and a runner that trusted it would make this route a way to check out anything in the
repository. → [23](23-local-runs.md#routes)

### `POST /api/local-run/stop`

No body and no id. There is one run, and "stop whatever is running" is the whole request — an id would
let a stale panel stop a run that had already been swapped out from under it, and would mean the same
thing whenever it was right.

**Answers before the stop has finished.** Taking a dev environment down is a session's turn — the
project's own stop command, because a dev environment is not a process tree and no signal reaches a
container — so the handler starts the teardown, the run goes to the live status `stopping`, and the
runner's own `changed` events carry the rest. Awaiting the turn here would hold a request open for up
to two minutes. → [23](23-local-runs.md#stopping-is-a-turn-not-a-signal)

### `GET /api/local-run/output`

The session's last lines. Fetched rather than shipped on the snapshot: the tail is up to two hundred
lines and the snapshot goes out on every heartbeat and every `dirty`, so putting it there would pay for
a log nobody has open — the argument that keeps the work graph and the prompt book off it too.

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
| `config`                        | `heartbeatIntervalMs`, `maxConcurrentAgents`, `watchLabel`, `containerTypes`, `canFileTickets`.                                                                                                                               |
| `control`                       | The **live** cap and pause state. The cockpit reads these, not the frozen `config` block.                                                                                                                                     |
| `worldObservedAt`               | When `world` was observed — the baseline's `takenAt`. **Null** before the first cycle, when `world` is empty.                                                                                                                 |
| `world`                         | The snapshot, with `health`, `attention` and `ciVerdict` per open PR and `pickup`, `conclusion`, `shortfall`, `assay`, `completion` and `spend` per issue.                                                                    |
| `retainedRuns`                  | Runs whose issue the world has forgotten (#203, #234), rebuilt from their stored snapshots by the same `retainedRunIssues` the dispatcher unions into its issue list, through the same per-issue enrichment a live one takes. |
| `plans`, `planParts`            | The plan graph — the same rows the per-issue chip reads, with `statusCommentRef` as a canonical ref.                                                                                                                          |
| `tasks`                         | Every task, **without prompts** — `TaskSummary`, not `Task`. See _Bulk text_ below.                                                                                                                                           |
| `jobs`                          | Operator jobs, newest first.                                                                                                                                                                                                  |
| `schedules`                     | Recurring blueprints, oldest first — **every** one, paused included, since this is the only surface anywhere that says a paused one exists. What a firing produces is an ordinary entry in `jobs`.                            |
| `agents`                        | Every agent row, including usage and the progress note.                                                                                                                                                                       |
| `flags`                         | Every artifact chip, grouped by the cockpit onto agents.                                                                                                                                                                      |
| `files`                         | Every file every agent wrote.                                                                                                                                                                                                 |
| `attachments`, `attachmentUrls` | Images an operator attached to a blueprint (#249), every ref in one list, plus the capability-carrying URL to load each one's bytes. The cockpit filters by `targetRef`: `job:<id>` while queued, `issue:<n>` once filed.     |
| `overlaps`                      | Paths two concurrently-live code agents wrote.                                                                                                                                                                                |
| `humanTasks`                    | Work only a person can do — open ones and a settled tail, newest first. Beside `findings` rather than inside `escalations`: nobody is parked on one.                                                                          |
| `findings`                      | Every finding.                                                                                                                                                                                                                |
| `escalations`                   | The escalations still waiting on a person — **open only**. See _Bulk text_ below.                                                                                                                                             |
| `recovery`                      | Work the previous run orphaned (a dead agent, or a task no agent ever started), each awaiting restore / requeue / remove. Non-empty ⇒ **the harness is running no cycles**.                                                   |
| `decisions`                     | The last 100 decisions, each with `subjectRef` — the one external thing the act is about (`issue:13`, `pr:42`), or null.                                                                                                      |
| `upcoming`                      | The last cycle's ranked queue with the headroom cut. Null until a cycle has run.                                                                                                                                              |
| `worldEvents`                   | The last 100 world events.                                                                                                                                                                                                    |
| `errors`                        | The last 100 recorded failures.                                                                                                                                                                                               |
| `refUrls`                       | The `ref → URL` map.                                                                                                                                                                                                          |
| `dispatchRules`                 | `DISPATCH_RULES` as data, so a decision row can expand into the rule that fired.                                                                                                                                              |
| `usage`                         | `{windows: {fiveHourCostUsd, sevenDayCostUsd}, rateLimits, unattributedCostUsd}`.                                                                                                                                             |

### Bulk text

**A collection on this snapshot carries no text nobody draws.** The snapshot is refetched on every
`dirty`, `world:changed`, `control:changed`, `world:events` and `cycle:end` — several times a pulse,
per open cockpit — so a bulk column that rides on one of them is not a size cost but a **rate** one,
and it is silent: the payload still validates and the cockpit still renders. The symptom is that every
action takes seconds.

Two collections were the whole of it on a real deployment, where `/api/state` was 24 MB and took 6–15 s
to serve:

- **`tasks` shipped every task's rendered agent prompt** — 17.4 MB of the 24 MB, for 1,248 rows.
  Nothing in `web/src` reads `task.prompt`; it was built, serialised, transferred, parsed and
  discarded. `tasks` is now `TaskSummary[]`, and `Store.listTasks` reads named columns
  ([14](14-persistence.md#tasks)).
- **`escalations` shipped the all-time list** — 373 rows at 0.57 MB, each carrying a 1,200-character
  transcript tail in `context.recentOutput`. Every surface that reads them filters to
  `status === 'open'` first: the needs-you queue, the console band, the view model. It is
  `Store.listOpenEscalations` now, which is a `WHERE` rather than a filter over the all-time read.

The remaining collections were audited against the same rule and hold none: `agents` carries usage
counters and a one-line progress note (its transcript is already a route), `decisions`, `worldEvents`
and `errors` are capped at 100, and `findings`, `humanTasks` and `plans` carry short prose that is
drawn in full.

**The pattern for text a surface does need is a route of its own, fetched on open** —
`GET /api/agents/:id/transcript` is the precedent, and `/api/spend`, `/api/work`,
`/api/retrospectives/:ref` and `/api/scratchpads/:ref` follow it. No route ships a task's prompt,
because no surface asks for one; a surface that wanted one would gain a per-row route beside the
transcript's, never a widening of `tasks` back to `Task`.

`test/snapshotShape.test.ts` pins both: that a shipped task has no `prompt` key and that no prompt text
reaches the payload by any route, and that a settled escalation stays on the server.

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

The local run's `changed` is a fourth, and the only one that is **rate-limited**: it fires per line of
output, and every `dirty` costs every connected cockpit a whole snapshot. So the hub gathers them for
`LOCAL_RUN_COALESCE_MS` (400) and asks once. Nothing subscribed to it at all when the runner shipped,
which is the failure worth naming: the panel's status, phase and log moved no sooner than the next
heartbeat, so a bring-up in progress and one that had hung looked identical for a whole pulse at a
time ([23](23-local-runs.md#saying-what-it-is-doing)).

### The tail

`Hub.updateTail` folds each output delta into a per-agent rolling state (`partial`, `last`). ANSI is
stripped first, so a coloured transcript label never shows as a literal escape in the plain-text
preview (escapes never contain newlines, so stripping before the line split is safe). The partial-line
buffer is capped at 256 characters and the emitted line at 200. The state is dropped when the agent
finishes.

The tail is **ephemeral and per-server**: it lives only in the `Hub`'s map, so a cockpit opened
mid-run shows nothing until the agent's next output. That is precisely the gap `note_progress` fills —
see [11](11-mcp-tools.md).
