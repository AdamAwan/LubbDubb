# Collapsing tool calls in the agent transcript

## The problem

The drawer transcript is dominated by tool activity. A single `grep -rn` fills the pane with a
dozen indented result lines, and the agent's reasoning — the thing an operator opens the drawer to
follow — is pushed apart into fragments between walls of output. Progress is legible only by
scrolling past the evidence of it.

What an operator wants from the pane is the agent's line of thought and a sense of movement. Tool
calls are scaffolding: worth seeing that they happened, worth opening when something looks wrong,
not worth reading by default.

## What changes

Tool calls render as **collapsed blocks**. A call is one dim line — its label, its one-line input
summary, and the size of what came back:

```
⚙ Bash cd D:/_git/NXG/.lubbdubb/worktrees/issue-35645 && grep -rn "RecurringJob.AddOrUpdate"… · 14 lines
```

Clicking it reveals the output. Reasoning is unbroken prose between those lines.

An **error result never collapses**: it renders expanded and red, as it does today. A failure that
hides is worse than a failure that takes up space.

## Where the structure comes from

The transcript remains a **text stream**. `src/wire.ts` gains no new payload, persistence is
untouched, the socket is untouched, and both agent runtimes keep producing the same bytes they
produce now. The change is that the block markers `renderToolUse` and `renderToolResult` already
emit stop being decoration and become a contract.

The marker tokens move into `src/wire.ts` as exported constants, imported by both
`src/agents/streamTranscript.ts` (which writes them) and the new client parser (which reads them).
`test/wireContract.test.ts` already forbids anything under `web/src/` from naming any other server
module, so `wire.ts` is the only place a shared constant can live — and a single definition read by
both sides is the point. Two independent views of the same bytes is the failure the PTY sentinel
scanner exists to prevent (`src/pty/sentinelScanner.ts`); a marker written by one regex and matched
by another would reintroduce it in a new place.

## The drawer

A new pure module `web/src/components/transcriptBlocks.ts`, sibling to `ansi.ts` and structured the
same way: it takes a chunk of transcript plus the state carried from the previous chunk, and returns
a list of **DOM operations** — open a tool block, append styled text to the current container, close
the block — together with the state to thread into the next chunk. Any incomplete trailing line is
held in that state until its newline arrives, so a delta splitting a marker mid-line cannot produce
a half-parsed block.

`AgentDrawer` keeps ownership of the DOM and of the append-only diff it already performs. Its
`appendChunk` stops appending unconditionally into the pane and instead applies the operations,
appending into whichever container is currently open. ANSI styling is unaffected: `parseAnsi` still
runs over each text run, and its carried `AnsiStyle` threads alongside the block state.

A tool block is a `<details>` element. Its `<summary>` is the existing dim one-liner plus the line
count of the result; its body is the result text, styled as today.

## Pairing a result with its call

A tool call and its result arrive in **separate messages**, and the rendered stream carries no tool
ids. The client therefore pairs a result with the tool line it **immediately follows**. That is
correct for the ordinary case of one call per turn.

When an agent fires **parallel** tool calls the stream is two `⚙` lines followed by two `↳` lines,
and adjacency would pair them wrongly. In that case each result renders as its **own standalone
collapsed block** rather than being folded into a tool line — still quiet, still one line until
opened, just not nested under its call.

The alternative — emitting a short tool id into each marker line so pairing is exact — was rejected:
it puts permanent visible noise into a transcript humans read raw, to fix a minority case whose
degraded rendering is merely un-nested rather than wrong.

## Consequences

**`MAX_RESULT_LINES` rises from 12 to 200.** The cap exists because unbounded output drowned the
pane; with bodies hidden by default that pressure is gone, and a collapsed block is only worth
opening if the whole result is inside it. The remaining-lines marker stays for output past 200.

**Blocks are always collapsed, including the one currently arriving.** In stream mode a message's
blocks land whole, so there is no live-typing effect to lose, and the summary line appears the
moment the call fires — which is the progress signal. No auto-open-then-collapse: that would make
the pane jitter for no information gained.

**No sticky expansion state.** Expansion lives in the DOM only. A reseed — an agent switch, or a
non-append change to the buffer — rebuilds the pane with every block collapsed. Reseeds are rare
enough that preserving state is not worth the bookkeeping.

**PTY mode is unchanged and gains nothing.** A settled PTY transcript carries no tool-call
boundaries, so the parser finds no markers and emits the pane as plain prose — exactly what it
renders today. This is a property of the runtime, not a gap in the design.

## Testing

- `test/transcriptBlocks.test.ts` — the new pure assembler: a call with a result, an error result,
  a chunk boundary splitting a marker line mid-way, parallel calls producing standalone result
  blocks, and prose interleaved between blocks.
- `test/streamTranscript.test.ts` — extended to assert the rendered output uses the shared marker
  constants, so a change to one side fails rather than silently desynchronising the other.
- `test/ansi.test.ts` — unchanged; styling is orthogonal.

## Specs to update in the same change

- [`docs/spec/17-cockpit.md`](../../spec/17-cockpit.md) — owns the transcript pane; documents the
  collapsed-block rendering and the expansion behaviour.
- [`docs/spec/10-agent-runtimes.md`](../../spec/10-agent-runtimes.md) — owns the transcript format;
  documents the markers as a contract and the raised result cap.
