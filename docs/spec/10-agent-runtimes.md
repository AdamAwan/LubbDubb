# 10 — Agent runtimes

## The session contract

`src/agents/session.ts` defines `AgentSession`, which both runtimes implement. `AgentManager`, the
`Hub` and the cockpit are agnostic to which is running.

```ts
interface AgentSession extends EventEmitter {
  readonly status: 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'failed';
  readonly pid: number | null;
  start(): void;
  send(text: string): void;
  deliverInitial?(text: string): void; // optional; boot-race-robust first message
  sendRaw(data: string): void; // no framing, for control chars
  kill(signal?: string): void;
}
```

Events, emitted by both: `output(delta)`, `waiting(reason)`, `done()`, `failed()`, `status(status)`,
`exit(code)`, `activity()`, `flag(ParsedFlag)`. The stream runtime additionally emits
`usage(AgentUsage)` at each turn end; the PTY runtime has no such channel and never emits it.

`activity` is the runtime's own statement that the agent **did** something — one per message carrying
a tool call. It exists because parking is only ever a _request_: the `escalate` tool returns at once,
so an agent that carries on leaves the harness saying `waiting` against an alert nobody is waiting on.
Two properties are load-bearing:

- **It is not derived from `output`**, because only the runtime knows whether its own output is
  model-produced. Stream emits it off `tool_use` blocks; PTY emits it **only** from the session file
  (`SessionTranscriptUpdate.toolUses`), never from `handleData` — the screen repaints while a session
  sits parked, which is the same reason the sentinel park is latched there.
- **It is narrowed to tool calls, not any block.** Prose after an escalation is usually the agent
  explaining that it is waiting, and reading that as work would mark alerts stale that need answering.

`SessionFactory` builds one from an `AgentSessionSpec` (`command`, `args`, `cwd`, `env`,
`waitingPatterns`, `sessionId`, `resume`). The composition root picks the factory from `agentMode`.

## The sentinel protocol

`src/agents/sentinels.ts` defines the protocol strings in exactly one place, shared by both runtimes:

| Sentinel                        | Meaning                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `@@LUBBDUBB_DONE@@`             | The task is completely finished.                            |
| `@@LUBBDUBB_WAITING:<reason>@@` | The agent needs a human and has stopped.                    |
| `@@LUBBDUBB_FLAG:<payload>@@`   | An artifact/link to surface. Carries **no** status meaning. |

These are reserved control strings: they are detected for status transitions **and** stripped from
displayed output, so they never leak into a transcript.

Pure helpers: `stripSentinels`, `stripFlags`, `extractWaitingReason`, `parseFlag`, `extractFlags`.
`stripDelimited` leaves an _unterminated_ trailing fragment in place, so a caller streaming across
chunk boundaries can withhold it. On the line-delimited stream-JSON transport a sentinel always
arrives whole inside one text block, so that is sufficient there.

The protocol is injected as an appended system prompt (`PROTOCOL_SYSTEM_PROMPT`,
`src/agents/agentProtocol.ts`) on every launch — a live `claude` emits none of it on its own. Tool
permission prompts are a separate CLI concern, handled by `--permission-mode` and the permission
model below, never by scraping output.

### The flag payload

A bare ref (a worktree-relative path or an `http(s)` URL) or a JSON object
`{kind?, label?, ref}`. `ref` is required. A missing `kind` defaults to `link` for URLs and `artifact`
otherwise; a missing `label` defaults to the ref's basename. A payload that starts with `{` but is not
valid JSON is rejected rather than treated as a path. `extractFlags` boundary-guards the prefix (start
of buffer or whitespace) so an echoed sentinel mid-token does not fire.

## Launch arguments

`src/agents/agentProtocol.ts` builds the argv.

**`buildClaudeStreamArgs`** (the production default):

```
-p --input-format stream-json --output-format stream-json --verbose
--append-system-prompt <protocol>
[--settings <file-events + permissions fragments>]
[--mcp-config <path> --allowedTools <names> [--permission-prompt-tool <name>]]
[--permission-mode <mode>]
[...claudeArgs]
```

**`buildClaudeArgs`** (PTY):

```
--append-system-prompt <protocol>
(--session-id <id> | --resume <id>)
[--settings <merged status-line + file-events + permissions fragments>]
[--mcp-config <path> --allowedTools <names> [--permission-prompt-tool <name>]]
[--permission-mode <mode>]
[...claudeArgs]
```

