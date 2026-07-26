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
  deliverInitial?(text: string): void;   // optional; boot-race-robust first message
  sendRaw(data: string): void;           // no framing, for control chars
  kill(signal?: string): void;
}
```

Events, emitted by both: `output(delta)`, `waiting(reason)`, `done()`, `failed()`, `status(status)`,
`exit(code)`, `flag(ParsedFlag)`. The stream runtime additionally emits `usage(AgentUsage)` at each
turn end; the PTY runtime has no such channel and never emits it.

`SessionFactory` builds one from an `AgentSessionSpec` (`command`, `args`, `cwd`, `env`,
`waitingPatterns`, `sessionId`, `resume`). The composition root picks the factory from `agentMode`.

## The sentinel protocol

`src/agents/sentinels.ts` defines the protocol strings in exactly one place, shared by both runtimes:

| Sentinel                          | Meaning                                                          |
| --------------------------------- | ------------------------------------------------------------------ |
| `@@LUBBDUBB_DONE@@`               | The task is completely finished.                                  |
| `@@LUBBDUBB_WAITING:<reason>@@`   | The agent needs a human and has stopped.                          |
| `@@LUBBDUBB_FLAG:<payload>@@`     | An artifact/link to surface. Carries **no** status meaning.        |

These are reserved control strings: they are detected for status transitions **and** stripped from
displayed output, so they never leak into a transcript.

Pure helpers: `stripSentinels`, `stripFlags`, `extractWaitingReason`, `parseFlag`, `extractFlags`.
`stripDelimited` leaves an *unterminated* trailing fragment in place, so a caller streaming across
chunk boundaries can withhold it. On the line-delimited stream-JSON transport a sentinel always
arrives whole inside one text block, so that is sufficient there.

The protocol is injected as an appended system prompt (`PROTOCOL_SYSTEM_PROMPT`,
`src/agents/agentProtocol.ts`) on every launch — a live `claude` emits none of it on its own. Tool
permission prompts are a separate CLI concern, handled by `--permission-mode`, never by scraping
output.

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
[--settings <file-events fragment>]
[--mcp-config <path> --allowedTools <names>]
[--permission-mode <mode>]
[...claudeArgs]
```

**`buildClaudeArgs`** (PTY):

```
--append-system-prompt <protocol>
(--session-id <id> | --resume <id>)
[--settings <merged status-line + file-events fragments>]
[--mcp-config <path> --allowedTools <names>]
[--permission-mode <mode>]
[...claudeArgs]
```

Points that are load-bearing:

- The protocol prompt is **re-appended on resume**. `--resume` replays the conversation but does not
  retain the original invocation's appended system prompt, so detection would otherwise break.
- `--session-id` and `--resume` are mutually exclusive; a resume must not also mint the id.
- `--settings` has no array form, so the status-line and file-events fragments are **merged into one
  JSON object** (`collectSettings`).
- Operator `claudeArgs` are appended last, so an explicit flag there has the last word.
- The status line never renders headless, so it is wired for PTY only. `PostToolUse` hooks *do* fire
  headless, so file-events capture is wired for both.
- When a launch carries the tool channel, `MCP_PROTOCOL_ADDENDUM` is appended too — see
  [11](11-mcp-tools.md).

`buildInitialMessage(task)` is the task prompt. `buildResumeMessage()` is the nudge typed into a
resumed agent that was mid-work.

## `StreamJsonSession`

`src/agents/streamJsonSession.ts`. Real `claude` over headless stream-JSON: no PTY, no TUI, structured
events, and it stays alive across turns so the waiting/answer loop works. This is what runs by default,
so "how agents run" is usually *not* a terminal.

Each `result` event carries **cumulative** `total_cost_usd`, `usage` and `num_turns`, which become a
`usage` session event.

### Transcript legibility

The raw event stream is never dumped. Each message's content blocks go through the pure `renderBlocks`
(`src/agents/streamTranscript.ts`):

- assistant text passes through with sentinels stripped;
- a `tool_use` becomes a labelled line with a one-line input summary (capped at 140 chars);
- a `tool_result` (which arrives as a `user` event) is sanitised — ANSI and control characters removed
  — and truncated to `MAX_RESULT_LINES` (12) with a `+N more lines` marker;
- a `human` block renders injected/human messages.

Labels carry SGR colour, which the cockpit's drawer renders through the pure parser in
`web/src/components/ansi.ts`. `stripAnsi` is applied by the `Hub` before the compact fleet-card tail,
so escapes never show as literal text there.

**Detection still scans the raw turn text**, so the raw-vs-display split must stay intact.

## `PtySession`

`src/pty/ptySession.ts`, over the swappable `PtyBackend` seam (`src/pty/backend.ts`;
`FakePtyBackend` for tests). Used for `agentMode: 'pty'` and `'raw'`, and by the `ClaudeDispatcher`.
All the "is it waiting / is it done" heuristics live here behind one testable abstraction.

`agentMode: 'pty'` marks the real interactive claude TUI (`claudeTui` in the composition root), which
enables three things `raw`/mock sessions do not get: session-file transcripts, exit-on-done, and the
idle-wait safety net.

### Sentinel scanning

