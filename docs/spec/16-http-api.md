# 16 — HTTP and WebSocket API

`src/server/app.ts` builds the Fastify instance; `src/server/hub.ts` fans events out to sockets. The
server listens on `config.host:<port>`, defaulting to **loopback** (`127.0.0.1`), and every `/api/*`
route and the `/ws` socket require a **bearer token** — see [Authentication](#authentication) below.
The MCP tool channel still uses a Unix socket rather than a second HTTP surface: a socket with 0600
file permissions is a stronger boundary than a token for a channel with fleet-wide write access to
the store, and it needs no credential in an agent's argv.

Rate limiting is registered with `global: false`: only routes that opt in are limited, so the
cockpit's frequent state polling is never throttled.

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
`test/cockpitAuth.test.ts` asserts this by walking the route table in `app.ts` and requiring a 401
from each. The SPA shell and its assets are deliberately unguarded: the token arrives in a URL
fragment the browser never sends, so the page has to load before it can authenticate, and it holds
no world state of its own.

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

### `GET /api/artifacts/:id`

Serves a local artifact an agent flagged, **addressed by flag id**. Rate-limited to 120/minute.
Confined, sandboxed and content-typed — see [12](12-artifacts-and-files.md). 404 for an unknown flag,
a missing agent or a path that escapes confinement; 400 for a URL ref (the cockpit links those
directly).

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

### `POST /api/inject`

**403 unless a `fake` provider is configured** — defence in depth, since the cockpit also hides the
panel. 400 on a body with no string `kind`. Applies the event, broadcasts `world:changed`, runs a
cycle, and returns `{ ok: true, report }`.

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

### `GET /api/work`

The durable work graph's roots — every node with no parent — plus `unrecorded`: work the harness did
that nothing in the tracker accounts for. Rate-limited rather than polled; the cockpit's Work panel
fetches it on open, because `/api/state` comes round every couple of seconds and the graph only ever
grows. Returns `{ roots, unrecorded }`. Each unrecorded entry carries `ignored` — an item the operator
cleared is still reported, because the panel is what hides it and a row filtered out at the source has
no title left to offer back under the un-ignore.

### `GET /api/work/:ref`

One subtree, walked from the given root by `parent_ref`. 404 when the ref names no node. Refs carry
colons (`issue:12`, `pr:41:ci`), so the route has to survive one in a path segment. Each node's URL is
resolved through the connector's own `resolveRefUrl` rather than read off the snapshot's `refUrls` —
that map is built from the world, and a PR the graph remembers merging left the world hours ago.
Returns `{ nodes, refUrls }`.

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
effect", and the honest answer is "at the next restart". `dispatcher` rides along so the panel can say
that under `dispatcher: 'claude'` the LLM composes its own prompts and none of this book fires.

### `POST /api/stories/:id/watch`

The same, for a story id, routed to the fake backlog's `StoryLabelCapable`.

### `POST /api/jobs`

Queue an operator job. See [13](13-jobs-and-findings.md). 400 on a missing/empty prompt, a bad `kind`,
a non-string `title` or `branch`; **409** when a code job names a branch a live task holds. Returns
`{ ok: true, job, report }`.

### `POST /api/upnext/order`

Re-order the "Up next" queue (issue #128). Body `{origins: string[]}` — the operator's desired
priority order of candidate origins. **400** when `origins` is not an array of strings, or contains a
duplicate. Replaces the whole override set (ranked `0..n-1`), broadcasts `world:changed`, and runs a
cycle so the new order takes effect immediately. It only re-orders — it never un-holds a held item,
and rule-0 jobs stay first regardless — so this is safe to run inline. Returns `{ ok: true, report }`.

### `POST /api/jobs/:id/cancel`

409 when the job is absent or no longer queued. Returns `{ ok: true, job }`.

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

### `POST /api/plans/:id/replan`

404 when the plan is unknown. Flips the plan to `planning`, **withdraws any pending plan proposal**
(the amended verdict is a new proposal, and the superseded card must not release a decomposition its
reader never saw), broadcasts, runs a cycle. **Tears nothing down** — see [08](08-planning.md).
Returns `{ ok: true, plan }`.

### `POST /api/plans/:id/discuss`

No body. 404 when the plan is unknown. **Discuss is a replan with a conversational planner** — same
mechanism as `/replan` (flips the plan to `planning`, withdraws any pending plan proposal for the same
reason), plus sets `plans.discussing`, which is the one thing that tells rule 3c to render the
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

Body `{response}`. 400 when the response is missing, the escalation is unknown, or it is not `open`.
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

### `POST /api/recovery/:agentId`

Body `{verdict}`, one of `restore` / `requeue` / `remove` — what happens to an agent the previous run
left orphaned (see [10](10-agent-runtimes.md#crash-recovery)). **While any of these is outstanding the
harness runs no cycles at all**, so this route is the only thing that can un-hold a booted-after-a-crash
harness; it therefore applies the verdict inline rather than emitting an action for a pulse that cannot
run to pick it up.

400 on an unknown verdict. **409 when the agent is not awaiting a decision** (already decided, or never
a candidate), and **409 when the verdict cannot be applied** — a `restore` for an agent with no session
id, no worktree, or on a runtime that cannot resume. A refusal is not a decision: the item stays
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

## The state snapshot

`buildStateSnapshot(system)` assembles everything the cockpit needs in one response. Several values are
read **once** and shared, so two parts of the UI cannot disagree.

| Key                  | Contents                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `config`             | `heartbeatIntervalMs`, `maxConcurrentAgents`, `dispatcher`, `steeringPriorities`, `watchLabel`, `ignoreLabel`, `injectable`.  |
| `control`            | The **live** cap and pause state. The cockpit reads these, not the frozen `config` block.                                     |
| `worldObservedAt`    | When `world` was observed — the baseline's `takenAt`. **Null** before the first cycle, when `world` is empty.                 |
| `world`              | The snapshot, with `health` and `attention` attached per open PR and `pickup` per issue.                                      |
| `plans`, `planParts` | The plan graph — the same rows the per-issue chip reads.                                                                      |
| `tasks`              | Every task.                                                                                                                   |
| `jobs`               | Operator jobs, newest first.                                                                                                  |
| `agents`             | Every agent row, including usage and the progress note.                                                                       |
| `flags`              | Every artifact chip, grouped by the cockpit onto agents.                                                                      |
| `files`              | Every file every agent wrote.                                                                                                 |
| `overlaps`           | Paths two concurrently-live code agents wrote.                                                                                |
| `findings`           | Every finding.                                                                                                                |
| `escalations`        | Every escalation.                                                                                                             |
| `recovery`           | Agents the previous run orphaned, each awaiting restore / requeue / remove. Non-empty ⇒ **the harness is running no cycles**. |
| `decisions`          | The last 100 decisions.                                                                                                       |
| `upcoming`           | The last cycle's ranked queue with the headroom cut. Null until a cycle has run, or under the LLM dispatcher.                 |
| `worldEvents`        | The last 100 world events.                                                                                                    |
| `errors`             | The last 100 recorded failures.                                                                                               |
| `refUrls`            | The `ref → URL` map.                                                                                                          |
| `dispatchRules`      | `DISPATCH_RULES` as data, so a decision row can expand into the rule that fired.                                              |
| `usage`              | `{windows: {fiveHourCostUsd, sevenDayCostUsd}, rateLimits}`.                                                                  |

Four consistency points:

- **The pickup verdict uses the same inputs rule 4 consults** — the policy, `DEFAULT_COOLDOWN`, the
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
- **`refUrls` covers closed PRs too**, since the cockpit's "recently closed" section links their
  numbers, and it resolves finding refs directly (a finding often names an item not in the world).

`usage.windows` are summed from `usage_events` (all modes, self-computed); `usage.rateLimits` is the
freshest PTY status-line payload, or `null`, in which case the cockpit chip falls back to cost.

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
