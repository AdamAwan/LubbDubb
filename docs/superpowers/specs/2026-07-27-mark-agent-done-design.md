# Marking an agent done

An operator-declared terminal that lands on `done` rather than `killed`.

## The gap

An agent can end four ways today, and only one of them is a clean finish:

| Path                                       | Agent          | Task          | Worktree                       |
| ------------------------------------------ | -------------- | ------------- | ------------------------------ |
| `@@LUBBDUBB_DONE@@` → `handleTerminal`     | `done`         | `done`        | removed on `reaped`            |
| `kill()` (the cockpit button)              | `killed`       | `interrupted` | kept, deliberately, for triage |
| `interruptAll()` (shutdown)                | `interrupted`  | unchanged     | kept                           |
| process died / non-zero exit               | `failed`       | `failed`      | kept                           |

The clean one is reachable **only by the agent**. So when an agent finishes the work
but never prints the sentinel, an operator who can see the work is done has no way to
say so — the only button is Kill, which records the opposite (`interrupted`), keeps a
worktree nobody needs, and reads in the log as an abandonment.

The common shape is not a crash. In stream mode a turn that ends without the sentinel
does **not** fail: `streamJsonSession.ts` parks the agent `waiting` with _"Agent ended
its turn without finishing; awaiting direction."_ and an escalation is raised. The agent
sits in "Needs you", alive, finished, and un-endable except by Kill.

## What ships

`AgentManager.complete(agentId)` — a sibling of `kill` that stops the process and then
routes through the **same** `handleTerminal(id, taskId, 'done')` the sentinel drives.
Surfaced on the agent card, the agent drawer and the escalation card; audited as the
operator's own act; settles the escalation the agent was parked on.

## Design

### The mechanism

`complete(agentId): boolean`, beside `kill`:

1. **No live session → `false`** (the route 409s, exactly as kill does). Liveness is the
   whole guard: an agent that has already ended is not a candidate, and re-labelling a
   finished record is a different feature with no caller asking for it.
2. **`session.kill()`.** The process has to stop — nothing else ends a REPL that has no
   more turns to take, and the stream child holds its stdin open awaiting direction. The
   session marks itself `killed` internally, which is both fine and load-bearing: that
   flag exists only to stop the _session_ reclassifying its own exit (`ptySession.ts`
   `reportExit`, `streamJsonSession.ts` `onExit`). Here the **manager** decides the
   record, and it decides `done`.
3. **`handleTerminal(agentId, task.id, 'done')`** — the sentinel's own path, reused
   whole: final file-events drain, unpark, transcript flush, agent `done`, task `done`,
   `emit('done')`, `terminals.set('done')`. Nothing about a completed agent should differ
   from a finished one, so nothing about it is written twice.
4. **`exited` is left alone** — the single line where this is the inverse of `kill`,
   which deletes it so a killed agent is never reaped and keeps its worktree. Both
   runtimes emit `exit` _before_ their killed early-return, so the exit still lands,
   `maybeReap` finds `terminals === 'done'`, and `reaped` fires → `system.ts` removes the
   worktree. Credential revocation and spool disposal ride along in `maybeReap` exactly as
   they do for a real done.

Rejected alternatives, so they are not re-derived:

- **Synthesise the sentinel** (write `@@LUBBDUBB_DONE@@` into the session and let the
  existing detector fire). It does not work: on PTY that is `send`, which types text into
  a REPL _as a new prompt_ — the agent carries on working; on stream-JSON there is no
  channel to inject assistant text at all. Detection scans what the **agent** said, and
  the operator is not the agent.
- **Kill, then relabel** (`PATCH /api/agents/:id`). Kill couples three effects — task
  `interrupted`, worktree kept, `exited` deleted so `reaped` never fires. A later status
  edit would have to undo all three, and the reap it suppressed is gone, so the worktree
  would never be cleaned up.

### Consequence, stated

A `done` task frees its origin, so if the world still shows the concern (an unhandled
comment, say) the next pulse may dispatch afresh, throttled by the usual cooldown. This is
identical to a sentinel done and is correct: marking done asserts that _this agent_
finished, not that the work item is closed.

### Surfaces

`POST /api/agents/:id/complete` → `agents.complete(id)`, 409 `agent not live` otherwise —
mirroring the kill route.

- **Agent card + drawer**: a `ConfirmButton` labelled **Mark done** beside Kill, under the
  same `agent.status !== 'done'` condition. Confirm-gated for the reason Kill is: it stops
  a live process.
- **Escalation card**: a ghost **Mark work done** button next to _Open agent transcript →_,
  shown when the escalation has an agent. Deliberately **not** a quick-answer chip — those
  route through `EscalationInbox.answer` → `agents.respond`, which types text into the
  session and flips the agent back to `running`, the opposite of finishing it. Sitting with
  the transcript link is also honest about what it is: an action on the agent, not an answer
  to the question.
- `web/src/api.ts` gains `completeAgent`; the demo backend gains a matching one, or
  `typecheck:web` and knip fail.

### The parked escalation

Marking done must settle the escalation the agent was parked on, or the item stays in
"Needs you" attached to a corpse — precisely the un-actionable clutter
`dismissEscalationsForAgent` exists to clear, and already the reaction to `killed` in
`system.ts`. So the reaction to an operator-declared done belongs in the same place: the
`done` event gains a `by: 'agent' | 'operator'` discriminator and the listener dismisses
with reason _"operator marked the work complete"_.

Narrow on purpose: a **sentinel** done with an open escalation is the same latent class,
but changing that is a separate call and not this feature's to make.

### Audit

`complete()` records a decision under cycle id `human:<agentId>` — the convention
`system.ts` and the proposals path already use for an act decided outside the pulse —
with `outcome: 'executed'` and a detail naming the agent, task and origin.

**No proposal is written.** There is nothing to authorize: the act is the operator's own
and already taken, whereas a proposal is a durable verdict a rule re-reads every pulse.

`DecisionLog` currently badges "you" by resolving `human:<id>` against the **proposals**
list, so a completion row would go unbadged. One two-line change: badge off the `human:`
prefix itself, and let the proposal lookup supply only the note when there is one. Without
it the audit decision above is invisible, which is the same as not making it.

## Testing

`test/agentComplete.test.ts`, at the usual `buildSystem` seam (in-memory SQLite, fake
session runtime):

1. Park a fake agent without a sentinel, complete it → agent `done`, task `done`, session
   gone.
2. Emit the fake process exit → `reaped` fires with `'done'` and the worktree is removed
   (follows `test/worktreeCleanup.test.ts`).
3. The open escalation is settled; `listOpenEscalations()` is empty.
4. A decision row exists under `human:<agentId>`.
5. A non-live agent → 409.

Accepted edges, unchanged from a sentinel done: a process that never exits gets no reap
and keeps its worktree; a branch with another live task on it still blocks removal.