**PTY sentinel matching goes through `src/pty/sentinelScanner.ts`, never `indexOf`.** The interactive
TUI styles the line it prints a sentinel on, so SGR escapes land *inside* the token
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
  (`MAX_SENTINEL_HOLD`, 512 bytes). Unbounded, an agent that merely *mentions*
  `@@LUBBDUBB_WAITING:` without closing it blacked out the transcript for the rest of the run.

Tests: `test/ptySentinelScanner.test.ts`.

### Transcript from the session file

The screen is the wrong source. The interactive claude TUI paints cursor-addressed redraws, so its
byte stream carries the slash-command dropdown, `Tip:` hints, `(ctrl+o to expand)` markers and input-box
rules as *content*, with prose already hard-wrapped at the emulator's column width. No chrome blacklist
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

- **`kill()` sets status `killed` *before* signalling the process.** A synchronously-delivered exit
  would otherwise be reclassified as `failed`, firing a terminal event.
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
  which then treats itself as a child of *that* session and **writes no session transcript of its
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
`progress`, `files` — all typed via `emit`/`on` overrides.

### Waiting

`handleWaiting(agentId, task, reason, ask?)` is the convergence point for the two ways an agent asks —
the `escalate` MCP tool and the WAITING sentinel:

- The `parked` set is the latch. An agent already parked is **not** parked again: re-running the
  whitelist would auto-answer the same prompt twice, and re-emitting `waiting` would race the inbox's
  own per-agent dedup.
- File events are drained here, because the escalation often *is* "review the file I just wrote", and
  a waiting agent reaches no terminal drain.
- A matching `whitelistedApprovals` rule auto-answers via `respond` and emits `autoAnswered` — no
  latch, because the agent is running again and its next question is a fresh park.
- Otherwise the agent goes to `waiting` with its reason, the task goes to `waiting`, and `waiting` is
  emitted with the optional structured `ask`.

`src/system.ts` listens for `waiting` and creates the escalation, idempotently per agent (an agent has
at most one open escalation), enriched with the task title, the origin ref, a tail of recent output,
and — when the park came through the tool — the answer `options` and `detail`.

### Terminal, exit and reap

`exit(code)` records the code and marks the process exited. `done`/`failed` call `handleTerminal`,
which drains file events one last time, clears the park, flushes the transcript, marks agent and task,
drops the session, records a `failed` agent to the error log with its exit code and an output tail,
emits `done`, and then calls `maybeReap`.

`reaped` is emitted only once **both** halves have happened — terminal status recorded *and* process
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

## Resume on boot (PTY only)

`reconcileAndResumeOnBoot(store, agents, escalations, errors)` runs once at boot, before
`harness.runCycle('boot')`, so resumed agents occupy their concurrency slots before new work is
dispatched.

**Candidate set:** agents in `starting` / `running` / `waiting` (a crash) or `interrupted` (a graceful
shutdown) **whose task is still active**. A cockpit kill leaves the agent `killed` and its task
`interrupted`, so it is excluded on both counts and stays dead. A prior boot's give-up leaves both
`interrupted`, so it is not resurrected on every restart.

For each candidate with a `sessionId` and an existing `cwd`, `agents.resume(agent, task)` re-attaches
to the same Claude session in the same worktree, reusing the existing agent row, id and cwd. It mints
a **fresh** spool key and a **fresh** MCP credential (the old ones died with the process), sheds the
death markers from the row, and re-wires the same listeners `spawn` uses.

`waitingReason` is the state signal:

- **Was waiting** → `restoreWaiting`: the park is re-latched, the row and task go back to `waiting`,
  and a `waiting` event is emitted only if no open escalation survives. The pre-restart escalation
  persists, so a queued answer routes straight in once the session is live.
- **Was mid-work** → the `buildResumeMessage()` nudge is delivered after the boot delay.

Best-effort by contract: no session id, a missing worktree, a non-PTY runtime, or a throw all fall back
to marking agent and task `interrupted` and cascade-dismissing the now-orphaned escalations. A resume
failure is recorded but never blocks boot. Stream-JSON resume is out of scope.

`spawn` and `resume` share their listener wiring — change one, change both. Tests: `test/resume.test.ts`.

## Usage capture

Two mode-specific sources. They are not interchangeable.

- **Stream mode** — each `result` event's cumulative `total_cost_usd` / `usage` / `num_turns` becomes
  a `usage` event. `Store.recordAgentUsage` writes the cumulative values onto the `agents` row (cache
  tokens folded into input) **and** the cost *delta* as a timestamped `usage_events` row, so rolling
  5h/7d cost windows are a plain `SUM` over the window.
- **PTY mode** — reports no per-turn usage. Instead it captures the **account rate limits**: the
  Pro/Max `rate_limits` in the status-line payload, which is the one programmatic surface for them.
  `buildClaudeArgs({statusLine: true})` wires a `--settings` status command that atomically dumps each
  payload to `$LUBBDUBB_STATUS_FILE` (per session id, under the OS tmpdir), and
  `StatusFileRateLimits.readLatest()` feeds the freshest one into the snapshot's `usage.rateLimits`.
  Parsing is pure (`parseStatusLinePayload`, `src/agents/statusLine.ts`).

`usage.rateLimits` is null when absent, and the cockpit chip then falls back to the cost windows.
Tests: `test/usage.test.ts`.
