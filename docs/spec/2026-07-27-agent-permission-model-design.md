# Agent permission model (issue #130)

## The problem

The documented default configuration cannot complete a coding task unattended.
`agentMode: 'stream'` and `agentPermissionMode: 'acceptEdits'` are both defaults, and
`acceptEdits` auto-accepts *file edits only*. Every `Bash` call — `npm run check`, `git`,
`gh` — still falls through to the permission prompt, and headless stream mode has no human
there. So an agent edits code, then parks the instant it tries to validate or push, printing
an escalation asking the operator to "grant Bash permissions in harness settings (not chat)".

That escalation is **unanswerable by construction**: the gate is a launch flag, not a
conversation, so the operator's only move is to edit config and restart — which loses the
agent. The one workaround, `agentPermissionMode: 'bypassPermissions'`
(`--dangerously-skip-permissions`), works but is all-or-nothing: it removes every gate at once
in a worktree of the real repo with the operator's shell environment (and `gh` auth) inherited,
and is refused outright under root.

## The decision

Two mechanisms, mirroring the split `autoSend` already makes for outbound actions —
**authorise the routine, ask about the rest**:

- **Phase A — a harness-owned allow-list** (`agentAllowedTools`) merged into the launch's
  `--settings` as a `permissions.allow` fragment. It pre-approves exactly the mechanical
  validate/commit/push commands so the default config completes a task unattended, without
  `bypassPermissions`.
- **Phase B — a permission backstop.** Anything *outside* the allow-list is routed to the
  operator through Claude Code's `--permission-prompt-tool` seam: a new `request_permission`
  MCP tool blocks the tool call, files an escalation in "Needs you", and returns the operator's
  allow/deny verdict to the *same* live agent. The agent is not lost, and a refusal does not
  orphan the task.

Phase A carries the happy path; phase B is the safety net for whatever the allow-list misses.
Because Claude Code evaluates allow rules *before* the permission-prompt-tool, an allowlisted
command never reaches phase B — so the unattended path stays synchronous and phase B only fires
for genuinely unusual commands, which are exactly the ones a human should see.

`agentPermissionMode` stays available and unchanged, root-refusal caveat included.

## Phase A — the allow-list

### Why `--settings`, not `--allowedTools` or `claudeArgs`

- **`claudeArgs: ["--allowedTools", …]` costs the MCP channel.** Operator args are appended
  last, and an explicit `--allowedTools` there takes the last word over the harness's own — so
  allowlisting `Bash(...)` silently drops the `mcp__lubbdubb__*` grants and every tool call is
  refused. That is the invisible drift `src/mcp/names.ts` exists to prevent.
- **Permission rules ride in `--settings`**, a *separate* flag from `--allowedTools`. Bash
  allow rules go under `permissions.allow`; the MCP grants stay on `--allowedTools`. Two flags,
  two concerns — the operator **cannot** drop the MCP grants by adjusting Bash access, by
  construction. This is the mechanism Claude Code intends for this, and it composes with the
  target repo's own settings the way the file-events hook fragment already does (merge, not
  last-one-wins).

### Shape

`collectSettings` (`src/agents/agentProtocol.ts`) already merges `STATUS_LINE_SETTINGS` and
`FILE_EVENTS_SETTINGS` into one `--settings` object (the flag has no array form). It gains a
third fragment: `{ permissions: { allow: agentAllowedTools } }`. The three top-level keys
(`statusLine` / `hooks` / `permissions`) are disjoint, so the merge is lossless. The **stream**
launch is switched to `collectSettings` too (it previously inlined only the file-events
fragment), so the allow-list reaches headless agents — the production default.

`agentAllowedTools` default (Claude Code rule syntax, colon-prefix match):

```
Bash(npm:*)  Bash(npx:*)  Bash(pnpm:*)  Bash(yarn:*)  Bash(node:*)  Bash(git:*)  Bash(gh:*)
```

The JS toolchain (validate), git (commit/push), gh (open the PR) — the commands a coding agent
must run to take an issue to an opened PR. Everything else falls through to phase B.

## Phase B — the permission backstop

### Mechanism

