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

### `POST /api/stories/:id/watch`

The same, for a story id, routed to the fake backlog's `StoryLabelCapable`.

### `POST /api/jobs`

Queue an operator job. See [13](13-jobs-and-findings.md). 400 on a missing/empty prompt, a bad `kind`,
a non-string `title` or `branch`; **409** when a code job names a branch a live task holds. Returns
`{ ok: true, job, report }`.

### `POST /api/jobs/:id/cancel`

409 when the job is absent or no longer queued. Returns `{ ok: true, job }`.

### `POST /api/findings/:id/promote`

404 when absent, 409 when not `open`, 400 on a bad `kind`. Body may override `title`, `prompt` and
`kind`. Creates the job, then resolves the finding, broadcasts, and runs a cycle. Returns
`{ ok: true, finding, job, report }`.

### `POST /api/findings/:id/dismiss`

409 when absent or already resolved. Returns `{ ok: true, finding }`.

### `POST /api/plans/:id/replan`

404 when the plan is unknown. Flips the plan to `planning`, **withdraws any pending plan proposal**
(the amended verdict is a new proposal, and the superseded card must not release a decomposition its
reader never saw), broadcasts, runs a cycle. **Tears nothing down** — see [08](08-planning.md).
Returns `{ ok: true, plan }`.

### `POST /api/escalations/:id/answer`

Body `{response}`. 400 when the response is missing, the escalation is unknown, or it is not `open`.
**409 when the item carries a pending proposal** (a merge, a drafted reply, or a plan's
decomposition): free text cannot be branched on, so answering here would settle the inbox item while
leaving the proposal pending. The error names the accept/reject routes that do settle it.
Returns `{ ok: true, escalation, routing }`, where `routing` is `typed_into_agent` (the escalation is
tied to a live agent, and the answer went straight into its session) or `queued_for_dispatch` (the
answer is recorded and the next cycle acts on it). **Also 409 when the item is a permission request**
(`context.permission`, issue #130) — the agent is blocked in a tool call, not at a prompt, so the
error names the permission route below.

### `POST /api/escalations/:id/permission`

Body `{allow: boolean, note?}`. Allow or deny a permission request an agent is blocked on (issue #130).
Resolves the blocked `--permission-prompt-tool` call with the operator's verdict and settles the inbox
item; the same live agent then continues (allow) or reads the denial (deny). 400 when `allow` is not a
boolean; **409 when no pending permission request is attached** (already decided, or the agent died
first). Returns `{ ok: true, allowed }`.

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

| Key             | Contents                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `config`        | `heartbeatIntervalMs`, `maxConcurrentAgents`, `dispatcher`, `steeringPriorities`, `watchLabel`, `ignoreLabel`, `injectable`. |
| `control`       | The **live** cap and pause state. The cockpit reads these, not the frozen `config` block.                   |
| `world`         | The snapshot, with `health` and `attention` attached per open PR and `pickup` per issue.                     |
| `plans`, `planParts` | The plan graph — the same rows the per-issue chip reads.                                               |
| `tasks`         | Every task.                                                                                                |
| `jobs`          | Operator jobs, newest first.                                                                               |
| `agents`        | Every agent row, including usage and the progress note.                                                    |
| `flags`         | Every artifact chip, grouped by the cockpit onto agents.                                                   |
| `files`         | Every file every agent wrote.                                                                              |
| `overlaps`      | Paths two concurrently-live code agents wrote.                                                             |
| `findings`      | Every finding.                                                                                             |
| `escalations`   | Every escalation.                                                                                          |
| `decisions`     | The last 100 decisions.                                                                                    |
| `upcoming`      | The last cycle's ranked queue with the headroom cut. Null until a cycle has run, or under the LLM dispatcher. |
| `worldEvents`   | The last 100 world events.                                                                                 |
| `errors`        | The last 100 recorded failures.                                                                            |
| `refUrls`       | The `ref → URL` map.                                                                                       |
| `dispatchRules` | `DISPATCH_RULES` as data, so a decision row can expand into the rule that fired.                            |
| `usage`         | `{windows: {fiveHourCostUsd, sevenDayCostUsd}, rateLimits}`.                                                |

Four consistency points:

- **The pickup verdict uses the same inputs rule 4 consults** — the policy, `DEFAULT_COOLDOWN`, the
  world's `takenAt`, tasks, the last 200 decisions, the **unfiltered** open PR list, the plan graph,
  the planning policy, and the same headroom arithmetic — so the chip predicts what happens next cycle.
- **PR health is passed the full open-PR list** as stack context, so an inherited CI failure names the
  PR underneath; otherwise a stacked PR reads as "CI failing" with no agent and no visible reason.
- **The attention verdict sits beside health, never inside it** — health answers *can this merge*,
  attention answers *whose turn is it*, and they have different right answers for the same PR (see
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

| Event                 | Payload                                    | Delivery                     |
| --------------------- | -------------------------------------------- | ---------------------------- |
| `dirty`               | —                                           | broadcast; "re-fetch `/api/state`" |
| `cycle:start`         | `cycleId`, `source`                         | broadcast                    |
| `cycle:end`           | `cycleId`, `rationale`, `summary`           | broadcast (+ `dirty`)        |
| `world:events`        | `events`                                    | broadcast (+ `dirty`)        |
| `world:changed`       | —                                           | broadcast by mutating routes |
| `control:changed`     | `cap`, `paused`                             | broadcast                    |
| `agent:output`        | `agentId`, `delta`                          | **subscribers only**         |
| `agent:tail`          | `agentId`, `line`                           | broadcast                    |
| `agent:flag`          | `flag`                                      | broadcast (+ `dirty`)        |
| `agent:finding`       | `finding`                                   | broadcast (+ `dirty`)        |
| `agent:status`        | `agentId`, `taskId`, `status`               | broadcast (+ `dirty`)        |
| `agent:waiting`       | `agentId`, `taskId`, `reason`               | broadcast (+ `dirty`)        |
| `agent:done`          | `agentId`, `taskId`, `status`               | broadcast (+ `dirty`)        |
| `escalation:created`  | `escalation`                                | broadcast (+ `dirty`)        |
| `escalation:answered` | `escalation`, `routing`                     | broadcast (+ `dirty`)        |
| `escalation:dismissed`| `escalation`                                | broadcast (+ `dirty`)        |
| `error:logged`        | `error`                                     | broadcast (+ `dirty`)        |

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