Points that are load-bearing:

- The protocol prompt is **re-appended on resume**. `--resume` replays the conversation but does not
  retain the original invocation's appended system prompt, so detection would otherwise break.
- `--session-id` and `--resume` are mutually exclusive; a resume must not also mint the id.
- `--settings` has no array form, so the status-line, file-events and `permissions` fragments
  are **merged into one JSON object** (`collectSettings`) — disjoint top-level keys, so the merge is
  lossless. The two halves of `permissions` (`allow` and `additionalDirectories`) are built into one
  object rather than assigned twice, or whichever was written first would be dropped. `collectSettings` is used by **both** runtimes, so the allow-list reaches headless agents.
- Operator `claudeArgs` are appended last, so an explicit flag there has the last word.
- The status line never renders headless, so it is wired for PTY only. `PostToolUse` hooks _do_ fire
  headless, so file-events capture is wired for both.
- `mcpConfigPath` is **per-launch** (minted by `AgentManager`, not fixed at wiring time) and is
  threaded through the `ArgsBuilder` in `src/system.ts` — without that, `--mcp-config` (and the
  permission-prompt tool that lives on that server) never reach the agent.
- When a launch carries the tool channel, `MCP_PROTOCOL_ADDENDUM` is appended too — see
  [11](11-mcp-tools.md).

`buildInitialMessage(task)` is the task prompt. `buildResumeMessage()` is the nudge typed into a
resumed agent that was mid-work.

## Permission model (issue #130)

`agentPermissionMode: 'acceptEdits'` (the default) auto-accepts **file edits only**, so a headless
agent — the production default, with no human at the permission prompt — hangs the moment it runs
`npm run check`, `git` or `gh`. The old workaround, `bypassPermissions`, removes _every_ gate at once
in a worktree of the real repo with the operator's shell environment inherited, and is refused under
root. Two mechanisms replace that, mirroring the "authorise the routine, ask about the rest" split
`autoSend` makes for outbound acts:

- **The allow-list (`agentAllowedTools`).** A `permissions.allow` fragment merged into `--settings`,
  pre-approving the mechanical validate/commit/push commands (the JS toolchain, `git`, `gh`) so the
  default config takes an issue to an opened PR unattended. It rides in `--settings`, deliberately
  **not** `--allowedTools`: that flag carries the `mcp__lubbdubb__*` grants, and mixing a Bash rule
  into it risks silently dropping them (the drift `src/mcp/names.ts` guards against). Two flags, two
  concerns — the operator cannot lose the MCP grants by adjusting Bash access, by construction.
