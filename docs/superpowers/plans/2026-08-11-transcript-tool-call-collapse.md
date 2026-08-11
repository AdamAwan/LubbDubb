# Transcript tool-call collapse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render tool calls in the agent drawer as collapsed one-line blocks so the agent's reasoning is the visual spine of the transcript.

**Architecture:** The transcript stays a flat ANSI text stream — no wire, socket or persistence change. The server labels a result with its pre-truncation line count and raises the truncation cap; a new pure client module turns the marker lines the renderer already emits into DOM operations, and `AgentDrawer` applies those operations into `<details>` elements instead of appending flat text.

**Tech Stack:** TypeScript (ESM, `nodenext`, explicit `.js` import extensions), React 18 for the cockpit, `node:test` + `node:assert/strict` for tests, plain CSS.

Spec: [`docs/superpowers/specs/2026-08-11-transcript-tool-call-collapse-design.md`](../specs/2026-08-11-transcript-tool-call-collapse-design.md)

## Global Constraints

- ESM with explicit `.js` import extensions, even from `.ts` sources.
- `src/wire.ts` must stay declaration-only — no runtime constant may be added there (`test/wireContract.test.ts`).
- `web/src/**` may import no server module other than `../../src/wire.js`, and only as `import type`.
- knip runs with every rule at `error`: every `export` must be imported somewhere. Drop the `export` keyword rather than adding an ignore.
- Two typecheckers: `npm run typecheck` (server) and `npm run typecheck:web` (cockpit). This change spans both.
- Comments explain *why*, not *what*. Match the terse, high-signal style of `web/src/components/ansi.ts`.
- Behaviour changes update the owning spec in the same change: `docs/spec/10-agent-runtimes.md` (transcript format), `docs/spec/17-cockpit.md` (transcript pane).
- `npm run check` must pass before the PR. On Windows, `format:check` reports CRLF noise across unrelated files; run `npm run format` and judge the real failures from `lint`/`typecheck`/`test`.

---

### Task 1: Server — line-count suffix and the raised cap

The collapsed summary needs the size of the result, and only the server knows the count before truncation. This task also raises `MAX_RESULT_LINES` from 12 to 200, which is only safe once bodies are hidden by default — but it is a pure formatting change and lands here with its sibling.

**Files:**
- Modify: `src/agents/streamTranscript.ts:33` (`MAX_RESULT_LINES`), `src/agents/streamTranscript.ts:93-103` (`renderToolResult`)
- Test: `test/streamTranscript.test.ts`
- Docs: `docs/spec/10-agent-runtimes.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the result label shape `  ↳ result · 214 lines` (and `  ↳ error · 3 lines`), which Task 2's parser matches. `MAX_RESULT_LINES = 200`. A single-line result carries **no** suffix.

- [ ] **Step 1: Write the failing tests**

Add to `test/streamTranscript.test.ts`:

```ts
test('renderBlocks labels a multi-line result with its line count', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', content: 'a\nb\nc' }]));
  assert.match(out, /↳ result · 3 lines/);
});

test('renderBlocks omits the count for a single-line result', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', content: 'just one' }]));
  assert.match(out, /↳ result\n/);
  assert.ok(!out.includes('· 1 line'), 'no count for a one-line result');
});

test('the result count is the pre-truncation total', () => {
  const body = Array.from({ length: MAX_RESULT_LINES + 14 }, (_, i) => `line-${i}`).join('\n');
  const out = plain(renderBlocks([{ type: 'tool_result', content: body }]));
  assert.match(out, new RegExp(`↳ result · ${MAX_RESULT_LINES + 14} lines`));
  assert.ok(/\+14 more lines/.test(out), 'still reports what was hidden');
});

