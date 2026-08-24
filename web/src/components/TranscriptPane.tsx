import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { parseAnsi, ansiClass, type AnsiStyle } from './ansi.js';
import { feedBlocks, emptyBlockState, type BlockState } from './transcriptBlocks.js';

/** How close to the bottom (px) still counts as "following the stream". */
const STICK_THRESHOLD = 24;

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
}

/** What one pane carries between deltas: ANSI run, block parse, and the open block's body. */
interface PaneState {
  ansi: AnsiStyle;
  blocks: BlockState;
  /** The open block's body, or null when writing straight into the pane. */
  body: HTMLElement | null;
}

/** Append styled text into `target`, resuming the ANSI run and returning where it ends. */
function appendStyled(target: HTMLElement, text: string, style: AnsiStyle): AnsiStyle {
  const { segments, end } = parseAnsi(text, style);
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    const cls = ansiClass(seg.style);
    if (!cls) {
      frag.appendChild(document.createTextNode(seg.text));
    } else {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = seg.text;
      frag.appendChild(span);
    }
  }
  target.appendChild(frag);
  return end;
}

/** A collapsed tool call: its summary line, and an empty body for the result. */
function openBlock(summary: string, error: boolean): { block: HTMLDetailsElement; body: HTMLElement } {
  const block = document.createElement('details');
  block.className = error ? 'tool-block error' : 'tool-block';
  // A failure that hides is worse than a noisy one, so an error is never collapsed.
  block.open = error;
  const head = document.createElement('summary');
  appendStyled(head, summary, {});
  block.appendChild(head);
  const body = document.createElement('div');
  body.className = 'tool-body';
  block.appendChild(body);
  return { block, body };
}

/** Prose accumulates in one span before the tail, so appends stay ordered. */
function proseSlot(el: HTMLElement, tailEl: HTMLElement): HTMLElement {
  const prev = tailEl.previousElementSibling;
  if (prev instanceof HTMLElement && prev.classList.contains('prose')) return prev;
  const span = document.createElement('span');
  span.className = 'prose';
  el.insertBefore(span, tailEl);
  return span;
}

/**
 * Apply a transcript chunk to the pane as blocks. `tailEl` holds the line still being
 * written — it is rewritten each delta and everything else is inserted before it, so
 * streaming text shows immediately without the parser having to guess at a partial line.
 */
function appendChunk(el: HTMLElement, tailEl: HTMLElement, chunk: string, state: PaneState): void {
  const { ops, tail, state: blocks } = feedBlocks(chunk, state.blocks);
  for (const op of ops) {
    if (op.kind === 'open') {
      const { block, body } = openBlock(op.text ?? '', op.error === true);
      el.insertBefore(block, tailEl);
      state.body = body;
      state.ansi = {};
    } else if (op.kind === 'close') {
      state.body = null;
      state.ansi = {};
    } else {
      const target = state.body ?? proseSlot(el, tailEl);
      state.ansi = appendStyled(target, op.text ?? '', state.ansi);
    }
  }
  tailEl.replaceChildren();
  if (tail) appendStyled(tailEl, tail, state.ansi);
  state.blocks = blocks;
}

/**
 * One session's output, rendered as real DOM: ANSI colour translated, tool calls folded
 * to a line, prose reading continuously between them.
 *
 * **Every surface that shows a session's output draws it here, and that is the whole
 * reason this is a component rather than the drawer's private business.** What a session
 * emits is `renderBlocks` output whoever is watching — the fleet's transcripts and the
 * local run's tail are the same bytes off the same `output` event
 * ([23](../../../docs/spec/23-local-runs.md)) — so a surface that drops that text into a
 * `<pre>` shows an operator raw SGR escapes wrapped around a page of undifferentiated
 * tool output. It is not a plainer rendering of the same thing, and nothing in `check`
 * has an opinion about it: it compiles, it renders, and it is unreadable.
 *
 * The text is already legible in every mode, never raw TUI bytes, so the browser wraps it
 * on word boundaries, scrolls it natively and lets it be selected. The one terminal
 * feature reproduced is SGR colour ({@link parseAnsi}).
 *
 * `streamId` names **which** stream is being drawn. A change to it is a reseed rather than
 * an append, as is any text that is not an extension of what has already been written — a
 * rolling tail that has dropped lines off its top being the case that matters. A reseed
 * rebuilds the pane, and because expansion is DOM-only state, every block comes back
 * collapsed.
 */
export function TranscriptPane({
  text,
  streamId,
  label,
  className,
}: {
  text: string;
  /** Which stream this is. A change reseeds the pane rather than appending to it. */
  streamId: string;
  /** What a screen reader calls the pane — there is more than one on the glass now. */
  label: string;
  /** Extra classes for the wrapper. `compact` caps it for a panel rather than a drawer. */
  className?: string;
}): JSX.Element {
  // The stream ran ahead while the user was scrolled up — offer a jump-to-latest.
  const [behind, setBehind] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  // What's already rendered into the pane, so we append only the new tail.
  const writtenRef = useRef('');
  // Parse and style state carried across appends (a run can split across deltas).
  const stateRef = useRef<PaneState>({ ansi: {}, blocks: emptyBlockState, body: null });
  // The line still being written, kept as the pane's last child.
  const tailRef = useRef<HTMLSpanElement | null>(null);
  const streamIdRef = useRef(streamId);

  // Render-diff into the pane: append only what's new; on a stream switch or a
  // non-append change (shrink/reseed), clear and rewrite the whole buffer.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const prev = writtenRef.current;
    const switched = streamIdRef.current !== streamId;
    const following = atBottom(el);
    // No tail element yet means nothing has been written — the first frame renders an
    // empty transcript, and the seed that follows it is a rewrite, not an append.
    if (switched || !text.startsWith(prev) || !tailRef.current) {
      el.replaceChildren();
      stateRef.current = { ansi: {}, blocks: emptyBlockState, body: null };
      // Expansion is DOM-only state, so a reseed starts every block collapsed.
      const tailEl = document.createElement('span');
      el.appendChild(tailEl);
      tailRef.current = tailEl;
      appendChunk(el, tailEl, text, stateRef.current);
      el.scrollTop = el.scrollHeight;
      setBehind(false);
    } else if (text.length > prev.length && tailRef.current) {
      appendChunk(el, tailRef.current, text.slice(prev.length), stateRef.current);
      if (following) {
        el.scrollTop = el.scrollHeight;
        setBehind(false);
      } else {
        setBehind(true);
      }
    }
    writtenRef.current = text;
    streamIdRef.current = streamId;
  }, [text, streamId]);

  const onScroll = useCallback(() => {
    const el = paneRef.current;
    if (el && atBottom(el)) setBehind(false);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = paneRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setBehind(false);
  }, []);

  return (
    <div className={className === undefined ? 'terminal-wrap' : `terminal-wrap ${className}`}>
      <div className="terminal" ref={paneRef} onScroll={onScroll} aria-label={label} />
      {behind && (
        <button type="button" className="term-jump" onClick={jumpToLatest}>
          ↓ New output
        </button>
      )}
    </div>
  );
}
