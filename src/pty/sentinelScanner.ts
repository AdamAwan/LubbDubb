import { stripAnsi } from '../agents/streamTranscript.js';

// → docs/spec/10-agent-runtimes.md

// TECHDEBT: the interactive claude TUI styles the line it prints a sentinel on, so SGR
// escapes arrive *inside* the token (`@@LUBB\x1b[0mDUBB_DONE@@`), not merely around it.
// Everything here matches through the escapes and reports *raw* offsets, so detection and
// stripping share one matcher over one view of the stream and cannot diverge.

type SentinelKind = 'done' | 'waiting' | 'flag';

export interface SentinelSpec {
  done: string;
  waitPrefix: string;
  waitSuffix: string;
  flagPrefix: string;
  flagSuffix: string;
}

interface SentinelHit {
  kind: SentinelKind;
  start: number;
  end: number;
  payload: string;
}

// Escape forms `stripAnsi` recognises, as sticky matchers so they can be tried at
// an exact offset without slicing.
// eslint-disable-next-line no-control-regex
const ESC_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
// eslint-disable-next-line no-control-regex
const ESC_C1 = /\x1b[@-Z\\-_]/y;

const BOUNDARY_WINDOW = 64;
const ESC_SLACK = 6;

function escLen(hay: string, i: number): number {
  if (hay.charCodeAt(i) !== 0x1b) return 0;
  ESC_CSI.lastIndex = i;
  if (ESC_CSI.test(hay)) return ESC_CSI.lastIndex - i;
  ESC_C1.lastIndex = i;
  if (ESC_C1.test(hay)) return ESC_C1.lastIndex - i;
  return 0;
}

function matchAt(hay: string, i: number, token: string): number {
  let p = i;
  for (const ch of token) {
    p += escLen(hay, p);
    if (hay[p] !== ch) return -1;
    p++;
  }
  return p;
}

function indexOfToken(hay: string, token: string, from: number): { start: number; end: number } | null {
  if (!token) return null;
  const first = token[0];
  for (let i = from; i < hay.length; i++) {
    if (hay[i] !== first) continue;
    const end = matchAt(hay, i, token);
    if (end !== -1) return { start: i, end };
  }
  return null;
}

function boundedBefore(hay: string, start: number): boolean {
  const win = stripAnsi(hay.slice(Math.max(0, start - BOUNDARY_WINDOW), start));
  const ch = win[win.length - 1];
  return ch === undefined || /\s/.test(ch);
}

function boundedAfter(hay: string, end: number): boolean {
  const win = stripAnsi(hay.slice(end, end + BOUNDARY_WINDOW));
  const ch = win[0];
  return ch === undefined || /\s/.test(ch);
}

function collectTokens(hay: string, token: string, kind: SentinelKind, out: SentinelHit[]): void {
  let from = 0;
  for (;;) {
    const m = indexOfToken(hay, token, from);
    if (!m) return;
    if (boundedBefore(hay, m.start) && boundedAfter(hay, m.end)) {
      out.push({ kind, start: m.start, end: m.end, payload: '' });
      from = m.end;
    } else {
      from = m.start + 1;
    }
  }
}

function collectSpans(hay: string, prefix: string, suffix: string, kind: SentinelKind, out: SentinelHit[]): void {
  if (!prefix || !suffix) return;
  let from = 0;
  for (;;) {
    const open = indexOfToken(hay, prefix, from);
    if (!open) return;
    if (!boundedBefore(hay, open.start)) {
      from = open.start + 1;
      continue;
    }
    const close = indexOfToken(hay, suffix, open.end);
    if (!close) return;
    if (!boundedAfter(hay, close.end)) {
      from = open.start + 1;
      continue;
    }
    out.push({
      kind,
      start: open.start,
      end: close.end,
      payload: stripAnsi(hay.slice(open.end, close.start)),
    });
    from = close.end;
  }
}

export function scanSentinels(hay: string, spec: SentinelSpec): SentinelHit[] {
  const hits: SentinelHit[] = [];
  collectTokens(hay, spec.done, 'done', hits);
  collectSpans(hay, spec.waitPrefix, spec.waitSuffix, 'waiting', hits);
  collectSpans(hay, spec.flagPrefix, spec.flagSuffix, 'flag', hits);
  const rank = (h: SentinelHit): number => (h.kind === 'done' ? 0 : 1);
  hits.sort((a, b) => a.start - b.start || rank(a) - rank(b) || b.end - a.end);
  const kept: SentinelHit[] = [];
  for (const h of hits) {
    const prev = kept[kept.length - 1];
    if (prev && h.start < prev.end) continue;
    kept.push(h);
  }
  return kept;
}

export function excise(hay: string, hits: SentinelHit[]): string {
  let out = '';
  let i = 0;
  for (const h of hits) {
    if (h.start < i) continue;
    out += hay.slice(i, h.start);
    i = h.end;
  }
  return out + hay.slice(i);
}

export function holdFrom(hay: string, spec: SentinelSpec, maxHold: number): number {
  let hold = hay.length;
  for (const pre of [spec.waitPrefix, spec.flagPrefix]) {
    const m = indexOfToken(hay, pre, 0);
    if (m && m.start < hold) hold = m.start;
  }
  if (hold < hay.length && hay.length - hold <= maxHold) return hold;
  return partialTailStart(hay, [spec.done, spec.waitPrefix, spec.flagPrefix]);
}

function partialTailStart(hay: string, tokens: string[]): number {
  const valid = tokens.filter((t) => t.length > 1);
  if (!valid.length) return hay.length;
  const maxLen = Math.max(...valid.map((t) => t.length)) - 1;
  const from = Math.max(0, hay.length - maxLen * ESC_SLACK);
  for (let i = from; i < hay.length; i++) {
    const run = stripAnsi(hay.slice(i));
    if (!run || run.length > maxLen) continue;
    if (valid.some((t) => t.length > run.length && t.startsWith(run))) return i;
  }
  return hay.length;
}