- **The backstop (`mcp.permissionEscalation`, `--permission-prompt-tool`).** Claude Code evaluates
  allow rules _before_ the permission-prompt tool, so an allowlisted command never reaches it and the
  unattended path stays synchronous; the backstop fires only for what the allow-list misses. See
  [11](11-mcp-tools.md#request_permission) for the `request_permission` tool, the blocking
  `PermissionDesk`, and how the operator's Allow/Deny reaches the same live agent.

`agentPermissionMode` stays available and unchanged, root-refusal caveat included.

### Reading outside the worktree

Every launch also carries `permissions.additionalDirectories: [attachmentRoot]`, in the same
`--settings` fragment as the allow-list and for the same reason it is not on `--allowedTools`.

It exists because a blueprint's attachments (issue #249) are stored **once**, outside every worktree —
see [09](09-execution.md#an-operators-attachments-reach-the-agent) — so the absolute path the prompt
names is one the agent could not otherwise open. It is a **standing grant for the life of the launch**
and it is not per-goal: an agent working an unrelated issue can read another goal's attachments. That
is a real widening, and the mitigations are that the root is the harness's own directory (nothing else
writes there), that it is config'd (`attachmentRoot`), and that stored filenames never come from a
client.

## `StreamJsonSession`

`src/agents/streamJsonSession.ts`. Real `claude` over headless stream-JSON: no PTY, no TUI, structured
events, and it stays alive across turns so the waiting/answer loop works. This is what runs by default,
so "how agents run" is usually _not_ a terminal.

Each `result` event carries **cumulative** `total_cost_usd`, `usage` and `num_turns`, which become a
`usage` session event.

### Transcript legibility

The raw event stream is never dumped. Each message's content blocks go through the pure `renderBlocks`
(`src/agents/streamTranscript.ts`):

- assistant text passes through with sentinels stripped;
- a `tool_use` becomes a labelled line with a one-line input summary (capped at 140 chars);
- a `tool_result` (which arrives as a `user` event) is sanitised — ANSI and control characters removed
  — and truncated to `MAX_RESULT_LINES` (200) with a `+N more lines` marker;
- a `human` block renders injected/human messages.

A result's label is `↳ result` (or `↳ error`) followed by a dim `· N lines` suffix giving the
**pre-truncation** total, omitted when the result is a single line. The cockpit folds that suffix into
the collapsed summary of the tool call ([17](17-cockpit.md)), and the server is the only side that
still knows what was cut. The cap can be this high because the drawer hides result bodies by default:
a collapsed block is only worth opening if the whole result is inside it.

Labels carry SGR colour, which the cockpit's drawer renders through the pure parser in
`web/src/components/ansi.ts`. `stripAnsi` is applied by the `Hub` before the compact fleet-card tail,
so escapes never show as literal text there.

**Detection still scans the raw turn text**, so the raw-vs-display split must stay intact.

## `PtySession`

`src/pty/ptySession.ts`, over the swappable `PtyBackend` seam (`src/pty/backend.ts`;
`FakePtyBackend` for tests). Used for `agentMode: 'pty'` and `'raw'`.
All the "is it waiting / is it done" heuristics live here behind one testable abstraction.

`agentMode: 'pty'` marks the real interactive claude TUI (`claudeTui` in the composition root), which
enables three things `raw`/mock sessions do not get: session-file transcripts, exit-on-done, and the
idle-wait safety net.

### Sentinel scanning

**PTY sentinel matching goes through `src/pty/sentinelScanner.ts`, never `indexOf`.** The interactive
TUI styles the line it prints a sentinel on, so SGR escapes land _inside_ the token
(`@@LUBB\x1b[0mDUBB_DONE@@`), not merely around it. The scanner matches through the escapes and reports
**raw byte spans** plus an escape-free payload.

`scanSentinels` is the one matcher for **both** detection and display-stripping. They used to be two
matchers over two views — detection on an ANSI-stripped copy, stripping on the raw bytes — which
disagreed exactly when it mattered: detection fired, the strip missed, and the sentinel leaked into
the transcript.

Two consequences:

- Every hit is **excised from the retained detection tail** (`TAIL_WINDOW`, 4096 bytes), which stops
  the sliding window re-firing a sentinel on later chunks. The `waiting` latch is still needed, but
  only to guard the "output while parked → running" reset.
- `holdFrom` **bounds** how much output is withheld waiting for a missing suffix
  (`MAX_SENTINEL_HOLD`, 512 bytes). Unbounded, an agent that merely _mentions_
  `@@LUBBDUBB_WAITING:` without closing it blacked out the transcript for the rest of the run.

Tests: `test/ptySentinelScanner.test.ts`.

### Transcript from the session file

The screen is the wrong source. The interactive claude TUI paints cursor-addressed redraws, so its
byte stream carries the slash-command dropdown, `Tip:` hints, `(ctrl+o to expand)` markers and input-box
rules as _content_, with prose already hard-wrapped at the emulator's column width. No chrome blacklist
recovers the logical lines.

So PTY mode does not read the screen at all. Claude Code writes every session's conversation to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, and since PTY is the runtime that pins
`--session-id`, the harness knows exactly which file is its agent's. `SessionTranscriptTail`
(`src/agents/sessionTranscript.ts`) tails it and renders the records with the **same** `renderBlocks`
stream mode uses, so both runtimes converge on one legibility seam and the TUI becomes purely an input
device.

Consequences:

- The file is append-only, so PTY emits plain `output` deltas like stream. There is no full-replacement
  `transcript` event and no `Store.setTranscript` path.
- Records are written per content block as each completes, so the transcript is live at **block**
  granularity, not token by token.
- The file is located by globbing `<root>/*/<id>.jsonl` rather than deriving the directory-encoding
  rule, so an encoding change cannot break it.
- `parseSessionEntries` drops **local-command envelopes** (`<local-command-caveat>`,
  `<command-name>`, `<local-command-stdout>`), or `exitOnDone`'s `/exit` would reintroduce exactly the
  noise this replaced.
- Human and injected messages render too, so the drawer shows both halves of the conversation.

Tests: `test/sessionTranscript.test.ts`.

### Two-source sentinel detection

The session file is the **primary** detector: clean text through the same `stripSentinels` /
`extractWaitingReason` helpers stream mode uses, so the styled-token bug class cannot occur there.

The raw-stream `scanSentinels` scan stays as a **backstop**. A terminal sighting is deferred by
`SENTINEL_BACKSTOP_MS` (5s) to let the file claim it first; if that never happens the terminal
detection is applied **and** `onWarning` records it, so drift shows up in the Errors panel instead of
rotting silently. The deferral is skipped entirely when the tail has not located a file
(`SessionTranscriptTail.located()`), or every transition would wait the full window on a source that
may never speak. Both paths converge on `noteSentinel`, and each transition is idempotent, so a double
report is harmless.

### Exit on done

The interactive claude REPL has no natural end — after a turn it sits at the prompt forever — so the
done sentinel alone would orphan the process and leak its worktree. With `exitOnDone: true` (real TUI
only; raw/mock processes exit by themselves) the session tears the REPL down after the sentinel-driven
`finish('done')`: it writes `/exit` plus a delayed Enter (the same paste-vs-keypress split as `send`,
but bypassing the status guards, since status is already `done`), with a `SIGTERM` backstop after
`exitGraceMs` (5s). `reportExit` already ignores exits on a `done` session, so neither path
reclassifies the finish as `failed`.

Tests: `test/ptyExitOnDone.test.ts`, `test/worktreeCleanup.test.ts`.

### Sharp edges

- **`kill()` sets status `killed` _before_ signalling the process.** A synchronously-delivered exit
  would otherwise be reclassified as `failed`, firing a terminal event.
- **`kill()` reaps the process _subtree_, and does it before the root is signalled.** Signalling the
  direct child alone leaves a Bash-tool shell holding the worktree cwd, which on Windows wedges the
  branch for every later dispatch; reaping after the root is gone finds nothing, because descendants
  are resolved through it. See [Reaping the process subtree](#reaping-the-process-subtree).
- **`send()` writes the text and its submitting carriage return as two separate writes**,
  `agentSubmitDelayMs` apart (default 60ms). The claude TUI coalesces a single input burst into a
  paste and treats a trailing CR as a literal newline, so a glued-on CR leaves the message sitting in
  the input unsubmitted. Trailing newlines in the text are stripped so the lone CR does the
  submitting. Test assertions therefore look for the payload as its own write, not `payload\r`.
- **`deliverInitial()` handles the first-message boot race.** A freshly-booted claude REPL paints its
  input box a second or two before its input loop honours a submitting Enter, so the first Enter is
  silently dropped and the pasted prompt sits unsent. The prompt is pasted **once** (a re-paste
  accumulates it in the box) and only the bare CR is re-sent until the message lands. "Landed" is
  **observed, not timed**: the session file records a `user` entry the moment the REPL accepts a
  message, so a rise in the tail's accepted-message count is direct proof. Without a session file
  (raw/mock) it degrades to a blind open-loop nudge bounded by `initialSubmitAttempts` (8). Tests:
  `test/ptyInitialSubmit.test.ts`.
- **Do not launch the server from inside a Claude Code session when using `agentMode: 'pty'`.**
  `NodePtyBackend` merges `process.env` into the agent's env, so the parent session's
  `CLAUDE_CODE_SESSION_ID` / `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` leak into the spawned `claude`,
  which then treats itself as a child of _that_ session and **writes no session transcript of its
  own**. The agent still runs and its sentinels still fire (via the terminal backstop), but the
  transcript falls back to raw screen output with a recorded warning.

## `AgentManager`

`src/agents/agentManager.ts` owns the live fleet. It maps session events onto store updates and
re-emits them for the server to broadcast.

### Spawn

1. Mint a session id (`randomUUID`) **only** when the runtime is resumable (PTY).
2. Mint a file-events spool key — independent of the session id, so stream agents get one too.
3. Mint an MCP credential (`mcp.open()`), before the session, so the launch config exists to point
   `--mcp-config` at.
4. Build the session with env `LUBBDUBB_PROMPT`, `LUBBDUBB_TASK_ID`, plus `LUBBDUBB_STATUS_FILE` and
   `LUBBDUBB_EVENTS_DIR` when wired.
5. Create the agent row (`starting`), bind the credential to it, set the task `running`.
6. `wireSession(...)`, then `session.start()`.
7. Deliver the initial message after `promptDelayMs` (0 for stream, which is ready immediately),
   preferring `deliverInitial` over `send`.

A synchronous spawn failure calls `failSpawn`: the session is dropped, the error message is written to
the transcript and flushed, agent and task are marked `failed`, the failure is recorded, and the throw
is re-raised so the executor audits it as a rejected dispatch rather than leaving a mystery agent stuck
in `starting`.

### Events emitted

`output`, `waiting`, `autoAnswered`, `done`, `reaped`, `status`, `usage`, `flag`, `finding`,
`progress`, `files`, `resumed` — all typed via `emit`/`on` overrides.

### Waiting

`handleWaiting(agentId, task, reason, ask?)` is the convergence point for the two ways an agent asks —
the `escalate` MCP tool and the WAITING sentinel:

- The `parked` set is the latch. An agent already parked is **not** parked again: re-running the
  whitelist would auto-answer the same prompt twice, and re-emitting `waiting` would race the inbox's
  own per-agent dedup.
- File events are drained here, because the escalation often _is_ "review the file I just wrote", and
  a waiting agent reaches no terminal drain.
- A matching `whitelistedApprovals` rule auto-answers via `respond` and emits `autoAnswered` — no
  latch, because the agent is running again and its next question is a fresh park.
- Otherwise the agent goes to `waiting` with its reason, the task goes to `waiting`, and `waiting` is
  emitted with the optional structured `ask`.

`src/system.ts` listens for `waiting` and creates the escalation, idempotently per agent (an agent has
at most one open escalation), enriched with the task title, the origin ref, a tail of recent output,
and — when the park came through the tool — the answer `options` and `detail`.

### Resumed while parked

`noteResumed` folds the session's `activity` event onto the agent row as `resumedAt` — but **only for
a parked agent**, and it deliberately does not un-park one. Flipping the row back to `running` would
desynchronise it from the runtime's own session status (which is still `waiting`), letting the next
turn-end file a _second_ escalation on top of the one the mark is meant to cast doubt on. The park is
the harness's model of the session; `resumedAt` is the evidence that model is out of date, and the
human settles the disagreement by answering or dismissing. Repeated tool calls just refresh the stamp.

It is cleared wherever the park ends or restarts — `respond` (answered), `handleWaiting` (a fresh
question must not arrive already looking stale), and `releasePark` (dismissed). Nothing in the
dispatcher reads it; the cockpit joins it to an open escalation by `agentId` and marks the card, and
`Hub` turns `resumed` into a plain `dirty` because the value already rides on the agent row.

`releasePark(agentId)` drops the latch without typing anything into the agent — what
`POST /api/escalations/:id/dismiss` calls. Releasing it is the point rather than a detail: while it is
held `handleWaiting` early-returns, so an agent whose alert was dismissed could never raise another.

### Terminal, exit and reap

`exit(code)` records the code and marks the process exited. `done`/`failed` call `handleTerminal`,
which drains file events one last time, clears the park, flushes the transcript, marks agent and task,
drops the session, records a `failed` agent to the error log with its exit code and an output tail,
emits `done`, and then calls `maybeReap`.

`reaped` is emitted only once **both** halves have happened — terminal status recorded _and_ process
exit observed. The two arrive in either order (PTY: sentinel first, exit later; stream: exit first).
On reap the file-events spool is disposed and the MCP credential is released. Only then is it safe to
touch resources the process pinned, which is why worktree removal hangs off this event.

### Kill vs interrupt vs interruptAll

| Call             | Agent status  | Task status   | Resumable on next boot | Worktree |
| ---------------- | ------------- | ------------- | ---------------------- | -------- |
| `kill(id)`       | `killed`      | `interrupted` | No                     | Kept     |
| `interrupt(id)`  | unchanged     | unchanged     | —                      | —        |
| `interruptAll()` | `interrupted` | unchanged     | Yes                    | Kept     |

`interrupt` sends raw ETX (`\x03`) and mutates no status — the agent's own output and exit drive what
happens next. `kill` releases the credential and spool, clears the park, flushes the transcript,
deletes the recorded exit code (a deliberate kill's exit code is not a failure cause) and clears the
exited marker, so a killed agent is never `reaped` and its worktree stays.

`interruptAll` is used on **server shutdown**: agents are left in the resumable `interrupted` state and
`waitingReason` and the task status are **preserved** as the signal for how to resume.

### Reaping the process subtree

**Stopping an agent stops everything it started.** That is the invariant, it holds for both runtimes,
and it is not what "kill the process" gives you: an agent that ran
`until az pipelines runs show …; do sleep 45; done` with the Bash tool leaves that shell and its
`sleep` behind when `claude` dies, with their cwd still set to the worktree. Windows refuses `rmdir`
on any live process's cwd, so from that moment every dispatch onto the branch fails `EBUSY` in
`WorktreeManager.reclaim` — one branch stayed wedged for two days and 100+ rejected dispatches that
way, and nothing in the harness could have said why.

`ProcessReaper` (`src/agents/processTree.ts`) is the seam; `killProcessTree` is the implementation:

- **Windows** — `taskkill /pid <pid> /T /F`, run with `spawnSync`. There is no process group to
  signal, so the tree is walked through the parent-pid links instead. Exit status 128 (`not found`)
  is success: the tree is already gone.
- **POSIX** — `kill(-pid)`, the process **group**. The group exists because the spawners make one:
  `defaultSpawner` passes `detached: true`, and node-pty's `forkpty` calls `setsid`. `ESRCH`/`EPERM`
  falls back to the bare pid.

Two things about it are load-bearing:

- **It runs before the root is signalled.** Both mechanisms resolve descendants *through* the root
  pid, so reaping after `child.kill()` finds a tree that no longer has a root — the children have been
  reparented and cannot be reached from here. In `PtySession.kill` this sits between the `killed`
  status and `proc.kill`, inside the ordering rule above.
- **It never throws.** A failed reap must not take a kill path down with it — the agent still has to
  be marked, the transcript flushed and the credential released — so failures go to the error log and
  the caller carries on.

Reached from `kill`, `complete`, `interruptAll`, and the PTY `exitOnDone` teardown's forced arm: every
path by which the *harness* stops an agent. **An agent that exits by itself is not covered** and
cannot be — once the root pid is gone there is nothing left to walk from. That residue is why
`reclaim` must survive a held directory and say so rather than treat the lock as permanent
([09](09-execution.md#reclaiming-an-orphaned-directory)).

The reaper is **injected**, in the composition root, and wired to the real implementation **only
alongside the real transports**: it signals whatever pid it is handed, and an injected `backend` or
`streamSpawner` scripts a process whose pid belongs to something else entirely on the host running the
suite. With a fake transport in place the default is a no-op, and a test that wants to observe the
reap injects its own recorder (`buildSystem`'s `reapProcessTree`). Tests:
`test/agentSubtreeReap.test.ts`.

## Crash recovery

A restart kills every agent. What happens to those agents is **an operator's decision, not the
harness's**, and until each one is made the harness runs no cycles at all.

What is orphaned is the **work**, not the process: the unit of recovery is the task, and the agent is
optional throughout. A restart orphans work two ways — an agent row with no process behind it, and a
task with no agent row at all.

### Detection

`RecoveryDesk.detect()` (`src/agents/recoveryDesk.ts`) runs once at boot, before
`harness.runCycle('boot')`. It resumes nothing and buries nothing: it finds the orphans and parks them.

**Candidate set, arm one — an orphaned agent** (`isRecoveryCandidate`, pure, `src/agents/crashRecovery.ts`): an agent in
`starting` / `running` / `waiting` (a crash — the row still claimed to be live because nothing got the
chance to write an ending), `interrupted` (a graceful `interruptAll` shutdown) or `crashed` (an earlier
boot already parked it), **whose task is still outstanding** (`queued` / `running` / `waiting`). A
cockpit kill leaves the agent `killed` and its task `interrupted`, so it is excluded on both counts and
stays dead; a previous recovery's `requeue` or `remove` settles the task, so its agent is history rather
than a question that reappears every boot.

Detection restamps only a row that still claimed to be live: status **`crashed`**, `pid` null, `endedAt`
stamped. That status is deliberately neither live nor terminal — `countLiveAgents()` excludes it, so a
dead row stops eating headroom and stops reading as running in the cockpit, while `restore` puts the
same row back to `running`. An already-`interrupted` row is left alone, which is what preserves the
crash / clean-shutdown distinction (`OrphanedWork.died`) without a column to hold it. A genuine crash is
recorded to the error log under source `boot`; a clean shutdown is not, because nothing failed.

**Candidate set, arm two — an orphaned task** (`isAgentlessCandidate`, pure): an outstanding task
(`queued` / `running` / `waiting`) with **no agent row anywhere pointing at it**, created before this
process booted. This is the more damaging orphan, and it went undetected until it was closed: the
executor writes the task row and then spawns (`ActionExecutor.execute`), so a restart between the two
leaves a `queued` task nothing is working — and `queued` is _active_ to `activeOrigins`,
`findActiveTaskByOrigin` and `findActiveTaskByBranch` alike. Its origin and branch are held shut
permanently, and the dispatcher reports "nothing actionable" against an idle fleet with no sign of why.
The two arms cannot double-count: the first is reached from an agent row and the second requires there
to be none.

**Nothing is stamped for arm two, and nothing needs to be.** `crashed` exists because an agent row
_lied_ — it claimed `running` with no process — so something had to be written to stop it counting as
live. A `queued` task with no agent tells the truth about itself; what was missing was a reader. There
is also no honest status to move it to: every task status that is not outstanding is _terminal_ to the
three gates above, so a new one would either go on wedging the origin or force every gate, present and
future, to learn a fourth state. The set is therefore computed, and both verdicts available to it settle
the task, which is what removes it.

`hasAgent` is asked of the agent **rows**, not of `task.agentId`: `AgentManager.spawn` writes the agent
row first and back-fills the column after, so reading the column would list one piece of work twice.

**The `bootedAt` fence is the one input not read off a row, and it is load-bearing.** The pending set is
re-derived on every pulse (the hold asks for it), and a live dispatch is transiently agentless for
exactly the window this arm cleans up after. A task created before this process booted cannot be one. It
is constant for the life of the process, so two readings never disagree, and a second restart just moves
it forward. `buildSystem`'s `bootedAt` option exists so a test can place a task on either side of it.

The fence is safe to keep this narrow because that window always ends within the run that opened it:
the dispatch either spawns, or throws and settles its own row — see
[09 — A failed dispatch settles its task row](09-execution.md#a-failed-dispatch-settles-its-task-row).
An agentless task outliving its own run is therefore a crash, which is what this arm is for. Widening
the fence to cover an orphan created _during_ a run would buy nothing and cost the property it exists
for: a pulse could park work an executor is midway through starting.

The pending set is therefore the rows themselves, not state held in the desk: it survives a second
restart, two cockpits cannot disagree about it, and `detect()` is idempotent. Arm two writes nothing at
all during detection — it is a reading — but it is still announced to the error log and the boot banner,
because a wedged origin is otherwise the most silent failure the harness has.

### The hold

`Harness.runCycle` asks `recovery.pendingCount()` **before anything else, including the world fetch**,
and returns a report with `cycleId: 'held'` while it is non-zero. The reason it holds the whole pulse
rather than dispatch alone: with undecided orphans the harness's model of its own fleet is wrong, so
every verdict a pulse would reach — merges, replies, plan reconciliation — is reached against a fiction.
The timer keeps running and the question is re-asked each beat, so the pulse resumes on its own the
moment the last decision lands; there is no un-hold to remember.

### The three verdicts

`RecoveryDesk.decide(taskId, verdict)`, reached from `POST /api/recovery/:taskId`. **The task is the
identity** — the route, the cockpit's card key and the verdict all key on it, because it is the only
thing every candidate has; `OrphanedWork.agentId` is null for an orphan that never had one.

| Verdict   | Effect                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `restore` | `agents.resume(agent, task)` — re-attach to the same session in the same worktree. Offered only when `restorable`.    |
| `requeue` | Retire agent (`interrupted`) and task (`interrupted`), dismiss its escalations, and file a **job** carrying the work — unless the job it came from never left the queue, below. |
| `remove`  | Retire agent and task, dismiss its escalations. Nothing is queued; the branch and worktree are kept.                  |

Settling the **task** is the load-bearing half of the last two, and the only half an agentless orphan
has: `interrupted` is what releases the origin and branch the `queued` row was holding shut. Such an
orphan has no escalations by construction — an escalation is raised by a process, and none ever ran.

`restorability` (pure) decides whether restore is on offer and carries the reason when it is not — no
agent having existed at all, a runtime that cannot resume (anything but PTY; stream-JSON resume does not
exist), a row with no `sessionId`, or a worktree no longer on disk. The agentless arm answers **first**,
because it makes the other three moot: there is no runtime that could resume a conversation nobody ever
had. The cockpit shows that reason rather than hiding the button, and the card reads `never started`,
saying outright that no work was done and that the item is what is holding the origin. A refused or
failed restore is **not** a decision: the row stays `crashed`, so requeue and remove remain available and
the hold stands.

A `restore` re-attaches exactly as before: the same agent row, id and cwd, a **fresh** spool key and MCP
credential (the old ones died with the process), the death markers shed, and the same listeners `spawn`
wires. `waitingReason` is the state signal:

- **Was waiting** → `restoreWaiting`: the park is re-latched, the row and task go back to `waiting`, and
  a `waiting` event is emitted only if no open escalation survives. The pre-restart escalation persists —
  which is why detection dismisses nothing — so a queued answer routes straight in once the session is
  live.
- **Was mid-work** → the `buildResumeMessage()` nudge is delivered after the boot delay.

`requeue` files a job rather than resetting the task, and that is forced rather than chosen: a `queued`
task with no agent is _active_ to `activeOrigins`, `findActiveTaskByOrigin` and `findActiveTaskByBranch`
alike, so parking the work there would wedge its origin and branch shut for good — which is not
hypothetical, it is the state arm two exists to find. The job (`requeueJobRequest(task, prior)`, pure)
carries the original prompt verbatim, plus a preamble naming the origin.

Its *dispatch* origin is `job:<id>`, and the original origin rides on `Job.originRef` — the work the
job **stands in for**. The gates read that field while the job is queued and while the task it became
is live, so the rule that produced the original does not staff the same work a second time; without
it, a requeued retro and a freshly dispatched `issue:249:retro` ran at once (#249). See
[13](13-jobs-and-findings.md#standing-in-for-another-origin) for the predicate and its two readers.
The preamble still names the origin in words, because a fresh agent needs to know it is redoing work.

**A requeue of work behind a still-queued job files nothing**, and hands that job back instead. A job
leaves the queue only through `markJobDispatched`, which runs after the spawn succeeds — so a
predecessor still `queued` means no agent ever ran and the queue is already holding the request
unchanged. A second job for it would not be a requeue but a duplicate, and a duplicate that locks the
queue: its `originRef` is the task's `job:<predecessor>`, which makes it *stand in* for the
predecessor and skips it in `manual-job` for as long as the duplicate is queued. Chains of three were
observed. See [13](13-jobs-and-findings.md#why-a-requeue-never-stands-in-for-a-queued-job) for the
gate this protects and why it is not the thing being changed.

`prior` is the agent that was on the task, or **null** when none ever ran, and the two arms say
materially different things: after a crash the branch may carry commits a fresh agent must read first
(and the crashed agent's last `note_progress` line is quoted), whereas a task whose agent never spawned
has had nothing done to it, and telling an agent otherwise sends it looking for work that was never
started.

**The `createTask` → `spawn` window itself is deliberately left open.** It cannot be closed, only moved:
`spawn` needs the task row to exist, and a transaction cannot span a process spawn. Reversing the order
trades an agentless task for an agentless _process_ — a live `claude` with no row, invisible to the
concurrency cap, to `kill`, and to recovery itself — which is strictly worse. Recovery is where this
belongs.

Every verdict, and the hold itself, is recorded in the decision log under cycle id `crash-recovery`.

`spawn` and `resume` share their listener wiring — change one, change both. Tests:
`test/crashRecovery.test.ts`, `test/resume.test.ts`.

## Usage capture

Two mode-specific sources. They are not interchangeable.

- **Stream mode** — each `result` event's cumulative `total_cost_usd` / `usage` / `num_turns` becomes
  a `usage` event. `Store.recordAgentUsage` writes the cumulative values onto the `agents` row (cache
  tokens folded into input) **and** the cost _delta_ as a timestamped `usage_events` row, so rolling
  5h/7d cost windows are a plain `SUM` over the window.
- **PTY mode** — reports no per-turn usage. Instead it captures the **account rate limits**: the
  Pro/Max `rate_limits` in the status-line payload, which is the one programmatic surface for them.
  `buildClaudeArgs({statusLine: true})` wires a `--settings` status command that atomically dumps each
  payload to `$LUBBDUBB_STATUS_FILE` (per session id, under the OS tmpdir), and
  `StatusFileRateLimits.readLatest()` feeds the freshest one into the snapshot's `usage.rateLimits`.
  Parsing is pure (`parseStatusLinePayload`, `src/agents/statusLine.ts`).

`usage.rateLimits` is null when absent, and the cockpit chip then falls back to the cost windows.
Tests: `test/usage.test.ts`.