test('an error result is labelled and counted the same way', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', is_error: true, content: 'boom\ntrace' }]));
  assert.match(out, /↳ error · 2 lines/);
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx tsx --test test/streamTranscript.test.ts
```

Expected: the four new tests fail — the label has no `·` suffix.

- [ ] **Step 3: Implement**

In `src/agents/streamTranscript.ts`, change the cap and the label:

```ts
/** Tool output longer than this many lines is truncated with a remaining-lines marker. */
export const MAX_RESULT_LINES = 200;
```

```ts
function renderToolResult(b: ContentBlock): string {
  const body = sanitise(extractResultText(b.content));
  const { text, hidden } = truncateLines(body, MAX_RESULT_LINES);
  // Pre-truncation total: the cockpit folds this into the collapsed summary, and
  // the server is the only side that still knows what was cut.
  const total = body === '' ? 0 : body.split('\n').length;
  const count = total > 1 ? `${DIM} · ${total} lines${RESET}` : '';
  const label = b.is_error ? `${RED}  ↳ error${RESET}${count}` : `${GRAY}  ↳ result${RESET}${count}`;
  const indented = text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  const more = hidden > 0 ? `\n  ${DIM}… (+${hidden} more lines)${RESET}` : '';
  return `\n${label}\n${indented}${more}\n`;
}
```

- [ ] **Step 4: Run the whole transcript suite**

```bash
npx tsx --test test/streamTranscript.test.ts
```

Expected: PASS, including the pre-existing truncation test (it asserts `+20 more lines` against `MAX_RESULT_LINES + 20`, so the raised cap does not break it).

- [ ] **Step 5: Update the runtime spec**

In `docs/spec/10-agent-runtimes.md`, in the section describing the rendered transcript, state as fact: a tool result is labelled `↳ result` (or `↳ error`) followed by a dim `· N lines` suffix giving the pre-truncation total, omitted when the result is a single line; output beyond 200 lines is truncated with a remaining-lines marker.

- [ ] **Step 6: Commit**

```bash
git add src/agents/streamTranscript.ts test/streamTranscript.test.ts docs/spec/10-agent-runtimes.md
git commit -m "Label a tool result with how much came back"
```

---

### Task 2: The block parser

A pure module that turns the transcript text stream into DOM operations. No DOM here — this is the testable seam, matching how `ansi.ts` is split from `AgentDrawer`.

**Files:**
- Create: `web/src/components/transcriptBlocks.ts`
- Test: `test/transcriptBlocks.test.ts`

**Interfaces:**
- Consumes: the label shapes Task 1 produces.
- Produces, for Task 3:

```ts
export interface BlockOp {
  /** `open` starts a collapsible block; `text` appends into the current container; `close` returns to the pane. */
  kind: 'open' | 'text' | 'close';
  /** `open`: the summary line, ANSI intact. `text`: the run to append, ANSI intact. */
  text?: string;
  /** `open` only: an error block, which renders expanded and never collapses. */
  error?: boolean;
}

export interface BlockState {
  /** An unterminated trailing line, held until its newline arrives. */
  pending: string;
  /** Whether a block is open, and whether its body has started. */
  inBlock: boolean;
  awaitingResult: boolean;
}

export const emptyBlockState: BlockState;

export function feedBlocks(chunk: string, state: BlockState): { ops: BlockOp[]; tail: string; state: BlockState };
```

`tail` is the current unterminated line — the caller renders it provisionally so streaming text is not held back, and replaces it on the next feed.

- [ ] **Step 1: Write the failing tests**

Create `test/transcriptBlocks.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedBlocks, emptyBlockState } from '../web/src/components/transcriptBlocks.js';
import { renderBlocks } from '../src/agents/streamTranscript.js';

/** Strip SGR so assertions read against plain text. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Feed a whole transcript in one go. */
function all(text: string) {
  const { ops, tail } = feedBlocks(text, emptyBlockState);
  return { ops: ops.map((o) => ({ ...o, text: o.text === undefined ? undefined : plain(o.text) })), tail: plain(tail) };
}

test('prose with no markers is a single text op', () => {
  const { ops } = all('I will look at the config.\n');
  assert.deepEqual(ops, [{ kind: 'text', text: 'I will look at the config.\n' }]);
});

test('a tool call and its result become one collapsed block', () => {
  const rendered = renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]) +
    renderBlocks([{ type: 'tool_result', content: 'a\nb\nc' }]);
  const { ops } = all(rendered);
  const open = ops.find((o) => o.kind === 'open');
  assert.ok(open, 'a block opened');
  assert.match(open!.text!, /⚙ Bash ls/);
  assert.match(open!.text!, /· 3 lines/, 'the result count is folded into the summary');
  assert.equal(open!.error, false);
  const body = ops.filter((o) => o.kind === 'text').map((o) => o.text).join('');
  assert.ok(body.includes('a') && body.includes('c'), 'the result body is inside the block');
  assert.equal(ops.at(-1)!.kind, 'close');
});

