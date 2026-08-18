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

Alongside the two sentinels it states one prohibition, because the commonest way an agent goes
missing is not a forgotten sentinel: **do not end a turn waiting for something you started** — a
build, a test run, a CI check, a long command. Nothing wakes an agent when one finishes, and the
WAITING sentinel is for a *person*. A turn ending with neither sentinel is an
[unannounced stop](#the-unannounced-stop).

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
(--session-id <id> | --resume <id>)
[--settings <file-events + permissions fragments>]
[--mcp-config <path> --allowedTools <names> [--permission-prompt-tool <name>]]
[--permission-mode <mode>]
[--model <model>]
[...claudeArgs]
```

**`buildClaudeArgs`** (PTY):

```
--append-system-prompt <protocol>
(--session-id <id> | --resume <id>)
[--settings <merged status-line + file-events + permissions fragments>]
[--mcp-config <path> --allowedTools <names> [--permission-prompt-tool <name>]]
[--permission-mode <mode>]
[--model <model>]
[...claudeArgs]
```

Points that are load-bearing:

- The protocol prompt is **re-appended on resume**. `--resume` replays the conversation but does not
  retain the original invocation's appended system prompt, so detection would otherwise break.
- `--session-id` and `--resume` are mutually exclusive, and both runtimes carry the pair (issue #318 —
  before it, the stream launch pinned no id at all and the recovery desk could never offer `restore`
  on the default deployment). Exclusivity is not house style: `claude` **refuses** `--session-id` on an
  id that already has a transcript, exiting 1 with a plain-stderr `Session ID … is already in use.`
  and no stream event — so a relaunch that carried the stored id down the mint arm would look to the
  harness like a process that died for no reason. `appendSessionFlags` is the one place either flag is
  written, and `test/agentProtocol.test.ts` asserts both builders emit exactly one of them.
- **Headless resume is a verified property, not an assumption** (probed against `claude` 2.1.223 for
  #318): a pinned id is honoured under `-p` and echoed on every event, its transcript lands at
  `~/.claude/projects/<slugified-cwd>/<id>.jsonl`, `--resume` re-opens _that_ file and appends rather
  than forking, the resumed session stays alive across turns exactly as a fresh one does, and a
  SIGKILL mid-assistant-turn still resumes off the half-written transcript. It also **replays
  nothing** — a resume emits `system`/`init`, the assistant turn for the new input, then `result` —
  so `StreamJsonSession` needs no swallow and the drawer's transcript continues instead of doubling.
  (`system`/`init` is emitted at the start of _every_ turn, fresh or resumed, so nothing may key off
  it as a resume marker.) `--resume` on an id with no transcript fails cleanly: exit 1, and a
  well-formed `result` of subtype `error_during_execution` on stdout.
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
- `--model` is per-launch for the same reason and carries the same trap (issue #321). It is the
  **task's own** model: resolved from the operator's `agentModels` policy at _dispatch_ — not here —
  and stored on the row, so `AgentManager` forwards a string and knows nothing about rules or
  profiles. That is what makes a boot-`resume` re-launch on the model the conversation started on
  rather than on whatever config says by then. Absent (no policy, or a rule the policy does not
  cover), the flag is omitted entirely and argv is byte-identical to a build without the feature.
  Pushed **before** `claudeArgs`, so an operator's own `--model` there still wins. The value is never
  validated by the harness — only the installed `claude` knows the valid set, so a bad alias surfaces
  as a failed agent at spawn. **`raw` mode ignores it**: running the operator's argv verbatim is that
  mode's whole contract. Since issue #342 the policy the value is resolved from has three levels
  rather than one — a pin on the goal, then the rule, then the fleet default — but the property this
  bullet is about is unchanged, and deliberately: the pin is keyed on the dispatch's _origin_, never
  on the run, so a retry and a re-dispatch resolve what the first attempt resolved.
  → [02](02-configuration.md#model-assignment-by-rule), [02](02-configuration.md#pinning-one-goal-to-a-profile)
- When a launch carries the tool channel, `MCP_PROTOCOL_ADDENDUM` is appended too — see
  [11](11-mcp-tools.md).

`buildInitialMessage(task)` is the task prompt. `buildResumeMessage()` is the nudge typed into a
resumed agent that was mid-work.

## Permission model (issue #130)

`agentPermissionMode: 'acceptEdits'` (the default) auto-accepts **file edits only**, so a headless
agent — the production default, with no human at the permission prompt — hangs the moment it runs
`npm run check`, `git` or `gh`. The old workaround, `bypassPermissions`, removes _every_ gate at once
in a worktree of the real repo with the operator's shell environment inherited, and is refused under
root. Two mechanisms replace that, on an "authorise the routine, ask about the rest" split:

- **The allow-list (`agentAllowedTools`).** A `permissions.allow` fragment merged into `--settings`,
  pre-approving the mechanical validate/commit/push commands (the JS toolchain, `git`, `gh`) so the
  default config takes an issue to an opened PR unattended. It rides in `--settings`, deliberately
  **not** `--allowedTools`: that flag carries the `mcp__lubbdubb__*` grants, and mixing a Bash rule
  into it risks silently dropping them (the drift `src/mcp/names.ts` guards against). Two flags, two
  concerns — the operator cannot lose the MCP grants by adjusting Bash access, by construction.
- **The backstop (`--permission-prompt-tool`).** Unconditional. Claude Code evaluates
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

### A `result` is the end of a turn, not of the session

Turn end is where done-vs-waiting-vs-stopped is decided, so which `result` counts as one matters. `pendingTurns`
counts the messages written to stdin that have not yet ended in a `result`: `send` raises it, each
`result` lowers it, and only the `result` that leaves **nothing queued** is scanned for sentinels. The
others emit their `usage`, drop the turn's text, and return.

The two come apart whenever a message is sent into a turn that is still running, and the `escalate`
tool makes that ordinary rather than exotic: it parks the agent **mid-turn** and returns at once
([Waiting](#waiting)), so the answer — a human's, or a `whitelistedApprovals` rule's, both of which
reach `respond` — routinely lands before the turn it interrupted has ended. `claude` queues that
message and runs it as the next turn. Judging the interrupted turn's `result` therefore parked an
agent that was already working on the answer, under a question nobody asked (an
[unannounced stop](#the-unannounced-stop)), and — because `respond` had just released the park latch — filed a second
escalation for it. The agent kept going and the alert was cascade-dismissed when it finished, so the
only trace was an inbox item that contradicted the transcript, and an answer to it would have typed a
stray message into a working agent.

Each turn is judged on **its own** text: the text is taken and cleared before the queued-turn check,
so a sentinel printed in the interrupted turn cannot be read again at the end of the queued one.

A path that never calls `send` (a resume delivering no first message) leaves the count at zero and is
judged exactly as before.

### The unannounced stop

A turn that comes to rest with **neither** sentinel in it is the third case, and it is not a question.
The runtime reports it as its own event — `stalled`, carrying the turn's text with the sentinels
stripped — rather than as `waiting`, and the session status moves to `waiting` because the session
really has stopped. What the stop *means* is `AgentManager`'s to decide, below.

Treating it as a question is what it used to do, and the population is why that was wrong. Two things
dominate it, and neither has anything for a person to answer:

- an agent that **finished** the work and narrated it instead of printing `@@LUBBDUBB_DONE@@` — the
  sentinel is stated once in the system prompt, thousands of tokens before the moment it matters
  ([11](11-mcp-tools.md#the-finish-reminder-on-a-terminal-tool) covers the terminal-tool half of this);
- an agent that started a **build, a test run or a CI check** and stopped as though something would
  wake it when that finished. Nothing does.

Both arrived in the inbox as one fixed sentence — "Agent ended its turn without finishing; awaiting
direction" — which named neither the agent's situation nor which of the two it was, so answering one
began by opening the transcript to find out what had actually happened. The items were cheap to file
and expensive to read, which is the ratio that makes an inbox stop being read.

`PROTOCOL_SYSTEM_PROMPT` states the rule against the second case directly (do not end a turn waiting
for something you started; the WAITING sentinel is for a *person*), and the two mechanisms below deal
with the stops that happen anyway.

#### The nudge

`AgentManager.handleStalled` asks the agent before it asks the operator. Up to `agentStallNudges`
times (default 2) it types `STALL_NUDGE` (`src/agents/agentProtocol.ts`) into the session, which
states the three exits — print the done sentinel, park with the waiting sentinel if a *person* is what
you are blocked on, or otherwise carry on and go and look at that build yourself — and picks none of
them. Guessing is the thing the harness cannot do and the agent can: an agent told "carry on" that had
genuinely finished invents work, and one told "you are done" that had not abandons it.

- **The budget is per agent, for its whole life**, not per stop. A counter reset by intervening work
  reads better and has no ceiling: an agent that made one tool call between every stop would be nudged
  for as long as it kept doing that, spending tokens with nothing to show and nobody told. It is held
  in memory, so a resume starts it over — the same fresh start the agent itself gets.
- **An agent already parked is never nudged.** The `escalate` tool parks mid-turn and returns at once,
  so the turn that asked ends with no sentinel in it — a stop by the letter of it, a real question in
  fact. Nudging there types "carry on" into an agent waiting on a person.
- **A dead process is not nudged**, because it cannot answer; the stop is all there is, so it parks.
- **The nudge is written to the transcript** as a sent message (`renderBlocks` with a `human` block)
  before it goes out. It is the harness taking a turn in the agent's conversation, and a transcript
  showing the agent apparently answering a question nobody asked is the same unexplained gap moved.

`agentStallNudges: 0` restores the immediate park exactly.

#### What the park says when it happens anyway

A stop that survives the budget goes through `handleWaiting` like any other park, with a reason built
by the pure `stallReason(lastWords)`: a headline saying the agent stopped without saying why, a blank
line, and then a quote of the **end** of its last turn (capped at 240 characters, elided from the
front). "Blocked until CI goes green on PR #412" is the whole diagnosis, and it is always the last
thing said rather than the first. The blank line is load-bearing — the cockpit's escalation card
splits a prompt on the first one into a headline and a body ([17](17-cockpit.md)), so the quote reads
as evidence under the claim rather than as part of it.

Tests: `test/stallNudge.test.ts` (the nudge, the budget, the quoted park, the parked-agent guard),
`test/streamJsonSession.test.ts` and `test/streamQueuedTurn.test.ts` (the runtime's half — which event
a turn end produces, and on whose text).

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

### The usage-limit park (issue #318)

A turn can end for a reason that is neither a sentinel nor a fault: the **account** ran out. `claude`
says so in structure rather than prose — a `rate_limit_event` carrying `rate_limit_info`, whose
`status` and `overageStatus` are the enum `allowed | allowed_warning | rejected`, with `resetsAt` in
whole unix seconds and `rateLimitType` one of `five_hour`, `seven_day`, `seven_day_opus`,
`seven_day_sonnet`, `seven_day_overage_included`, `overage`. (Verified against the 2.1.223 payload
schema, the binary this deployment launches; every field but `status` is optional there, so a park
must survive a reading that names neither window nor reset.)

`rejected` is the only spelling of "spent". `allowed_warning` is the near-the-line warning and parks
nobody — an account with room left must keep working. An account **on overage** reports
`status: "allowed"` with the exhaustion in `overageStatus`, so both are read. The latest reading wins,
including one that says the limit came back: a five-hour window can turn over mid-run, and a stale
rejection would park an agent that is allowed to work.

Nothing is announced when the event lands, because the exhaustion rides _beside_ the turn. The park is
declared at the **turn end** — after the done sentinel, so an agent that finished the work and then
hit the limit is `done` and not resurrected as a park — or, if `claude` gives up first, at **process
exit**, which is what makes this not a crash: an exit code alone would be `failed`. Either way it is
announced once, as `limited`(`RateLimitPark`), and never as `waiting` or `failed`.

`RateLimitPark` is `{limitType, resetsAt, overage}` — facts, not wording. The sentence an operator
reads is composed in `AgentManager` ([below](#the-limit-park)), where the rest of the harness's rows
are worded. The enum members are carried as plain strings rather than re-declared unions: this is
someone else's wire format, and a narrower type here would read a value the CLI adds tomorrow as "not
exhausted".

The PTY runtime emits none of this. The same exhaustion there arrives as screen text, and a park off a
scraped sentence is one an ordinary line of prose can forge.

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

1. Mint a session id (`randomUUID`) **only** when the runtime is resumable — both real runtimes are,
   leaving only `raw`, which speaks no protocol and pins nothing. A spawn handed a
   `resumeSessionId` takes that id instead of minting one: see
   [Inheriting a conversation on re-dispatch](#inheriting-a-conversation-on-re-dispatch).
2. Mint a file-events spool key — independent of the session id, and minted per spawn either way.
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

### Inheriting a conversation on re-dispatch

`spawn(task, cwd, resumeSessionId?)` re-dispatches an origin **into the conversation its last agent
had** rather than a cold one (issue #333). The cooldown allows three attempts per origin; every one of
them used to mint a fresh session id, so attempt two re-read the repository and `CLAUDE.md` to
re-derive what attempt one had already worked out. Which origins qualify is
[the dispatcher's](05-dispatcher.md#a-re-dispatch-inherits-the-last-agents-conversation) — this is
only the launch.

The launch differs from a cold one in exactly three places: the session id is the inherited one rather
than a minted one, `resume` is true so `appendSessionFlags` writes `--resume` and not `--session-id`,
and — nothing else. The spool key and the MCP credential are minted per spawn as always, and the
initial message is the task's prompt as always, because the retry note **is** the prompt the executor
stored on the row.

A runtime that cannot resume ignores the argument and launches cold, which is what makes it safe to
pass unconditionally. The caller learns what happened by reading `sessionId` back off the returned
row rather than by asking whether it asked.

**This is `spawn`, not [`resume`](#auto-resume-on-a-mid-run-crash), and the difference is why it is
here.** `resume` reuses the agent row, so `sessions`, `eventsKeys` and `mcpTokens` already hold
entries under that id and a caller must tear the dead launch down first or leak a spool directory and
leave an MCP bearer token bound with nothing to revoke it. A retry gets a **new agent row**: all three
maps are keyed by agent id, so there is nothing to write over and nothing to tear down, and the
previous agent's teardown already ran when it was reaped.

Two agent rows then share one `sessionId`. That is correct rather than tolerated — `--resume` appends
to that transcript instead of forking a new id, so the id names the _conversation_ and the rows name
the _attempts_ that spoke into it. Nothing keys on the id being unique per agent, and the one place
that could collide cannot: `isRecoveryCandidate` gates on the task being outstanding, and attempt
one's is settled before attempt two exists.

The launch cwd is load-bearing and is checked, not assumed. `claude --resume` resolves the transcript
inside the launch directory's project dir, so a retry that lands anywhere else finds nothing to
re-attach to — and fails as a run that died for no visible reason. The executor compares the resolved
cwd against the previous agent's and drops the inheritance if they differ.

### Events emitted

`output`, `waiting`, `autoAnswered`, `done`, `reaped`, `status`, `usage`, `flag`, `finding`,
`progress`, `files`, `resumed`, `limited` — all typed via `emit`/`on` overrides.

### Waiting

`handleWaiting(agentId, task, reason, ask?)` is the convergence point for the two ways an agent asks —
the `escalate` MCP tool and the WAITING sentinel — and for the one way it does not ask at all: an
[unannounced stop](#the-unannounced-stop) whose nudges are spent arrives here too, carrying a reason
built from the agent's own last words rather than a question it asked.

- The `parked` set is the latch. An agent already parked is **not** parked again: re-running the
  whitelist would auto-answer the same prompt twice, and re-emitting `waiting` would race the inbox's
  own per-agent dedup.
- File events are drained here, because the escalation often _is_ "review the file I just wrote", and
  a waiting agent reaches no terminal drain.
- A matching `whitelistedApprovals` rule auto-answers via `respond` and emits `autoAnswered` — no
  latch, because the agent is running again and its next question is a fresh park.
- Otherwise the agent goes to `waiting` with its reason, the task goes to `waiting`, and `waiting` is
  emitted with the optional structured `ask`.

The tool arm parks the agent **mid-turn** — the tool returns at once — so the park and the end of the
turn that raised it are two separate events, and an answer can land between them. That is why the
stream runtime does not judge a turn with a message queued behind it
([above](#a-result-is-the-end-of-a-turn-not-of-the-session)).

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

### The limit park

`handleLimited(agentId, task, park)` is the other park: the account ran out, not the agent
([above](#the-usage-limit-park-issue-318)). It is the same latch and the same three store writes as
`handleWaiting`, and deliberately **not** the same event.

- The row's `waitingReason` becomes a sentence naming what ran out and when it resets —
  `Parked on a usage limit: this account's five-hour usage limit is spent, and it resets at …`. An
  unknown window name is printed verbatim rather than dropped: a park that names no limit is the
  failure the wording exists to prevent.
- **No escalation.** `waiting` is what `src/system.ts` turns into an inbox item, and an inbox item is a
  question put to a human; this one has no answer. It would sit in the queue as a message nobody can
  reply to, under a heading that says somebody must. The park is drawn on the _agent_ instead — the
  fleet row, the drawer, and a `limit` row in "Needs you" built from the fleet rather than from an
  escalation ([17](17-cockpit.md#the-queue-rail--needs-you)).
- An agent that had **already** parked on a question keeps that question on its row. The escalation it
  raised is still open and still the thing a human must answer; overwriting the reason would leave that
  inbox row pointing at a sentence about a limit.
- **Nothing is settled.** The row keeps its session id, `endedAt` stays null, the task stays `waiting`
  (outstanding, so the work is neither lost nor re-dispatched on top) and the worktree stays on disk.
  All three are what the resume needs, and all three are what recording this as `failed` threw away.

The park is held in memory (`limited`, agentId → reason), because it describes a park _this process_ is
holding. A restart drops it, at which point the same rows — `waiting` agent, outstanding task — are
ordinary orphans and the recovery desk asks the wider question.

When the process exits under a park, `shedLimitedSession` gives back what the launch held — the spool,
the MCP credential, the session map entry, the pid — **without** a terminal transition. Leaving the
credential bound would keep a live bearer token for the length of a park, which can be hours. The
`exited`/`exitCodes` entries are dropped for `kill`'s reason: no reap is owed for a process whose work
is unfinished, and a stale `exited` would make the _resumed_ run's first terminal reap a worktree out
from under a live agent.

`resumeParked(agentId)` ends it, and is the only thing that does — reached two ways, which is not the
same as two paths. If the session somehow survived, one message goes down
the stdin that is already open; otherwise the conversation is re-opened through `resume`, which is why
the park keeps the session id. The reason is cleared _before_ either arm, since `resume` reads the row
to decide whether the agent was parked on a question — and this park is the one it must not put back.
The message is the limit's own, not `buildResumeMessage`'s "you were resumed after a server restart":
nothing restarted, and an agent that believes otherwise re-reads its branch looking for work it did
itself minutes ago. Any failure puts the park back, so a refused resume leaves the operator where they
were rather than with an agent that is neither parked nor running.

Only an agent this process parked is a candidate; anything else is refused by name. `kill` is the one
other verdict available on a limit park, and it is available _because_ the session is gone: a park that
outlives its process would otherwise have "resume" as the only thing anyone could ever say to it.

#### Ending it on the clock

`resumeExpiredParks()` is the first of the two callers: the harness cycle
([04](04-harness-cycle.md)) ends every park whose `resetsAt` has passed, so the ordinary case needs no
operator at all. It sits with the pulse's other bookkeeping, above the `listTasks`/`listAgents` reads
so an agent it wakes reads as `running` for the rest of that pulse rather than appearing parked to
the burn watch and the state snapshot one last time. Worst-case lag is one heartbeat past the reset.

This is the one park with a **known end**: nobody has to decide anything, and `claude` says on the way
out when the account works again. So the reset time is kept in the `limited` map as a value beside the
sentence it is also printed in — re-parsing it back out of an operator-facing sentence would make that
wording load-bearing.

- **A park with no `resetsAt` is never resumed automatically.** Every field but `status` is optional in
  the CLI's payload, and there is no moment to wait for. Picking one would be the harness guessing at
  another service's accounting and waking an agent into an account still spent — a launch, a fresh MCP
  credential and a turn, and then a re-park. An unparseable reading takes the same arm, for the same
  reason. `POST /api/agents/:id/resume` ([16](16-http-api.md#post-apiagentsidresume)) is the way out of
  those, and stays the way to end any park ahead of its window.
- **No headroom check.** `countLiveAgents` counts `waiting`, so a parked agent has held its slot the
  whole time it was parked: resuming it changes no count and can crowd out nothing.
- **A resume that fails is recorded**, by the cycle rather than by the manager. The park goes back on,
  so the next pulse retries — and a park that can never be resumed would otherwise retry forever in
  silence, which is the shape of failure the park itself was written to stop being.

A park held across a **restart** is not covered: the map is in-memory, so those rows reach the recovery
desk, which asks the wider question. That is unchanged, and deliberately — two surfaces resuming one
row would race for its session id.

### Terminal, exit and reap

`exit(code)` records the code and marks the process exited. `done` calls `handleTerminal` directly;
`failed` goes through the auto-resume gate below first, and only reaches it if the agent is not being
re-attached. `handleTerminal`
which drains file events one last time, clears the park, flushes the transcript, marks agent and task,
drops the session, records a `failed` agent to the error log with its exit code and an output tail,
emits `done`, and then calls `maybeReap`.

`reaped` is emitted only once **both** halves have happened — terminal status recorded _and_ process
exit observed. The two arrive in either order (PTY: sentinel first, exit later; stream: exit first).
On reap the file-events spool is disposed and the MCP credential is released. Only then is it safe to
touch resources the process pinned, which is why worktree removal hangs off this event.

### The questions a dead agent leaves behind

An escalation carrying an `agentId` is a question **a process asked** — a park
([above](#waiting)) or a permission request ([11](11-mcp-tools.md#request_permission)) — and its
answer routes into that process. Once the process is gone, the answer routes nowhere, so the card is
un-answerable and must leave "Needs you". Nothing else in the inbox is affected: a proposal, a
stack-landing stop and every rule-raised item carry no `agentId` and stay answerable whatever the
fleet did.

`src/system.ts` is the fast path, dismissing through `EscalationInbox.dismissEscalationsForAgent` at
each terminal transition it hears — `killed` off `status`, and every `done` whatever status it carries
and whoever declared it. **An agent-declared `done` counts**: an agent that answered its own question
and finished leaves exactly the same un-answerable card as one that crashed with it open.

`EscalationInbox.tidyDeadAgents()` is the backstop, run once per pulse from `Harness.runCycle`
immediately before the store read that ships the inbox, so a swept card is gone on the same pulse. It
scans open escalations, looks up each one's agent, and dismisses whatever names a row in `done`,
`failed`, `killed` or `interrupted`. It exists because the fast path is an _enumeration of
transitions_ that has to stay complete: a death arriving by a route nobody wired there leaves the card
up for good, and nothing about it looks wrong — it renders correctly, and only the agent's absence
says otherwise. Idempotent, and it writes nothing over a clean inbox.

`crashed` is deliberately not in that set, and neither is an `agentId` naming no row at all. A crashed
agent is awaiting a recovery decision and may be **restored**, and a restored agent must come back to
the question it parked on — the dismissal hangs off the requeue/remove verdicts instead
([below](#the-three-verdicts)). Agent rows are never deleted, so a missing one is a fault elsewhere,
and dismissing on a read that came back empty is how a store bug becomes a silently emptied inbox.

Both paths record the dismissal in `context.dismissal` and in the decision log under the synthetic
cycle id `agent-lifecycle` ([18](18-observability.md#the-decision-log)), so a cleared question leaves
a trace like any other outcome.

### Auto-resume on a mid-run crash

`failed` is gated before it reaches `handleTerminal`. When the runtime is resumable, the row carries a
session id, its worktree is still on disk and the agent has spent fewer than `agentResumeAttempts`
(default 3), the death is **not** terminal: the agent is re-attached to its own conversation with
`AgentManager.resume`, on the same row, in the same worktree, and — if it was mid-work rather than
parked — handed the `buildResumeMessage()` nudge. The task stays `running` and nothing reaches the
error log.

The death of the process is not the death of the session: the transcript is on disk and `--resume`
picks it up with everything the agent had learned, so settling the task throws away a recoverable run.
`requeue` exists and starts over, which is a different and worse answer.

What keeps that from being a crash loop is the budget. It is counted on **`agents.resume_attempts`**,
not in memory, because `spawn`/`resume` reuse one agent row across restarts — an in-memory counter
refills on every boot and an agent whose `claude` dies at launch would relaunch forever. It is never
cleared, so it bounds the agent's whole life rather than its current launch, and it is deliberately
_not_ `resumed_at`: that column records an observation about a **park** and is cleared whenever an
escalation is answered, so a budget riding on it would refill every time somebody replied. The
`agentResumeAttempts + 1`-th death settles as `failed` with an error naming how many resumes were
tried, so a loop reads as a loop. `agentResumeAttempts: 0` restores the pre-#318 behaviour.

**The teardown before the re-attach is the sharp edge.** `resume` was written for boot, where the
in-memory maps are empty: it `set`s the spool key and the MCP token rather than replacing them, and
its own `sessions.has` guard returns a silent success for an agent still in the map. Called mid-run
without first dropping the dead session, disposing its spool and releasing its credential, it leaks a
spool directory and leaves a **bearer credential bound and live** with nothing left to revoke it —
and the agent visibly comes back either way, which is why `test/streamResume.test.ts` asserts the
revocation rather than reasoning about it. The recorded exit code and the exited marker are cleared
too: they belong to the launch that died, not to the one replacing it.

A decided ending is never re-opened. `kill` and `complete` drop the session from the map first, so the
process exit that follows finds a session that is no longer the agent's and the gate declines it — the
same reason `ORPHAN_STATUSES` excludes `killed`/`done`/`failed`.

### Auto-restore after an upgrade

An ordinary restart parks every orphan for a verdict, and the pulse is held until each one is
answered. A restart the harness asked for **on its own behalf** is the one exception: under an
`applying` upgrade intent, `RecoveryDesk.settleUpgrade` restores each orphan that is `interrupted`
and restorable, without asking.

The verdict was decided before the shutdown, not on the way back up. An operator who pressed apply
with agents running was told in the refusal they overrode that those agents come back, so this is the
second half of a decision already taken — not the harness deciding for them, which is the thing this
desk exists to have stopped.

Two fences keep it that narrow. **Only under `applying`**, so a restart that was not the upgrade's
restores nothing. And **only `interrupted`**: a `crashed` row never got the chance to write an
ending, so something else killed that agent between the handoff and the restart, and its work is in a
state nobody has looked at. Anything not restorable — no session id, worktree gone — lands in the
panel with the reason `restorability` already wrote. Full flow: [21](21-self-update.md#coming-back-up).

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

- **It runs before the root is signalled.** Both mechanisms resolve descendants _through_ the root
  pid, so reaping after `child.kill()` finds a tree that no longer has a root — the children have been
  reparented and cannot be reached from here. In `PtySession.kill` this sits between the `killed`
  status and `proc.kill`, inside the ordering rule above.
- **It never throws.** A failed reap must not take a kill path down with it — the agent still has to
  be marked, the transcript flushed and the credential released — so failures go to the error log and
  the caller carries on.

Reached from `kill`, `complete`, `interruptAll`, and the PTY `exitOnDone` teardown's forced arm: every
path by which the _harness_ stops an agent. **An agent that exits by itself is not covered** and
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

| Verdict   | Effect                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restore` | `agents.resume(agent, task)` — re-attach to the same session in the same worktree. Offered only when `restorable`.                                                              |
| `requeue` | Retire agent (`interrupted`) and task (`interrupted`), dismiss its escalations, and file a **job** carrying the work — unless the job it came from never left the queue, below. |
| `remove`  | Retire agent and task, dismiss its escalations. Nothing is queued; the branch and worktree are kept.                                                                            |

Settling the **task** is the load-bearing half of the last two, and the only half an agentless orphan
has: `interrupted` is what releases the origin and branch the `queued` row was holding shut. Such an
orphan has no escalations by construction — an escalation is raised by a process, and none ever ran.

`restorability` (pure) decides whether restore is on offer and carries the reason when it is not — no
agent having existed at all, a runtime that cannot resume (only `raw`, which keeps no session id —
stream and PTY both do, since #318), a row with no `sessionId`, or a worktree no longer on disk. The
agentless arm answers **first**,
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

Its _dispatch_ origin is `job:<id>`, and the original origin rides on `Job.originRef` — the work the
job **stands in for**. The gates read that field while the job is queued and while the task it became
is live, so the rule that produced the original does not staff the same work a second time; without
it, a requeued retro and a freshly dispatched `issue:249:retro` ran at once (#249). See
[13](13-jobs-and-findings.md#standing-in-for-another-origin) for the predicate and its two readers.
The preamble still names the origin in words, because a fresh agent needs to know it is redoing work.

**A requeue of work behind a still-queued job files nothing**, and hands that job back instead. A job
leaves the queue only through `markJobDispatched`, which runs after the spawn succeeds — so a
predecessor still `queued` means no agent ever ran and the queue is already holding the request
unchanged. A second job for it would not be a requeue but a duplicate, and a duplicate that locks the
queue: its `originRef` is the task's `job:<predecessor>`, which makes it _stand in_ for the
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

`spawn` and `resume` share their listener wiring — change one, change both. None of the restore path is
runtime-specific: it re-uses the row, mints fresh per-launch resources and branches on `waitingReason`,
which is why teaching the stream launch the two flags was the whole of making the default deployment
restorable. Tests: `test/crashRecovery.test.ts`, `test/resume.test.ts` (PTY),
`test/streamResume.test.ts` (stream — the same restart, restore, nudged-vs-parked and
transcript-continues assertions on the default runtime).

## Usage capture

Two mode-specific sources. They are not interchangeable.

- **Stream mode** — each `result` event's cumulative `total_cost_usd` / `usage` / `num_turns` becomes
  a `usage` event. `Store.recordAgentUsage` writes the cumulative values onto the `agents` row (cache
  tokens folded into input, and the read/write split kept apart beside it —
  [18](18-observability.md#the-cached-share-is-stored-not-inferred)) **and** the cost _delta_ as a
  timestamped `usage_events` row, so rolling 5h/7d cost windows are a plain `SUM` over the window.
- **PTY mode** — reports no per-turn usage. Instead it captures the **account rate limits**: the
  Pro/Max `rate_limits` in the status-line payload, which is the one programmatic surface for them.
  `buildClaudeArgs({statusLine: true})` wires a `--settings` status command that atomically dumps each
  payload to `$LUBBDUBB_STATUS_FILE` (per session id, under the OS tmpdir), and
  `StatusFileRateLimits.readLatest()` feeds the freshest one into the snapshot's `usage.rateLimits`.
  Parsing is pure (`parseStatusLinePayload`, `src/agents/statusLine.ts`).

`usage.rateLimits` is null when absent, and the cockpit chip then falls back to the cost windows.
Tests: `test/usage.test.ts`.
