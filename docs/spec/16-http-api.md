# 16 — HTTP and WebSocket API

`src/server/app.ts` builds the Fastify instance; `src/server/hub.ts` fans events out to sockets. The
server listens on `0.0.0.0:<port>` and is **unauthenticated** — it is a self-hosted cockpit, and that
is why the MCP tool channel uses a Unix socket with a bearer token rather than a second HTTP surface.

Rate limiting is registered with `global: false`: only routes that opt in are limited, so the
cockpit's frequent state polling is never throttled.

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

404 when the plan is unknown. Flips the plan to `planning`, broadcasts, runs a cycle. **Tears nothing
down** — see [08](08-planning.md). Returns `{ ok: true, plan }`.

### `POST /api/escalations/:id/answer`

Body `{response}`. 400 when the response is missing, the escalation is unknown, or it is not `open`.
Returns `{ ok: true, escalation, routing }`, where `routing` is `typed_into_agent` (the escalation is
tied to a live agent, and the answer went straight into its session) or `queued_for_dispatch` (the
answer is recorded and the next cycle acts on it).

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
| `world`         | The snapshot, with `health` attached per open PR and `pickup` per issue.                                     |
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

Three consistency points:

- **The pickup verdict uses the same inputs rule 4 consults** — the policy, `DEFAULT_COOLDOWN`, the
  world's `takenAt`, tasks, the last 200 decisions, the **unfiltered** open PR list, the plan graph,
  the planning policy, and the same headroom arithmetic — so the chip predicts what happens next cycle.
- **PR health is passed the full open-PR list** as stack context, so an inherited CI failure names the
  PR underneath; otherwise a stacked PR reads as "CI failing" with no agent and no visible reason.
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
