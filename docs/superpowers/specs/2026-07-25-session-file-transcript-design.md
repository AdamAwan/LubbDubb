# Session-file transcript (PTY mode)

**Date:** 2026-07-25
**Status:** approved

## Problem

In `agentMode: 'pty'` the cockpit transcript is produced by screen-scraping the interactive
`claude` TUI: raw PTY bytes go into a headless xterm (`TerminalTranscript`), the settled screen
is read back, and rows that look like chrome are dropped by the `isTuiChromeLine` heuristic.

That is structurally lossy, and it shows. Observed in a live drawer:

- the slash-command autocomplete dropdown captured as transcript content (`/exit  Exit the CLI`,
  `/context  Visualize current context usage as a colored grid`, `/usage-credits …`)
- `Tip: Use /memory to view and manage Claude memory`
- `Read 1 file (ctrl+o to expand)`
- separator rules from the input box frame
- assistant prose hard-wrapped at the emulator's column width

Every one of those is a new pattern to blacklist, and the wrapping cannot be fixed by
blacklisting at all — the emulator has already destroyed the logical line structure. The last
several PTY commits have been this treadmill (sentinel detection diverging on styled tokens, the
initial-submit race, hooks in PTY mode).

The requirement is narrow: **an up-to-date, nicely formatted transcript, plus the ability to send
messages.** No terminal fidelity is wanted in the UI. The cockpit already renders an HTML pane,
not a terminal.

## Key insight

Claude Code already writes a clean, structured transcript for every session to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

PTY mode already pins the session id (`--session-id`, needed for resume), so LubbDubb knows
exactly which file belongs to each agent. The same session that produced the mess above is on
disk as:

```
[user]                "Read this project's README.md and write a 3-4 sentence summary…"
[assistant/thinking]
[assistant/tool_use]  "Read"
[user/tool_result]    "1\t# LubbDubb\n2\t\nA self-hosted, always-running…"
[assistant/tool_use]  "Write"
[assistant/text]      "Written to `reports/lubbdubb-summary.md` — a four-paragraph…"
[user]                "You were resumed after a server restart. Continue the task…"
[assistant/text]      "The file survived the restart… @@LUBBDUBB_WAITING:…"
[user]                "yea all good"
[assistant/text]      "Confirmed — summary is accurate… @@LUBBDUBB_DONE@@"
```