test('an error result opens an error block', () => {
  const rendered = renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'nope' } }]) +
    renderBlocks([{ type: 'tool_result', is_error: true, content: 'command not found' }]);
  const open = all(rendered).ops.find((o) => o.kind === 'open');
  assert.equal(open!.error, true);
});

test('parallel calls yield standalone blocks rather than mispaired ones', () => {
  const rendered =
    renderBlocks([
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', name: 'Read', input: { file_path: 'b.ts' } },
    ]) + renderBlocks([{ type: 'tool_result', content: 'aaa' }, { type: 'tool_result', content: 'bbb' }]);
  const opens = all(rendered).ops.filter((o) => o.kind === 'open');
  assert.equal(opens.length, 4, 'two calls and two results, each its own block');
  assert.match(opens[0].text!, /a\.ts/);
  assert.match(opens[1].text!, /b\.ts/);
  assert.match(opens[2].text!, /↳ result/);
});

test('prose after a result leaves the block', () => {
  const rendered =
    renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]) +
    renderBlocks([{ type: 'tool_result', content: 'a\nb' }]) +
    renderBlocks([{ type: 'text', text: 'Three files, as expected.' }]);
  const { ops, tail } = all(rendered);
  assert.ok(ops.some((o) => o.kind === 'close'), 'the block closed');
  const after = ops.slice(ops.findLastIndex((o) => o.kind === 'close') + 1);
  assert.ok(after.concat([{ kind: 'text', text: tail }]).some((o) => (o.text ?? '').includes('Three files')));
});

test('a chunk boundary mid-marker does not half-parse a block', () => {
  const rendered =
    renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]) +
    renderBlocks([{ type: 'tool_result', content: 'a\nb' }]);
  const cut = rendered.indexOf('Bash') + 2;
  const first = feedBlocks(rendered.slice(0, cut), emptyBlockState);
  const second = feedBlocks(rendered.slice(cut), first.state);
  const opens = [...first.ops, ...second.ops].filter((o) => o.kind === 'open');
  assert.equal(opens.length, 1, 'exactly one block despite the split');
  assert.match(plain(opens[0].text!), /⚙ Bash ls/);
});

