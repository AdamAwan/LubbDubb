# 11 — The MCP tool channel

`src/mcp/`. Every spawned agent is wired to a tools-only MCP server running **inside the harness**.
Config `mcp.enabled`, **on by default** — it is purely additive: it adds tools an agent may use and
changes nothing about how one is dispatched, parked or finished.

The channel exists because the sentinels and the file-events hook are both **fire-and-forget**. An
agent can announce, but never receive a value back, never learn that what it sent was rejected, and
never ask a question. `plan.json` is the proof: a structured payload smuggled through an
artifact-detection hook, whose validation failure the planner never hears, costing a whole agent to
discover what a synchronous error would have said in one turn.

## The five tools

`src/mcp/names.ts` lists them; `src/mcp/tools.ts` builds them.

| Tool             | Purpose                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `plan_submit`    | Submit a decomposition verdict. Replaces writing `.lubbdubb/plan.json`.                   |
| `escalate`       | Ask the human a question and park. The typed form of the WAITING sentinel.                |
| `world_read`     | Read the harness's own view of a PR, issue or story.                                      |
| `report_finding` | File something noticed outside the agent's own task.                                      |
| `note_progress`  | Say in one line what the agent is working on right now.                                   |

### The `_status` envelope

**Every** tool response carries `_status`, which is what removes the need for a polling tool: an agent
that calls anything at all learns its origin, whether a human is currently parked on it, and how its
plan is progressing.

```ts
{
  origin: string | null,
  task: { title, status },
  awaitingHuman: { prompt } | null,
  plan?: { status, parts: { slug, status }[] }   // present when the agent's issue has a plan
}
```

### `plan_submit`

Arguments `{verdict: 'single'|'parts', reason, parts?}`. Refused unless the caller's origin is a
planning origin (`planOriginIssue(task.originRef)`). Validated with the **same** `PlanDocumentSchema`
the file path uses; on rejection the reason is returned and **nothing is written**, so the caller
retries against an unchanged plan graph. On success it routes through the shared `ingestPlanDocument`,
and reports `{accepted, status, retired}` plus a `warning` when a `single` verdict was overridden.

### `escalate`

Arguments `{question, kind?: 'approve'|'choose'|'clarify'|'review', options?, detail?}`. Routes through
`AgentManager.ask` → the same `handleWaiting` the WAITING sentinel drives, so the whitelist, the drain
and the store writes cannot diverge between the two. Whichever detector fires first owns the park; the
`parked` latch makes the second a no-op. An agent that calls `escalate` **and** prints the sentinel
raises one escalation, not two.

Returns `{parked, escalationId, note}`. An `escalationId` of `null` means an operator whitelist rule
auto-answered it and the agent was never parked — said explicitly, rather than implying a human saw it.

### `world_read`

Arguments `{kind: 'pr'|'issue'|'story', ref?}`. Closes the `gh`-shell-out gap: an agent that needed a
PR's CI status or review comments had to shell out, which is provider-coupled (nothing works under
`azure`) and re-fetches what the pulse already holds.

- **The source is `Store.getWorldBaseline()`** — exactly what `Harness.recordWorldChanges` persists
  each pulse. No provider fan-out per agent, no provider-shaped payload, and the agent sees the world
  the dispatch decision was made against. It is a pulse-old reading and says so (`observedAt`). Before
  the first cycle it errors informatively rather than throwing. **This must never be routed to a
  connector** — that coupling is what the tool exists to remove.
- **Same verdicts as the cockpit, from the same functions**: `prHealth`, `basePrOf`,
  `inheritedCiFailure`, over the **unfiltered** open list so an `-ignore`d base still attributes. An
  agent told `CI failing on base PR #7` and an operator reading the same phrase are reading one fact.
- **A closed PR is still readable** — "did the PR my branch is stacked on actually merge, or was it
  abandoned?" is exactly the question the closed-PR window answers.
- **An issue additionally carries its plan graph**, which lives only in the store.
- **`ref` is suffix-tolerant, kind-strict.** `pr:42:ci`, `issue:12:part:schema` and `issue:12:plan` all
  name their world item, so the origin ref from `_status.origin` passes back verbatim; bare `42` and
  `#42` work too. Omitting `ref` defaults to the caller's own origin. A prefix that contradicts `kind`
  is an **error**, not a guess. A miss lists the refs the harness is tracking (up to 20), so discovery
  needs no second mode.

`world_read` is **deliberately a general read, not confined to the caller's origin**, and
`test/mcpChannel.test.ts` says so. The dispatcher's own reasoning is cross-item, so an agent's is too:
a stacked PR's red CI belongs to the PR underneath it, a part's context is its siblings, a PR-fix agent
wants the issue it resolves. Fencing it would send an agent that was just told "CI failing on base PR
#7" straight back to `gh`. What structural identity protects is **writes**; a read forges nothing and
mutates nothing, and the cockpit already serves this same snapshot unauthenticated over HTTP while
this path needs a 0600 bearer token. What *is* kept: an agent can only name items the harness already
holds, in the harness's own vocabulary — no query, no provider passthrough, no path or URL argument,
so it cannot reach another repository or project.