No chrome, no wrapping, sentinels clean and unstyled — and these are exactly the `ContentBlock`
shapes `renderBlocks` (stream mode's legibility seam) already consumes. Resumed turns append to
the same file, because the session id is pinned.

Entries are written per content block as each completes (observed: `thinking` at `:43`,
`tool_use` at `:45`, `tool_result` at `:45.5`, `text` at `:52:00`). Not token-by-token, but live
at block granularity — sufficient for "up to date", and far better than a 200ms debounce of a
garbled screen.

## Approach

**Stop reading the screen. Tail the session file.** The TUI becomes purely an input device. PTY
and stream converge on one legibility path (`renderBlocks`).

### 1. New module `src/agents/sessionTranscript.ts`

Split on the repo's usual pure/IO seam.

**`parseSessionEntries(lines: string[]): ParsedBatch`** — pure.

```ts
interface ParsedBatch {
  blocks: ContentBlock[]; // in order, ready for renderBlocks
  assistantText: string; // raw assistant text, sentinels intact, for detection
  userEntries: number; // human/injected messages accepted by the session
}
```

Keeps only `user` and `assistant` entries. Drops, by observation of real session files:

- other entry types: `attachment`, `system`, `mode`, `permission-mode`, `last-prompt`,
  `ai-title`, `file-history-snapshot`, `file-history-delta`, `queue-operation`
- `isMeta: true` and `isSidechain: true` entries (subagent chatter — the parent's `Task`
  `tool_use` already marks it)
- **local-command envelopes.** `exitOnDone` writes `/exit`, which lands in the JSONL as
  `<local-command-caveat>…`, `<command-name>/exit</command-name>`,
  `<command-message>`, `<command-args>`, `<local-command-stdout>Bye!</local-command-stdout>`.
  Unfiltered, the teardown reintroduces exactly the mess this change removes. Filtered by a
  small allowlist of envelope tag names at the head of a string `user` content.

A `user` entry with string content is a human/injected message; with array content it carries
`tool_result` blocks. String content becomes a `{ type: 'human', text }` block so the drawer
shows what was sent — you should be able to see your own messages.

**`SessionTranscriptTail`** — the IO side.

- Locates the file by globbing `<root>/*/<sessionId>.jsonl`. Deliberately **does not** derive the
  directory-name encoding rule; the session id is unique and the glob is robust to encoding
  changes.
- Polls for growth, reads appended bytes, buffers a partially-written trailing line until its
  `\n`.
- `startAtEof` for resume: a resumed session reopens a file that already holds the prior turns,
  which are already persisted, so the tail seeds its offset at EOF rather than re-emitting them
  as duplicates.
- One callback per batch carrying the three derived facts: display text (→ `output` delta), raw
  assistant text (→ sentinel detection), and the user-entry count (→ boot-race landing signal).

Tested against a temp file — no fakes and no native dependency needed.

### 2. `PtySession`: the mirror is replaced by the tail

`legibleTranscript` becomes `sessionTranscript: { root }`. The append/replace split in the
current `onUpdate` disappears: a file tail is append-only, so PTY emits plain `output` deltas
exactly like stream mode.

`raw`/mock sessions have no session file and keep emitting raw bytes as today, so
`scripts/mock-agent.sh` is unaffected.

### 3. Detection: primary source plus an announcing backstop

Both sources call one idempotent `noteSentinel(kind, payload, source)`.

- **Primary** — JSONL assistant text, through the same `stripSentinels` / `extractWaitingReason`
  helpers stream mode uses. Clean text, so the styled-token bug class cannot occur.
- **Backstop** — the existing raw `scanSentinels` scan, deferred. A raw hit starts a
  `SENTINEL_BACKSTOP_MS` (5s) timer; the primary reporting the same sentinel cancels it. If the
  timer fires, the raw detection is applied **and** `errors.record` logs that the session-file
  tail missed a sentinel.

The announcing property is the point. Two detectors that silently disagree is the bug already
fixed once in `fd560e6`; a backstop that reports when it fires makes drift visible in the Errors
panel instead of rotting. With the screen no longer feeding the UI, the two paths cannot diverge
*visibly* — they are both detectors, and status transitions are already idempotent.

`sentinelScanner.ts` shrinks rather than deletes: `scanSentinels` and the detection-tail excision
stay (excision still prevents the sliding window re-firing). `holdFrom` and the display-excise
path go, since nothing forwards raw bytes to a display any more.

### 4. Boot race gets a better signal

`deliverInitial` stops reading the emulator's input box. "The pasted prompt landed" becomes "a new
`user` entry appeared in the JSONL" — observed rather than inferred from box contents, and
available without an emulator. The paste-once / re-send-bare-CR loop is otherwise unchanged, and
still bounded by `initialSubmitAttempts`.

### 5. Resume

`resume()` builds a new session against the same file. The tail starts at EOF so prior turns are
not re-emitted; the user-entry count therefore naturally counts only post-resume messages, which
is what the boot-race signal needs.

## Deletions

| Item                                                                                                            | Lines |
| --------------------------------------------------------------------------------------------------------------- | ----- |
| `src/pty/terminalTranscript.ts` (incl. `isTuiChromeLine`, `inputBoxText`)                                       | 165   |
| `@xterm/headless` dependency                                                                                     | —     |
| `test/terminalTranscript.test.ts`, `test/ptyLegibleTranscript.test.ts`                                           | 294   |
| `transcript` event path end-to-end: `Store.setTranscript`, `agent:transcript`, `Hub.handleTranscript` + its duplicated tail rebuild, the drawer's replace branch | ~60   |
| `PtySession` mirror / hold / chunk-straddle machinery                                                            | ~150  |

## Rendering decisions

- **Human messages render.** `renderBlocks` gains a `human` block case. You should see what you
  sent.
- **`thinking` blocks stay dropped**, matching stream mode today. `renderBlocks` already ignores
  unknown block types.

## Risk

The JSONL shape is internal to Claude Code and undocumented; it could change across versions.
Accepted, because:

- it is far more stable than screen-scraping a TUI, which changes with every UI tweak;
- failure is loud — a parse error routes through `errorLog` and surfaces in the Errors panel,
  rather than silently producing garbage;
- the glob-by-session-id lookup avoids depending on the directory-name encoding at all;
- the deferred raw-scan backstop means status transitions still fire even if the tail breaks
  entirely.

## Testing

- `test/sessionTranscript.test.ts` — new. Pure parser against fixture lines (all real entry
  types, `isMeta`/`isSidechain`, local-command envelopes, string vs `tool_result` user content);
  tail against a temp file (growth, partial trailing line, `startAtEof`).
- `test/ptySentinelScanner.test.ts` — updated for the reduced scanner surface.
- `test/ptyInitialSubmit.test.ts` — updated for the JSONL landing signal, dropping the
  hand-rendered input-box rows.
- `test/hub.test.ts` — updated for the removed `agent:transcript` frame.