`--permission-prompt-tool mcp__lubbdubb__request_permission` designates an MCP tool Claude Code
calls whenever a tool request is resolved by neither the allow rules nor the permission mode
(the headless equivalent of the SDK `canUseTool` callback). The tool receives the pending
`tool_name` + `input` and must return **bare** JSON — `{"behavior":"allow","updatedInput":…}`
or `{"behavior":"deny","message":…}` — in its content, *without* the `_status` envelope every
other LubbDubb tool carries.

### Why a live registry, not a `Proposal`

A `Proposal` is a durable verdict re-read every pulse against persistent world state, with
settle windows and world-signal expiry (`proposalHold`). A permission request is the opposite:
**ephemeral and single-shot** — Claude is blocked on an open socket *right now*; if the harness
restarts, the blocked call dies with the process and there is nothing to re-read. Reusing
Proposals would bolt an in-memory Promise map onto machinery whose settle/expiry semantics are
actively wrong here (a denied command must not *hold* future permission checks). So phase B is a
small in-memory `PermissionDesk`, not a proposal kind.

### The parts

- **`PermissionDesk` (`src/agents/permissionDesk.ts`).** Holds `Map<escalationId, {agentId,
  resolve}>`. `request(agent, task, toolName, input)` files an `Escalation`
  (type `grant_permission`, `context.options: ['Allow','Deny']`, the tool + a one-line input
  summary in context) via the existing `EscalationInbox` — so it renders in "Needs you" and
  streams to the cockpit for free — then returns a Promise keyed by that escalation id.
  `decide(escalationId, allow, note)` resolves the Promise with the verdict and answers the
  escalation. `denyAll(agentId, reason)` resolves every pending request for an agent as deny.
- **`AgentToolTarget.requestPermission`.** The tool layer reaches the desk the same way
  `escalate`/`report_finding` reach the fleet. Identity is structural: the handler derives the
  agent from the credential — it takes no agent argument. The handler returns
  `toolJson({behavior,…})` directly (never `ok()`, which would add `_status`; never `toolError`,
  which Claude reads as a *failure* not a structured verdict).
- **Decision endpoint.** `POST /api/escalations/:id/permission` `{allow, note?}` → `decide`.
  A `grant_permission` escalation must *not* go through the ordinary
  `POST /api/escalations/:id/answer` (which types the answer into the agent's stdin via
  `agents.respond` — wrong, the agent is blocked inside a tool call, not at a prompt), so answer
  refuses it and names the permission route, mirroring how it already refuses an escalation with
  a pending proposal.
- **The cockpit** renders Allow/Deny buttons for a `grant_permission` escalation
  (`EscalationCard`), posting to the permission route.
- **Cleanup at the choke point.** A killed/failed/reaped agent must not leave Claude blocked.
  `denyAll(agentId)` is called from `McpBridgeServer.release(token)` — the single point
  `AgentManager.releaseMcp` hits on *every* terminal path (kill, interruptAll, maybeReap). The
  existing cascade in `system.ts` dismisses the open escalation; the desk resolves the Promise.

### The latency cost, stated

An agent blocked on a permission request holds its concurrency slot until the operator clicks
(or the agent is killed). There is deliberately **no auto-timeout-deny**: a silent timeout would
tell the agent a command is forbidden when the operator merely hadn't looked, which is worse than
waiting. Because phase A's allow-list covers the mechanical happy path, phase B blocks only on
genuinely unusual commands — the ones that *should* wait for a human. `agentPermissionEscalation`
(on `mcp`, default on, gated by `mcp.enabled`) turns the backstop off for operators who prefer
the old fail-closed behaviour.

## Testing

- Phase A: `test/agentProtocol.test.ts` — the allow-list becomes a `permissions.allow` fragment
  in `--settings` for both runtimes, merges alongside the other fragments, and never touches
  `--allowedTools`.
- Phase B: `test/mcpChannel.test.ts` — `request_permission` returns bare allow/deny JSON, blocks
  until `decide`, denies on agent death, and stays out of the `_status` envelope; the desk +
  endpoint round-trip. The real-Claude wiring (does Claude actually call the tool) is only
  observable under `npm run smoke`, noted in the PR.

## Out of scope

Applying `autoSend`'s confidence gate to tool use (auto-approving low-risk commands without a
click); a per-command "allow for the rest of the fleet" memory. Both are natural extensions of
the desk but not needed to make the default config work unattended.
