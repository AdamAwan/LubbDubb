import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { parseAnsi, ansiClass, type AnsiStyle } from './ansi.js';
import { feedBlocks, emptyBlockState, type BlockState } from './transcriptBlocks.js';

// → docs/spec/17-cockpit.md

const STICK_THRESHOLD = 24;

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
}

interface PaneState {
  ansi: AnsiStyle;
  blocks: BlockState;
  body: HTMLElement | null;
}

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

function openBlock(summary: string, error: boolean): { block: HTMLDetailsElement; body: HTMLElement } {
  const block = document.createElement('details');
  block.className = error ? 'tool-block error' : 'tool-block';
  block.open = error;
  const head = document.createElement('summary');
  appendStyled(head, summary, {});
  block.appendChild(head);
  const body = document.createElement('div');
  body.className = 'tool-body';
  block.appendChild(body);
  return { block, body };
}

function proseSlot(el: HTMLElement, tailEl: HTMLElement): HTMLElement {
  const prev = tailEl.previousElementSibling;
  if (prev instanceof HTMLElement && prev.classList.contains('prose')) return prev;
  const span = document.createElement('span');
  span.className = 'prose';
  el.insertBefore(span, tailEl);
  return span;
}

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

export function TranscriptPane({
  text,
  streamId,
  label,
  className,
}: {
  text: string;
  streamId: string;
  label: string;
  className?: string;
}): JSX.Element {
  const [behind, setBehind] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const writtenRef = useRef('');
  const stateRef = useRef<PaneState>({ ansi: {}, blocks: emptyBlockState, body: null });
  const tailRef = useRef<HTMLSpanElement | null>(null);
  const streamIdRef = useRef(streamId);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const prev = writtenRef.current;
    const switched = streamIdRef.current !== streamId;
    const following = atBottom(el);
    if (switched || !text.startsWith(prev) || !tailRef.current) {
      el.replaceChildren();
      stateRef.current = { ansi: {}, blocks: emptyBlockState, body: null };
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