test('an unterminated trailing line is reported as tail, not swallowed', () => {
  const { ops, tail } = all('thinking about it');
  assert.deepEqual(ops, []);
  assert.equal(tail, 'thinking about it');
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx tsx --test test/transcriptBlocks.test.ts
```

Expected: FAIL — cannot find module `transcriptBlocks.js`.

- [ ] **Step 3: Implement the parser**

Create `web/src/components/transcriptBlocks.ts`:

```ts
/**
 * Turns the drawer transcript — a flat text stream — into the block structure the
 * pane renders as collapsible tool calls.
 *
 * The stream carries no markup: `renderBlocks` on the server writes tool activity
 * as labelled lines, and those labels are the only structure there is. So this
 * module recognises them by line shape and emits DOM *operations* rather than DOM,
 * keeping it pure and unit-testable the way `ansi.ts` is. `test/transcriptBlocks.test.ts`
 * feeds it real `renderBlocks` output, so the two sides cannot drift apart quietly.
 *
 * Work is line-at-a-time: an unterminated trailing line is held in state (a marker
 * split across deltas must not half-parse) and handed back as `tail` so the caller
 * can still show it while it is being typed.
 */
export interface BlockOp {
  kind: 'open' | 'text' | 'close';
  text?: string;
  error?: boolean;
}

export interface BlockState {
  pending: string;
  inBlock: boolean;
  awaitingResult: boolean;
}

export const emptyBlockState: BlockState = { pending: '', inBlock: false, awaitingResult: false };

/** SGR is decoration; classification reads the bare text. */
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;
const bare = (line: string): string => line.replace(SGR, '');

const TOOL = /^⚙ /;
const RESULT = /^ {2}↳ (result|error)\b/;
/** A result body line is indented by two spaces; the emitter indents even blank ones. */
const BODY = /^ {2}/;

export function feedBlocks(chunk: string, state: BlockState): { ops: BlockOp[]; tail: string; state: BlockState } {
  const ops: BlockOp[] = [];
  let { inBlock, awaitingResult } = state;
  const buffer = state.pending + chunk;
  const lines = buffer.split('\n');
  const tail = lines.pop() ?? '';

  const close = () => {
    if (inBlock) ops.push({ kind: 'close' });
    inBlock = false;
    awaitingResult = false;
  };
  const emit = (text: string) => ops.push({ kind: 'text', text });

  for (const line of lines) {
    const text = bare(line);
    if (TOOL.test(text)) {
      close();
      ops.push({ kind: 'open', text: line, error: false });
      inBlock = true;
      awaitingResult = true;
      continue;
    }
    const result = RESULT.exec(text);
    if (result) {
      const error = result[1] === 'error';
      // A result immediately after its call folds into that block; anything else —
      // parallel calls, an orphan — stands on its own so adjacency never lies.
      if (inBlock && awaitingResult && !error) {
        awaitingResult = false;
        continue;
      }
      close();
      ops.push({ kind: 'open', text: line, error });
      inBlock = true;
      awaitingResult = false;
      continue;
    }
    if (inBlock && !awaitingResult && !BODY.test(text)) close();
    if (inBlock && awaitingResult && text.trim() !== '' && !BODY.test(text)) close();
    emit(`${line}\n`);
  }
  return { ops, tail, state: { pending: tail, inBlock, awaitingResult } };
}
```

The summary line for a folded call needs the result's count appended. Handle it by
emitting the count as part of the `open` op when the result folds in — replace the
fold branch above with one that rewrites the open op already emitted:

```ts
      if (inBlock && awaitingResult && !error) {
        const open = ops.findLast((o) => o.kind === 'open');
        // The count lives on the result label; the collapsed summary is where it is useful.
        const suffix = line.slice(line.indexOf('↳') + 1).replace(/^\s*(result|error)/, '');
        if (open && suffix.trim()) open.text = `${open.text}${suffix}`;
        awaitingResult = false;
        continue;
      }
```

Note the `open` op may belong to a previous chunk, in which case there is nothing to
rewrite — the count is simply absent for that block. Accept that; it is cosmetic, and
in stream mode a message's blocks arrive together.

- [ ] **Step 4: Run the tests**

```bash
npx tsx --test test/transcriptBlocks.test.ts
```

Expected: PASS. If the error-block test fails, check that an error result never folds — it must open its own block so it renders expanded.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/transcriptBlocks.ts test/transcriptBlocks.test.ts
git commit -m "Find the tool calls in a transcript"
```

---

### Task 3: The drawer renders blocks

**Files:**
- Modify: `web/src/components/AgentDrawer.tsx:18-35` (`appendChunk`), `web/src/components/AgentDrawer.tsx:103-126` (the render-diff effect)
- Modify: `web/src/styles.css:1049-1088` (the `.terminal` rules)
- Docs: `docs/spec/17-cockpit.md`

**Interfaces:**
- Consumes: `feedBlocks`, `emptyBlockState`, `BlockState` from Task 2; `parseAnsi`, `ansiClass`, `AnsiStyle` from `ansi.ts` (unchanged).
- Produces: no exports beyond the existing `AgentDrawer`.

- [ ] **Step 1: Replace `appendChunk` with a block-aware renderer**

The pane keeps a *tail* span as its last child so an unterminated line still shows; ops are inserted before it.

```tsx
interface PaneState {
  ansi: AnsiStyle;
  blocks: BlockState;
  /** The open <details> body, or null when writing straight into the pane. */
  body: HTMLElement | null;
}

/** Append styled text into `target`, threading ANSI state. */
function appendStyled(target: HTMLElement, text: string, style: AnsiStyle): AnsiStyle {
  const { segments, end } = parseAnsi(text, style);
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    const cls = ansiClass(seg.style);
    if (!cls) frag.appendChild(document.createTextNode(seg.text));
    else {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = seg.text;
      frag.appendChild(span);
    }
  }
  target.appendChild(frag);
  return end;
}

/** Apply one transcript chunk to the pane as blocks. */
function appendChunk(el: HTMLElement, tailEl: HTMLElement, chunk: string, state: PaneState): void {
  const { ops, tail, state: blocks } = feedBlocks(chunk, state.blocks);
  for (const op of ops) {
    if (op.kind === 'open') {
      const details = document.createElement('details');
      details.className = op.error ? 'tool-block error' : 'tool-block';
      // An error is never hidden: a failure that collapses is worse than a noisy one.
      if (op.error) details.open = true;
      const summary = document.createElement('summary');
      appendStyled(summary, op.text ?? '', {});
      details.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'tool-body';
      details.appendChild(body);
      el.insertBefore(details, tailEl);
      state.body = body;
    } else if (op.kind === 'close') {
      state.body = null;
    } else {
      const target = state.body ?? el;
      if (target === el) state.ansi = appendStyled(makeSlot(el, tailEl), op.text ?? '', state.ansi);
      else state.ansi = appendStyled(target, op.text ?? '', state.ansi);
    }
  }
  tailEl.replaceChildren();
  if (tail) appendStyled(tailEl, tail, state.ansi);
  state.blocks = blocks;
}

/** Prose goes into a span before the tail so insertion order stays simple. */
function makeSlot(el: HTMLElement, tailEl: HTMLElement): HTMLElement {
  const prev = tailEl.previousElementSibling;
  if (prev instanceof HTMLElement && prev.classList.contains('prose')) return prev;
  const span = document.createElement('span');
  span.className = 'prose';
  el.insertBefore(span, tailEl);
  return span;
}
```

- [ ] **Step 2: Thread the state through the effect**

Replace `ansiRef` with a single `paneRef`-adjacent state ref and create the tail element once:

```tsx
  const stateRef = useRef<PaneState>({ ansi: {}, blocks: emptyBlockState, body: null });
  const tailRef = useRef<HTMLSpanElement | null>(null);
```

Inside the effect, on the reseed path:

```tsx
    if (switched || !output.startsWith(prev)) {
      el.replaceChildren();
      stateRef.current = { ansi: {}, blocks: emptyBlockState, body: null };
      const tailEl = document.createElement('span');
      el.appendChild(tailEl);
      tailRef.current = tailEl;
      appendChunk(el, tailEl, output, stateRef.current);
      el.scrollTop = el.scrollHeight;
      setBehind(false);
    } else if (output.length > prev.length && tailRef.current) {
      appendChunk(el, tailRef.current, output.slice(prev.length), stateRef.current);
      …unchanged scroll handling…
    }
```

- [ ] **Step 3: Style the blocks**

Append to the `.terminal` rules in `web/src/styles.css`:

```css
/* A tool call: one dim line until opened, so reasoning is the spine of the pane. */
.terminal .tool-block > summary {
  cursor: pointer;
  list-style: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-radius: 4px;
  padding: 0 2px;
}
.terminal .tool-block > summary::-webkit-details-marker {
  display: none;
}
.terminal .tool-block > summary:hover {
  background: rgba(255, 255, 255, 0.05);
}
.terminal .tool-block[open] > summary {
  margin-bottom: 2px;
}
.terminal .tool-body {
  border-left: 2px solid var(--border);
  padding-left: 8px;
  margin-left: 2px;
}
.terminal .tool-block.error > summary {
  color: #ff8a8a;
}
```

- [ ] **Step 4: Typecheck both trees and run the suite**

```bash
npm run typecheck && npm run typecheck:web && npx tsx --test test/transcriptBlocks.test.ts test/ansi.test.ts test/streamTranscript.test.ts
```

Expected: clean, PASS.

- [ ] **Step 5: See it in the browser**

Start the cockpit preview and open an agent drawer with a transcript containing tool calls (the demo backend fixtures in `web/src/demo/fixtures.ts` carry one). Confirm: tool calls are one line, clicking expands, an error block is open and red, prose reads continuously.

- [ ] **Step 6: Update the cockpit spec**

In `docs/spec/17-cockpit.md`, at the transcript-pane section (around the line stating the pane is HTML rather than a terminal), state as fact: tool calls render as collapsed blocks summarised by their label, input summary and result line count; an error result renders expanded and is never collapsed; expansion is DOM-only state and a reseed restores every block to collapsed; a PTY transcript carries no markers and renders as plain prose.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/AgentDrawer.tsx web/src/styles.css docs/spec/17-cockpit.md
git commit -m "Fold a tool call down to one line"
```

---

### Task 4: Full check and PR

- [ ] **Step 1: Format, then run the full gate**

```bash
npm run format && npm run check
```

Expected: all six pass. knip is the likely failure — every export of `transcriptBlocks.ts` must be imported by `AgentDrawer.tsx` or the test. If `BlockOp` or `BlockState` is flagged, drop the `export` keyword on the type rather than adding an ignore.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin HEAD
```

PR body: the problem (tool output drowns the reasoning), what changed (collapsed blocks, result counts, cap 12 → 200), and the one approximation (parallel calls render results as standalone blocks rather than pairing by adjacency).