### `report_finding`

Arguments `{kind: 'duplicate'|'blocked'|'out_of_scope', summary, ref?}`. See
[13](13-jobs-and-findings.md) for the full vocabulary and the promotion path. Three properties:

- **It queues nothing, and that is the design.** A queued job is dispatched by rule 0 ahead of every
  world-driven rule, so an agent that could queue jobs could put agents on the fleet — a capability
  escalation. Promotion is an operator's click. The tool's description **and** its response say so, so
  an agent does not report a bug and then assume its fix is scheduled.
- **Identity is structural, with full force.** The schema is `{kind, summary, ref}` and nothing else;
  `agentId`/`taskId`/`originRef` come from the credential. This is a write that puts words in an
  agent's mouth in front of an operator and is read as testimony about work its author actually did.
- **`ref` is kind-strict and a bare number is refused.** Unlike `world_read` there is no `kind`
  argument to say whether `41` is an issue or a PR, and a duplicate report must not guess. Anything
  off-vocabulary is refused with "omit ref, describe it in the summary".

### `note_progress`

Argument `{note}`. The agent's own answer to "what is it doing, and is it stuck?".

It sits **beside** `agent:tail`, never replacing it. Same asymmetry as `@@LUBBDUBB_DONE@@` against the
`result` event: a note an agent forgets to call is *silence*, and silence must not read as "no
progress". An agent that never calls it leaves a card identical to the pre-tool one — there is no
placeholder and nothing inferred from output. Where both exist the card shows both: the note is a
claim (durable, attributed, as old as its timestamp), the tail is evidence the process is still
emitting.

- **Latest value, so a column and not a table.** One row per call would be an audit trail, and that
  trail already exists — every call is a tool use in the agent's transcript, in order, with context. A
  second lossier copy in SQLite answers nothing new. Exactly one current reading is kept: `note` +
  `noted_at` on the `agents` row, overwritten per call, riding to the cockpit inside `listAgents()`
  with no new snapshot key, route or panel. The note deliberately outlives the agent — a finished
  agent's last note is the one-line summary of the run.
- **`notedAt` is display context, never liveness.** Nothing derives a staleness or health verdict from
  it, and `test/mcpChannel.test.ts` asserts no derived field appears on the shipped agent. The longest
  gaps between notes are long test runs and big refactors — the healthiest stretches — so reading age
  as "stuck" would punish honest use and turn an optional note into a heartbeat.
- **One field.** There is no `stage` enum, because the only member that would imply an operator action
  is `blocked`, and `escalate` already owns that and does it properly.
- **Trimmed, not rejected.** An over-long note is collapsed to one line, cut to `MAX_NOTE_LENGTH`
  (200) with an ellipsis, and **stored**, with the trim reported back. The opposite of
  `report_finding`, because a finding is testimony an operator acts on while a note is a status line
  whose value is being cheap and frequent. Only an empty note is refused.

It routes through `AgentManager.recordProgress` for the `progress` event, which the `Hub` turns into a
plain `dirty` (unlike `agent:tail`, the payload is already on the row the refetch brings).

## Identity

**Identity is structural, not argued — for every write.** No write tool takes an agent, task or issue
argument. The credential minted at spawn resolves `token → agent → task → origin`, so an agent cannot
name itself and therefore cannot address another's work. This is what the `planOriginIssue` fencing was
approximating over a transport that carried no identity at all.

The token is a **bearer credential**: it lives in the 0600 launch-config file, never in argv (where
`ps` would show it), and it is revoked on kill, interrupt and reap. A resume mints a fresh one for the
same agent row.

## Transport

A **Unix domain socket** (named pipe on Windows), never a TCP port — the cockpit's HTTP surface is
already unauthenticated on `0.0.0.0`, and a second one with fleet-wide write access to the store is not
a trade worth making.

- Socket path: `<tmpdir>/lubbdubb/mcp-<pid>.sock`, or `\\.\pipe\lubbdubb-mcp-<pid>`. Per-pid, so two
  harnesses on one machine do not fight, and under the OS tmpdir to stay inside the ~104-character
  POSIX limit on socket paths.
- Launch configs: `<tmpdir>/lubbdubb/mcp/<token>.json`, written with mode `0600`.
- `bridge.mjs` (spawned by `claude`, shipped `.mjs` like `statusCapture.mjs`) is a **byte-transparent
  pipe with no protocol logic**, so `initialize` / `tools/list` / `tools/call` / validation all live in
  `protocol.ts` and `tools.ts` and are testable with no transport at all.
- A connection that does not hand over a token first is **dropped unanswered**. The handshake line is
  `{"lubbdubb":1,"token":"…"}`; everything after it is newline-delimited JSON-RPC 2.0.

`listen()` removes a stale socket file from a crashed run before binding — binding is the only way to
tell a dead socket from a live one, and a live one means another harness owns the path.

## The wire protocol

`src/mcp/protocol.ts`, pure. MCP revision `2024-11-05`. Only the methods a tools-only server must
answer are implemented; anything else returns a proper `method not found` rather than silence, so a
client mismatch shows up as an error instead of a hang.

| Method                                            | Behaviour                                                    |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `initialize`                                      | Echoes the version, `capabilities: {tools:{}}`, `serverInfo`. |
| `notifications/initialized`, `notifications/cancelled` | Returns nothing (notifications take no frame).           |
| `ping`                                            | `{}` for a request; nothing for a notification.              |
| `tools/list`                                      | Name, description and input schema for each tool.            |
| `tools/call`                                      | Runs the named tool.                                         |

`handleRequest` **never throws**: a handler that blows up becomes an `isError` tool result, so an agent
gets a message it can act on instead of a dead channel. That is the whole point of the tool path over
the `plan.json` one.

`resolve(token)` failures are handled asymmetrically on purpose: `initialize` and `tools/list` are still
answered (with an empty tool set) so a bridge that raced ahead of `bind` completes its handshake and can
retry; only an actual `tools/call` needs a real identity, and it gets the reason as a handled error.

## Launch flags

Both verified empirically against `claude` 2.1.220 in headless `-p` mode, not assumed:

- **`--mcp-config` is additive.** Launched in a cwd holding its own `.mcp.json`, the init event reports
  `mcp_servers: [{theirs}, {ours}]`. `--strict-mcp-config` is therefore deliberately **not** passed: it
  would suppress the user's own servers in the user's own checkout.
- **`--allowedTools ALLOWED_MCP_TOOLS` is required, not defensive.** An `--mcp-config` server connects
  with no approval step (a project `.mcp.json` server instead sits at `pending`), but its tool *calls*
  are still permission-gated, and `acceptEdits` — the default `agentPermissionMode` — does not cover
  them. Without the flag every call returns `"Claude requested permissions to use mcp__lubbdubb__…, but
  you haven't granted it yet."` with no human at the prompt. The flag is **additive, not restrictive**:
  an agent launched with it still uses Bash and Write normally.

This is why `src/mcp/names.ts` exists. Three things must agree — the `mcpServers` key
(`MCP_SERVER_ID = 'lubbdubb'`), the tool names, and the `mcp__<key>__<tool>` grants — and drift between
them yields a *connected* server whose every call is refused, invisible until an agent needs it.
`test/mcpChannel.test.ts` asserts all three against each other. **Adding a tool to `buildTools` without
adding its name to `MCP_TOOL_NAMES` is the sharp edge of the whole module.**

## Degradation

The sentinels remain the floor everything degrades to. `MCP_PROTOCOL_ADDENDUM` states a *preference*,
never a replacement, and `@@LUBBDUBB_DONE@@` has **no tool at all**: MCP has no turn-boundary event, so
a `finish()` the model forgets to call is silence, and silence is indistinguishable from thinking. The
`result` event plus the sentinel is what disambiguates *finished* from *stopped mid-task*.

Every one of these leaves behaviour byte-for-byte as it was without the channel, and
`test/mcpChannel.test.ts` asserts that floor rather than merely intending it:

- `mcp.enabled: false`
- `listen()` returning false (socket unavailable)
- An unwritable launch-config file (that one agent falls back; the rest are unaffected)
- A `claude` that ignores the server

In each case `open()` hands back a null `configPath`, no `--mcp-config` is passed, and the agent runs on
the sentinels alone.

## Testing

Tests drive `mcp.session(agentId)`, which converges on the same `dispatch` an agent's bridge reaches —
**there is no test-only tool path.** `npm run smoke` runs a real `bridge.mjs` child over a real socket,
which is the half unit tests cannot cover.

## `claim(ref)` — investigated and closed

Not an omission. **Origin and branch are 1:1 for every world-driven dispatch rule**, so the
`activeOrigins` / `findActiveTaskByOrigin` gate already *is* a branch gate, and the existing gates leave
no dispatch-time collision for a claim to prevent. What they cannot see is what an agent does once
running — and a claim cannot fix that either: **advisory** makes it documentation an agent may forget,
**enforcing** needs a lock that vanishes under `mcp.enabled: false` (a lock that silently is not one),
and **letting the dispatcher read claims** would let an agent suppress another's dispatch. The
structural detector in [12](12-artifacts-and-files.md) is what shipped instead.
